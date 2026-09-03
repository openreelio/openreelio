//! Agent Plan Runner
//!
//! Executes an [`AgentPlan`] atomically against an open project: every step is
//! applied through the `CommandExecutor`, and the first failure unwinds all the
//! work the plan already applied — both the in-memory undo stack and the
//! persisted ops log.
//!
//! The runner is Tauri-free on purpose. Step lifecycle progress is delivered
//! through the [`PlanStepReporter`] port, so the GUI can forward it to the
//! frontend as Tauri events while headless callers and tests use their own
//! sink. That keeps the atomicity guarantee under test without an `AppHandle`.

use std::collections::HashMap;
use std::time::Instant;

use super::agent_plan::{AgentPlan, AgentPlanResult, RollbackReport, StepResult};
use super::plan_executor::{resolve_step_references, PlanExecutor};
use crate::core::commands::{infer_sequence_id, payload_string, EditRecording, RecordSource};
use crate::core::project::ProjectState;
use crate::core::TimeRange;
use crate::ipc::CommandPayload;
use crate::ActiveProject;

// =============================================================================
// Progress reporting port
// =============================================================================

/// Progress payload emitted when a plan step starts.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepEvent {
    pub plan_id: String,
    pub step_id: String,
    pub step_index: usize,
    pub total_steps: usize,
}

/// Progress payload emitted when a plan step completes successfully.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepCompleteEvent {
    pub plan_id: String,
    pub step_id: String,
    pub step_index: usize,
    pub total_steps: usize,
    pub operation_id: Option<String>,
    pub duration_ms: u64,
}

/// Progress payload emitted when a plan step fails.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepFailedEvent {
    pub plan_id: String,
    pub step_id: String,
    pub step_index: usize,
    pub total_steps: usize,
    pub error: String,
}

/// Sink for plan step lifecycle progress.
///
/// Reporting is best-effort and must never influence execution: an
/// implementation that fails to deliver a message swallows the error.
pub trait PlanStepReporter {
    /// Called immediately before a step is applied.
    fn step_start(&self, event: PlanStepEvent);

    /// Called after a step was applied successfully.
    fn step_complete(&self, event: PlanStepCompleteEvent);

    /// Called after a step failed, before the rollback runs.
    fn step_failed(&self, event: PlanStepFailedEvent);
}

/// Reporter that drops every message. Used by headless callers and tests.
pub struct NullPlanStepReporter;

impl PlanStepReporter for NullPlanStepReporter {
    fn step_start(&self, _event: PlanStepEvent) {}
    fn step_complete(&self, _event: PlanStepCompleteEvent) {}
    fn step_failed(&self, _event: PlanStepFailedEvent) {}
}

// =============================================================================
// Runner
// =============================================================================

/// Executes `plan` against `project`, rolling back completely on the first
/// failure.
///
/// Returns `Err` when the plan itself is unusable (over the step cap, cyclic,
/// or referencing a step that does not exist) — nothing is applied in that
/// case. A step failure is reported as `Ok` with `success: false` and a
/// [`RollbackReport`], because the project was mutated and then restored.
///
/// Callers that must reject an invalid plan *before* acquiring side effects of
/// their own (a project lock, an approval-proof consumption) can run
/// [`PlanExecutor::validate_and_prepare`] first; re-validating here is O(steps)
/// and keeps this entry point safe to call standalone.
pub fn run_agent_plan(
    project: &mut ActiveProject,
    plan: &AgentPlan,
    reporter: &dyn PlanStepReporter,
    start: Instant,
) -> Result<AgentPlanResult, String> {
    let executor = PlanExecutor::new(plan.clone());
    let execution_order = executor
        .validate_and_prepare()
        .map_err(|e| format!("Plan validation failed: {e}"))?;

    Ok(execute_prepared_plan(
        project,
        plan,
        &executor,
        &execution_order,
        reporter,
        start,
    ))
}

/// Executes a plan whose dependency graph was already validated.
///
/// `execution_order` must come from [`PlanExecutor::validate_and_prepare`] for
/// the same plan.
///
/// The whole plan is diffed against one before-image of the target sequence,
/// through the same [`EditRecording`] every other surface applies edits with,
/// and the result is reported as `affected_ranges` and written to the project's
/// where-to-look hand-off. That is what lets the next inspection step — a
/// contact sheet of the change, say — ask for "the last edit" instead of
/// re-reading the whole timeline. On failure the ranges follow the rollback:
/// see [`rolled_back_ranges`].
pub fn execute_prepared_plan(
    project: &mut ActiveProject,
    plan: &AgentPlan,
    executor: &PlanExecutor,
    execution_order: &[usize],
    reporter: &dyn PlanStepReporter,
    start: Instant,
) -> AgentPlanResult {
    let plan_id = plan.id.clone();
    let total_steps = plan.steps.len();
    let project_path = project.path.clone();
    let target_sequence_id = resolve_plan_sequence_id(&project.state, plan).unwrap_or_default();
    // The before-image has to be taken before the first step runs: the ranges
    // are a diff across the whole apply, and a ripple move shifts clips no
    // reported `StateChange` names.
    let mut recording =
        EditRecording::begin(&project.state, &target_sequence_id, RecordSource::AgentPlan);

    // Rollback unwinds the executor's in-memory undo stack, and that stack is
    // capped for interactive use — far below the plan step cap. Without this, a
    // plan that fails deep enough has already had its earliest steps evicted
    // and could not undo them.
    project.executor.ensure_history_capacity(total_steps);

    let mut step_results: Vec<StepResult> = Vec::with_capacity(total_steps);
    let mut results_by_id: HashMap<String, StepResult> = HashMap::new();
    let mut operation_ids: Vec<String> = Vec::new();
    let mut steps_completed: usize = 0;

    tracing::info!(
        plan_id = %plan_id,
        total_steps = total_steps,
        "Executing agent plan"
    );

    for &step_idx in execution_order {
        let step = &plan.steps[step_idx];
        let step_start = Instant::now();

        reporter.step_start(PlanStepEvent {
            plan_id: plan_id.clone(),
            step_id: step.id.clone(),
            step_index: step_idx,
            total_steps,
        });

        // Resolve $fromStep/$path references in step params
        let resolved_params = match resolve_step_references(&step.params, &results_by_id) {
            Ok(params) => params,
            Err(e) => {
                let duration_ms = step_start.elapsed().as_millis() as u64;
                let error_msg = format!("Reference resolution failed: {e}");

                reporter.step_failed(PlanStepFailedEvent {
                    plan_id: plan_id.clone(),
                    step_id: step.id.clone(),
                    step_index: step_idx,
                    total_steps,
                    error: error_msg.clone(),
                });

                step_results.push(StepResult {
                    step_id: step.id.clone(),
                    success: false,
                    data: None,
                    error: Some(error_msg),
                    duration_ms,
                    operation_id: None,
                });

                let rollback_report = rollback_steps(project, executor, step_idx, &step_results);
                let affected_ranges =
                    rolled_back_ranges(&rollback_report, &recording, &project.state);

                return AgentPlanResult {
                    plan_id,
                    success: false,
                    total_steps,
                    steps_completed,
                    step_results,
                    operation_ids,
                    rollback_report: Some(rollback_report),
                    error_message: Some(format!(
                        "Step '{}' failed: reference resolution error",
                        step.id
                    )),
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    sequence_id: reported_sequence_id(&target_sequence_id),
                    affected_ranges,
                };
            }
        };

        // Parse tool_name + resolved_params into a CommandPayload
        let typed_payload = match CommandPayload::parse(step.tool_name.clone(), resolved_params) {
            Ok(payload) => payload,
            Err(e) => {
                let duration_ms = step_start.elapsed().as_millis() as u64;
                let error_msg = format!("Invalid command '{}': {e}", step.tool_name);

                reporter.step_failed(PlanStepFailedEvent {
                    plan_id: plan_id.clone(),
                    step_id: step.id.clone(),
                    step_index: step_idx,
                    total_steps,
                    error: error_msg.clone(),
                });

                step_results.push(StepResult {
                    step_id: step.id.clone(),
                    success: false,
                    data: None,
                    error: Some(error_msg),
                    duration_ms,
                    operation_id: None,
                });

                let rollback_report = rollback_steps(project, executor, step_idx, &step_results);
                let affected_ranges =
                    rolled_back_ranges(&rollback_report, &recording, &project.state);

                return AgentPlanResult {
                    plan_id,
                    success: false,
                    total_steps,
                    steps_completed,
                    step_results,
                    operation_ids,
                    rollback_report: Some(rollback_report),
                    error_message: Some(format!("Step '{}' failed: invalid command", step.id)),
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    sequence_id: reported_sequence_id(&target_sequence_id),
                    affected_ranges,
                };
            }
        };

        let command = typed_payload.build_command(&project_path);
        match project.executor.execute(command, &mut project.state) {
            Ok(cmd_result) => {
                let duration_ms = step_start.elapsed().as_millis() as u64;
                let op_id = cmd_result.op_id.clone();
                recording.observe(&cmd_result);

                let step_data = serde_json::json!({
                    "operationId": op_id,
                    "createdIds": cmd_result.created_ids,
                    "deletedIds": cmd_result.deleted_ids,
                });

                let result = StepResult {
                    step_id: step.id.clone(),
                    success: true,
                    data: Some(step_data),
                    error: None,
                    duration_ms,
                    operation_id: Some(op_id.clone()),
                };

                reporter.step_complete(PlanStepCompleteEvent {
                    plan_id: plan_id.clone(),
                    step_id: step.id.clone(),
                    step_index: step_idx,
                    total_steps,
                    operation_id: Some(op_id.clone()),
                    duration_ms,
                });

                operation_ids.push(op_id);
                results_by_id.insert(step.id.clone(), result.clone());
                step_results.push(result);
                steps_completed += 1;

                tracing::debug!(
                    step_id = %step.id,
                    step_index = step_idx,
                    duration_ms = duration_ms,
                    "Plan step completed successfully"
                );
            }
            Err(e) => {
                let duration_ms = step_start.elapsed().as_millis() as u64;
                let error_msg = format!("Command execution failed: {e}");

                reporter.step_failed(PlanStepFailedEvent {
                    plan_id: plan_id.clone(),
                    step_id: step.id.clone(),
                    step_index: step_idx,
                    total_steps,
                    error: error_msg.clone(),
                });

                step_results.push(StepResult {
                    step_id: step.id.clone(),
                    success: false,
                    data: None,
                    error: Some(error_msg),
                    duration_ms,
                    operation_id: None,
                });

                tracing::warn!(
                    step_id = %step.id,
                    step_index = step_idx,
                    error = %e,
                    "Plan step failed, initiating rollback"
                );

                let rollback_report = rollback_steps(project, executor, step_idx, &step_results);
                let affected_ranges =
                    rolled_back_ranges(&rollback_report, &recording, &project.state);

                return AgentPlanResult {
                    plan_id,
                    success: false,
                    total_steps,
                    steps_completed,
                    step_results,
                    operation_ids,
                    rollback_report: Some(rollback_report),
                    error_message: Some(format!("Step '{}' failed during execution", step.id)),
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    sequence_id: reported_sequence_id(&target_sequence_id),
                    affected_ranges,
                };
            }
        }
    }

    // The plan is already durable in the ops log by now, so a hand-off that
    // cannot be written costs the next inspection step its shortcut and nothing
    // else; the recorder logs that failure itself.
    let affected_ranges = recording.finish(&project_path, &project.state);

    tracing::info!(
        plan_id = %plan_id,
        steps_completed = steps_completed,
        affected_ranges = affected_ranges.len(),
        elapsed_ms = start.elapsed().as_millis(),
        "Agent plan executed successfully"
    );

    AgentPlanResult {
        plan_id,
        success: true,
        total_steps,
        steps_completed,
        step_results,
        operation_ids,
        rollback_report: None,
        error_message: None,
        execution_time_ms: start.elapsed().as_millis() as u64,
        sequence_id: reported_sequence_id(&target_sequence_id),
        affected_ranges,
    }
}

/// Picks the sequence a plan's affected ranges are measured against.
///
/// The first step that names an existing `sequenceId` wins. Failing that, the
/// first step naming an `effectId` or a `clipId` identifies one through
/// [`infer_sequence_id`]: `UpdateEffect`, `UpdateMask` and `RemoveMask` address
/// an effect and never a sequence, so a plan made only of those reported no
/// ranges at all — or, worse, the active sequence's.
///
/// Resolved once for the whole plan rather than per step, because a hand-off
/// file describing two timelines could not say which seconds of which one to
/// look at.
///
/// `None` when nothing in the plan identifies a timeline — an asset import, a
/// `CreateSequence` — and deliberately *not* the active sequence: reporting the
/// whole timeline of a sequence the plan never touched is worse than reporting
/// nothing, because an agent cannot tell a confident wrong answer from a right
/// one.
fn resolve_plan_sequence_id(state: &ProjectState, plan: &AgentPlan) -> Option<String> {
    let named = plan
        .steps
        .iter()
        .filter_map(|step| step.params.get("sequenceId").and_then(|id| id.as_str()))
        .find(|sequence_id| state.sequences.contains_key(*sequence_id));
    if let Some(sequence_id) = named {
        return Some(sequence_id.to_string());
    }

    plan.steps.iter().find_map(|step| {
        infer_sequence_id(
            state,
            payload_string(&step.params, "effectId").as_deref(),
            payload_string(&step.params, "clipId").as_deref(),
        )
    })
}

/// The sequence id a result reports, or `None` when none could be resolved.
fn reported_sequence_id(sequence_id: &str) -> Option<String> {
    (!sequence_id.is_empty()).then(|| sequence_id.to_string())
}

/// The ranges a failed plan reports, decided by whether the rollback worked.
///
/// A clean rollback puts every applied step back, so the ranges those steps
/// reported no longer name anything changed and all of them are dropped —
/// sending an inspector to a frame that never differed is worse than sending it
/// nowhere.
///
/// An incomplete rollback is the opposite case: an operation that could not be
/// undone or discarded stays applied and comes back on the next open, so the
/// project really is changed. Reporting no ranges there would say in one breath
/// that the project was mutated and that nothing on the timeline moved. The
/// recording's own diff — the plan's before-image against the state the failed
/// rollback actually left — is the answer to "where do I look now", and it is
/// measured rather than assembled, so a step that was undone cleanly before the
/// rollback stalled contributes only what still differs.
///
/// Nothing is written to the hand-off file either way: a failed plan must not
/// overwrite the record of the last apply that did land.
fn rolled_back_ranges(
    report: &RollbackReport,
    recording: &EditRecording,
    state: &ProjectState,
) -> Vec<TimeRange> {
    if report.rollback_errors.is_empty() {
        return Vec::new();
    }

    recording.ranges(state)
}

/// Rolls back completed steps in reverse order and excludes their persisted ops
/// from history replay.
fn rollback_steps(
    project: &mut ActiveProject,
    executor: &PlanExecutor,
    failed_index: usize,
    step_results: &[StepResult],
) -> RollbackReport {
    // Build the initial report (with candidate steps identified)
    let mut report = executor.build_rollback_report(failed_index, step_results);

    if !report.attempted {
        return report;
    }

    // Undo completed operations in reverse order via the CommandExecutor's undo stack
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut rollback_errors = Vec::new();
    let completed_operation_ids = step_results
        .iter()
        .filter_map(|result| result.operation_id.clone())
        .collect::<Vec<_>>();

    for step_id in &report.rolled_back_steps.clone() {
        match project.executor.undo(&mut project.state) {
            Ok(()) => {
                succeeded += 1;
                tracing::debug!(step_id = %step_id, "Rolled back step successfully");
            }
            Err(e) => {
                failed += 1;
                let error_msg = format!("Failed to undo step '{}': {}", step_id, e);
                tracing::error!("{}", error_msg);
                rollback_errors.push(error_msg);
                // Stop rollback on first undo failure to avoid inconsistent state
                break;
            }
        }
    }

    if !completed_operation_ids.is_empty() {
        match project.discard_persisted_operations(&completed_operation_ids) {
            Ok(still_applied) => {
                if still_applied.is_empty() {
                    tracing::debug!(
                        discarded_ops = completed_operation_ids.len(),
                        "Discarded rolled-back agent plan operations from persisted history"
                    );
                } else {
                    // Protected operations stay applied and return on the next
                    // open, so this rollback did not put the project back.
                    let error_msg = format!(
                        "Rollback could not discard protected operation(s) [{}]: they stay in the \
                         project's applied history and will be present on the next open",
                        still_applied.join(", ")
                    );
                    tracing::error!("{}", error_msg);
                    rollback_errors.push(error_msg);
                    failed = failed.max(1);
                }
            }
            Err(e) => {
                let error_msg =
                    format!("Failed to discard rolled-back operations from persisted history: {e}");
                tracing::error!("{}", error_msg);
                rollback_errors.push(error_msg);
                failed = failed.max(1);
            }
        }
    }

    report.succeeded_count = succeeded;
    report.failed_count = failed;
    report.rollback_errors = rollback_errors;

    report
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ai::agent_plan::{PlanRiskLevel, PlanStep};
    use crate::core::ai::plan_executor::MAX_PLAN_STEPS;
    use tempfile::TempDir;

    /// Records every reported lifecycle event so tests can assert that a
    /// rejected plan never reached a step.
    #[derive(Default)]
    struct RecordingReporter {
        started: std::cell::RefCell<Vec<String>>,
        failed: std::cell::RefCell<Vec<String>>,
    }

    impl PlanStepReporter for RecordingReporter {
        fn step_start(&self, event: PlanStepEvent) {
            self.started.borrow_mut().push(event.step_id);
        }
        fn step_complete(&self, _event: PlanStepCompleteEvent) {}
        fn step_failed(&self, event: PlanStepFailedEvent) {
            self.failed.borrow_mut().push(event.step_id);
        }
    }

    fn add_track_step(id: &str, sequence_id: &str, name: &str) -> PlanStep {
        PlanStep {
            id: id.to_string(),
            tool_name: "addTrack".to_string(),
            params: serde_json::json!({
                "sequenceId": sequence_id,
                "kind": "video",
                "name": name,
            }),
            description: format!("Add track {name}"),
            risk_level: PlanRiskLevel::Low,
            depends_on: vec![],
            optional: false,
        }
    }

    fn plan_with(steps: Vec<PlanStep>) -> AgentPlan {
        AgentPlan {
            id: "plan-runner-test".to_string(),
            goal: "Runner test".to_string(),
            steps,
            approval_granted: true,
            approval_proof: None,
            session_id: None,
        }
    }

    fn open_project(dir: &TempDir) -> ActiveProject {
        let mut project = ActiveProject::create("Runner Test", dir.path().to_path_buf())
            .expect("project creation must succeed");
        // Every step targets the active sequence, so one must exist.
        if project.state.active_sequence_id.is_none() {
            let sequence_id = project
                .state
                .sequences
                .keys()
                .next()
                .cloned()
                .expect("a new project must have a sequence");
            project.state.active_sequence_id = Some(sequence_id);
        }
        project
    }

    /// A step that drops a marker at `time` on the target sequence.
    ///
    /// A marker is the cheapest edit that lands at a known place on a timeline:
    /// it needs no asset and no track, so the test measures the range
    /// arithmetic rather than a fixture.
    fn add_marker_step(id: &str, sequence_id: &str, time: f64) -> PlanStep {
        PlanStep {
            id: id.to_string(),
            tool_name: "addMarker".to_string(),
            params: serde_json::json!({
                "sequenceId": sequence_id,
                "timeSec": time,
                "label": format!("Marker at {time}"),
            }),
            description: format!("Mark {time}"),
            risk_level: PlanRiskLevel::Low,
            depends_on: vec![],
            optional: false,
        }
    }

    /// A step carrying nothing but the given params, for the resolution tests.
    fn step_with_params(id: &str, params: serde_json::Value) -> PlanStep {
        PlanStep {
            id: id.to_string(),
            tool_name: "updateEffect".to_string(),
            params,
            description: "Resolution fixture".to_string(),
            risk_level: PlanRiskLevel::Low,
            depends_on: vec![],
            optional: false,
        }
    }

    #[test]
    fn resolve_plan_sequence_id_should_infer_the_timeline_an_effect_hangs_on() {
        let dir = TempDir::new().expect("temp dir");
        let mut project = open_project(&dir);
        let sequence_id = project
            .state
            .active_sequence_id
            .clone()
            .expect("active sequence");

        // `UpdateEffect`, `UpdateMask` and `RemoveMask` address an effect and
        // never a sequence, so this is the only thing that identifies the
        // timeline such a plan changes.
        let mut clip = crate::core::timeline::Clip::new("asset-a");
        clip.effects.push("fx-1".to_string());
        let sequence = project
            .state
            .sequences
            .get_mut(&sequence_id)
            .expect("the active sequence exists");
        sequence
            .tracks
            .first_mut()
            .expect("a new project has a track")
            .clips
            .push(clip);

        let plan = plan_with(vec![step_with_params(
            "step-1",
            serde_json::json!({ "effectId": "fx-1", "params": {} }),
        )]);

        assert_eq!(
            resolve_plan_sequence_id(&project.state, &plan).as_deref(),
            Some(sequence_id.as_str())
        );
    }

    #[test]
    fn resolve_plan_sequence_id_should_report_nothing_for_a_plan_that_names_no_timeline() {
        let dir = TempDir::new().expect("temp dir");
        let project = open_project(&dir);
        assert!(
            project.state.active_sequence_id.is_some(),
            "the fallback under test only differs while an active sequence exists"
        );

        let plan = plan_with(vec![step_with_params(
            "step-1",
            serde_json::json!({ "name": "clip.mp4", "uri": "/media/clip.mp4" }),
        )]);

        // Falling back to the active sequence reported the whole timeline of a
        // sequence the plan had not touched, which an agent cannot tell from a
        // right answer.
        assert!(
            resolve_plan_sequence_id(&project.state, &plan).is_none(),
            "an import identifies no timeline, and the active one is not an answer"
        );
    }

    #[test]
    fn run_agent_plan_reports_and_records_where_the_plan_landed() {
        let dir = TempDir::new().expect("temp dir");
        let mut project = open_project(&dir);
        let sequence_id = project
            .state
            .active_sequence_id
            .clone()
            .expect("active sequence");

        let plan = plan_with(vec![
            add_marker_step("step-1", &sequence_id, 1.5),
            add_marker_step("step-2", &sequence_id, 6.0),
        ]);

        let result = run_agent_plan(&mut project, &plan, &NullPlanStepReporter, Instant::now())
            .expect("the plan applies");

        assert!(result.success, "{:?}", result.error_message);
        assert_eq!(result.sequence_id.as_deref(), Some(sequence_id.as_str()));
        // Two moments apart on the timeline: the union keeps them as two
        // ranges rather than one span covering the gap between them.
        assert_eq!(
            result
                .affected_ranges
                .iter()
                .map(|range| (range.start_sec, range.end_sec))
                .collect::<Vec<_>>(),
            vec![(1.5, 1.5), (6.0, 6.0)]
        );

        // The hand-off is what makes a later `--affected` inspection mean "the
        // last edit"; without it the in-app bridge could never use one.
        let record = crate::core::commands::load_last_affected_ranges(&project.path)
            .expect("a hand-off was written");
        assert_eq!(record.sequence_id, sequence_id);
        assert_eq!(record.op_ids, result.operation_ids);
        assert_eq!(record.affected_ranges, result.affected_ranges);
    }

    #[test]
    fn run_agent_plan_reports_no_ranges_when_the_plan_rolled_back_cleanly() {
        let dir = TempDir::new().expect("temp dir");
        let mut project = open_project(&dir);
        let sequence_id = project
            .state
            .active_sequence_id
            .clone()
            .expect("active sequence");

        let mut steps = vec![add_marker_step("step-1", &sequence_id, 1.5)];
        // Rejected by the payload parser, after the first step already applied.
        steps.push(PlanStep {
            id: "step-boom".to_string(),
            tool_name: "addTrack".to_string(),
            params: serde_json::json!({ "trackType": "not-a-track-type" }),
            description: "Invalid step".to_string(),
            risk_level: PlanRiskLevel::Low,
            depends_on: vec![],
            optional: false,
        });

        let result = run_agent_plan(
            &mut project,
            &plan_with(steps),
            &NullPlanStepReporter,
            Instant::now(),
        )
        .expect("a step failure is reported as a failed result");

        assert!(!result.success);
        let report = result.rollback_report.as_ref().expect("a rollback report");
        assert!(
            report.rollback_errors.is_empty(),
            "the rollback must be clean for this case: {:?}",
            report.rollback_errors
        );
        // Everything went back, so nothing on the timeline differs any more.
        // Sending an inspector to a frame that never changed is worse than
        // sending it nowhere.
        assert!(
            result.affected_ranges.is_empty(),
            "a clean rollback must report no ranges: {:?}",
            result.affected_ranges
        );
        // And the hand-off of whatever landed before must not be overwritten
        // by a plan that did not land.
        assert!(crate::core::commands::load_last_affected_ranges(&project.path).is_none());
    }

    #[test]
    fn run_agent_plan_rejects_an_over_cap_plan_before_running_any_step() {
        let dir = TempDir::new().expect("temp dir");
        let mut project = open_project(&dir);
        let sequence_id = project
            .state
            .active_sequence_id
            .clone()
            .expect("active sequence");
        let tracks_before = project.state.sequences[&sequence_id].tracks.len();

        let plan = plan_with(
            (0..=MAX_PLAN_STEPS)
                .map(|index| {
                    add_track_step(
                        &format!("step-{index}"),
                        &sequence_id,
                        &format!("Track {index}"),
                    )
                })
                .collect(),
        );
        let reporter = RecordingReporter::default();

        let error = run_agent_plan(&mut project, &plan, &reporter, Instant::now())
            .expect_err("an over-cap plan must be refused");

        assert!(
            error.contains(&MAX_PLAN_STEPS.to_string()),
            "the rejection must name the cap: {error}"
        );
        assert!(
            reporter.started.borrow().is_empty(),
            "no step may start when the plan is refused"
        );
        assert_eq!(
            project.state.sequences[&sequence_id].tracks.len(),
            tracks_before,
            "a refused plan must not mutate the project"
        );
        assert_eq!(project.executor.undo_count(), 0);
    }

    #[test]
    fn run_agent_plan_rolls_back_a_batch_longer_than_the_interactive_undo_cap() {
        let dir = TempDir::new().expect("temp dir");
        let mut project = open_project(&dir);
        let sequence_id = project
            .state
            .active_sequence_id
            .clone()
            .expect("active sequence");
        let tracks_before = project.state.sequences[&sequence_id].tracks.len();

        // Longer than DEFAULT_MAX_HISTORY_SIZE (100) so the undo stack would
        // evict the earliest steps without an explicit capacity bump.
        let applied_step_count = 150;
        let mut steps: Vec<PlanStep> = (0..applied_step_count)
            .map(|index| {
                add_track_step(
                    &format!("step-{index}"),
                    &sequence_id,
                    &format!("Track {index}"),
                )
            })
            .collect();
        // A step the payload parser rejects: it fails after everything before it
        // was already applied and persisted.
        steps.push(PlanStep {
            id: "step-boom".to_string(),
            tool_name: "addTrack".to_string(),
            params: serde_json::json!({ "trackType": "not-a-track-type" }),
            description: "Invalid step".to_string(),
            risk_level: PlanRiskLevel::Low,
            depends_on: vec![],
            optional: false,
        });

        let plan = plan_with(steps);
        let reporter = RecordingReporter::default();

        let result = run_agent_plan(&mut project, &plan, &reporter, Instant::now())
            .expect("a step failure is reported as a failed result, not an error");

        assert!(!result.success, "the plan must fail");
        assert_eq!(result.steps_completed, applied_step_count);
        assert_eq!(reporter.failed.borrow().as_slice(), ["step-boom"]);

        let report = result.rollback_report.expect("a rollback report");
        assert_eq!(
            report.succeeded_count, applied_step_count,
            "every applied step must unwind, not just the last {} \
             the interactive cap would hold",
            report.succeeded_count
        );
        assert!(
            report.rollback_errors.is_empty(),
            "rollback must complete cleanly: {:?}",
            report.rollback_errors
        );
        assert_eq!(
            project.state.sequences[&sequence_id].tracks.len(),
            tracks_before,
            "the project must be back where it started"
        );

        // Every applied op must be discarded from persisted history, otherwise
        // reopening the project resurrects the rolled-back work.
        let reopened = ActiveProject::open(dir.path().to_path_buf()).expect("reopen");
        assert_eq!(
            reopened.state.sequences[&sequence_id].tracks.len(),
            tracks_before,
            "rolled-back plan work must not survive a reopen"
        );
    }
}

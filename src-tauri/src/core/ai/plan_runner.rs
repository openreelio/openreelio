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
                };
            }
        };

        // Build and execute the command
        let command = typed_payload.build_command(&project_path);
        match project.executor.execute(command, &mut project.state) {
            Ok(cmd_result) => {
                let duration_ms = step_start.elapsed().as_millis() as u64;
                let op_id = cmd_result.op_id.clone();

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
                };
            }
        }
    }

    tracing::info!(
        plan_id = %plan_id,
        steps_completed = steps_completed,
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
    }
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

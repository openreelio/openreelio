//! Plan execution commands: execute, validate, template.
//!
//! Plans are JSON files containing a sequence of editing operations
//! that are executed atomically. If any step fails, the entire plan
//! is rolled back.
//!
//! `plan execute` validates the whole plan before it mutates anything, because
//! rolling a plan back is strictly more expensive than refusing it: every
//! applied step is already fsynced into the append-only ops log by the time the
//! next one fails.
//!
//! Exit codes for `plan execute`: `0` applied and saved, `1` the plan was
//! rejected or a step failed and the rollback completed cleanly, `2` the tool
//! could not run, the rollback was incomplete (`rollbackIncomplete: true`), or
//! the plan applied but could not be saved (`appliedNotSaved: true`).
//! `plan validate` and `plan template` keep reporting through JSON alone.

use crate::output;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Upper bound on the steps a single plan may carry.
///
/// Owned by core so every plan surface (CLI, MCP, backend `execute_agent_plan`
/// and the in-app `execute_plan` meta-tool) refuses the same plan size.
pub use openreelio_core::ai::MAX_PLAN_STEPS;

/// Exit code for a plan that was rejected, or failed and rolled back cleanly.
const EXIT_PLAN_FAILED: i32 = 1;

/// Exit code for a failure of the tool itself, an incomplete rollback, or a
/// plan that applied but could not be saved.
const EXIT_TOOL_FAILURE: i32 = 2;

#[derive(Subcommand)]
pub enum PlanAction {
    /// Execute a plan file atomically
    Execute {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Path to the plan JSON file
        #[arg(long)]
        file: PathBuf,
    },

    /// Validate a plan file without executing
    Validate {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Path to the plan JSON file
        #[arg(long)]
        file: PathBuf,
    },

    /// Build a plan that cuts an asset to a curated pacing profile
    FromProfile {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Pacing profile id (see `packs list --kind pacing`)
        #[arg(long)]
        profile: String,

        /// Asset to cut; must already have a cached analysis bundle
        #[arg(long)]
        asset: String,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,

        /// Name for the track the plan creates
        #[arg(long)]
        track_name: Option<String>,

        /// Write the plan JSON to this file as well as stdout
        #[arg(long)]
        out: Option<PathBuf>,
    },

    /// Generate a plan template
    Template {
        /// Template type (e.g., split-and-move, multi-trim)
        ///
        /// `--template-type` stays accepted as a hidden alias: it was the flag
        /// this command actually shipped while the docs advertised `--type`.
        #[arg(long = "type", alias = "template-type")]
        template_type: String,
    },
}

/// A single step in an edit plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    /// Unique step identifier
    pub id: String,
    /// Command type (e.g., "SplitClip", "MoveClip")
    pub command_type: String,
    /// Command payload (JSON matching the IPC payload format)
    pub payload: serde_json::Value,
    /// Step IDs that must complete before this step
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// An edit plan containing multiple steps.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPlan {
    /// Plan identifier
    pub id: String,
    /// Ordered list of steps
    pub steps: Vec<PlanStep>,
}

pub fn execute(action: PlanAction) -> anyhow::Result<()> {
    match action {
        // Only `execute` mutates, so only `execute` carries the exit-code
        // contract; the read-only verbs keep reporting through JSON alone.
        PlanAction::Execute { path, file } => match run_execute(&path, &file) {
            Ok(0) => Ok(()),
            Ok(exit_code) => {
                flush_stdout();
                std::process::exit(exit_code)
            }
            Err(error) => {
                flush_stdout();
                eprintln!("error: {error}");
                std::process::exit(EXIT_TOOL_FAILURE)
            }
        },

        PlanAction::Validate { path, file } => {
            let plan = read_plan(&file)?;

            let _project = super::load_project(&path)?;

            let errors = validate_edit_plan(&plan);

            if errors.is_empty() {
                output::print_json(&serde_json::json!({
                    "status": "ok",
                    "message": "Plan is valid",
                    "planId": plan.id,
                    "stepCount": plan.steps.len(),
                }))
            } else {
                output::print_json(&serde_json::json!({
                    "status": "error",
                    "message": "Plan validation failed",
                    "errors": errors,
                }))
            }
        }

        PlanAction::FromProfile {
            path,
            profile,
            asset,
            sequence,
            track_name,
            out,
        } => run_from_profile(
            &path,
            &profile,
            &asset,
            sequence,
            track_name,
            out.as_deref(),
        ),

        PlanAction::Template { template_type } => {
            let template = match template_type.as_str() {
                "split-and-move" => serde_json::json!({
                    "id": "plan_001",
                    "steps": [
                        {
                            "id": "step_1",
                            "commandType": "SplitClip",
                            "payload": {
                                "sequenceId": "<SEQUENCE_ID>",
                                "trackId": "<TRACK_ID>",
                                "clipId": "<CLIP_ID>",
                                "splitTime": 5.0
                            },
                            "dependsOn": []
                        },
                        {
                            "id": "step_2",
                            "commandType": "MoveClip",
                            "payload": {
                                "sequenceId": "<SEQUENCE_ID>",
                                "trackId": "<TRACK_ID>",
                                "clipId": "<CLIP_ID_RIGHT>",
                                "newTimelineIn": 10.0
                            },
                            "dependsOn": ["step_1"]
                        }
                    ]
                }),
                "multi-trim" => serde_json::json!({
                    "id": "plan_002",
                    "steps": [
                        {
                            "id": "step_1",
                            "commandType": "TrimClip",
                            "payload": {
                                "sequenceId": "<SEQUENCE_ID>",
                                "trackId": "<TRACK_ID>",
                                "clipId": "<CLIP_ID>",
                                "newSourceIn": 2.0,
                                "newSourceOut": 8.0
                            },
                            "dependsOn": []
                        }
                    ]
                }),
                _ => {
                    return Err(anyhow::anyhow!(
                        "Unknown template type '{}'. Available: split-and-move, multi-trim",
                        template_type
                    ));
                }
            };

            output::print_json_pretty(&template)
        }
    }
}

/// Builds a plan that cuts one asset to a curated pacing profile.
///
/// Deliberately does not execute. A pacing profile is a taste decision, and the
/// point of writing it down as a plan is that it can be read, edited, and
/// diffed before it changes anything — `plan validate` then `plan execute` are
/// the next two steps, and both take the file this writes.
fn run_from_profile(
    path: &PathBuf,
    profile_id: &str,
    asset_id: &str,
    sequence: Option<String>,
    track_name: Option<String>,
    out: Option<&Path>,
) -> anyhow::Result<()> {
    use openreelio_core::analysis::style_planner::{StylePlanner, StylePlanningContext};
    use openreelio_core::analysis::AnalysisJobRunner;
    use openreelio_core::style::resolve_pacing_profile;

    let project_dir = std::fs::canonicalize(path)
        .map_err(|e| anyhow::anyhow!("Project path '{}' not found: {}", path.display(), e))?;
    let project = super::load_project(&project_dir)?;
    let sequence_id = super::resolve_sequence_id(&project, sequence)?;

    let profile = resolve_pacing_profile(profile_id).map_err(|error| anyhow::anyhow!(error))?;

    if !project.state.assets.contains_key(asset_id) {
        return Err(anyhow::anyhow!(
            "Asset '{}' is not in this project. List them with `openreelio-cli asset list --path {}`",
            asset_id,
            path.display()
        ));
    }

    let bundle = AnalysisJobRunner::new(&project_dir)
        .load_bundle_optional(asset_id)
        .map_err(|error| anyhow::anyhow!("Failed to read the analysis bundle: {}", error))?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "No cached analysis for asset '{}'. A pacing plan needs the source duration, and \
                 shot boundaries if the profile respects them: run `openreelio-cli analysis run \
                 --path {} --id {}` first",
                asset_id,
                path.display(),
                asset_id
            )
        })?;

    let mut context = StylePlanningContext::new(&sequence_id, asset_id);
    if let Some(track_name) = track_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        context = context.with_track_name(track_name);
    } else {
        context = context.with_track_name(format!("Pacing: {}", profile.id));
    }

    let planned = StylePlanner::plan_from_profile(profile, &bundle, &context)
        .map_err(|error| anyhow::anyhow!("Failed to plan from profile: {}", error))?;

    let plan = edit_plan_from_agent_plan(&planned.plan);
    let errors = validate_edit_plan(&plan);

    if let Some(out) = out {
        let serialized = serde_json::to_string_pretty(&plan)
            .map_err(|error| anyhow::anyhow!("Failed to serialize plan: {}", error))?;
        std::fs::write(out, serialized).map_err(|error| {
            anyhow::anyhow!("Failed to write plan to '{}': {}", out.display(), error)
        })?;
    }

    let cut_count = plan
        .steps
        .iter()
        .filter(|step| step.command_type == "SplitClip")
        .count();
    let transition_count = plan
        .steps
        .iter()
        .filter(|step| step.command_type == "AddEffect")
        .count();

    output::print_json_pretty(&serde_json::json!({
        "status": if errors.is_empty() { "ok" } else { "error" },
        "planId": plan.id,
        "profile": profile.id,
        "assetId": asset_id,
        "sequenceId": sequence_id,
        "stepCount": plan.steps.len(),
        "cutCount": cut_count,
        "transitionCount": transition_count,
        "transitionRecipe": profile.transition_recipe,
        "fidelityScore": planned.compatibility_score,
        "warnings": planned.warnings,
        "errors": errors,
        "outputPath": out.map(|out| out.display().to_string()),
        "plan": plan,
    }))
}

/// Converts a planner [`AgentPlan`] into the plan-file shape.
///
/// The two differ only in what the step's command is called: the planner
/// carries it as `toolName`, the plan file as `commandType`. No translation
/// table is needed because `CommandPayload` accepts both the camelCase and
/// PascalCase spelling of every variant through its serde aliases, and the
/// planner already emits the PascalCase one.
fn edit_plan_from_agent_plan(plan: &openreelio_core::ai::AgentPlan) -> EditPlan {
    EditPlan {
        id: plan.id.clone(),
        steps: plan
            .steps
            .iter()
            .map(|step| PlanStep {
                id: step.id.clone(),
                command_type: step.tool_name.clone(),
                payload: step.params.clone(),
                depends_on: step.depends_on.clone(),
            })
            .collect(),
    }
}

/// Reads and deserializes a plan file.
fn read_plan(file: &Path) -> anyhow::Result<EditPlan> {
    let plan_content = std::fs::read_to_string(file)
        .map_err(|e| anyhow::anyhow!("Failed to read plan file '{}': {}", file.display(), e))?;
    serde_json::from_str(&plan_content).map_err(|e| anyhow::anyhow!("Invalid plan JSON: {}", e))
}

/// Validates and applies the plan, prints the report, returns the exit code.
///
/// Returning `Err` is reserved for failures that happen *before* anything is
/// applied — an unreadable plan file, a project that will not open. Every
/// outcome that touched the project reports through `Ok` with a non-zero code,
/// including a plan that applied but could not be saved: a bare `Err` there
/// would leave stdout empty and invite the caller to retry work that is already
/// durable. stdout therefore carries exactly one JSON object whenever the
/// project was mutated.
fn run_execute(path: &PathBuf, file: &Path) -> anyhow::Result<i32> {
    let plan = read_plan(file)?;
    let mut project = super::load_project(path)?;

    // Nothing is mutated until the whole plan is known to be sound. A payload
    // that only fails when its step is reached takes the project through a
    // rollback it never needed to risk.
    let validation_errors = validate_edit_plan(&plan);
    if !validation_errors.is_empty() {
        output::print_json(&serde_json::json!({
            "status": "error",
            "message": "Plan validation failed",
            "planId": plan.id,
            "errors": validation_errors,
        }))?;
        return Ok(EXIT_PLAN_FAILED);
    }

    let mut result = apply_edit_plan(&mut project, &plan)?;
    if result["status"] == "ok" {
        if let Err(save_error) = super::save_project(&mut project) {
            result = applied_not_saved_report(&plan, &result, &save_error);
        }
    }

    let exit_code = plan_exit_code(&result);
    output::print_json(&result)?;
    Ok(exit_code)
}

/// Report for a plan whose steps all applied but whose save failed.
///
/// Every step is already fsynced into the append-only ops log by the time the
/// save runs, so the plan is durably applied whether or not the snapshot caught
/// up — the next open folds those ops back in. Discarding them is not on the
/// table either: they are legitimately applied truth, and the discard writes
/// through the same handle that just failed. What the caller needs instead is
/// to be told, in the report rather than in an empty stdout, that re-running
/// the plan would apply it twice.
fn applied_not_saved_report(
    plan: &EditPlan,
    applied: &serde_json::Value,
    save_error: &anyhow::Error,
) -> serde_json::Value {
    serde_json::json!({
        "status": "error",
        "message": format!(
            "Plan applied but the project could not be saved: {save_error}. \
             Every step is already in the operations log and will be present on \
             the next open — do NOT re-run this plan."
        ),
        "planId": plan.id,
        "appliedNotSaved": true,
        "stepsApplied": applied["stepsExecuted"].clone(),
        "error": save_error.to_string(),
        "stepResults": applied["stepResults"].clone(),
    })
}

/// Maps an [`apply_edit_plan`] report onto the process exit code.
fn plan_exit_code(result: &serde_json::Value) -> i32 {
    if result["status"] == "ok" {
        0
    } else if result["rollbackIncomplete"] == serde_json::Value::Bool(true)
        || result["appliedNotSaved"] == serde_json::Value::Bool(true)
    {
        // The project is not where any further command would assume it is —
        // either not back at the start, or applied without a current snapshot —
        // so this is a tool failure rather than a rejected plan.
        EXIT_TOOL_FAILURE
    } else {
        EXIT_PLAN_FAILED
    }
}

fn flush_stdout() {
    let _ = std::io::stdout().flush();
}

/// Stand-in value a `$fromStep` reference takes while a plan is validated.
///
/// The real value does not exist until the referenced step runs, but the rest
/// of the payload still has to be checked before anything is mutated. A
/// placeholder of the right JSON type lets `CommandPayload::parse` reject a
/// misspelled field or a missing one, and only leaves the referenced value
/// itself unchecked — which is exactly the part that cannot be known yet.
const STEP_REFERENCE_PLACEHOLDER: &str = "$fromStep";

/// Collects the step ids a payload references through `$fromStep`.
fn collect_step_references(payload: &serde_json::Value, found: &mut Vec<String>) {
    match payload {
        serde_json::Value::Object(map) => {
            if let (Some(from_step), Some(_)) = (map.get("$fromStep"), map.get("$path")) {
                if let Some(step_id) = from_step.as_str() {
                    found.push(step_id.to_string());
                }
                return;
            }
            for value in map.values() {
                collect_step_references(value, found);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_step_references(item, found);
            }
        }
        _ => {}
    }
}

/// Replaces every `$fromStep` reference with [`STEP_REFERENCE_PLACEHOLDER`].
fn substitute_step_references(payload: &serde_json::Value) -> serde_json::Value {
    match payload {
        serde_json::Value::Object(map) => {
            if map.contains_key("$fromStep") && map.contains_key("$path") {
                return serde_json::Value::String(STEP_REFERENCE_PLACEHOLDER.to_string());
            }
            serde_json::Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), substitute_step_references(value)))
                    .collect(),
            )
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(substitute_step_references).collect())
        }
        other => other.clone(),
    }
}

/// Returns every step id reachable from `step_id` through `dependsOn`.
fn dependency_closure<'a>(step_id: &str, steps: &'a [PlanStep]) -> HashSet<&'a str> {
    let by_id: HashMap<&str, &PlanStep> = steps.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut closure = HashSet::new();
    let mut pending: Vec<&str> = by_id
        .get(step_id)
        .map(|step| step.depends_on.iter().map(String::as_str).collect())
        .unwrap_or_default();

    while let Some(current) = pending.pop() {
        let Some(step) = by_id.get(current) else {
            continue;
        };
        if !closure.insert(step.id.as_str()) {
            continue;
        }
        pending.extend(step.depends_on.iter().map(String::as_str));
    }

    closure
}

pub(crate) fn validate_edit_plan(plan: &EditPlan) -> Vec<String> {
    let mut step_ids = HashSet::new();
    let mut errors = Vec::new();

    if plan.id.trim().is_empty() {
        errors.push("plan.id is required".to_string());
    }

    if plan.steps.len() > MAX_PLAN_STEPS {
        errors.push(format!(
            "Plan has {} steps, which exceeds the maximum of {}",
            plan.steps.len(),
            MAX_PLAN_STEPS
        ));
    }

    for step in &plan.steps {
        if step.id.trim().is_empty() {
            errors.push("Every step must include id".to_string());
        }
    }

    for step in &plan.steps {
        if !step_ids.insert(step.id.as_str()) {
            errors.push(format!("Duplicate step id '{}'", step.id));
        }
    }

    for step in &plan.steps {
        for dep in &step.depends_on {
            if !step_ids.contains(dep.as_str()) {
                errors.push(format!(
                    "Step '{}' depends on '{}' which does not exist",
                    step.id, dep
                ));
            }
        }

        // A `$fromStep` value only exists once the step it names has run, so
        // the reference has to be ordered behind that step. `dependsOn` is the
        // only thing that orders anything here: without the edge, the
        // topological sort is free to run the reader first.
        let mut references = Vec::new();
        collect_step_references(&step.payload, &mut references);
        if !references.is_empty() {
            let reachable = dependency_closure(&step.id, &plan.steps);
            for reference in &references {
                if !step_ids.contains(reference.as_str()) {
                    errors.push(format!(
                        "Step '{}' references '{}' which does not exist",
                        step.id, reference
                    ));
                } else if !reachable.contains(reference.as_str()) {
                    errors.push(format!(
                        "Step '{}' references '{}' without depending on it, so it may run first",
                        step.id, reference
                    ));
                }
            }
        }

        if let Err(error) = openreelio_core::ipc::CommandPayload::parse(
            step.command_type.clone(),
            substitute_step_references(&step.payload),
        ) {
            errors.push(format!(
                "Step '{}' has invalid command payload for '{}': {}",
                step.id, step.command_type, error
            ));
        }
    }

    if let Err(cycle_err) = topological_sort(&plan.steps) {
        errors.push(cycle_err.to_string());
    }

    errors
}

pub(crate) fn apply_edit_plan(
    project: &mut openreelio_core::ActiveProject,
    plan: &EditPlan,
) -> anyhow::Result<serde_json::Value> {
    let mut results = Vec::new();
    let mut succeeded = 0;
    let mut applied_op_ids: Vec<String> = Vec::new();

    // Rollback unwinds the executor's in-memory undo stack, and that stack is
    // capped for interactive use — far below the plan step cap. Without this,
    // a plan that fails deep enough has already had its earliest steps evicted
    // and could not undo them.
    project.executor.ensure_history_capacity(plan.steps.len());

    // `$fromStep` reads out of this as the plan runs. A step's ids are not
    // knowable until it has executed, which is the whole reason a plan that
    // creates a track and then fills it has to be one plan rather than three
    // round trips through `timeline tracks`.
    let mut step_results: HashMap<String, openreelio_core::ai::StepResult> = HashMap::new();

    let sorted_steps = topological_sort(&plan.steps)?;
    for step in sorted_steps {
        match execute_step(project, step, &step_results) {
            Ok(result) => {
                results.push(serde_json::json!({
                    "stepId": step.id,
                    "status": "ok",
                    "opId": result.op_id,
                    "createdIds": result.created_ids,
                    "deletedIds": result.deleted_ids,
                }));
                step_results.insert(
                    step.id.clone(),
                    openreelio_core::ai::StepResult {
                        step_id: step.id.clone(),
                        success: true,
                        data: Some(serde_json::json!({
                            "opId": result.op_id,
                            "createdIds": result.created_ids,
                            "deletedIds": result.deleted_ids,
                        })),
                        error: None,
                        duration_ms: 0,
                        operation_id: Some(result.op_id.clone()),
                    },
                );
                applied_op_ids.push(result.op_id);
                succeeded += 1;
            }
            Err(e) => {
                results.push(serde_json::json!({
                    "stepId": step.id,
                    "status": "error",
                    "error": e.to_string(),
                }));
                let mut rollback_failures = Vec::new();
                for _ in 0..succeeded {
                    if let Err(undo_err) = project.executor.undo(&mut project.state) {
                        rollback_failures.push(undo_err.to_string());
                    }
                }

                // Undo only unwinds memory. `execute` already fsynced an op for
                // every step that succeeded, and skipping the save does not
                // remove them: the next open folds those durable entries back
                // in as new user edits and the rollback reverts itself. Marking
                // them discarded is what makes the rollback stick.
                if !applied_op_ids.is_empty() {
                    match project.discard_persisted_operations(&applied_op_ids) {
                        // A protected operation stays applied and comes back on
                        // the next open, so the project is not where it started.
                        // Reporting that as a clean rollback would be a lie the
                        // caller cannot check.
                        Ok(still_applied) if !still_applied.is_empty() => {
                            rollback_failures.push(format!(
                                "Rollback could not discard protected operation(s) [{}]: they stay \
                                 in the project's applied history and will be present on the next open",
                                still_applied.join(", ")
                            ));
                        }
                        Ok(_) => {}
                        Err(discard_error) => {
                            rollback_failures.push(format!(
                                "Failed to discard rolled-back operations from persisted history: {discard_error}"
                            ));
                        }
                    }
                }

                return Ok(serde_json::json!({
                    "status": "error",
                    "message": format!("Plan failed at step '{}': {}", step.id, e),
                    "planId": plan.id,
                    "failedStep": step.id,
                    "error": e.to_string(),
                    "rolledBack": succeeded,
                    "rollbackIncomplete": !rollback_failures.is_empty(),
                    "rollbackFailures": rollback_failures,
                    "stepResults": results,
                }));
            }
        }
    }

    Ok(serde_json::json!({
        "status": "ok",
        "planId": plan.id,
        "stepsExecuted": succeeded,
        "stepResults": results,
    }))
}

/// Execute a single plan step by dispatching to the appropriate command.
fn execute_step(
    project: &mut openreelio_core::ActiveProject,
    step: &PlanStep,
    step_results: &HashMap<String, openreelio_core::ai::StepResult>,
) -> anyhow::Result<openreelio_core::commands::CommandResult> {
    let resolved_payload =
        openreelio_core::ai::resolve_step_references(&step.payload, step_results).map_err(
            |error| anyhow::anyhow!("Cannot resolve references in step '{}': {}", step.id, error),
        )?;

    let typed_payload =
        openreelio_core::ipc::CommandPayload::parse(step.command_type.clone(), resolved_payload)
            .map_err(|error| {
                anyhow::anyhow!("Invalid command '{}': {}", step.command_type, error)
            })?;
    let cmd = typed_payload.build_command(&project.path);

    project
        .executor
        .execute(cmd, &mut project.state)
        .map_err(|e| anyhow::anyhow!("Command '{}' failed: {}", step.command_type, e))
}

/// Sort plan steps in dependency order (Kahn's algorithm).
/// Returns an error if the dependency graph contains a cycle.
fn topological_sort(steps: &[PlanStep]) -> anyhow::Result<Vec<&PlanStep>> {
    let step_map: HashMap<&str, &PlanStep> = steps.iter().map(|s| (s.id.as_str(), s)).collect();
    let mut in_degree: HashMap<&str, usize> = steps.iter().map(|s| (s.id.as_str(), 0)).collect();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();

    for step in steps {
        for dep in &step.depends_on {
            if let Some(deg) = in_degree.get_mut(dep.as_str()) {
                let _ = deg; // dep exists
            }
            dependents.entry(dep.as_str()).or_default().push(&step.id);
            if let Some(d) = in_degree.get_mut(step.id.as_str()) {
                *d += 1;
            }
        }
    }

    let mut queue: VecDeque<&str> = in_degree
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(&id, _)| id)
        .collect();
    let mut sorted = Vec::new();

    while let Some(id) = queue.pop_front() {
        if let Some(&step) = step_map.get(id) {
            sorted.push(step);
        }
        if let Some(deps) = dependents.get(id) {
            for &dep_id in deps {
                if let Some(deg) = in_degree.get_mut(dep_id) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(dep_id);
                    }
                }
            }
        }
    }

    if sorted.len() != steps.len() {
        return Err(anyhow::anyhow!("Cycle detected in plan step dependencies"));
    }
    Ok(sorted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, depends_on: &[&str]) -> PlanStep {
        PlanStep {
            id: id.to_string(),
            command_type: "AddTrack".to_string(),
            payload: serde_json::json!({
                "sequenceId": "sequence-1",
                "name": id,
                "kind": "video"
            }),
            depends_on: depends_on.iter().map(|d| d.to_string()).collect(),
        }
    }

    fn plan(steps: Vec<PlanStep>) -> EditPlan {
        EditPlan {
            id: "plan-1".to_string(),
            steps,
        }
    }

    /// An `InsertClip` step whose track comes from another step's result.
    fn step_referencing_track(id: &str, referenced: &str, depends_on: &[&str]) -> PlanStep {
        PlanStep {
            id: id.to_string(),
            command_type: "InsertClip".to_string(),
            payload: serde_json::json!({
                "sequenceId": "sequence-1",
                "trackId": { "$fromStep": referenced, "$path": "createdIds.0" },
                "assetId": "asset-1",
                "timelineStart": 0.0,
            }),
            depends_on: depends_on.iter().map(|d| d.to_string()).collect(),
        }
    }

    #[test]
    fn should_accept_a_sound_plan() {
        assert!(validate_edit_plan(&plan(vec![step("a", &[]), step("b", &["a"])])).is_empty());
    }

    #[test]
    fn should_accept_a_reference_to_a_step_it_depends_on() {
        let errors = validate_edit_plan(&plan(vec![
            step("a", &[]),
            step_referencing_track("b", "a", &["a"]),
        ]));

        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn should_accept_a_reference_reached_through_the_dependency_chain() {
        // `c` never names `a` directly, but `b` does, so `a` still runs first.
        let errors = validate_edit_plan(&plan(vec![
            step("a", &[]),
            step("b", &["a"]),
            step_referencing_track("c", "a", &["b"]),
        ]));

        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn should_reject_a_reference_to_a_step_that_does_not_exist() {
        let errors = validate_edit_plan(&plan(vec![step_referencing_track("b", "ghost", &[])]));

        assert!(
            errors
                .iter()
                .any(|error| error.contains("ghost") && error.contains("does not exist")),
            "{errors:?}"
        );
    }

    #[test]
    fn should_reject_a_reference_the_plan_does_not_order() {
        // Both steps exist, but nothing forces `a` to run before `b`.
        let errors = validate_edit_plan(&plan(vec![
            step("a", &[]),
            step_referencing_track("b", "a", &[]),
        ]));

        assert!(
            errors
                .iter()
                .any(|error| error.contains("without depending on it")),
            "{errors:?}"
        );
    }

    #[test]
    fn should_still_type_check_a_payload_that_carries_references() {
        let mut broken = step_referencing_track("b", "a", &["a"]);
        broken.payload["nonsenseField"] = serde_json::json!(true);

        let errors = validate_edit_plan(&plan(vec![step("a", &[]), broken]));

        assert!(
            errors
                .iter()
                .any(|error| error.contains("invalid command payload")),
            "a reference must not shield the rest of the payload: {errors:?}"
        );
    }

    #[test]
    fn should_reject_a_plan_over_the_step_cap() {
        let steps = (0..=MAX_PLAN_STEPS)
            .map(|index| step(&format!("step-{index}"), &[]))
            .collect();

        let errors = validate_edit_plan(&plan(steps));

        assert!(
            errors.iter().any(
                |error| error.contains(&format!("{} steps", MAX_PLAN_STEPS + 1))
                    && error.contains(&MAX_PLAN_STEPS.to_string())
            ),
            "the error must state the cap and the offending count: {errors:?}"
        );
    }

    #[test]
    fn should_accept_a_plan_exactly_at_the_step_cap() {
        let steps = (0..MAX_PLAN_STEPS)
            .map(|index| step(&format!("step-{index}"), &[]))
            .collect();

        assert!(validate_edit_plan(&plan(steps)).is_empty());
    }

    #[test]
    fn should_require_plan_and_step_ids() {
        let mut candidate = plan(vec![step("", &[])]);
        candidate.id = "  ".to_string();

        let errors = validate_edit_plan(&candidate);

        assert!(errors.iter().any(|error| error == "plan.id is required"));
        assert!(errors
            .iter()
            .any(|error| error == "Every step must include id"));
    }

    #[test]
    fn should_report_cycles_duplicates_and_missing_dependencies() {
        let errors = validate_edit_plan(&plan(vec![
            step("a", &["b"]),
            step("b", &["a"]),
            step("b", &[]),
            step("c", &["ghost"]),
        ]));

        assert!(errors.iter().any(|error| error.contains("Cycle detected")));
        assert!(errors
            .iter()
            .any(|error| error.contains("Duplicate step id 'b'")));
        assert!(errors
            .iter()
            .any(|error| error.contains("'ghost'") && error.contains("does not exist")));
    }

    #[test]
    fn should_reject_a_step_whose_payload_cannot_parse() {
        let mut broken = step("a", &[]);
        broken.payload = serde_json::json!({ "sequenceId": "sequence-1", "kind": "not-a-kind" });

        let errors = validate_edit_plan(&plan(vec![broken]));

        assert!(errors
            .iter()
            .any(|error| error.contains("Step 'a' has invalid command payload")));
    }

    #[test]
    fn should_map_an_applied_plan_to_the_success_exit_code() {
        assert_eq!(
            plan_exit_code(&serde_json::json!({ "status": "ok", "stepsExecuted": 2 })),
            0
        );
    }

    #[test]
    fn should_map_a_clean_rollback_to_the_plan_failure_exit_code() {
        assert_eq!(
            plan_exit_code(&serde_json::json!({
                "status": "error",
                "rollbackIncomplete": false,
                "rollbackFailures": [],
            })),
            EXIT_PLAN_FAILED
        );
    }

    #[test]
    fn should_map_an_incomplete_rollback_to_the_tool_failure_exit_code() {
        assert_eq!(
            plan_exit_code(&serde_json::json!({
                "status": "error",
                "rollbackIncomplete": true,
                "rollbackFailures": ["undo failed"],
            })),
            EXIT_TOOL_FAILURE
        );
    }

    #[test]
    fn should_map_an_applied_but_unsaved_plan_to_the_tool_failure_exit_code() {
        assert_eq!(
            plan_exit_code(&serde_json::json!({
                "status": "error",
                "appliedNotSaved": true,
            })),
            EXIT_TOOL_FAILURE
        );
    }

    #[test]
    fn should_report_an_applied_but_unsaved_plan_without_inviting_a_retry() {
        let applied = serde_json::json!({
            "status": "ok",
            "planId": "plan-1",
            "stepsExecuted": 2,
            "stepResults": [{ "stepId": "a" }, { "stepId": "b" }],
        });

        let report = applied_not_saved_report(
            &plan(vec![step("a", &[]), step("b", &["a"])]),
            &applied,
            &anyhow::anyhow!("disk is full"),
        );

        assert_eq!(report["status"], "error");
        assert_eq!(report["appliedNotSaved"], true);
        assert_eq!(report["stepsApplied"], 2);
        assert_eq!(report["planId"], "plan-1");
        assert_eq!(report["stepResults"], applied["stepResults"]);
        let message = report["message"].as_str().unwrap();
        assert!(message.contains("disk is full"), "{message}");
        assert!(
            message.contains("do NOT re-run this plan"),
            "the report has to say the work is already durable: {message}"
        );
    }
}

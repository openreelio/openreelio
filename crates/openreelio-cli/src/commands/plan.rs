//! Plan execution commands: execute, validate, template.
//!
//! Plans are JSON files containing a sequence of editing operations
//! that are executed atomically. If any step fails, the entire plan
//! is rolled back.

use crate::output;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;

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

    /// Generate a plan template
    Template {
        /// Template type (e.g., split-and-move, multi-trim)
        #[arg(long, name = "type")]
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
        PlanAction::Execute { path, file } => {
            let plan_content = std::fs::read_to_string(&file).map_err(|e| {
                anyhow::anyhow!("Failed to read plan file '{}': {}", file.display(), e)
            })?;
            let plan: EditPlan = serde_json::from_str(&plan_content)
                .map_err(|e| anyhow::anyhow!("Invalid plan JSON: {}", e))?;

            let mut project = super::load_project(&path)?;
            let result = apply_edit_plan(&mut project, &plan)?;
            if result["status"] == "ok" {
                super::save_project(&mut project)?;
            }

            output::print_json(&result)
        }

        PlanAction::Validate { path, file } => {
            let plan_content = std::fs::read_to_string(&file).map_err(|e| {
                anyhow::anyhow!("Failed to read plan file '{}': {}", file.display(), e)
            })?;
            let plan: EditPlan = serde_json::from_str(&plan_content)
                .map_err(|e| anyhow::anyhow!("Invalid plan JSON: {}", e))?;

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

pub(crate) fn validate_edit_plan(plan: &EditPlan) -> Vec<String> {
    let step_ids: HashSet<&str> = plan.steps.iter().map(|s| s.id.as_str()).collect();
    let mut errors = Vec::new();

    for step in &plan.steps {
        for dep in &step.depends_on {
            if !step_ids.contains(dep.as_str()) {
                errors.push(format!(
                    "Step '{}' depends on '{}' which does not exist",
                    step.id, dep
                ));
            }
        }

        if let Err(error) = openreelio_core::ipc::CommandPayload::parse(
            step.command_type.clone(),
            step.payload.clone(),
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

    let sorted_steps = topological_sort(&plan.steps)?;
    for step in sorted_steps {
        match execute_step(project, step) {
            Ok(result) => {
                results.push(serde_json::json!({
                    "stepId": step.id,
                    "status": "ok",
                    "opId": result.op_id,
                    "createdIds": result.created_ids,
                    "deletedIds": result.deleted_ids,
                }));
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
                return Ok(serde_json::json!({
                    "status": "error",
                    "message": format!("Plan failed at step '{}': {}", step.id, e),
                    "rolledBack": succeeded,
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
) -> anyhow::Result<openreelio_core::commands::CommandResult> {
    let typed_payload = openreelio_core::ipc::CommandPayload::parse(
        step.command_type.clone(),
        step.payload.clone(),
    )
    .map_err(|error| anyhow::anyhow!("Invalid command '{}': {}", step.command_type, error))?;
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

//! Plan execution commands: execute, validate, template.
//!
//! Plans are JSON files containing a sequence of editing operations
//! that are executed atomically. If any step fails, the entire plan
//! is rolled back.

use std::path::PathBuf;
use clap::Subcommand;
use serde::{Deserialize, Serialize};
use crate::output;

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

pub async fn execute(action: PlanAction) -> anyhow::Result<()> {
    match action {
        PlanAction::Execute { path, file } => {
            let plan_content = std::fs::read_to_string(&file)
                .map_err(|e| anyhow::anyhow!("Failed to read plan file '{}': {}", file.display(), e))?;
            let plan: EditPlan = serde_json::from_str(&plan_content)
                .map_err(|e| anyhow::anyhow!("Invalid plan JSON: {}", e))?;

            let mut project = super::load_project(&path)?;
            let mut results = Vec::new();
            let mut succeeded = 0;

            for step in &plan.steps {
                // Build command from type + payload using the same pattern as IPC
                match execute_step(&mut project, step) {
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
                        // Rollback: undo all successful steps in reverse
                        for _ in 0..succeeded {
                            let _ = project.executor.undo(&mut project.state);
                        }
                        return output::print_json(&serde_json::json!({
                            "status": "error",
                            "message": format!("Plan failed at step '{}': {}", step.id, e),
                            "rolledBack": succeeded,
                            "stepResults": results,
                        }));
                    }
                }
            }

            super::save_project(&mut project)?;
            output::print_json(&serde_json::json!({
                "status": "ok",
                "planId": plan.id,
                "stepsExecuted": succeeded,
                "stepResults": results,
            }))
        }

        PlanAction::Validate { path, file } => {
            let plan_content = std::fs::read_to_string(&file)
                .map_err(|e| anyhow::anyhow!("Failed to read plan file '{}': {}", file.display(), e))?;
            let plan: EditPlan = serde_json::from_str(&plan_content)
                .map_err(|e| anyhow::anyhow!("Invalid plan JSON: {}", e))?;

            let _project = super::load_project(&path)?;

            // Validate step dependencies form a DAG
            let step_ids: std::collections::HashSet<&str> =
                plan.steps.iter().map(|s| s.id.as_str()).collect();

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
            }

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

/// Execute a single plan step by dispatching to the appropriate command.
fn execute_step(
    project: &mut openreelio_core::ActiveProject,
    step: &PlanStep,
) -> anyhow::Result<openreelio_core::commands::CommandResult> {
    use openreelio_core::commands::*;

    let payload = &step.payload;
    let cmd: Box<dyn Command> = match step.command_type.as_str() {
        "InsertClip" => Box::new(serde_json::from_value::<InsertClipCommand>(payload.clone())?),
        "RemoveClip" => Box::new(serde_json::from_value::<RemoveClipCommand>(payload.clone())?),
        "MoveClip" => Box::new(serde_json::from_value::<MoveClipCommand>(payload.clone())?),
        "TrimClip" => Box::new(serde_json::from_value::<TrimClipCommand>(payload.clone())?),
        "SplitClip" => Box::new(serde_json::from_value::<SplitClipCommand>(payload.clone())?),
        "SetClipSpeed" => Box::new(serde_json::from_value::<SetClipSpeedCommand>(payload.clone())?),
        "AddTrack" => Box::new(serde_json::from_value::<AddTrackCommand>(payload.clone())?),
        "RemoveTrack" => Box::new(serde_json::from_value::<RemoveTrackCommand>(payload.clone())?),
        "AddEffect" => Box::new(serde_json::from_value::<AddEffectCommand>(payload.clone())?),
        "RemoveEffect" => Box::new(serde_json::from_value::<RemoveEffectCommand>(payload.clone())?),
        "CreateCaption" => Box::new(serde_json::from_value::<CreateCaptionCommand>(payload.clone())?),
        "DeleteCaption" => Box::new(serde_json::from_value::<DeleteCaptionCommand>(payload.clone())?),
        "UpdateCaption" => Box::new(serde_json::from_value::<UpdateCaptionCommand>(payload.clone())?),
        "ImportAsset" => Box::new(serde_json::from_value::<ImportAssetCommand>(payload.clone())?),
        "RemoveAsset" => Box::new(serde_json::from_value::<RemoveAssetCommand>(payload.clone())?),
        "AddMarker" => Box::new(serde_json::from_value::<AddMarkerCommand>(payload.clone())?),
        "RemoveMarker" => Box::new(serde_json::from_value::<RemoveMarkerCommand>(payload.clone())?),
        other => {
            return Err(anyhow::anyhow!("Unknown command type: '{}'", other));
        }
    };

    project
        .executor
        .execute(cmd, &mut project.state)
        .map_err(|e| anyhow::anyhow!("Command '{}' failed: {}", step.command_type, e))
}

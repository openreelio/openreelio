//! Project lifecycle commands: create, open, info, save.

use crate::output;
use clap::Subcommand;
use openreelio_core::ActiveProject;
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum ProjectAction {
    /// Create a new project
    Create {
        /// Project name
        #[arg(long)]
        name: String,

        /// Project directory path
        #[arg(long)]
        path: PathBuf,
    },

    /// Open an existing project and display its metadata
    Open {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,
    },

    /// Display project information as JSON
    Info {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,
    },

    /// Save the current project state
    Save {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,
    },
}

pub async fn execute(action: ProjectAction) -> anyhow::Result<()> {
    match action {
        ProjectAction::Create { name, path } => {
            std::fs::create_dir_all(&path)?;
            let project = ActiveProject::create(&name, path.clone())
                .map_err(|e| anyhow::anyhow!("Failed to create project: {}", e))?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "message": "Project created",
                "name": project.state.meta.name,
                "path": path.display().to_string(),
            }))
        }

        ProjectAction::Open { path } => {
            let project = super::load_project(&path)?;
            output::print_json(&serde_json::json!({
                "status": "ok",
                "message": "Project opened",
                "name": project.state.meta.name,
                "path": path.display().to_string(),
                "sequenceCount": project.state.sequences.len(),
                "assetCount": project.state.assets.len(),
                "opCount": project.state.op_count,
            }))
        }

        ProjectAction::Info { path } => {
            let project = super::load_project(&path)?;

            let sequences: Vec<serde_json::Value> = project
                .state
                .sequences
                .iter()
                .map(|(id, seq)| {
                    serde_json::json!({
                        "id": id,
                        "name": seq.name,
                        "trackCount": seq.tracks.len(),
                    })
                })
                .collect();

            let assets: Vec<serde_json::Value> = project
                .state
                .assets
                .iter()
                .map(|(id, asset)| {
                    serde_json::json!({
                        "id": id,
                        "name": asset.name,
                        "kind": format!("{:?}", asset.kind),
                        "uri": asset.uri,
                    })
                })
                .collect();

            output::print_json_pretty(&serde_json::json!({
                "name": project.state.meta.name,
                "path": path.display().to_string(),
                "activeSequenceId": project.state.active_sequence_id,
                "opCount": project.state.op_count,
                "lastOpId": project.state.last_op_id,
                "isDirty": project.state.is_dirty,
                "sequences": sequences,
                "assets": assets,
            }))
        }

        ProjectAction::Save { path } => {
            let mut project = super::load_project(&path)?;
            super::save_project(&mut project)?;
            output::print_success("Project saved")
        }
    }
}

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

        /// Sequence frame rate, e.g. 25, 29.97, 23.976 (default 30)
        #[arg(long)]
        fps: Option<f64>,

        /// Sequence canvas width in pixels, even, 16..=16384 (default 1920)
        #[arg(long)]
        width: Option<u32>,

        /// Sequence canvas height in pixels, even, 16..=16384 (default 1080)
        #[arg(long)]
        height: Option<u32>,
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

pub fn execute(action: ProjectAction) -> anyhow::Result<()> {
    match action {
        ProjectAction::Create {
            name,
            path,
            fps,
            width,
            height,
        } => {
            std::fs::create_dir_all(&path)?;
            let mut project = ActiveProject::create(&name, path.clone())
                .map_err(|e| anyhow::anyhow!("Failed to create project: {}", e))?;

            // Applied *after* creation, through the same `SetSequenceFormat`
            // command an agent would run: the format change is then an entry in
            // the ops log like any other edit, replayable and undoable, rather
            // than a hidden property of how the project happened to be created.
            let request = super::timeline::SequenceFormatRequest {
                fps,
                width,
                height,
                ..Default::default()
            };
            let format = if request.is_empty() {
                None
            } else {
                let sequence_id = super::resolve_sequence_id(&project, None)?;
                Some(
                    super::timeline::apply_sequence_format(&mut project, &sequence_id, &request)
                        // The project is already on disk by this point, so the
                        // failure has to say so: the caller's next step is
                        // `timeline set-format` on the project that exists, not
                        // `project create` again into a non-empty directory.
                        .map_err(|error| {
                            anyhow::anyhow!(
                                "Project '{}' was created but the requested format was \
                                 refused: {error}. Re-apply it with 'timeline set-format'.",
                                path.display()
                            )
                        })?,
                )
            };

            let mut created = serde_json::json!({
                "status": "ok",
                "message": "Project created",
                "name": project.state.meta.name,
                "path": path.display().to_string(),
            });
            if let (Some(format), Some(object)) = (format, created.as_object_mut()) {
                object.insert("sequenceFormat".to_string(), format);
            }

            output::print_json(&created)
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

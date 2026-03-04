//! Caption and subtitle commands: add, update, remove, list, export.

use crate::output;
use crate::validate;
use clap::Subcommand;
use openreelio_core::commands::*;
use openreelio_core::timeline::TrackKind;
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum CaptionAction {
    /// Add a caption to a caption track
    Add {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Track ID (must be a caption track)
        #[arg(long)]
        track: String,

        /// Caption text content
        #[arg(long)]
        text: String,

        /// Start time in seconds
        #[arg(long)]
        start: f64,

        /// End time in seconds
        #[arg(long)]
        end: f64,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Update a caption's text
    Update {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Caption ID to update
        #[arg(long)]
        id: String,

        /// Track ID containing the caption
        #[arg(long)]
        track: String,

        /// New text (optional)
        #[arg(long)]
        text: Option<String>,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Remove a caption
    Remove {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Caption ID to remove
        #[arg(long)]
        id: String,

        /// Track ID containing the caption
        #[arg(long)]
        track: String,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// List all captions in the sequence
    List {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Export captions to SRT or VTT format
    Export {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Output format: srt or vtt
        #[arg(long)]
        format: String,

        /// Output file path
        #[arg(long)]
        output: PathBuf,

        /// Sequence ID (defaults to active)
        #[arg(long)]
        sequence: Option<String>,
    },
}

pub fn execute(action: CaptionAction) -> anyhow::Result<()> {
    match action {
        CaptionAction::Add {
            path,
            track,
            text,
            start,
            end,
            sequence,
        } => {
            validate::non_empty(&track, "track")?;
            validate::non_empty(&text, "text")?;
            validate::time_range_ordered(start, end, "start", "end")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let cmd = CreateCaptionCommand::new(&seq_id, &track, start, end).with_text(&text);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Add caption failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
            }))
        }

        CaptionAction::Update {
            path,
            id,
            track,
            text,
            sequence,
        } => {
            validate::non_empty(&id, "id")?;
            validate::non_empty(&track, "track")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let mut cmd = UpdateCaptionCommand::new(&seq_id, &track, &id);
            if let Some(t) = text {
                cmd = cmd.with_text(Some(t));
            }
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Update caption failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
            }))
        }

        CaptionAction::Remove {
            path,
            id,
            track,
            sequence,
        } => {
            validate::non_empty(&id, "id")?;
            validate::non_empty(&track, "track")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let cmd = DeleteCaptionCommand::new(&seq_id, &track, &id);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Remove caption failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "deletedIds": result.deleted_ids,
            }))
        }

        CaptionAction::List { path, sequence } => {
            let project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let seq = project
                .state
                .sequences
                .get(&seq_id)
                .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", seq_id))?;

            // Captions are stored as clips on caption tracks
            let mut captions = Vec::new();
            for t in &seq.tracks {
                if t.kind == TrackKind::Caption {
                    for c in &t.clips {
                        captions.push(serde_json::json!({
                            "id": c.id,
                            "trackId": t.id,
                            "text": c.label,
                            "startSec": c.place.timeline_in_sec,
                            "durationSec": c.place.duration_sec,
                        }));
                    }
                }
            }

            output::print_json_pretty(&serde_json::json!({
                "sequenceId": seq_id,
                "captions": captions,
                "count": captions.len(),
            }))
        }

        CaptionAction::Export {
            path,
            format,
            output: output_path,
            sequence,
        } => {
            let project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let seq = project
                .state
                .sequences
                .get(&seq_id)
                .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", seq_id))?;

            // Collect caption clips and build Caption structs for export
            let mut caption_data = Vec::new();
            for t in &seq.tracks {
                if t.kind == TrackKind::Caption {
                    for c in &t.clips {
                        caption_data.push(openreelio_core::captions::Caption {
                            id: c.id.clone(),
                            start_sec: c.place.timeline_in_sec,
                            end_sec: c.place.timeline_in_sec + c.place.duration_sec,
                            text: c.label.clone().unwrap_or_default(),
                            style_override: None,
                            position_override: None,
                            speaker: None,
                            metadata: Default::default(),
                        });
                    }
                }
            }

            let content = match format.to_lowercase().as_str() {
                "srt" => openreelio_core::captions::export_srt(&caption_data),
                "vtt" => openreelio_core::captions::export_vtt(&caption_data),
                _ => {
                    return Err(anyhow::anyhow!(
                        "Unsupported format: '{}'. Use 'srt' or 'vtt'.",
                        format
                    ))
                }
            };

            std::fs::write(&output_path, content)?;
            output::print_json(&serde_json::json!({
                "status": "ok",
                "message": "Captions exported",
                "format": format,
                "output": output_path.display().to_string(),
                "captionCount": caption_data.len(),
            }))
        }
    }
}

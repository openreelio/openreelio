//! Timeline editing commands: insert, move, trim, split, speed, tracks, effects.

use crate::output;
use clap::Subcommand;
use openreelio_core::commands::*;
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum TimelineAction {
    /// Display timeline information
    Info {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// List all clips in the timeline
    Clips {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,

        /// Filter by track ID
        #[arg(long)]
        track: Option<String>,
    },

    /// List all tracks in the timeline
    Tracks {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Insert a clip onto the timeline
    Insert {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Asset ID to insert
        #[arg(long)]
        asset: String,

        /// Track ID to insert onto
        #[arg(long)]
        track: String,

        /// Timeline position in seconds
        #[arg(long)]
        at: f64,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Remove a clip from the timeline
    Remove {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Clip ID to remove
        #[arg(long)]
        clip: String,

        /// Track ID containing the clip
        #[arg(long)]
        track: String,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Move a clip to a new position
    Move {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Clip ID to move
        #[arg(long)]
        clip: String,

        /// New timeline position in seconds
        #[arg(long)]
        to: f64,

        /// Current track ID
        #[arg(long)]
        track: String,

        /// Target track ID (for cross-track moves)
        #[arg(long)]
        new_track: Option<String>,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Trim a clip's in/out points
    Trim {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Clip ID to trim
        #[arg(long)]
        clip: String,

        /// Track ID containing the clip
        #[arg(long)]
        track: String,

        /// New source in point (seconds)
        #[arg(long, name = "in")]
        source_in: Option<f64>,

        /// New source out point (seconds)
        #[arg(long, name = "out")]
        source_out: Option<f64>,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Split a clip at a specific position
    Split {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Clip ID to split
        #[arg(long)]
        clip: String,

        /// Track ID containing the clip
        #[arg(long)]
        track: String,

        /// Split position in seconds (timeline time)
        #[arg(long)]
        at: f64,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Change clip playback speed
    Speed {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Clip ID
        #[arg(long)]
        clip: String,

        /// Track ID
        #[arg(long)]
        track: String,

        /// Speed multiplier (e.g. 2.0 for 2x)
        #[arg(long)]
        speed: f32,

        /// Reverse playback
        #[arg(long, default_value = "false")]
        reverse: bool,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Add a new track to the timeline
    AddTrack {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Track type: video or audio
        #[arg(long)]
        kind: String,

        /// Track name
        #[arg(long)]
        name: String,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Remove a track from the timeline
    RemoveTrack {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Track ID to remove
        #[arg(long)]
        track: String,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Undo the last operation
    Undo {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,
    },

    /// Redo the last undone operation
    Redo {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,
    },
}

/// Resolve the sequence ID: use explicit arg or fall back to active sequence.
fn resolve_sequence_id(
    project: &openreelio_core::ActiveProject,
    explicit: Option<String>,
) -> anyhow::Result<String> {
    explicit
        .or_else(|| project.state.active_sequence_id.clone())
        .ok_or_else(|| anyhow::anyhow!("No sequence specified and no active sequence set"))
}

pub async fn execute(action: TimelineAction) -> anyhow::Result<()> {
    match action {
        TimelineAction::Info { path, sequence } => {
            let project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let seq = project
                .state
                .sequences
                .get(&seq_id)
                .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", seq_id))?;

            let tracks: Vec<serde_json::Value> = seq
                .tracks
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "id": t.id,
                        "name": t.name,
                        "kind": format!("{:?}", t.kind),
                        "clipCount": t.clips.len(),
                    })
                })
                .collect();

            output::print_json_pretty(&serde_json::json!({
                "sequenceId": seq_id,
                "name": seq.name,
                "tracks": tracks,
                "trackCount": seq.tracks.len(),
            }))
        }

        TimelineAction::Clips {
            path,
            sequence,
            track,
        } => {
            let project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let seq = project
                .state
                .sequences
                .get(&seq_id)
                .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", seq_id))?;

            let mut clips = Vec::new();
            for t in &seq.tracks {
                if let Some(ref filter_track) = track {
                    if &t.id != filter_track {
                        continue;
                    }
                }
                for c in &t.clips {
                    clips.push(serde_json::json!({
                        "id": c.id,
                        "trackId": t.id,
                        "assetId": c.asset_id,
                        "timelineInSec": c.place.timeline_in_sec,
                        "durationSec": c.place.duration_sec,
                        "sourceInSec": c.range.source_in_sec,
                        "sourceOutSec": c.range.source_out_sec,
                        "speed": c.speed,
                    }));
                }
            }

            output::print_json_pretty(&serde_json::json!({
                "sequenceId": seq_id,
                "clips": clips,
                "count": clips.len(),
            }))
        }

        TimelineAction::Tracks { path, sequence } => {
            let project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let seq = project
                .state
                .sequences
                .get(&seq_id)
                .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", seq_id))?;

            let tracks: Vec<serde_json::Value> = seq
                .tracks
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "id": t.id,
                        "name": t.name,
                        "kind": format!("{:?}", t.kind),
                        "clipCount": t.clips.len(),
                        "muted": t.muted,
                        "locked": t.locked,
                    })
                })
                .collect();

            output::print_json_pretty(&serde_json::json!({
                "sequenceId": seq_id,
                "tracks": tracks,
                "count": tracks.len(),
            }))
        }

        TimelineAction::Insert {
            path,
            asset,
            track,
            at,
            sequence,
        } => {
            let mut project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let cmd = InsertClipCommand::new(&seq_id, &track, &asset, at);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Insert failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
            }))
        }

        TimelineAction::Remove {
            path,
            clip,
            track,
            sequence,
        } => {
            let mut project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let cmd = RemoveClipCommand::new(&seq_id, &track, &clip);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Remove failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "deletedIds": result.deleted_ids,
            }))
        }

        TimelineAction::Move {
            path,
            clip,
            to,
            track,
            new_track,
            sequence,
        } => {
            let mut project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let mut cmd = MoveClipCommand::new(&seq_id, &track, &clip, to, None);
            if let Some(ref target_track) = new_track {
                cmd = cmd.to_track(target_track);
            }
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Move failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
            }))
        }

        TimelineAction::Trim {
            path,
            clip,
            track,
            source_in,
            source_out,
            sequence,
        } => {
            let mut project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let cmd = TrimClipCommand::new(
                &seq_id, &track, &clip, source_in, source_out, None, // timeline_in
            );
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Trim failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
            }))
        }

        TimelineAction::Split {
            path,
            clip,
            track,
            at,
            sequence,
        } => {
            let mut project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let cmd = SplitClipCommand::new(&seq_id, &track, &clip, at);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Split failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
            }))
        }

        TimelineAction::Speed {
            path,
            clip,
            track,
            speed,
            reverse,
            sequence,
        } => {
            let mut project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let cmd = SetClipSpeedCommand::new(&seq_id, &track, &clip, speed, reverse);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Set speed failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
            }))
        }

        TimelineAction::AddTrack {
            path,
            kind,
            name,
            sequence,
        } => {
            let mut project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let track_kind = match kind.to_lowercase().as_str() {
                "video" => openreelio_core::timeline::TrackKind::Video,
                "audio" => openreelio_core::timeline::TrackKind::Audio,
                "caption" => openreelio_core::timeline::TrackKind::Caption,
                "overlay" => openreelio_core::timeline::TrackKind::Overlay,
                _ => {
                    return Err(anyhow::anyhow!(
                        "Unknown track kind '{}'. Use: video, audio, caption, overlay",
                        kind
                    ))
                }
            };
            let cmd = AddTrackCommand::new(&seq_id, &name, track_kind);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Add track failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
            }))
        }

        TimelineAction::RemoveTrack {
            path,
            track,
            sequence,
        } => {
            let mut project = super::load_project(&path)?;
            let seq_id = resolve_sequence_id(&project, sequence)?;
            let cmd = RemoveTrackCommand::new(&seq_id, &track);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| anyhow::anyhow!("Remove track failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "deletedIds": result.deleted_ids,
            }))
        }

        TimelineAction::Undo { path } => {
            let mut project = super::load_project(&path)?;
            project
                .executor
                .undo(&mut project.state)
                .map_err(|e| anyhow::anyhow!("Undo failed: {}", e))?;
            super::save_project(&mut project)?;
            output::print_success("Undo successful")
        }

        TimelineAction::Redo { path } => {
            let mut project = super::load_project(&path)?;
            let result = project
                .executor
                .redo(&mut project.state)
                .map_err(|e| anyhow::anyhow!("Redo failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
            }))
        }
    }
}

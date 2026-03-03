//! State inspection commands: dump, ops, snapshot.

use std::path::PathBuf;
use clap::Subcommand;
use crate::output;

#[derive(Subcommand)]
pub enum StateAction {
    /// Dump the full project state as JSON
    Dump {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID to focus on (optional)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Show recent operations from the ops log
    Ops {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Number of recent operations to show
        #[arg(long, default_value = "10")]
        last: usize,
    },

    /// Force a snapshot save
    Snapshot {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,
    },
}

pub async fn execute(action: StateAction) -> anyhow::Result<()> {
    match action {
        StateAction::Dump { path, sequence } => {
            let project = super::load_project(&path)?;

            if let Some(seq_id) = sequence {
                // Dump a specific sequence
                let seq = project
                    .state
                    .sequences
                    .get(&seq_id)
                    .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", seq_id))?;

                output::print_json_pretty(&serde_json::json!({
                    "sequenceId": seq_id,
                    "name": seq.name,
                    "tracks": seq.tracks.iter().map(|t| {
                        serde_json::json!({
                            "id": t.id,
                            "name": t.name,
                            "kind": format!("{:?}", t.kind),
                            "clips": t.clips.iter().map(|c| {
                                serde_json::json!({
                                    "id": c.id,
                                    "assetId": c.asset_id,
                                    "timelineInSec": c.place.timeline_in_sec,
                                    "durationSec": c.place.duration_sec,
                                    "sourceInSec": c.range.source_in_sec,
                                    "sourceOutSec": c.range.source_out_sec,
                                    "speed": c.speed,
                                    "muted": c.audio.muted,
                                })
                            }).collect::<Vec<_>>(),
                        })
                    }).collect::<Vec<_>>(),
                }))
            } else {
                // Dump full project state
                let sequences: Vec<serde_json::Value> = project
                    .state
                    .sequences
                    .iter()
                    .map(|(id, seq)| {
                        let clip_count: usize = seq.tracks.iter().map(|t| t.clips.len()).sum();
                        serde_json::json!({
                            "id": id,
                            "name": seq.name,
                            "trackCount": seq.tracks.len(),
                            "clipCount": clip_count,
                            "trackCount": seq.tracks.len(),
                        })
                    })
                    .collect();

                output::print_json_pretty(&serde_json::json!({
                    "project": {
                        "name": project.state.meta.name,
                        "path": path.display().to_string(),
                        "opCount": project.state.op_count,
                        "lastOpId": project.state.last_op_id,
                        "isDirty": project.state.is_dirty,
                        "activeSequenceId": project.state.active_sequence_id,
                    },
                    "assetCount": project.state.assets.len(),
                    "sequences": sequences,
                }))
            }
        }

        StateAction::Ops { path, last } => {
            let project = super::load_project(&path)?;
            // Read the ops log file directly
            let ops_path = project.state_dir.join("ops.jsonl");
            if !ops_path.exists() {
                return output::print_json(&serde_json::json!({
                    "ops": [],
                    "count": 0,
                    "message": "No operations log found",
                }));
            }

            let content = std::fs::read_to_string(&ops_path)?;
            let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
            let start = if lines.len() > last { lines.len() - last } else { 0 };

            let ops: Vec<serde_json::Value> = lines[start..]
                .iter()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();

            output::print_json_pretty(&serde_json::json!({
                "ops": ops,
                "count": ops.len(),
                "totalOps": lines.len(),
            }))
        }

        StateAction::Snapshot { path } => {
            let mut project = super::load_project(&path)?;
            super::save_project(&mut project)?;
            output::print_success("Snapshot saved")
        }
    }
}

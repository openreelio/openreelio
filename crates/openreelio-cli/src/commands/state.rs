//! State inspection commands: dump, ops, history, jump, snapshot.

use crate::output;
use clap::Subcommand;
use openreelio_core::commands::HistoryEntryInfo;
use openreelio_core::ActiveProject;
use std::path::PathBuf;

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

    /// List the edit history with the position it is currently at
    History {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Number of most recent entries to show (defaults to all of them)
        #[arg(long)]
        last: Option<usize>,
    },

    /// Move the project to a position in its edit history
    Jump {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// History index to move to; -1 undoes every entry
        #[arg(long, allow_negative_numbers = true)]
        index: i32,
    },

    /// Force a snapshot save
    Snapshot {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,
    },
}

/// Reads the visible history: applied entries, redoable entries, and the index
/// the project currently sits at.
fn read_history(
    project: &mut ActiveProject,
) -> anyhow::Result<(Vec<HistoryEntryInfo>, Vec<HistoryEntryInfo>, i32)> {
    project
        .persisted_history_entries()
        .map_err(|error| anyhow::anyhow!("Failed to read history: {}", error))
}

fn history_entry_json(entry: &HistoryEntryInfo) -> serde_json::Value {
    serde_json::json!({
        "index": entry.index,
        "opId": entry.op_id,
        "commandType": entry.command_type,
        "timestamp": entry.timestamp,
    })
}

pub fn execute(action: StateAction) -> anyhow::Result<()> {
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
            let start = if lines.len() > last {
                lines.len() - last
            } else {
                0
            };

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

        StateAction::History { path, last } => {
            let mut project = super::load_project(&path)?;
            let (applied, redoable, current_index) = read_history(&mut project)?;

            // The two lists share one index space: applied entries run
            // 0..appliedCount and redoable entries continue from there, so
            // `currentIndex` splits the list into what is in effect and what a
            // jump forward would restore.
            let mut entries: Vec<serde_json::Value> = applied
                .iter()
                .chain(redoable.iter())
                .map(history_entry_json)
                .collect();
            if let Some(limit) = last {
                if entries.len() > limit {
                    entries.drain(..entries.len() - limit);
                }
            }

            output::print_json_pretty(&serde_json::json!({
                "status": "ok",
                "appliedCount": applied.len(),
                "redoCount": redoable.len(),
                "discardedCount": project.history.discarded_op_ids.len(),
                "currentIndex": current_index,
                "entries": entries,
            }))
        }

        StateAction::Jump { path, index } => {
            let mut project = super::load_project(&path)?;
            let (applied, redoable, previous_index) = read_history(&mut project)?;

            let total = (applied.len() + redoable.len()) as i32;
            if index < -1 || index >= total {
                return Err(anyhow::anyhow!(
                    "Invalid value for --index: {} is outside the history range [-1, {}). Run 'state history' to list the entries; -1 undoes all of them.",
                    index,
                    total
                ));
            }

            // The jump rewrites the history manifest through the guarded log, so
            // a project another process has edited since this one opened is
            // refused here rather than silently reverted.
            let current_index = project
                .jump_to_history_index_persisted(index)
                .map_err(|error| anyhow::anyhow!("History jump failed: {}", error))?;
            super::save_project(&mut project)?;

            let (applied_after, redo_after, _) = read_history(&mut project)?;

            output::print_json_pretty(&serde_json::json!({
                "status": "ok",
                "previousIndex": previous_index,
                "currentIndex": current_index,
                "appliedCount": applied_after.len(),
                "redoCount": redo_after.len(),
            }))
        }

        StateAction::Snapshot { path } => {
            let mut project = super::load_project(&path)?;
            super::save_project(&mut project)?;
            output::print_success("Snapshot saved")
        }
    }
}

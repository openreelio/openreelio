//! CLI command definitions and dispatch.
//!
//! All subcommands follow the pattern:
//! 1. Parse arguments (clap)
//! 2. Load ActiveProject from `--path`
//! 3. Build + execute Command via CommandExecutor
//! 4. Save project state
//! 5. Output JSON result to stdout

mod analysis;
mod asset;
mod caption;
mod command;
mod ffmpeg;
mod frame;
mod help_json;
mod mcp;
mod otio;
mod packs;
mod perception;
mod plan;
mod project;
mod render;
mod state;
mod text;
mod timeline;
mod transcription;
mod verify;

use clap::{Parser, Subcommand};

/// OpenReelio CLI — Headless AI agent-driven video editing
#[derive(Parser)]
#[command(name = "openreelio-cli", version, about, long_about = None)]
pub struct Cli {
    /// Increase log verbosity (show INFO and DEBUG messages)
    #[arg(long, short = 'v', global = true)]
    pub verbose: bool,

    /// Suppress all log output
    #[arg(long, short = 'q', global = true, conflicts_with = "verbose")]
    pub quiet: bool,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
pub enum Commands {
    /// Project lifecycle operations (create, open, info, save)
    Project {
        #[command(subcommand)]
        action: project::ProjectAction,
    },

    /// Asset management (import, list, info, remove)
    Asset {
        #[command(subcommand)]
        action: asset::AssetAction,
    },

    /// Cached source analysis inspection
    Analysis {
        #[command(subcommand)]
        action: analysis::AnalysisAction,
    },

    /// Timeline editing operations (insert, move, trim, split, effects, tracks)
    Timeline {
        #[command(subcommand)]
        action: timeline::TimelineAction,
    },

    /// Caption and subtitle operations
    Caption {
        #[command(subcommand)]
        action: caption::CaptionAction,
    },

    /// OpenTimelineIO interchange (export, import)
    Otio {
        #[command(subcommand)]
        action: otio::OtioAction,
    },

    /// Curated caption style packs, transition recipes, and text presets
    Packs {
        #[command(subcommand)]
        action: packs::PacksAction,
    },

    /// Speech-to-text transcription and auto-caption generation
    Transcription {
        #[command(subcommand)]
        action: transcription::TranscriptionAction,
    },

    /// Editable text overlay operations
    Text {
        #[command(subcommand)]
        action: text::TextAction,
    },

    /// Render and export operations
    Render {
        #[command(subcommand)]
        action: render::RenderAction,
    },

    /// FFmpeg toolchain inspection
    Ffmpeg {
        #[command(subcommand)]
        action: ffmpeg::FfmpegAction,
    },

    /// Still frame extraction for visual inspection
    Frame {
        #[command(subcommand)]
        action: frame::FrameAction,
    },

    /// Batch plan execution (atomic multi-step edits)
    Plan {
        #[command(subcommand)]
        action: plan::PlanAction,
    },

    /// Generic backend command execution and schema inspection
    Command {
        #[command(subcommand)]
        action: command::CommandAction,
    },

    /// State inspection and debugging
    State {
        #[command(subcommand)]
        action: state::StateAction,
    },

    /// Deterministic quality control for a sequence and its rendered output
    Verify(verify::VerifyArgs),

    /// Model Context Protocol server for external AI agents
    Mcp(mcp::McpAction),

    /// Output full command schema as JSON (for agent consumption)
    HelpJson,
}

/// Execute the parsed CLI command.
pub fn execute(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Commands::Project { action } => project::execute(action),
        Commands::Asset { action } => asset::execute(action),
        Commands::Analysis { action } => analysis::execute(action),
        Commands::Timeline { action } => timeline::execute(action),
        Commands::Caption { action } => caption::execute(action),
        Commands::Otio { action } => otio::execute(action),
        Commands::Packs { action } => packs::execute(action),
        Commands::Transcription { action } => transcription::execute(action),
        Commands::Text { action } => text::execute(action),
        Commands::Render { action } => render::execute(action),
        Commands::Ffmpeg { action } => ffmpeg::execute(action),
        Commands::Frame { action } => frame::execute(action),
        Commands::Plan { action } => plan::execute(action),
        Commands::Command { action } => command::execute(action),
        Commands::State { action } => state::execute(action),
        Commands::Verify(args) => verify::execute(args),
        Commands::Mcp(action) => mcp::execute(action),
        Commands::HelpJson => help_json::execute(),
    }
}

// ── Shared Helpers ──────────────────────────────────────────────────────

use openreelio_core::ActiveProject;
use std::path::PathBuf;

/// Load an existing project from the given path.
///
/// Opening installs the external-edit guard: the session records the revision of
/// `ops.jsonl` and `history.json` it replayed, and refuses to write on top of
/// another process's changes. The CLI is not exempt from it, and does not need
/// to be — an invocation opens, mutates, saves and exits, so a command that runs
/// after another writer baselines against the current tail and appends onto it.
///
/// A command that runs *while* another process is editing the same project is
/// refused with `ExternalChangeDetected` instead of interleaving; re-run it and
/// the fresh open picks up the other writer's work. Serialize concurrent
/// automation on a project rather than racing it.
pub(crate) fn load_project(path: &PathBuf) -> anyhow::Result<ActiveProject> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| anyhow::anyhow!("Project path '{}' not found: {}", path.display(), e))?;
    ActiveProject::open(canonical).map_err(|e| anyhow::anyhow!("Failed to open project: {}", e))
}

/// Read a project's state for a command that must not change anything.
///
/// [`load_project`] opens an editing *session*, and opening one writes: it
/// creates the hidden state directory, migrates legacy state files into it and
/// takes the ops-log lock. A verb that promised to change nothing — `otio
/// import --dry-run` — cannot do any of that just to read the assets it needs,
/// so it reads the state where it lies instead. There is no session and no
/// [`ActiveProject`], so nothing downstream can save through it by accident.
///
/// The project root is returned alongside the state because a read-only caller
/// still needs to know where the project is.
pub(crate) fn load_project_state_read_only(
    path: &PathBuf,
) -> anyhow::Result<(PathBuf, openreelio_core::project::ProjectState)> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| anyhow::anyhow!("Project path '{}' not found: {}", path.display(), e))?;
    let state = ActiveProject::read_state_without_session(&canonical)
        .map_err(|e| anyhow::anyhow!("Failed to read project: {}", e))?;
    Ok((canonical, state))
}

/// Save the project state (snapshot + metadata).
pub(crate) fn save_project(project: &mut ActiveProject) -> anyhow::Result<()> {
    project
        .save()
        .map_err(|e| anyhow::anyhow!("Failed to save project: {}", e))
}

/// One mutating verb's edit, from the before-image to the recorded hand-off.
///
/// Every mutating CLI verb has to answer the same question — *where on the
/// timeline did this land* — and only `command execute` and `plan execute` used
/// to. The rest saved and exited, which left the hand-off file describing an
/// older edit: a later `frame extract --affected` then sampled the previous
/// change and said nothing about it. Routing every verb through one recorder is
/// what makes `--affected` mean "the last edit" rather than "the last edit some
/// surfaces bothered to record".
///
/// A verb that applies several commands under one save — `text update` moves a
/// clip and retrims it — opens one recorder and executes through it repeatedly;
/// the ranges are then the diff across the whole verb, which is what the caller
/// asked about anyway.
///
/// The range arithmetic itself is not reimplemented here: this wraps the core's
/// [`EditRecording`](openreelio_core::commands::EditRecording), which the GUI's
/// own edit path and its plan runner also apply through, so no two surfaces can
/// disagree about what `--affected` will point at. What the CLI adds is the
/// order it needs — ranges, then save, then hand-off — because a hand-off
/// written before a failed save would describe an edit that is not on disk.
pub(crate) struct EditRecorder {
    recording: openreelio_core::commands::EditRecording,
}

impl EditRecorder {
    /// Captures the before-image of the sequence the verb is about to change.
    ///
    /// Must be called before the first command runs: the ranges are a diff
    /// across the mutation, and a ripple move shifts clips no reported change
    /// names.
    pub(crate) fn begin(project: &ActiveProject, sequence_id: &str) -> Self {
        Self {
            recording: openreelio_core::commands::EditRecording::begin(
                &project.state,
                sequence_id,
                // Every verb of this binary is headless, and so is the MCP
                // server that shares its code: a reader has to be able to tell
                // these ranges from an interactive edit in the app.
                openreelio_core::commands::RecordSource::Cli,
            ),
        }
    }

    /// Executes one command, folding its result into the recording.
    ///
    /// The executor's error is passed through untouched so each verb keeps
    /// phrasing its own failure ("Insert failed", "Trim failed").
    pub(crate) fn execute(
        &mut self,
        project: &mut ActiveProject,
        command: Box<dyn openreelio_core::commands::Command>,
    ) -> openreelio_core::CoreResult<openreelio_core::commands::CommandResult> {
        let result = project.executor.execute(command, &mut project.state)?;
        self.recording.observe(&result);
        Ok(result)
    }

    /// Saves the project, records the hand-off, and returns the changed ranges.
    ///
    /// The ranges are returned so the verb can publish them under
    /// `affectedRanges` as well — an additive key, so a reader of the verb's
    /// JSON keeps everything it already parsed.
    pub(crate) fn finish(
        self,
        project: &mut ActiveProject,
    ) -> anyhow::Result<Vec<openreelio_core::TimeRange>> {
        let affected_ranges = self.recording.ranges(&project.state);
        let sequence_id = self.recording.sequence_id().to_string();
        let op_ids = self.recording.op_ids().to_vec();
        save_project(project)?;
        command::record_affected_ranges(&project.path, &sequence_id, op_ids, &affected_ranges);
        Ok(affected_ranges)
    }
}

/// Reports the audio clip an insert extracted alongside a picture clip.
///
/// A video asset that carries sound is placed the way a drag-and-drop in the
/// app places it: the picture clip is muted and the sound goes onto its own
/// audio track as a linked clip, creating that track when the sequence has
/// none. Two clips come back where the caller asked for one, and the audio one
/// has an id of its own — every later `trim`, `split`, `move` and `remove`
/// names a single clip, so a caller that never saw this id would leave the
/// sound behind. `null` when the insert placed only one clip.
///
/// The primary clip is the first created id, which is what
/// [`InsertMediaCommand`](openreelio_core::commands::InsertMediaCommand)
/// reports; the partner is the other clip sharing its link group.
pub(crate) fn linked_audio_json(
    state: &openreelio_core::project::ProjectState,
    sequence_id: &str,
    created_ids: &[String],
) -> serde_json::Value {
    let Some(primary_clip_id) = created_ids.first() else {
        return serde_json::Value::Null;
    };
    let Some(sequence) = state.sequences.get(sequence_id) else {
        return serde_json::Value::Null;
    };
    let Some(link_group_id) = sequence
        .tracks
        .iter()
        .flat_map(|track| track.clips.iter())
        .find(|clip| &clip.id == primary_clip_id)
        .and_then(|clip| clip.link_group_id.clone())
    else {
        return serde_json::Value::Null;
    };

    sequence
        .tracks
        .iter()
        .find_map(|track| {
            track
                .clips
                .iter()
                .find(|clip| {
                    &clip.id != primary_clip_id
                        && clip.link_group_id.as_deref() == Some(link_group_id.as_str())
                })
                .map(|clip| (track.id.clone(), clip.id.clone()))
        })
        .map(|(audio_track_id, audio_clip_id)| {
            let created_track = created_ids.contains(&audio_track_id);
            serde_json::json!({
                "trackId": audio_track_id,
                "clipId": audio_clip_id,
                "createdTrack": created_track,
            })
        })
        .unwrap_or(serde_json::Value::Null)
}

/// Resolve the sequence ID: use explicit arg or fall back to active sequence.
pub(crate) fn resolve_sequence_id(
    project: &ActiveProject,
    explicit: Option<String>,
) -> anyhow::Result<String> {
    resolve_sequence_id_in_state(&project.state, explicit)
}

/// Same, for a caller that holds state without a session.
pub(crate) fn resolve_sequence_id_in_state(
    state: &openreelio_core::project::ProjectState,
    explicit: Option<String>,
) -> anyhow::Result<String> {
    explicit
        .or_else(|| state.active_sequence_id.clone())
        .ok_or_else(|| anyhow::anyhow!("No sequence specified and no active sequence set"))
}

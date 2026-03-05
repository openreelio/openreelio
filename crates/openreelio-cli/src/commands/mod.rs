//! CLI command definitions and dispatch.
//!
//! All subcommands follow the pattern:
//! 1. Parse arguments (clap)
//! 2. Load ActiveProject from `--path`
//! 3. Build + execute Command via CommandExecutor
//! 4. Save project state
//! 5. Output JSON result to stdout

mod asset;
mod caption;
mod help_json;
mod plan;
mod project;
mod render;
mod state;
mod timeline;

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

    /// Render and export operations
    Render {
        #[command(subcommand)]
        action: render::RenderAction,
    },

    /// Batch plan execution (atomic multi-step edits)
    Plan {
        #[command(subcommand)]
        action: plan::PlanAction,
    },

    /// State inspection and debugging
    State {
        #[command(subcommand)]
        action: state::StateAction,
    },

    /// Output full command schema as JSON (for agent consumption)
    HelpJson,
}

/// Execute the parsed CLI command.
pub fn execute(cli: Cli) -> anyhow::Result<()> {
    match cli.command {
        Commands::Project { action } => project::execute(action),
        Commands::Asset { action } => asset::execute(action),
        Commands::Timeline { action } => timeline::execute(action),
        Commands::Caption { action } => caption::execute(action),
        Commands::Render { action } => render::execute(action),
        Commands::Plan { action } => plan::execute(action),
        Commands::State { action } => state::execute(action),
        Commands::HelpJson => help_json::execute(),
    }
}

// ── Shared Helpers ──────────────────────────────────────────────────────

use openreelio_core::ActiveProject;
use std::path::PathBuf;

/// Load an existing project from the given path.
pub(crate) fn load_project(path: &PathBuf) -> anyhow::Result<ActiveProject> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| anyhow::anyhow!("Project path '{}' not found: {}", path.display(), e))?;
    ActiveProject::open(canonical).map_err(|e| anyhow::anyhow!("Failed to open project: {}", e))
}

/// Save the project state (snapshot + metadata).
pub(crate) fn save_project(project: &mut ActiveProject) -> anyhow::Result<()> {
    project
        .save()
        .map_err(|e| anyhow::anyhow!("Failed to save project: {}", e))
}

/// Resolve the sequence ID: use explicit arg or fall back to active sequence.
pub(crate) fn resolve_sequence_id(
    project: &ActiveProject,
    explicit: Option<String>,
) -> anyhow::Result<String> {
    explicit
        .or_else(|| project.state.active_sequence_id.clone())
        .ok_or_else(|| anyhow::anyhow!("No sequence specified and no active sequence set"))
}

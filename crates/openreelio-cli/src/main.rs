#![recursion_limit = "256"]
//! OpenReelio CLI
//!
//! Headless command-line interface for AI agent-driven video editing.
//! Shares the same core engine as the GUI app, enabling automated
//! editing workflows, CI/CD pipelines, and agent-native operation.
//!
//! ## Usage
//!
//! IDs are ULIDs the CLI returns; read them from `createdIds`, `asset list`,
//! `timeline tracks` or `timeline clips` rather than inventing them.
//!
//! ```bash
//! openreelio-cli project create --name "My Project" --path ./my-project
//! openreelio-cli asset import --path ./my-project --file video.mp4
//! openreelio-cli timeline insert --path ./my-project --asset <ASSET_ID> --track <TRACK_ID> --at 0.0
//! openreelio-cli timeline split --path ./my-project --clip <CLIP_ID> --track <TRACK_ID> --at 5.0
//! openreelio-cli state dump --path ./my-project
//! ```
mod commands;
mod ffmpeg_env;
mod output;
mod validate;

use clap::Parser;
use commands::Cli;

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // Determine log level from flags
    let level = if cli.quiet {
        tracing::Level::ERROR
    } else if cli.verbose {
        tracing::Level::DEBUG
    } else {
        tracing::Level::WARN
    };

    // Initialize logging (flags augment RUST_LOG env var)
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env().add_directive(level.into()),
        )
        .with_writer(std::io::stderr)
        .init();

    commands::execute(cli)
}

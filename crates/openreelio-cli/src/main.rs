//! OpenReelio CLI
//!
//! Headless command-line interface for AI agent-driven video editing.
//! Shares the same core engine as the GUI app, enabling automated
//! editing workflows, CI/CD pipelines, and agent-native operation.
//!
//! ## Usage
//!
//! ```bash
//! openreelio-cli project create --name "My Project" --path ./my-project
//! openreelio-cli asset import --path ./my-project --file video.mp4
//! openreelio-cli timeline insert --path ./my-project --asset asset_001 --track track_v1 --at 0.0
//! openreelio-cli timeline split --path ./my-project --clip clip_001 --at 5.0
//! openreelio-cli state dump --path ./my-project
//! ```

mod commands;
mod output;

use clap::Parser;
use commands::Cli;

fn main() -> anyhow::Result<()> {
    // Initialize logging (respects RUST_LOG env var)
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::WARN.into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();

    // Build a single-threaded Tokio runtime for async operations
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;

    rt.block_on(commands::execute(cli))
}

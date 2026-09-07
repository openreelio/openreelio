// `help_json::build_schema` is one `serde_json::json!` literal covering every
// CLI leaf command, and the macro recurses once per nesting level it expands.
// The limit tracks that literal's size, so adding commands may need it raised.
#![recursion_limit = "512"]
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
mod media_probe;
mod output;
mod validate;

use clap::Parser;
use commands::Cli;

/// Stack size handed to the thread every CLI verb runs on.
///
/// The process main thread is sized by the OS from the executable header, which
/// is 1 MiB on Windows — the smallest of the three platforms we ship, and small
/// enough that the frame probe walked off the end of it. Driving a future with
/// `block_on` costs far more stack than the future itself: an unoptimised build
/// of Tokio's entry chain stores the future by value in several frames, so the
/// 41 KiB `FrameProbePlan::run` state machine cost roughly 650 KiB of stack
/// before its body was even entered, and the composite-still chain below it
/// (contact sheet, windowed export, FFmpeg invocation) added ~370 KiB more.
/// A `frame extract` with a sampler and an auto grid therefore peaked around
/// 1.3 MiB, and the MCP server — whose JSON-RPC dispatch adds another ~32 KiB
/// under the same call — died on it with an unrecoverable stack overflow.
///
/// Boxing the future at the `block_on` boundary (see `commands::frame`) removes
/// the amplification and is the actual fix. This is the second line of defence:
/// no future anywhere below a CLI verb may ever be able to kill the process,
/// because on Windows a stack overflow is not a panic that can be caught.
const WORKER_STACK_SIZE_BYTES: usize = 64 * 1024 * 1024;

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

    run_on_worker_thread(cli)
}

/// Runs the parsed command on a thread with an explicitly sized stack.
///
/// A panic on the worker is re-raised on the main thread so the process still
/// reports it exactly as it did when the work ran here: the same message on
/// stderr from the default hook, and the same non-zero exit.
fn run_on_worker_thread(cli: Cli) -> anyhow::Result<()> {
    let worker = std::thread::Builder::new()
        .name("openreelio-cli".to_string())
        .stack_size(WORKER_STACK_SIZE_BYTES)
        .spawn(move || commands::execute(cli))
        .map_err(|error| anyhow::anyhow!("Failed to start the CLI worker thread: {error}"))?;

    match worker.join() {
        Ok(result) => result,
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

//! Output formatting utilities for the CLI.
//!
//! All normal output goes to stdout as JSON for machine consumption.
//! Errors and diagnostics go to stderr.

use serde::Serialize;

/// Prints a JSON value to stdout (compact format).
pub fn print_json<T: Serialize>(value: &T) -> anyhow::Result<()> {
    serde_json::to_writer(std::io::stdout(), value)?;
    println!(); // trailing newline
    Ok(())
}

/// Prints a JSON value to stdout (pretty format).
pub fn print_json_pretty<T: Serialize>(value: &T) -> anyhow::Result<()> {
    serde_json::to_writer_pretty(std::io::stdout(), value)?;
    println!();
    Ok(())
}

/// Prints a simple success message to stdout as JSON.
pub fn print_success(message: &str) -> anyhow::Result<()> {
    print_json(&serde_json::json!({
        "status": "ok",
        "message": message
    }))
}

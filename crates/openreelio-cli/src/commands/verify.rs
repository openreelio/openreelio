//! `verify` — deterministic QC for a sequence, with or without a rendered file.
//!
//! This is the command shell only: clap arguments, project loading, FFmpeg
//! resolution and printing. Everything that decides what a verdict *is* — the
//! rule selection, the measurement pass, the document and the exit code — lives
//! in [`openreelio_core::qc::verify`], shared verbatim with the
//! `openreelio.verify` MCP tool and the GUI's `verify_sequence` command, so the
//! three surfaces cannot disagree about whether an edit is sound.
//!
//! Exit codes: `0` ran without breaching the threshold, `1` threshold breached,
//! `2` the tool itself failed (bad arguments, unreadable file, FFmpeg failure,
//! or a rule that errored, leaving the verdict incomplete).

use crate::ffmpeg_env::ensure_ffmpeg;
use crate::output;
use clap::Args;
use openreelio_core::ffmpeg::FFmpegRunner;
use openreelio_core::qc::verify::{
    VerifyArgumentNames, VerifyPlan, VerifyRequest, DEFAULT_FAIL_ON, DEFAULT_MEASURE_TIMEOUT_SEC,
    EXIT_TOOL_FAILURE,
};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Arguments for `verify`.
#[derive(Args)]
pub struct VerifyArgs {
    /// Project directory path
    #[arg(long)]
    pub path: PathBuf,

    /// Sequence ID (defaults to active)
    #[arg(long)]
    pub sequence: Option<String>,

    /// Rendered file to measure; without it only structural checks run
    #[arg(long, conflicts_with = "structural_only")]
    pub file: Option<PathBuf>,

    /// Run structural checks only and never touch FFmpeg
    #[arg(long)]
    pub structural_only: bool,

    /// Run only these check IDs (comma-separated)
    #[arg(long, value_delimiter = ',')]
    pub checks: Option<Vec<String>>,

    /// Skip these check IDs (comma-separated)
    #[arg(long, value_delimiter = ',')]
    pub skip: Option<Vec<String>>,

    /// Integrated loudness target in LUFS
    #[arg(long)]
    pub target_lufs: Option<f64>,

    /// Maximum acceptable true peak in dBTP
    #[arg(long)]
    pub max_true_peak: Option<f64>,

    /// Divergence tolerated between the rendered file and the sequence, in
    /// seconds; honoured exactly, so a tighter value really is tighter
    #[arg(long)]
    pub duration_tolerance_sec: Option<f64>,

    /// Lowest severity that fails the run: info, warning, error, critical
    #[arg(long, default_value = DEFAULT_FAIL_ON)]
    pub fail_on: String,

    /// Timeout for the rendered-file measurement pass, in seconds
    #[arg(long, default_value_t = DEFAULT_MEASURE_TIMEOUT_SEC)]
    pub timeout_sec: u64,

    /// Pretty-print the JSON output
    #[arg(long)]
    pub json_pretty: bool,
}

impl VerifyArgs {
    /// The engine request these arguments describe.
    fn into_request(self) -> (PathBuf, VerifyRequest, bool) {
        let json_pretty = self.json_pretty;
        let path = self.path;
        (
            path,
            VerifyRequest {
                sequence: self.sequence,
                file: self.file,
                structural_only: self.structural_only,
                checks: self.checks,
                skip: self.skip,
                target_lufs: self.target_lufs,
                max_true_peak: self.max_true_peak,
                duration_tolerance_sec: self.duration_tolerance_sec,
                fail_on: self.fail_on,
                timeout_sec: self.timeout_sec,
                // A refusal from the shared engine has to name the flag the
                // user typed, not the JSON field another surface sends.
                names: VerifyArgumentNames::cli(),
            },
            json_pretty,
        )
    }
}

pub fn execute(args: VerifyArgs) -> anyhow::Result<()> {
    match run(args) {
        Ok(0) => Ok(()),
        Ok(exit_code) => {
            flush_stdout();
            std::process::exit(exit_code)
        }
        Err(error) => {
            flush_stdout();
            eprintln!("error: {error}");
            std::process::exit(i32::from(EXIT_TOOL_FAILURE))
        }
    }
}

/// Runs the verification, prints the report, and returns the process exit code.
///
/// Returning `Err` means the tool failed before it could produce a report; a
/// report that merely found problems returns `Ok` with a non-zero code.
fn run(args: VerifyArgs) -> anyhow::Result<i32> {
    let (path, request, json_pretty) = args.into_request();
    let (output_value, exit_code) = run_verify(&path, request)?;

    if json_pretty {
        output::print_json_pretty(&output_value)?;
    } else {
        output::print_json(&output_value)?;
    }

    Ok(exit_code)
}

/// Runs the verification and returns the report document plus the exit code.
///
/// This is the print-free seam for in-process callers — the MCP server hands
/// the returned document straight to its own client. The document is exactly
/// what the CLI prints, so the two surfaces can never drift.
///
/// The order is load-bearing: the request is validated (and the rendered file's
/// existence settled) *before* FFmpeg is resolved, so a structural run never
/// needs FFmpeg installed and a path that names nothing reads as a missing
/// file rather than a missing toolchain.
///
/// Returning `Err` means the tool failed before it could produce a report; a
/// report that merely found problems returns `Ok` with a non-zero code.
pub(crate) fn run_verify(path: &Path, request: VerifyRequest) -> anyhow::Result<(Value, i32)> {
    let plan = VerifyPlan::resolve(request).map_err(|error| anyhow::anyhow!("{error}"))?;

    let project = super::load_project(&path.to_path_buf())?;

    let runner = if plan.requires_ffmpeg() {
        Some(FFmpegRunner::new(ensure_ffmpeg()?))
    } else {
        None
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("Failed to create Tokio runtime: {error}"))?;

    // Boxed for the same reason `frame::extract_with_project` boxes its probe:
    // `block_on` copies the future it is given through several of its own frames
    // in an unoptimised build, so a wide state machine costs a multiple of its
    // size in stack. Only a pointer travels through those frames now.
    let report = runtime
        .block_on(Box::pin(plan.run(&project.state, runner.as_ref())))
        .map_err(|error| anyhow::anyhow!("{error}"))?;

    let exit_code = i32::from(report.exit_code());
    Ok((report.into_payload(), exit_code))
}

fn flush_stdout() {
    let _ = std::io::stdout().flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// Parses `verify` arguments exactly as the binary's own parser would.
    #[derive(Parser)]
    struct TestCli {
        #[command(flatten)]
        args: VerifyArgs,
    }

    fn parse(arguments: &[&str]) -> VerifyArgs {
        TestCli::try_parse_from(arguments)
            .expect("the arguments parse")
            .args
    }

    /// Feature: Argument names in refusals
    /// Scenario: should name the flag the user typed, not another surface's
    /// JSON field
    #[test]
    fn should_refuse_a_bad_argument_in_the_cli_spelling() {
        for (arguments, expected) in [
            (
                vec!["verify", "--path", "project", "--timeout-sec", "0"],
                "--timeout-sec",
            ),
            (
                vec!["verify", "--path", "project", "--fail-on", "loud"],
                "--fail-on",
            ),
            (
                vec!["verify", "--path", "project", "--duration-tolerance-sec=-1"],
                "--duration-tolerance-sec",
            ),
        ] {
            let (_, request, _) = parse(&arguments).into_request();

            let error = VerifyPlan::resolve(request).expect_err("the argument is invalid");

            assert!(
                error.to_string().contains(expected),
                "expected the refusal to name '{expected}', got: {error}"
            );
        }
    }

    /// Feature: Argument names in the report
    /// Scenario: should nudge a CLI caller towards the flag it can pass
    #[test]
    fn should_nudge_towards_the_file_flag_in_the_cli_spelling() {
        let (_, request, _) = parse(&["verify", "--path", "project"]).into_request();

        assert_eq!(
            request.names.rendered_file_hint,
            "pass --file <RENDER> to run them"
        );
    }
}

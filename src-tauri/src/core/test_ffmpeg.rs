//! FFmpeg discovery for the ignored, FFmpeg-backed library tests.
//!
//! Several tests hand a real FFmpeg the filtergraph the export builds and
//! measure what comes out. They are `#[ignore]`d because they need a binary
//! the machine may not have, and each one used to resolve that binary and
//! quietly `return` when it was missing.
//!
//! A test that skips itself still reports green, so a job that runs the suite
//! without FFmpeg reports the same result as a job that runs it with FFmpeg and
//! passes. `REQUIRE_FFMPEG_TESTS` closes that hole: the CI step that installs
//! FFmpeg sets it, which turns every skip in here into a failure, while a
//! developer without FFmpeg on their machine keeps the quiet skip.
//!
//! This mirrors the CLI end-to-end suite's helper
//! (`crates/openreelio-cli/tests/integration.rs`) so both surfaces behave
//! identically.

use std::path::PathBuf;

/// Environment override naming the FFmpeg binary the tests should use.
const FFMPEG_PATH_ENV: &str = "OPENREELIO_FFMPEG_PATH";

/// Environment flag that turns a quiet skip into a failure.
const REQUIRE_FFMPEG_TESTS_ENV: &str = "REQUIRE_FFMPEG_TESTS";

/// Whether `REQUIRE_FFMPEG_TESTS` carrying `value` demands that the tests run.
///
/// Split out from the environment lookup so the reading of the flag can be
/// asserted without mutating the environment of a running test binary.
fn require_flag_demands_a_run(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
    })
}

/// Whether a missing FFmpeg must fail the run rather than quietly skip it.
fn ffmpeg_tests_are_required() -> bool {
    require_flag_demands_a_run(std::env::var(REQUIRE_FFMPEG_TESTS_ENV).ok().as_deref())
}

/// Records a skip, or fails when FFmpeg was supposed to be available.
#[track_caller]
pub(crate) fn skip_without_ffmpeg(reason: &str) {
    assert!(
        !ffmpeg_tests_are_required(),
        "REQUIRE_FFMPEG_TESTS is set, so this test must run, but {reason}"
    );
    eprintln!("Skipping test: {reason}");
}

/// The FFmpeg binary the tests should use: the override, else whatever `ffmpeg`
/// resolves to on `PATH`.
fn ffmpeg_binary() -> PathBuf {
    std::env::var_os(FFMPEG_PATH_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

/// An FFmpeg binary that has been proven to launch, or `None` after recording a skip.
///
/// Use it as the first line of an FFmpeg-backed test:
///
/// ```ignore
/// let Some(ffmpeg) = require_or_skip_ffmpeg() else {
///     return;
/// };
/// ```
///
/// With `REQUIRE_FFMPEG_TESTS` set this panics instead of returning `None`, so
/// the test cannot pass without having run.
#[track_caller]
pub(crate) fn require_or_skip_ffmpeg() -> Option<PathBuf> {
    let binary = ffmpeg_binary();

    let mut cmd = std::process::Command::new(&binary);
    crate::core::process::configure_std_command(&mut cmd);
    let probe = cmd.args(["-hide_banner", "-version"]).output();

    match probe {
        Ok(output) if output.status.success() => Some(binary),
        Ok(output) => {
            skip_without_ffmpeg(&format!(
                "`{} -version` exited with {}",
                binary.display(),
                output.status
            ));
            None
        }
        Err(error) => {
            skip_without_ffmpeg(&format!(
                "`{}` could not be launched: {error}",
                binary.display()
            ));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feature: FFmpeg-backed tests in CI
    /// Scenario: the require flag is read the way the CLI suite reads it
    ///
    /// The two suites are set from the same workflow variable, so a disagreement
    /// over what counts as "set" would leave one of them skipping while the
    /// other ran.
    #[test]
    fn the_require_flag_is_read_the_same_way_as_the_cli_suite() {
        for value in ["1", "true", "TRUE", "yes"] {
            assert!(
                require_flag_demands_a_run(Some(value)),
                "`REQUIRE_FFMPEG_TESTS={value}` must require the tests to run"
            );
        }

        for value in ["", "0", "false", "False"] {
            assert!(
                !require_flag_demands_a_run(Some(value)),
                "`REQUIRE_FFMPEG_TESTS={value}` must leave the quiet skip in place"
            );
        }

        assert!(
            !require_flag_demands_a_run(None),
            "an unset flag must leave the quiet skip in place"
        );
    }
}

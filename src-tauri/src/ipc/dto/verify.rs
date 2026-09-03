//! Verification request and result shapes for the in-app agent bridge.
//!
//! `verify` is the agent's self-check — deterministic QC over the project
//! state, and over a rendered file when one is named — and until now it existed
//! only in the CLI and its MCP server. An agent running inside the app could
//! make an edit and look at it, but had no way to ask whether the edit was
//! *sound*: gaps, orphaned clips, captions off the safe area, black or frozen
//! program, loudness and true peak. This is the request it sends and the result
//! it gets back.
//!
//! The engine is [`crate::core::qc::verify`], shared verbatim with the CLI, so
//! the two surfaces cannot disagree about what a verdict is. What lives here is
//! the boundary the app adds around it: the translation into the engine's
//! request and the confinement of a caller-supplied render path. It is
//! deliberately Tauri-free, so all of that is unit-testable — `ipc::commands`
//! is not compiled into the test build, and the command itself is a thin caller
//! of what is here.
//!
//! # Scope
//!
//! A `file` to measure is confined to the project directory, because it is a
//! caller-supplied path handed straight to FFmpeg. It shares
//! [`confine_probe_file`] with the frame probe rather than restating the rules:
//! the two arguments have the same shape, the same threat model, and must be
//! refused in the same words — including the deliberately identical message for
//! "outside the project" and "not there at all", which is what stops the
//! argument becoming a whole-disk existence oracle.

use std::path::PathBuf;

use crate::core::qc::verify::{VerifyPlan, VerifyRequest, DEFAULT_MEASURE_TIMEOUT_SEC};

pub(crate) use super::frame_probe::confine_probe_file;

/// What to verify, as the in-app agent bridge expresses it.
///
/// Mirrors [`VerifyRequest`] field for field, with `file` as a string the app
/// confines rather than a path it trusts, and with `failOn` and `timeoutSec`
/// optional so `{}` is a complete request: verify the active sequence
/// structurally, failing on error-or-worse.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VerifySequenceRequestDto {
    /// Sequence to verify; the project's active sequence when absent.
    #[serde(default)]
    pub sequence: Option<String>,
    /// Rendered video inside the project to measure.
    ///
    /// Without it only structural checks run and FFmpeg is never invoked.
    /// Measured times are file-relative and compared against timeline times, so
    /// this should be a render of the whole sequence from timeline zero.
    #[serde(default)]
    pub file: Option<String>,
    /// Run structural checks only and never touch FFmpeg.
    #[serde(default)]
    pub structural_only: bool,
    /// Run only these check IDs.
    #[serde(default)]
    pub checks: Option<Vec<String>>,
    /// Skip these check IDs.
    #[serde(default)]
    pub skip: Option<Vec<String>>,
    /// Integrated loudness target in LUFS.
    #[serde(default)]
    pub target_lufs: Option<f64>,
    /// Maximum acceptable true peak in dBTP.
    #[serde(default)]
    pub max_true_peak: Option<f64>,
    /// Divergence tolerated between the rendered file and the sequence, in seconds.
    #[serde(default)]
    pub duration_tolerance_sec: Option<f64>,
    /// Lowest severity that fails the run: `info`, `warning`, `error` (default)
    /// or `critical`.
    #[serde(default)]
    pub fail_on: Option<String>,
    /// Timeout for the rendered-file measurement pass, in seconds.
    #[serde(default)]
    pub timeout_sec: Option<u64>,
}

/// A finished verification.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VerifySequenceResultDto {
    /// The QC report — the same object `openreelio-cli verify` prints.
    ///
    /// Passed through verbatim rather than re-typed, so the checks, violations,
    /// suggested fixes and measurements an agent reasons over are identical on
    /// every surface and cannot drift as the rule set grows.
    pub payload: serde_json::Value,
    /// `0` clean, `1` the `failOn` threshold was breached, `2` the run could
    /// not complete — the same grading the CLI exits with.
    ///
    /// The payload's own `status`, `passed` and per-check outcomes say the same
    /// thing in more detail; this is the one-glance verdict a loop branches on.
    pub exit_code: u8,
}

impl VerifySequenceRequestDto {
    /// Turns the request into the engine's own, with `file` already confined.
    ///
    /// `file` is the confined path, not the string the caller sent: confinement
    /// canonicalizes, and handing the engine anything else would measure a
    /// different file from the one that was checked.
    pub(crate) fn into_request(self, file: Option<PathBuf>) -> VerifyRequest {
        VerifyRequest {
            sequence: self.sequence,
            file,
            structural_only: self.structural_only,
            checks: self.checks,
            skip: self.skip,
            target_lufs: self.target_lufs,
            max_true_peak: self.max_true_peak,
            duration_tolerance_sec: self.duration_tolerance_sec,
            fail_on: self
                .fail_on
                .unwrap_or_else(|| crate::core::qc::verify::DEFAULT_FAIL_ON.to_string()),
            timeout_sec: self.timeout_sec.unwrap_or(DEFAULT_MEASURE_TIMEOUT_SEC),
        }
    }
}

/// Validates a bridge request and builds the plan that will run it.
///
/// Separated from the command so the argument rules are unit-testable, and
/// ordered so a caller learns its arguments are wrong before anything is paid
/// for — in particular before FFmpeg is resolved, which a structural run must
/// never need.
pub fn plan_verify_sequence(
    request: VerifySequenceRequestDto,
    file: Option<PathBuf>,
) -> Result<VerifyPlan, String> {
    VerifyPlan::resolve(request.into_request(file)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::qc::Severity;

    /// Feature: The bridge request
    /// Scenario: should treat an empty request as a structural run of the
    /// active sequence
    #[test]
    fn should_accept_an_empty_request() {
        let request: VerifySequenceRequestDto =
            serde_json::from_str("{}").expect("an empty object is a complete request");

        let plan = plan_verify_sequence(request, None).expect("plan resolves");

        assert!(
            !plan.requires_ffmpeg(),
            "a structural run must not need FFmpeg"
        );
        assert!(plan.rendered_file().is_none());
        assert_eq!(plan.fail_on(), Severity::Error);
        assert!(
            !plan.selected_checks().is_empty(),
            "an empty request must still run the default check set"
        );
    }

    /// Feature: The bridge request
    /// Scenario: should read every field the bridge sends in camelCase
    #[test]
    fn should_read_the_camel_case_wire_shape() {
        let request: VerifySequenceRequestDto = serde_json::from_value(serde_json::json!({
            "sequence": "seq_1",
            "structuralOnly": true,
            "checks": ["timeline.gap"],
            "skip": ["shot.length_stats"],
            "targetLufs": -16.0,
            "maxTruePeak": -2.0,
            "durationToleranceSec": 0.04,
            "failOn": "warning",
            "timeoutSec": 30,
        }))
        .expect("the wire shape parses");

        assert_eq!(request.sequence.as_deref(), Some("seq_1"));
        assert_eq!(request.target_lufs, Some(-16.0));
        assert_eq!(request.timeout_sec, Some(30));

        let plan = plan_verify_sequence(request, None).expect("plan resolves");
        assert_eq!(plan.fail_on(), Severity::Warning);
        assert_eq!(
            plan.selected_checks(),
            ["timeline.gap"],
            "checks and skip must both reach the engine"
        );
    }

    /// Feature: Threshold selection
    /// Scenario: should reject a threshold that names no severity
    #[test]
    fn should_reject_an_unknown_fail_on_threshold() {
        for (raw, expected) in [
            ("info", Some(Severity::Info)),
            ("WARNING", Some(Severity::Warning)),
            (" error ", Some(Severity::Error)),
            ("critical", Some(Severity::Critical)),
            ("loud", None),
            ("", None),
        ] {
            let request = VerifySequenceRequestDto {
                fail_on: Some(raw.to_string()),
                ..Default::default()
            };

            match (plan_verify_sequence(request, None), expected) {
                (Ok(plan), Some(severity)) => assert_eq!(plan.fail_on(), severity),
                (Err(error), None) => assert!(
                    error.contains("failOn"),
                    "the refusal should name the argument, got: {error}"
                ),
                (Ok(_), None) => panic!("'{raw}' must not be accepted as a threshold"),
                (Err(error), Some(_)) => panic!("'{raw}' must be accepted, got: {error}"),
            }
        }
    }

    /// Feature: Request validation
    /// Scenario: should refuse to both measure a file and skip measuring
    #[test]
    fn should_reject_a_file_with_structural_only() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let file = temp.path().join("render.mp4");
        std::fs::write(&file, b"render").expect("write render");

        let request = VerifySequenceRequestDto {
            structural_only: true,
            ..Default::default()
        };

        let error = plan_verify_sequence(request, Some(file)).expect_err("contradictory arguments");
        assert!(error.contains("structuralOnly"));
    }

    /// Feature: Rendered-file confinement
    /// Scenario: should accept a render inside the project and reject the rest
    #[test]
    fn should_confine_the_rendered_file_to_the_project() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join("exports")).expect("project");
        std::fs::write(project.join("exports").join("cut.mp4"), b"render").expect("render");
        let outside = temp.path().join("outside.mp4");
        std::fs::write(&outside, b"render").expect("outside render");
        let canonical = std::fs::canonicalize(&project).expect("canonical project");

        let inside = confine_probe_file(&canonical, "exports/cut.mp4").expect("a render inside");
        let plan = plan_verify_sequence(VerifySequenceRequestDto::default(), Some(inside.clone()))
            .expect("plan resolves");
        assert!(plan.requires_ffmpeg());
        assert_eq!(plan.rendered_file(), Some(inside.as_path()));

        for escape in [
            outside.to_string_lossy().to_string(),
            "../outside.mp4".to_string(),
            "exports/../../outside.mp4".to_string(),
            r"\\attacker\share\cut.mp4".to_string(),
            "//attacker/share/cut.mp4".to_string(),
            "https://example.com/cut.mp4".to_string(),
            "  ".to_string(),
            r"C:exports\cut.mp4".to_string(),
        ] {
            assert!(
                confine_probe_file(&canonical, &escape).is_err(),
                "'{escape}' must not be measurable through verify"
            );
        }
    }

    /// Feature: Rendered-file confinement
    /// Scenario: should refuse a missing file and an out-of-scope file alike
    ///
    /// Distinguishable refusals turn the argument into a whole-disk existence
    /// oracle: ask for a path, read which way it was refused.
    #[test]
    fn should_not_report_whether_an_out_of_scope_file_exists() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).expect("project");
        let existing_outside = temp.path().join("secret.mp4");
        std::fs::write(&existing_outside, b"render").expect("outside render");
        let canonical = std::fs::canonicalize(&project).expect("canonical project");

        let outside = confine_probe_file(&canonical, &existing_outside.to_string_lossy())
            .expect_err("a render outside the project must be refused");
        let missing = confine_probe_file(&canonical, "never_rendered.mp4")
            .expect_err("a render that was never produced must be refused");

        assert!(outside.ends_with("must resolve inside the project directory"));
        assert_eq!(
            missing, "file 'never_rendered.mp4' must resolve inside the project directory",
            "the refusal must not say whether the file exists"
        );
        for message in [&outside, &missing] {
            assert!(
                !message.contains(&canonical.to_string_lossy().to_string()),
                "the refusal must not leak the canonical project path: {message}"
            );
        }
    }

    /// Feature: Rendered-file confinement
    /// Scenario: should refuse a symlink inside the project that points out of it
    #[cfg(windows)]
    #[test]
    fn should_refuse_a_symlink_that_escapes_the_project() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).expect("project");
        let outside = temp.path().join("outside.mp4");
        std::fs::write(&outside, b"render").expect("outside render");
        let canonical = std::fs::canonicalize(&project).expect("canonical project");

        let link = project.join("linked.mp4");
        // Symlink creation needs Developer Mode or elevation on Windows; when it
        // is unavailable there is nothing to prove here.
        if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
            return;
        }

        assert!(
            confine_probe_file(&canonical, "linked.mp4").is_err(),
            "a link out of the project must be refused by resolution, not by spelling"
        );
    }

    /// Feature: The result shape
    /// Scenario: should carry the report verbatim under a camelCase envelope
    #[test]
    fn should_serialize_the_result_without_reshaping_the_report() {
        let payload = serde_json::json!({
            "status": "failed",
            "passed": false,
            "checks": [{ "id": "timeline.gap", "status": "failed" }],
        });
        let result = VerifySequenceResultDto {
            payload: payload.clone(),
            exit_code: 1,
        };

        let encoded = serde_json::to_value(&result).expect("result serializes");

        assert_eq!(encoded["payload"], payload);
        assert_eq!(encoded["exitCode"], 1);
    }

    /// Feature: Path confinement reuse
    /// Scenario: should refuse a request whose confined file is not there
    ///
    /// Confinement resolves the path, so a file it accepted exists. This covers
    /// the other direction — a caller that skipped confinement gets the engine's
    /// own refusal rather than an FFmpeg failure minutes later.
    #[test]
    fn should_reject_a_rendered_file_that_is_not_there() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let missing = temp.path().join("never_rendered.mp4");

        let error = plan_verify_sequence(VerifySequenceRequestDto::default(), Some(missing))
            .expect_err("a missing render is an error");

        assert!(
            error.contains("does not exist"),
            "expected a missing-file message, got: {error}"
        );
    }
}

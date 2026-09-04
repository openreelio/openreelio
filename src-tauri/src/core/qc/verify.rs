//! Deterministic QC for a sequence, with or without a rendered file.
//!
//! `verify` is the agent's self-check: it runs the shared QC engine over the
//! project state and, when a rendered file is supplied, over measurements taken
//! from that file. Every check that ran appears in the output — including the
//! ones that passed — because an agent cannot act on a report that silently
//! omits what it did not look at.
//!
//! This is the engine behind `openreelio-cli verify`, the `openreelio.verify`
//! MCP tool and the GUI's `verify_sequence` command. It is deliberately
//! Tauri-free and takes its project state and FFmpeg runner by parameter, so
//! the CLI keeps only argument parsing, project loading and FFmpeg resolution,
//! and the three surfaces cannot disagree about what a verdict is.
//!
//! # Exit codes
//!
//! [`EXIT_THRESHOLD_BREACHED`] means the report breached the caller's
//! `fail_on` threshold, [`EXIT_TOOL_FAILURE`] means the tool itself failed —
//! an unreadable file, an FFmpeg failure, or a rule that errored, leaving the
//! verdict incomplete — and `0` means neither happened. A caller with nowhere
//! honest to put a process code (an MCP result, an IPC reply) can ignore it:
//! the document carries `status`, `passed` and the per-check outcomes.
//!
//! # Two meanings of "passed"
//!
//! Two different questions share the word, and the document keeps them apart.
//! Per check, `status`/`passed` answer "did this check find anything?" —
//! `passed` is true only for a check that ran and reported nothing, and a check
//! with warning- or info-level findings reports `warned` (see [`CheckStatus`]).
//! At the top level, `status`/`passed` answer "is the report a failing
//! verdict?" — driven by severity, so warnings and info leave `passed` true and
//! only error-or-worse findings (or a tool error) turn it false. A report can
//! therefore pass overall while individual checks are `warned`.
//!
//! # Timebases
//!
//! Measurement times are file-relative while structural findings are
//! timeline-relative. The two are compared directly (see
//! [`crossref_black_ranges_with_gaps`]), so a `file` is expected to be a render
//! of the whole sequence from timeline zero; a partial render still measures
//! correctly but its timestamps no longer line up with the timeline.

use super::{
    crossref_black_ranges_with_gaps, measure_rendered_file_detailed, MeasureOptions,
    MeasurementReport, QCContext, QCEngine, QCEngineConfig, QCReport, QCSeverityFilter, RuleStatus,
    Severity, ViolationFix,
};
use crate::core::ffmpeg::FFmpegRunner;
use crate::core::project::ProjectState;
use crate::core::timeline::Sequence;
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Exit code for a report that breached the `fail_on` threshold.
pub const EXIT_THRESHOLD_BREACHED: u8 = 1;

/// Exit code for a failure of the tool itself.
pub const EXIT_TOOL_FAILURE: u8 = 2;

/// Severity threshold applied when the caller names none.
pub const DEFAULT_FAIL_ON: &str = "error";

/// Timeout for the rendered-file measurement pass when the caller names none.
pub const DEFAULT_MEASURE_TIMEOUT_SEC: u64 = 600;

/// Checks that are disabled unless explicitly requested via `checks`.
///
/// Both encode expectations `verify` cannot confirm on its own: licence
/// paperwork lives outside the project file, and duration limits depend on the
/// delivery platform. Left on by default they would fail every healthy project.
pub const OPT_IN_CHECK_IDS: &[&str] = &["asset.license", "sequence.duration"];

/// Check ID of the loudness rule, wired to `target_lufs`.
const LOUDNESS_CHECK_ID: &str = "audio.loudness";

/// Check ID of the peak rule, wired to `max_true_peak`.
const PEAK_CHECK_ID: &str = "audio.peak";

/// Check ID of the render-length rule, wired to `duration_tolerance_sec`.
const DURATION_CHECK_ID: &str = "render.duration_mismatch";

/// Why a verification could not be run as asked.
///
/// Callers read the message; only a surface that has to *re-word* a refusal
/// needs the kind. The one that does is the in-app bridge, which must not
/// repeat a resolved path back to an external agent — see
/// [`VerifyErrorKind::MissingRenderedFile`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyErrorKind {
    /// An argument was missing, malformed, or contradicted another one.
    InvalidArgument,
    /// The rendered file named by `file` was not there when the plan resolved.
    ///
    /// Kept apart from every other refusal because the message names the path:
    /// harmless for a CLI caller that typed it, but a surface whose path was
    /// resolved on the caller's behalf has to say so in its own words.
    MissingRenderedFile,
}

/// A verification that could not be run as asked.
///
/// From a caller's point of view verification has one failure mode — the
/// request could not be served — and the message says which part of it could
/// not be, in terms the caller can act on. Every surface wraps it the same way:
/// the CLI prints the message and exits [`EXIT_TOOL_FAILURE`], the MCP server
/// returns it as a tool error, the IPC command as an error string.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct VerifyError {
    message: String,
    kind: VerifyErrorKind,
}

impl VerifyError {
    /// Builds an argument error from an already-formatted, caller-facing message.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            kind: VerifyErrorKind::InvalidArgument,
        }
    }

    /// Builds the refusal for a `file` that is not on disk.
    pub fn missing_rendered_file(file: &Path) -> Self {
        Self {
            message: format!("Rendered file '{}' does not exist", file.display()),
            kind: VerifyErrorKind::MissingRenderedFile,
        }
    }

    /// What kind of refusal this is, for a surface that must re-word it.
    pub fn kind(&self) -> VerifyErrorKind {
        self.kind
    }
}

/// Result of a verification operation.
pub type VerifyResult<T> = Result<T, VerifyError>;

/// How one surface spells `verify`'s arguments back to its own caller.
///
/// The engine is shared by three surfaces that name the same argument three
/// ways — `--timeout-sec` on the command line, `timeoutSec` in an MCP payload
/// or an IPC request — and a refusal that names an argument the caller cannot
/// type is a refusal it cannot act on. Every "Invalid value for …" message is
/// built from these labels, so each surface refuses in its own vocabulary
/// without the rules themselves being restated per surface.
///
/// Build one with [`VerifyArgumentNames::cli`] or [`VerifyArgumentNames::api`];
/// the fields are public so a fourth surface can spell an argument its own way
/// without a new constructor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VerifyArgumentNames {
    /// Name of the severity-threshold argument.
    pub fail_on: &'static str,
    /// Name of the measurement-timeout argument.
    pub timeout_sec: &'static str,
    /// Name of the check-selection argument.
    pub checks: &'static str,
    /// Name of the loudness-target argument.
    pub target_lufs: &'static str,
    /// Name of the true-peak-ceiling argument.
    pub max_true_peak: &'static str,
    /// Name of the render-length-tolerance argument.
    pub duration_tolerance_sec: &'static str,
    /// Name of the rendered-file argument.
    pub file: &'static str,
    /// Name of the structural-only switch.
    pub structural_only: &'static str,
    /// How to ask this surface for the rendered measurement pass, as a phrase
    /// the report's warning about skipped rendered checks ends with.
    pub rendered_file_hint: &'static str,
}

impl VerifyArgumentNames {
    /// The `openreelio-cli verify` spelling: long flags, as clap accepts them.
    pub const fn cli() -> Self {
        Self {
            fail_on: "--fail-on",
            timeout_sec: "--timeout-sec",
            checks: "--checks",
            target_lufs: "--target-lufs",
            max_true_peak: "--max-true-peak",
            duration_tolerance_sec: "--duration-tolerance-sec",
            file: "--file",
            structural_only: "--structural-only",
            rendered_file_hint: "pass --file <RENDER> to run them",
        }
    }

    /// The JSON spelling shared by the MCP tool and the in-app IPC request.
    pub const fn api() -> Self {
        Self {
            fail_on: "failOn",
            timeout_sec: "timeoutSec",
            checks: "checks",
            target_lufs: "targetLufs",
            max_true_peak: "maxTruePeak",
            duration_tolerance_sec: "durationToleranceSec",
            file: "file",
            structural_only: "structuralOnly",
            rendered_file_hint: "name a rendered file (file) to run them",
        }
    }
}

/// The JSON spelling, because two of the three surfaces speak it and a request
/// built field by field is far more likely to be one of those than the CLI's.
impl Default for VerifyArgumentNames {
    fn default() -> Self {
        Self::api()
    }
}

/// What to verify, exactly as the caller expressed it.
///
/// Field names mirror the CLI flags they came from. What makes a combination
/// legal is enforced by [`VerifyPlan::resolve`] rather than by the type,
/// because every surface — clap, MCP JSON, an IPC DTO — has to be told the same
/// thing in the same words.
#[derive(Clone, Debug)]
pub struct VerifyRequest {
    /// Sequence to verify; the project's active sequence when absent.
    pub sequence: Option<String>,
    /// Rendered file to measure; without it only structural checks run.
    pub file: Option<PathBuf>,
    /// Run structural checks only and never touch FFmpeg.
    pub structural_only: bool,
    /// Run only these check IDs.
    pub checks: Option<Vec<String>>,
    /// Skip these check IDs.
    pub skip: Option<Vec<String>>,
    /// Integrated loudness target in LUFS.
    pub target_lufs: Option<f64>,
    /// Maximum acceptable true peak in dBTP.
    pub max_true_peak: Option<f64>,
    /// Divergence tolerated between the rendered file and the sequence, in
    /// seconds; honoured exactly, so a tighter value really is tighter.
    pub duration_tolerance_sec: Option<f64>,
    /// Lowest severity that fails the run: info, warning, error, critical.
    pub fail_on: String,
    /// Timeout for the rendered-file measurement pass, in seconds.
    pub timeout_sec: u64,
    /// How the calling surface spells these arguments when it has to name one
    /// in a refusal or a warning.
    pub names: VerifyArgumentNames,
}

impl Default for VerifyRequest {
    fn default() -> Self {
        Self {
            sequence: None,
            file: None,
            structural_only: false,
            checks: None,
            skip: None,
            target_lufs: None,
            max_true_peak: None,
            duration_tolerance_sec: None,
            fail_on: DEFAULT_FAIL_ON.to_string(),
            timeout_sec: DEFAULT_MEASURE_TIMEOUT_SEC,
            names: VerifyArgumentNames::api(),
        }
    }
}

/// A verification whose request has been validated and turned into engine
/// configuration.
///
/// Resolving is separate from running so a caller learns that its arguments are
/// wrong before it pays for anything: reading the project, and above all
/// resolving FFmpeg, which a structural-only run must never need. That is also
/// why the rendered file's existence is settled here — a caller asks
/// [`requires_ffmpeg`](Self::requires_ffmpeg) only once the file it would
/// measure is known to be there, so "the file is missing" never arrives dressed
/// as "FFmpeg is missing".
pub struct VerifyPlan {
    request: VerifyRequest,
    fail_on: Severity,
    engine: QCEngine,
    config: QCEngineConfig,
    selected_ids: Vec<String>,
}

/// Printed by hand because [`QCEngine`] holds its rules as trait objects and
/// is not `Debug`. A plan is worth printing when a test or a log wants to say
/// what was about to run, and the engine is the one part of it that carries no
/// information the caller supplied.
impl std::fmt::Debug for VerifyPlan {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VerifyPlan")
            .field("request", &self.request)
            .field("fail_on", &self.fail_on)
            .field("selected_checks", &self.selected_ids)
            .finish_non_exhaustive()
    }
}

impl VerifyPlan {
    /// Validates a request and builds the engine configuration it describes.
    ///
    /// Every rejection here is a caller error worth [`EXIT_TOOL_FAILURE`]: an
    /// unknown check ID, a threshold name that names no severity, a selection
    /// that would leave nothing enabled.
    pub fn resolve(request: VerifyRequest) -> VerifyResult<Self> {
        let names = request.names;
        let fail_on = parse_severity(&request.fail_on, names.fail_on)?;
        if request.timeout_sec == 0 {
            return Err(VerifyError::new(format!(
                "Invalid value for {}: must be >= 1",
                names.timeout_sec
            )));
        }
        if request.file.is_some() && request.structural_only {
            return Err(VerifyError::new(format!(
                "{} and {} cannot be combined",
                names.file, names.structural_only
            )));
        }

        let engine = QCEngine::new();
        let config = build_engine_config(&engine, &request)?;
        let selected_ids = enabled_check_ids(&engine, &config);

        // Checked before the caller resolves FFmpeg, so a typo'd path reads as
        // a typo'd path rather than as a missing toolchain.
        if let Some(file) = request.file.as_ref() {
            if !file.exists() {
                return Err(VerifyError::missing_rendered_file(file));
            }
        }

        Ok(Self {
            request,
            fail_on,
            engine,
            config,
            selected_ids,
        })
    }

    /// The severity at which a finding becomes a failing verdict.
    pub fn fail_on(&self) -> Severity {
        self.fail_on
    }

    /// Whether running this plan will spawn FFmpeg.
    ///
    /// False for a structural run, which must work on a machine that has no
    /// FFmpeg at all.
    pub fn requires_ffmpeg(&self) -> bool {
        self.request.file.is_some()
    }

    /// The rendered file this plan will measure, if any.
    pub fn rendered_file(&self) -> Option<&Path> {
        self.request.file.as_deref()
    }

    /// The check IDs this plan leaves enabled.
    pub fn selected_checks(&self) -> &[String] {
        &self.selected_ids
    }

    /// Runs the checks and assembles the report.
    ///
    /// `runner` is required exactly when [`requires_ffmpeg`](Self::requires_ffmpeg)
    /// says so. A measurement that fails does not abandon the run: the
    /// structural half of the report is still worth emitting, and the failure
    /// is recorded in `errors` and in the exit code.
    pub async fn run(
        &self,
        state: &ProjectState,
        runner: Option<&FFmpegRunner>,
    ) -> VerifyResult<VerifyReport> {
        let sequence_id = resolve_sequence_id(state, self.request.sequence.as_deref())?;
        let sequence = state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| VerifyError::new(format!("Sequence '{}' not found", sequence_id)))?;

        self.engine.set_config(self.config.clone()).await;

        let mut warnings: Vec<String> = Vec::new();
        let mut errors: Vec<String> = Vec::new();
        let mut measurement: Option<MeasurementReport> = None;

        if let Some(file) = self.request.file.as_ref() {
            // FFmpeg is only required once a rendered file is in play; the
            // caller was told as much by `requires_ffmpeg`, so arriving here
            // without a runner is a wiring bug rather than a missing install.
            let runner = runner
                .ok_or_else(|| VerifyError::new("FFmpeg is required to measure a rendered file"))?;
            let options = MeasureOptions {
                timeout: Duration::from_secs(self.request.timeout_sec),
                ..Default::default()
            };

            match measure_rendered_file_detailed(runner, file, &options).await {
                Ok(report) => {
                    warnings.extend(report.notes.iter().cloned());
                    measurement = Some(report);
                }
                Err(error) => {
                    errors.push(format!("Rendered-file measurement failed: {error}"));
                }
            }
        }

        let measurement_failed = self.request.file.is_some() && measurement.is_none();

        let mut report = match measurement.as_ref() {
            Some(measured) => {
                self.engine
                    .check_with_measurements(sequence, state, measured.measurements.clone())
                    .await
            }
            None => self.engine.check(sequence, state).await,
        }
        .map_err(|error| VerifyError::new(error.to_string()))?;

        // Black pixels only become an error once they are known to sit over a
        // hole in the timeline, which needs both halves of the report. The
        // tolerance is the same one the rules use, so it comes from the shared
        // context rather than a second definition of "one frame".
        let frame_duration_sec = QCContext::from_sequence(sequence).frame_duration_sec();
        crossref_black_ranges_with_gaps(&mut report, sequence, frame_duration_sec);

        for failure in &report.errored_rules {
            errors.push(format!(
                "Check '{}' failed to run: {}",
                failure.rule_name, failure.message
            ));
        }

        let payload = build_output(
            OutputInputs {
                sequence,
                sequence_id: &sequence_id,
                report: &report,
                engine: &self.engine,
                selected_ids: &self.selected_ids,
                measurement: measurement.as_ref(),
                rendered_file: self.request.file.as_deref(),
                structural_only: self.request.structural_only,
                rendered_file_hint: self.request.names.rendered_file_hint,
            },
            warnings,
            errors,
        );

        Ok(VerifyReport {
            payload,
            exit_code: exit_code_for(&report, self.fail_on, measurement_failed),
        })
    }
}

/// A finished verification: the document, and the verdict as a process code.
#[derive(Clone, Debug)]
pub struct VerifyReport {
    payload: Value,
    exit_code: u8,
}

impl VerifyReport {
    /// The JSON document — the same object every surface hands its caller.
    pub fn payload(&self) -> &Value {
        &self.payload
    }

    /// Takes the JSON document, for a caller that only forwards it.
    pub fn into_payload(self) -> Value {
        self.payload
    }

    /// `0`, [`EXIT_THRESHOLD_BREACHED`] or [`EXIT_TOOL_FAILURE`].
    pub fn exit_code(&self) -> u8 {
        self.exit_code
    }
}

/// Grades a finished QC run into a process exit code.
///
/// A breach outranks an incomplete run on purpose: a caller that was told
/// "threshold breached" acts on the findings, whereas "the tool failed" sends
/// it looking at its own invocation. When both are true the findings are the
/// more actionable answer, and `errors` in the document still names the
/// failure.
pub fn exit_code_for(report: &QCReport, fail_on: Severity, measurement_failed: bool) -> u8 {
    let breached = report
        .violations
        .iter()
        .any(|violation| violation.severity.meets_threshold(fail_on));

    if breached {
        EXIT_THRESHOLD_BREACHED
    } else if measurement_failed || !report.errored_rules.is_empty() {
        EXIT_TOOL_FAILURE
    } else {
        0
    }
}

// ── Configuration ───────────────────────────────────────────────────────

/// Picks the sequence to verify, defaulting to the project's active one.
///
/// # Why this is not shared
///
/// Two other resolvers apply the same rule — take the caller's id, else the
/// active one, else refuse with the same sentence:
///
/// * `frame_probe::resolve_sequence` also looks the sequence up and reports
///   through `FrameProbeError`, so its signature is not this one's.
/// * `openreelio_cli::commands::resolve_sequence_id_in_state` reports through
///   `anyhow` and lives in a crate that depends on this one, so nothing here
///   can call it.
///
/// Collapsing the three needs a resolver that returns no error at all — an
/// `Option<String>` accessor on [`ProjectState`] that each surface wraps in its
/// own error type. That belongs in the project state module rather than in any
/// one of its callers, so this copy stands until that accessor exists; the
/// duplicated part is then a single `ok_or_else`.
fn resolve_sequence_id(state: &ProjectState, explicit: Option<&str>) -> VerifyResult<String> {
    explicit
        .map(str::to_string)
        .or_else(|| state.active_sequence_id.clone())
        .ok_or_else(|| VerifyError::new("No sequence specified and no active sequence set"))
}

/// Parses a severity threshold name, refusing in the caller's own vocabulary.
///
/// Private: every surface (clap, MCP JSON, the in-app IPC bridge) hands the raw
/// `failOn` string to [`VerifyRequest`] and lets this module do the parsing, so
/// there is no caller outside it and nothing to widen the visibility for.
fn parse_severity(raw: &str, argument: &str) -> VerifyResult<Severity> {
    match raw.trim().to_lowercase().as_str() {
        "info" => Ok(Severity::Info),
        "warning" | "warn" => Ok(Severity::Warning),
        "error" => Ok(Severity::Error),
        "critical" => Ok(Severity::Critical),
        other => Err(VerifyError::new(format!(
            "Invalid value for {}: expected info, warning, error, or critical (got '{}')",
            argument, other
        ))),
    }
}

/// Builds the engine configuration from the selection and threshold arguments.
fn build_engine_config(engine: &QCEngine, request: &VerifyRequest) -> VerifyResult<QCEngineConfig> {
    let names = request.names;
    let mut config = QCEngineConfig {
        // Informational findings carry the metrics agents steer by, so the
        // report keeps every severity and lets `fail_on` decide the verdict.
        severity_filter: QCSeverityFilter::All,
        ..Default::default()
    };

    let known_ids: Vec<String> = engine
        .rules()
        .iter()
        .map(|rule| rule.check_id().to_string())
        .collect();

    if let Some(requested) = request.checks.as_ref() {
        let requested = normalize_ids(requested);
        // An empty selection would disable every rule and report a clean run
        // over nothing checked, which an agent reads as "verified".
        if requested.is_empty() {
            return Err(VerifyError::new(format!(
                "Invalid value for {}: at least one check ID is required",
                names.checks
            )));
        }
        for id in &requested {
            if !known_ids.contains(id) {
                return Err(unknown_check_error(id, &known_ids));
            }
        }
        for rule in engine.rules() {
            if !requested.iter().any(|id| id == rule.check_id()) {
                config.disable_rule(rule.name());
            }
        }
    } else {
        for rule in engine.rules() {
            if OPT_IN_CHECK_IDS.contains(&rule.check_id()) {
                config.disable_rule(rule.name());
            }
        }
    }

    if let Some(skipped) = request.skip.as_ref() {
        for id in normalize_ids(skipped) {
            if !known_ids.contains(&id) {
                return Err(unknown_check_error(&id, &known_ids));
            }
            if let Some(rule) = engine.get_rule_by_check_id(&id) {
                config.disable_rule(rule.name());
            }
        }
    }

    if let Some(target_lufs) = request.target_lufs {
        if !target_lufs.is_finite() {
            return Err(VerifyError::new(format!(
                "Invalid value for {}: must be a finite number",
                names.target_lufs
            )));
        }
        set_param(
            engine,
            &mut config,
            LOUDNESS_CHECK_ID,
            "target_lufs",
            target_lufs,
        );
    }

    if let Some(max_true_peak) = request.max_true_peak {
        if !max_true_peak.is_finite() {
            return Err(VerifyError::new(format!(
                "Invalid value for {}: must be a finite number",
                names.max_true_peak
            )));
        }
        set_param(engine, &mut config, PEAK_CHECK_ID, "peak_db", max_true_peak);
    }

    if let Some(tolerance_sec) = request.duration_tolerance_sec {
        if !tolerance_sec.is_finite() || tolerance_sec < 0.0 {
            return Err(VerifyError::new(format!(
                "Invalid value for {}: must be a finite, non-negative number",
                names.duration_tolerance_sec
            )));
        }
        set_param(
            engine,
            &mut config,
            DURATION_CHECK_ID,
            "tolerance_sec",
            tolerance_sec,
        );
    }

    Ok(config)
}

/// Sets a rule parameter, addressed by check ID rather than rule name.
fn set_param(
    engine: &QCEngine,
    config: &mut QCEngineConfig,
    check_id: &str,
    key: &str,
    value: f64,
) {
    let Some(rule) = engine.get_rule_by_check_id(check_id) else {
        return;
    };
    let mut rule_config = config.get_rule_config(rule.name());
    rule_config.set_param(key, value);
    config.set_rule_config(rule.name(), rule_config);
}

/// Trims and lowercases requested check IDs, dropping empty entries.
fn normalize_ids(ids: &[String]) -> Vec<String> {
    ids.iter()
        .map(|id| id.trim().to_lowercase())
        .filter(|id| !id.is_empty())
        .collect()
}

fn unknown_check_error(id: &str, known_ids: &[String]) -> VerifyError {
    VerifyError::new(format!(
        "Unknown check '{}'. Available checks: {}",
        id,
        known_ids.join(", ")
    ))
}

/// Lists the check IDs left enabled by a configuration.
fn enabled_check_ids(engine: &QCEngine, config: &QCEngineConfig) -> Vec<String> {
    engine
        .rules()
        .iter()
        .filter(|rule| config.is_rule_enabled(rule.name()))
        .map(|rule| rule.check_id().to_string())
        .collect()
}

// ── Output ──────────────────────────────────────────────────────────────

/// A time span attached to a check result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimeSpan {
    start_sec: f64,
    end_sec: f64,
}

/// One violation, as reported inside a check entry.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViolationEntry {
    id: String,
    severity: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    time_range: Option<TimeSpan>,
    entities: Vec<String>,
    metrics: Map<String, Value>,
    auto_fixable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    suggested_fix: Option<Value>,
}

/// What a single check concluded.
///
/// `Passed` means the check ran and found nothing at all, which is the only
/// state an agent may read as "clean". A check that ran and produced findings
/// is `Warned` or `Failed` depending on the worst severity among them —
/// never `Passed`, however mild the findings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    /// Ran and found nothing
    Passed,
    /// Ran and found only warning- or info-level issues
    Warned,
    /// Ran and found at least one error or critical issue
    Failed,
    /// Did not run, because it was disabled or its inputs were missing
    Skipped,
    /// Ran and raised an error, leaving its part of the verdict unknown
    Errored,
}

impl CheckStatus {
    /// The wire name reported in the JSON document.
    pub fn as_str(self) -> &'static str {
        match self {
            CheckStatus::Passed => "passed",
            CheckStatus::Warned => "warned",
            CheckStatus::Failed => "failed",
            CheckStatus::Skipped => "skipped",
            CheckStatus::Errored => "errored",
        }
    }

    /// Whether the check ran and found nothing.
    pub fn is_clean(self) -> bool {
        matches!(self, CheckStatus::Passed)
    }

    /// Grades one check from how its rule ended and the worst finding it made.
    ///
    /// The severity of the findings decides between [`CheckStatus::Warned`] and
    /// [`CheckStatus::Failed`]; their mere existence decides against
    /// [`CheckStatus::Passed`].
    pub fn grade(rule_status: RuleStatus, max_severity: Option<Severity>) -> Self {
        match rule_status {
            RuleStatus::Skipped => CheckStatus::Skipped,
            RuleStatus::Errored => CheckStatus::Errored,
            RuleStatus::Ran => match max_severity {
                None => CheckStatus::Passed,
                Some(severity) if severity >= Severity::Error => CheckStatus::Failed,
                Some(_) => CheckStatus::Warned,
            },
        }
    }
}

impl Serialize for CheckStatus {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// One check, whether it passed, warned, failed, was skipped, or errored.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckEntry {
    id: String,
    rule: String,
    category: String,
    status: CheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    severity: Option<String>,
    passed: bool,
    skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    skip_reason: Option<String>,
    message: String,
    violation_count: usize,
    time_ranges: Vec<TimeSpan>,
    entities: Vec<String>,
    metrics: Map<String, Value>,
    auto_fixable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    suggested_fix: Option<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    violations: Vec<ViolationEntry>,
}

/// Everything the output document is assembled from.
struct OutputInputs<'a> {
    sequence: &'a Sequence,
    sequence_id: &'a str,
    report: &'a QCReport,
    engine: &'a QCEngine,
    selected_ids: &'a [String],
    measurement: Option<&'a MeasurementReport>,
    rendered_file: Option<&'a Path>,
    structural_only: bool,
    /// How the calling surface asks for the rendered pass, for the warning
    /// that names the checks it skipped without one.
    rendered_file_hint: &'a str,
}

/// Assembles the report document.
fn build_output(inputs: OutputInputs<'_>, mut warnings: Vec<String>, errors: Vec<String>) -> Value {
    let report = inputs.report;
    let checks = build_checks(report, inputs.engine);
    let skipped_count = checks.iter().filter(|check| check.skipped).count();

    let rendered_skipped = checks
        .iter()
        .filter(|check| check.skipped && check.category == "rendered")
        .count();
    if rendered_skipped > 0 && inputs.rendered_file.is_none() && !inputs.structural_only {
        warnings.push(format!(
            "{} rendered check(s) were skipped; {}",
            rendered_skipped, inputs.rendered_file_hint
        ));
    }

    // The verdict follows the findings, not the diagnostics: a clean run that
    // simply had nothing rendered to inspect is still "ok". This is the
    // severity question, not the "did any check find something" question that
    // each entry's own status answers.
    let status = if !report.passed || !errors.is_empty() {
        "failed"
    } else if report.count(Severity::Warning) > 0 {
        "warning"
    } else {
        "ok"
    };

    serde_json::json!({
        "status": status,
        "passed": report.passed && errors.is_empty(),
        "checkedAt": report.checked_at.to_rfc3339(),
        "durationMs": report.duration_ms,
        "target": {
            "sequenceId": inputs.sequence_id,
            "sequenceName": inputs.sequence.name,
            "renderedFile": inputs.rendered_file.map(|path| path.display().to_string()),
            "measured": inputs.measurement.is_some(),
            "selectedChecks": inputs.selected_ids,
        },
        "summary": {
            "critical": report.count(Severity::Critical),
            "error": report.count(Severity::Error),
            "warning": report.count(Severity::Warning),
            "info": report.count(Severity::Info),
            "skipped": skipped_count,
        },
        "checks": checks,
        "measurements": build_measurements(inputs.measurement, inputs.rendered_file),
        "warnings": warnings,
        "errors": errors,
    })
}

/// Turns the per-rule outcomes and violations into one entry per check.
fn build_checks(report: &QCReport, engine: &QCEngine) -> Vec<CheckEntry> {
    report
        .rule_outcomes
        .iter()
        .map(|outcome| {
            let violations: Vec<_> = report
                .violations
                .iter()
                .filter(|violation| violation.rule_name == outcome.rule_name)
                .collect();

            let max_severity = violations.iter().map(|violation| violation.severity).max();

            // "Ran and found nothing" is the only clean outcome; a check that
            // reported anything at all says so, and the severity says how
            // loudly.
            let status = CheckStatus::grade(outcome.status, max_severity);

            let description = engine
                .get_rule_by_check_id(&outcome.check_id)
                .map(|rule| rule.description().to_string())
                .unwrap_or_default();

            let message = match outcome.status {
                RuleStatus::Skipped => format!(
                    "Skipped: {}",
                    outcome.reason.as_deref().unwrap_or("no reason recorded")
                ),
                RuleStatus::Errored => format!(
                    "Check failed to run: {}",
                    outcome.reason.as_deref().unwrap_or("unknown error")
                ),
                RuleStatus::Ran => match violations.first() {
                    Some(first) if violations.len() == 1 => first.message.clone(),
                    Some(first) => format!("{} findings, e.g. {}", violations.len(), first.message),
                    None => description,
                },
            };

            // Metrics only make sense at check level when a single finding owns
            // them; otherwise they stay on the individual violations.
            let metrics = if violations.len() == 1 {
                to_json_map(&violations[0].metrics)
            } else {
                Map::new()
            };

            let mut entities: Vec<String> = violations
                .iter()
                .flat_map(|violation| violation.affected_entities.iter().cloned())
                .collect();
            entities.sort();
            entities.dedup();

            let suggested_fix = violations
                .iter()
                .find_map(|violation| violation.suggested_fix.as_ref())
                .and_then(to_edit_script);

            CheckEntry {
                id: outcome.check_id.clone(),
                rule: outcome.rule_name.clone(),
                category: outcome.category.to_string(),
                status,
                severity: max_severity.map(|severity| severity_key(severity).to_string()),
                passed: status.is_clean(),
                skipped: matches!(outcome.status, RuleStatus::Skipped),
                skip_reason: match outcome.status {
                    RuleStatus::Skipped => outcome.reason.clone(),
                    _ => None,
                },
                message,
                violation_count: violations.len(),
                time_ranges: violations
                    .iter()
                    .filter_map(|violation| violation.location.as_ref())
                    .map(|range| TimeSpan {
                        start_sec: range.start_sec,
                        end_sec: range.end_sec,
                    })
                    .collect(),
                entities,
                metrics,
                auto_fixable: violations.iter().any(|violation| violation.auto_fixable),
                suggested_fix,
                violations: violations
                    .iter()
                    .map(|violation| ViolationEntry {
                        id: violation.id.clone(),
                        severity: severity_key(violation.severity).to_string(),
                        message: violation.message.clone(),
                        details: violation.details.clone(),
                        time_range: violation.location.as_ref().map(|range| TimeSpan {
                            start_sec: range.start_sec,
                            end_sec: range.end_sec,
                        }),
                        entities: violation.affected_entities.clone(),
                        metrics: to_json_map(&violation.metrics),
                        auto_fixable: violation.auto_fixable,
                        suggested_fix: violation.suggested_fix.as_ref().and_then(to_edit_script),
                    })
                    .collect(),
            }
        })
        .collect()
}

/// Serialises the measurement block, or records that nothing was measured.
fn build_measurements(measurement: Option<&MeasurementReport>, file: Option<&Path>) -> Value {
    let Some(report) = measurement else {
        return serde_json::json!({ "measured": false });
    };

    let measurements = &report.measurements;
    serde_json::json!({
        "measured": true,
        "file": file.map(|path| path.display().to_string()),
        "durationSec": report.duration_sec,
        "videoMeasured": report.video_measured,
        "audioMeasured": report.audio_measured,
        // The stream table itself, so "no picture in the file" is readable
        // rather than inferred from an empty detection list.
        "videoStream": measurements.video_stream().map(|video| serde_json::json!({
            "width": video.width,
            "height": video.height,
            "fps": video.fps,
        })),
        "blackRanges": spans_json(&measurements.black_ranges),
        "freezeRanges": spans_json(&measurements.freeze_ranges),
        "silenceRanges": spans_json(&measurements.silence_ranges),
        "integratedLufs": measurements.integrated_lufs,
        "loudnessRangeLu": measurements.loudness_range_lu,
        "truePeakDbtp": measurements.true_peak_dbtp,
        "samplePeakDb": measurements.sample_peak_db,
        "flatFactor": measurements.flat_factor,
        "notes": report.notes,
    })
}

fn spans_json(ranges: &[(f64, f64)]) -> Vec<Value> {
    ranges
        .iter()
        .map(|(start, end)| serde_json::json!({ "startSec": start, "endSec": end }))
        .collect()
}

/// Lowercase severity key, matching the serde representation of `Severity`.
fn severity_key(severity: Severity) -> &'static str {
    match severity {
        Severity::Info => "info",
        Severity::Warning => "warning",
        Severity::Error => "error",
        Severity::Critical => "critical",
    }
}

fn to_json_map(metrics: &std::collections::BTreeMap<String, Value>) -> Map<String, Value> {
    metrics
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// Converts a QC fix into the plan-step shape `plan execute` accepts.
///
/// QC rules describe fixes as flat `{"type": …, …}` command descriptors; edit
/// plans expect `{"commandType": …, "payload": {…}}`. Translating here keeps the
/// suggestion directly executable instead of merely descriptive.
///
/// Returns `None` when any command cannot be translated: a plan missing steps
/// would still carry the full description and apply only part of the fix. Each
/// step depends on its predecessor so `plan execute` preserves command order.
fn to_edit_script(fix: &ViolationFix) -> Option<Value> {
    let steps: Option<Vec<Value>> = fix
        .commands
        .iter()
        .enumerate()
        .map(|(index, command)| {
            let object = command.as_object()?;
            let command_type = object.get("type")?.as_str()?.to_string();

            let payload: Map<String, Value> = object
                .iter()
                .filter(|(key, _)| key.as_str() != "type")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();

            let depends_on: Vec<String> = if index == 0 {
                Vec::new()
            } else {
                vec![format!("fix_{}", index)]
            };

            Some(serde_json::json!({
                "id": format!("fix_{}", index + 1),
                "commandType": command_type,
                "payload": payload,
                "dependsOn": depends_on,
            }))
        })
        .collect();

    Some(serde_json::json!({
        "description": fix.description,
        "confidence": fix.confidence,
        "steps": steps?,
    }))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::qc::{QCViolation, RenderMeasurements, RuleFailure};
    use crate::core::timeline::{Clip, SequenceFormat, Track};

    /// A request that runs structural checks only, for configuration tests.
    fn structural_request() -> VerifyRequest {
        VerifyRequest {
            structural_only: true,
            ..Default::default()
        }
    }

    /// A two-clip sequence with a gap between the clips.
    fn sequence_with_gap() -> Sequence {
        let mut sequence = Sequence::new("Fix loop", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("V1");
        for timeline_in in [0.0, 4.0] {
            let mut clip = Clip::with_range("asset_1", 0.0, 2.0);
            clip.place.timeline_in_sec = timeline_in;
            clip.place.duration_sec = 2.0;
            track.add_clip(clip);
        }
        sequence.add_track(track);
        sequence
    }

    #[test]
    fn test_parse_severity_should_accept_every_threshold_name() {
        let argument = VerifyArgumentNames::api().fail_on;
        assert_eq!(
            parse_severity("info", argument).expect("info"),
            Severity::Info
        );
        assert_eq!(
            parse_severity("WARNING", argument).expect("warning"),
            Severity::Warning
        );
        assert_eq!(
            parse_severity(" error ", argument).expect("error"),
            Severity::Error
        );
        assert_eq!(
            parse_severity("critical", argument).expect("critical"),
            Severity::Critical
        );
        assert!(parse_severity("nonsense", argument).is_err());
    }

    /// Feature: Surface-specific argument names
    /// Scenario: should refuse in the vocabulary the caller can actually type
    ///
    /// The engine is shared by surfaces that spell the same argument three
    /// ways. A refusal naming a spelling none of them accepts is one the caller
    /// cannot act on, so every message is built from the caller's own labels.
    #[test]
    fn test_refusals_should_name_arguments_in_the_calling_surface_spelling() {
        let cases = [
            (
                VerifyArgumentNames::cli(),
                [
                    "--fail-on",
                    "--timeout-sec",
                    "--checks",
                    "--target-lufs",
                    "--max-true-peak",
                    "--duration-tolerance-sec",
                ],
            ),
            (
                VerifyArgumentNames::api(),
                [
                    "failOn",
                    "timeoutSec",
                    "checks",
                    "targetLufs",
                    "maxTruePeak",
                    "durationToleranceSec",
                ],
            ),
        ];

        for (names, expected) in cases {
            let base = || VerifyRequest {
                names,
                ..Default::default()
            };
            let refusals = [
                VerifyPlan::resolve(VerifyRequest {
                    fail_on: "loud".to_string(),
                    ..base()
                })
                .err(),
                VerifyPlan::resolve(VerifyRequest {
                    timeout_sec: 0,
                    ..base()
                })
                .err(),
                VerifyPlan::resolve(VerifyRequest {
                    checks: Some(vec!["  ".to_string()]),
                    ..base()
                })
                .err(),
                VerifyPlan::resolve(VerifyRequest {
                    target_lufs: Some(f64::NAN),
                    ..base()
                })
                .err(),
                VerifyPlan::resolve(VerifyRequest {
                    max_true_peak: Some(f64::INFINITY),
                    ..base()
                })
                .err(),
                VerifyPlan::resolve(VerifyRequest {
                    duration_tolerance_sec: Some(-1.0),
                    ..base()
                })
                .err(),
            ];

            for (refusal, argument) in refusals.into_iter().zip(expected) {
                let message = refusal.expect("the argument is invalid").to_string();
                assert!(
                    message.contains(argument),
                    "expected the refusal to name '{argument}', got: {message}"
                );
            }
        }
    }

    /// Feature: Surface-specific argument names
    /// Scenario: should refuse contradictory arguments in the same spelling
    #[test]
    fn test_contradictory_arguments_should_be_named_in_the_calling_surface_spelling() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let file = temp.path().join("render.mp4");
        std::fs::write(&file, b"render").expect("write render");

        let error = VerifyPlan::resolve(VerifyRequest {
            file: Some(file),
            structural_only: true,
            names: VerifyArgumentNames::cli(),
            ..Default::default()
        })
        .expect_err("contradictory arguments");

        assert_eq!(
            error.to_string(),
            "--file and --structural-only cannot be combined"
        );
    }

    #[test]
    fn test_default_config_should_disable_only_the_opt_in_checks() {
        let engine = QCEngine::new();
        let config = build_engine_config(&engine, &structural_request()).expect("config builds");
        let enabled = enabled_check_ids(&engine, &config);

        assert!(enabled.contains(&"timeline.gap".to_string()));
        assert!(enabled.contains(&"shot.length_stats".to_string()));
        for opt_in in OPT_IN_CHECK_IDS {
            assert!(
                !enabled.contains(&opt_in.to_string()),
                "{opt_in} must stay opt-in"
            );
        }
    }

    #[test]
    fn test_checks_argument_should_restrict_the_run_to_the_named_checks() {
        let engine = QCEngine::new();
        let mut request = structural_request();
        request.checks = Some(vec!["timeline.gap".to_string()]);

        let config = build_engine_config(&engine, &request).expect("config builds");
        assert_eq!(enabled_check_ids(&engine, &config), vec!["timeline.gap"]);

        request.checks = Some(vec!["nope.not.a.check".to_string()]);
        assert!(build_engine_config(&engine, &request).is_err());
    }

    #[test]
    fn test_skip_argument_should_disable_the_named_check() {
        let engine = QCEngine::new();
        let mut request = structural_request();
        request.skip = Some(vec!["timeline.gap".to_string()]);

        let config = build_engine_config(&engine, &request).expect("config builds");

        assert!(!enabled_check_ids(&engine, &config).contains(&"timeline.gap".to_string()));
    }

    #[test]
    fn test_loudness_target_should_reach_the_rule_configuration() {
        let engine = QCEngine::new();
        let request = VerifyRequest {
            target_lufs: Some(-16.0),
            max_true_peak: Some(-2.0),
            ..Default::default()
        };

        let config = build_engine_config(&engine, &request).expect("config builds");

        let loudness_rule = engine
            .get_rule_by_check_id(LOUDNESS_CHECK_ID)
            .expect("loudness rule registered");
        let peak_rule = engine
            .get_rule_by_check_id(PEAK_CHECK_ID)
            .expect("peak rule registered");

        assert_eq!(
            config
                .get_rule_config(loudness_rule.name())
                .get_param::<f64>("target_lufs"),
            Some(-16.0)
        );
        assert_eq!(
            config
                .get_rule_config(peak_rule.name())
                .get_param::<f64>("peak_db"),
            Some(-2.0)
        );
    }

    /// Feature: Render-length tolerance
    /// Scenario: should hand an explicit tolerance to the rule unchanged
    #[test]
    fn test_duration_tolerance_should_reach_the_rule_configuration() {
        let engine = QCEngine::new();
        let mut request = VerifyRequest {
            duration_tolerance_sec: Some(0.04),
            ..Default::default()
        };

        let config = build_engine_config(&engine, &request).expect("config builds");
        let rule = engine
            .get_rule_by_check_id(DURATION_CHECK_ID)
            .expect("render-length rule registered");

        assert_eq!(
            config
                .get_rule_config(rule.name())
                .get_param::<f64>("tolerance_sec"),
            Some(0.04),
            "a tolerance the caller asked for must not be widened on the way in"
        );

        request.duration_tolerance_sec = Some(-1.0);
        assert!(build_engine_config(&engine, &request).is_err());
    }

    #[test]
    fn test_empty_checks_selection_should_be_rejected() {
        let engine = QCEngine::new();
        let mut request = structural_request();
        request.checks = Some(vec![String::new(), "  ".to_string()]);

        assert!(build_engine_config(&engine, &request).is_err());
    }

    /// Feature: Request validation
    /// Scenario: should refuse a threshold name that names no severity
    #[test]
    fn test_resolve_should_reject_an_unparseable_threshold() {
        let request = VerifyRequest {
            fail_on: "loud".to_string(),
            ..Default::default()
        };

        let error = VerifyPlan::resolve(request).expect_err("an unknown threshold is an error");
        assert!(error.to_string().contains("failOn"));
    }

    /// Feature: Request validation
    /// Scenario: should refuse a zero measurement timeout
    #[test]
    fn test_resolve_should_reject_a_zero_timeout() {
        let request = VerifyRequest {
            timeout_sec: 0,
            ..Default::default()
        };

        assert!(VerifyPlan::resolve(request).is_err());
    }

    /// Feature: Request validation
    /// Scenario: should refuse to both measure a file and skip measuring
    #[test]
    fn test_resolve_should_reject_a_file_with_structural_only() {
        let request = VerifyRequest {
            file: Some(PathBuf::from("render.mp4")),
            structural_only: true,
            ..Default::default()
        };

        let error = VerifyPlan::resolve(request).expect_err("contradictory arguments");
        assert!(error.to_string().contains("structuralOnly"));
    }

    /// Feature: Request validation
    /// Scenario: should name the missing render rather than blaming FFmpeg
    ///
    /// The ordering is the point: a caller resolves FFmpeg only after
    /// `resolve` succeeds, so a path that names nothing must be caught here.
    #[test]
    fn test_resolve_should_reject_a_rendered_file_that_is_not_there() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let request = VerifyRequest {
            file: Some(temp.path().join("definitely-not-here.mp4")),
            ..Default::default()
        };

        let error = VerifyPlan::resolve(request).expect_err("a missing render is an error");
        assert!(
            error.to_string().contains("does not exist"),
            "expected a missing-file message, got: {error}"
        );
        assert_eq!(
            error.kind(),
            VerifyErrorKind::MissingRenderedFile,
            "a surface that resolved the path on the caller's behalf re-words this one"
        );
    }

    /// Feature: Surface-specific argument names
    /// Scenario: should tell each surface how *it* asks for the rendered pass
    ///
    /// The nudge is only useful if the caller can follow it, and `--file` is
    /// not something an MCP or IPC client can pass.
    #[tokio::test]
    async fn test_skipped_rendered_checks_should_be_nudged_in_the_calling_surface_spelling() {
        let mut state = ProjectState::new("Rendered nudge");
        let sequence = sequence_with_gap();
        state.active_sequence_id = Some(sequence.id.clone());
        state.sequences.insert(sequence.id.clone(), sequence);

        for (names, expected) in [
            (
                VerifyArgumentNames::cli(),
                "pass --file <RENDER> to run them",
            ),
            (
                VerifyArgumentNames::api(),
                "name a rendered file (file) to run them",
            ),
        ] {
            let plan = VerifyPlan::resolve(VerifyRequest {
                names,
                ..Default::default()
            })
            .expect("plan resolves");

            let report = plan.run(&state, None).await.expect("verification runs");
            let warnings = report.payload()["warnings"]
                .as_array()
                .expect("warnings array")
                .iter()
                .filter_map(|warning| warning.as_str().map(str::to_string))
                .collect::<Vec<_>>();

            assert!(
                warnings.iter().any(|warning| warning.ends_with(expected)),
                "expected a warning ending in '{expected}', got: {warnings:?}"
            );
        }
    }

    /// Feature: FFmpeg dependency
    /// Scenario: should need FFmpeg only once a rendered file is in play
    #[test]
    fn test_structural_plan_should_not_require_ffmpeg() {
        let plan = VerifyPlan::resolve(structural_request()).expect("plan resolves");

        assert!(!plan.requires_ffmpeg());
        assert!(plan.rendered_file().is_none());
        assert_eq!(plan.fail_on(), Severity::Error);
        assert!(!plan.selected_checks().is_empty());
    }

    /// Feature: FFmpeg dependency
    /// Scenario: should refuse to measure a file with no runner to measure it
    #[tokio::test]
    async fn test_run_should_refuse_to_measure_without_a_runner() {
        let temp = tempfile::TempDir::new().expect("temp dir");
        let file = temp.path().join("render.mp4");
        std::fs::write(&file, b"not a real render").expect("write render");

        let plan = VerifyPlan::resolve(VerifyRequest {
            file: Some(file),
            ..Default::default()
        })
        .expect("plan resolves");
        assert!(plan.requires_ffmpeg());

        let mut state = ProjectState::new("Runner required");
        let sequence = sequence_with_gap();
        state.active_sequence_id = Some(sequence.id.clone());
        state.sequences.insert(sequence.id.clone(), sequence);

        let error = plan
            .run(&state, None)
            .await
            .expect_err("measuring needs a runner");
        assert!(error.to_string().contains("FFmpeg"));
    }

    /// Feature: Sequence selection
    /// Scenario: should refuse when no sequence is named and none is active
    #[tokio::test]
    async fn test_run_should_report_when_there_is_no_sequence_to_verify() {
        let plan = VerifyPlan::resolve(structural_request()).expect("plan resolves");
        let mut state = ProjectState::new("Empty");
        state.sequences.clear();
        state.active_sequence_id = None;

        let error = plan
            .run(&state, None)
            .await
            .expect_err("no sequence to verify");
        assert!(error.to_string().contains("no active sequence"));
    }

    /// Feature: Sequence selection
    /// Scenario: should name a sequence the project does not have
    #[tokio::test]
    async fn test_run_should_report_a_sequence_that_is_not_in_the_project() {
        let plan = VerifyPlan::resolve(VerifyRequest {
            sequence: Some("seq_does_not_exist".to_string()),
            structural_only: true,
            ..Default::default()
        })
        .expect("plan resolves");

        let error = plan
            .run(&ProjectState::new("Named"), None)
            .await
            .expect_err("an unknown sequence is an error");
        assert!(
            error.to_string().contains("seq_does_not_exist"),
            "the refusal must name the sequence asked for, got: {error}"
        );
    }

    /// Feature: Structural verification
    /// Scenario: should report a timeline gap without ever needing FFmpeg
    #[tokio::test]
    async fn test_run_should_produce_the_shared_document_for_a_structural_run() {
        let plan = VerifyPlan::resolve(structural_request()).expect("plan resolves");

        let mut state = ProjectState::new("Structural");
        let sequence = sequence_with_gap();
        let sequence_id = sequence.id.clone();
        state.active_sequence_id = Some(sequence_id.clone());
        state.sequences.insert(sequence_id.clone(), sequence);

        let report = plan.run(&state, None).await.expect("verification runs");
        let payload = report.payload();

        assert_eq!(payload["target"]["sequenceId"], sequence_id);
        assert_eq!(payload["target"]["measured"], false);
        assert_eq!(payload["measurements"]["measured"], false);

        let gap = payload["checks"]
            .as_array()
            .expect("checks array")
            .iter()
            .find(|check| check["id"] == "timeline.gap")
            .expect("the gap check must appear in the document");
        assert_eq!(gap["status"], "failed", "the fixture has a two-second hole");
        assert_eq!(
            report.exit_code(),
            EXIT_THRESHOLD_BREACHED,
            "an error-level finding breaches the default threshold"
        );

        // Rendered checks are reported as skipped rather than omitted: an agent
        // cannot act on a report that silently leaves out what it did not look
        // at. `structural_only` is the caller saying it knows, so the nudge to
        // pass a render is not added on top.
        assert!(payload["checks"]
            .as_array()
            .expect("checks array")
            .iter()
            .any(|check| check["category"] == "rendered" && check["skipped"] == true));
        assert_eq!(payload["warnings"], serde_json::json!([]));
    }

    /// Feature: Check status reporting
    /// Scenario: should never call a check with findings "passed"
    #[test]
    fn test_check_status_should_separate_clean_from_merely_non_failing() {
        assert_eq!(
            CheckStatus::grade(RuleStatus::Ran, None),
            CheckStatus::Passed
        );
        assert!(CheckStatus::grade(RuleStatus::Ran, None).is_clean());

        for severity in [Severity::Info, Severity::Warning] {
            let status = CheckStatus::grade(RuleStatus::Ran, Some(severity));
            assert_eq!(
                status,
                CheckStatus::Warned,
                "{severity} findings are findings, not a clean check"
            );
            assert!(
                !status.is_clean(),
                "{severity} findings must not report passed: true"
            );
        }

        for severity in [Severity::Error, Severity::Critical] {
            let status = CheckStatus::grade(RuleStatus::Ran, Some(severity));
            assert_eq!(status, CheckStatus::Failed);
            assert!(!status.is_clean());
        }
    }

    /// Feature: Check status reporting
    /// Scenario: should keep "did not run" distinct from "ran and passed"
    #[test]
    fn test_check_status_should_not_call_an_unrun_check_passed() {
        for rule_status in [RuleStatus::Skipped, RuleStatus::Errored] {
            let status = CheckStatus::grade(rule_status, None);
            assert!(!status.is_clean());
            assert!(matches!(
                status,
                CheckStatus::Skipped | CheckStatus::Errored
            ));
        }
    }

    #[test]
    fn test_check_status_wire_names_are_stable() {
        assert_eq!(CheckStatus::Passed.as_str(), "passed");
        assert_eq!(CheckStatus::Warned.as_str(), "warned");
        assert_eq!(CheckStatus::Failed.as_str(), "failed");
        assert_eq!(CheckStatus::Skipped.as_str(), "skipped");
        assert_eq!(CheckStatus::Errored.as_str(), "errored");
    }

    /// Feature: Exit codes
    /// Scenario: should grade a clean run, a breach and a broken tool apart
    ///
    /// Grading is pure, so the report is driven rather than produced: a real
    /// run's findings are whatever the rule set currently reports, which is not
    /// what this is about.
    #[tokio::test]
    async fn test_exit_code_should_follow_the_threshold_then_the_tool() {
        // `QCReport` has no public constructor, so the shape comes from a real
        // (empty) run and the findings under test are then set outright.
        let clean = QCEngine::new()
            .check(
                &Sequence::new("Clean", SequenceFormat::youtube_1080()),
                &ProjectState::new("Exit codes"),
            )
            .await
            .expect("QC run completes");

        let graded = |severity: Option<Severity>, errored: bool| {
            let mut report = clean.clone();
            report.violations.clear();
            report.errored_rules.clear();
            if let Some(severity) = severity {
                report
                    .violations
                    .push(QCViolation::new("GradedRule", severity, "A finding"));
            }
            if errored {
                report.errored_rules.push(RuleFailure {
                    rule_name: "GradedRule".to_string(),
                    message: "the rule blew up".to_string(),
                });
            }
            report
        };

        assert_eq!(
            exit_code_for(&graded(None, false), Severity::Error, false),
            0,
            "a run with nothing to report is clean"
        );
        assert_eq!(
            exit_code_for(
                &graded(Some(Severity::Error), false),
                Severity::Error,
                false
            ),
            EXIT_THRESHOLD_BREACHED
        );
        assert_eq!(
            exit_code_for(
                &graded(Some(Severity::Warning), false),
                Severity::Error,
                false
            ),
            0,
            "a finding below the threshold must not fail the run"
        );
        assert_eq!(
            exit_code_for(&graded(None, false), Severity::Error, true),
            EXIT_TOOL_FAILURE,
            "a failed measurement leaves the verdict incomplete"
        );
        assert_eq!(
            exit_code_for(&graded(None, true), Severity::Error, false),
            EXIT_TOOL_FAILURE,
            "a rule that errored leaves its part of the verdict unknown"
        );
        assert_eq!(
            exit_code_for(&graded(Some(Severity::Error), true), Severity::Error, true),
            EXIT_THRESHOLD_BREACHED,
            "findings the caller can act on outrank a diagnostic about the run"
        );
    }

    #[test]
    fn test_to_edit_script_should_produce_executable_plan_steps() {
        let fix = ViolationFix::new(
            "Close the gap",
            vec![serde_json::json!({
                "type": "CloseGap",
                "sequenceId": "seq_1",
                "trackId": "track_v1",
                "gapStart": 2.0,
                "gapEnd": 3.0
            })],
        );

        let script = to_edit_script(&fix).expect("fix translates");

        assert_eq!(script["description"], "Close the gap");
        assert_eq!(script["steps"][0]["commandType"], "CloseGap");
        assert_eq!(script["steps"][0]["payload"]["trackId"], "track_v1");
        assert!(script["steps"][0]["payload"].get("type").is_none());
        assert_eq!(script["steps"][0]["dependsOn"], serde_json::json!([]));
    }

    #[test]
    fn test_to_edit_script_should_chain_steps_in_command_order() {
        let fix = ViolationFix::new(
            "Two ordered commands",
            vec![
                serde_json::json!({ "type": "SplitClip", "clipId": "clip_1" }),
                serde_json::json!({ "type": "RemoveClip", "clipId": "clip_2" }),
            ],
        );

        let script = to_edit_script(&fix).expect("fix translates");

        assert_eq!(script["steps"][0]["id"], "fix_1");
        assert_eq!(script["steps"][1]["id"], "fix_2");
        assert_eq!(
            script["steps"][1]["dependsOn"],
            serde_json::json!(["fix_1"])
        );
    }

    #[test]
    fn test_to_edit_script_should_reject_a_fix_it_cannot_translate_in_full() {
        let fix = ViolationFix::new(
            "Half-translatable",
            vec![
                serde_json::json!({ "type": "CloseGap", "trackId": "track_v1" }),
                serde_json::json!({ "missingType": true }),
            ],
        );

        assert!(to_edit_script(&fix).is_none());
    }

    /// Feature: The fix loop
    /// Scenario: should hand back plan steps the command layer accepts
    ///
    /// `to_edit_script` is the only translation between what a QC rule
    /// describes and what `plan execute` runs. This drives that translation
    /// with a real rule's output and parses the result with the same strict
    /// parser the plan executor uses, so a step that would be rejected on
    /// execution fails here instead.
    #[tokio::test]
    async fn test_to_edit_script_steps_should_parse_as_real_commands() {
        let sequence = sequence_with_gap();

        let report = QCEngine::new()
            .check_with_measurements(
                &sequence,
                &ProjectState::new("Fix loop"),
                RenderMeasurements {
                    true_peak_dbtp: Some(-0.2),
                    file_duration_sec: Some(sequence.duration()),
                    ..Default::default()
                },
            )
            .await
            .expect("QC run completes");

        let fixes: Vec<_> = report
            .violations
            .iter()
            .filter_map(|violation| violation.suggested_fix.as_ref())
            .collect();
        assert!(
            !fixes.is_empty(),
            "the fixture must produce at least one fix, or this proves nothing"
        );

        for fix in fixes {
            let script = to_edit_script(fix).expect("every emitted fix translates to plan steps");

            for step in script["steps"].as_array().expect("steps array") {
                let command_type = step["commandType"]
                    .as_str()
                    .expect("step carries a commandType")
                    .to_string();

                crate::ipc::CommandPayload::parse(command_type.clone(), step["payload"].clone())
                    .unwrap_or_else(|error| {
                        panic!("plan step '{command_type}' would be rejected on execution: {error}")
                    });
            }
        }
    }

    #[test]
    fn test_build_measurements_should_report_when_nothing_was_measured() {
        let value = build_measurements(None, None);

        assert_eq!(value["measured"], false);
    }

    #[test]
    fn test_severity_key_matches_the_serde_representation() {
        for severity in [
            Severity::Info,
            Severity::Warning,
            Severity::Error,
            Severity::Critical,
        ] {
            let serialized = serde_json::to_value(severity).expect("severity serializes");
            assert_eq!(
                serialized,
                Value::String(severity_key(severity).to_string())
            );
        }
    }
}

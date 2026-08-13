//! Deterministic QC for a sequence, with or without a rendered file.
//!
//! `verify` is the agent's self-check: it runs the shared QC engine over the
//! project state and, when a rendered file is supplied, over measurements taken
//! from that file. Every check that ran appears in the output — including the
//! ones that passed — because an agent cannot act on a report that silently
//! omits what it did not look at.
//!
//! Exit codes: `0` ran without breaching the threshold, `1` threshold breached,
//! `2` the tool itself failed (bad arguments, unreadable file, FFmpeg failure,
//! or a rule that errored, leaving the verdict incomplete).
//!
//! Measurement times are file-relative while structural findings are
//! timeline-relative. The two are compared directly (see
//! [`crossref_black_ranges_with_gaps`]), so `--file` expects a render of the
//! whole sequence from timeline zero; a partial render (`render start --start`)
//! still measures correctly but its timestamps no longer line up with the
//! timeline.

use crate::ffmpeg_env::ensure_ffmpeg;
use crate::output;
use clap::Args;
use openreelio_core::ffmpeg::FFmpegRunner;
use openreelio_core::qc::{
    crossref_black_ranges_with_gaps, measure_rendered_file_detailed, MeasureOptions,
    MeasurementReport, QCContext, QCEngine, QCEngineConfig, QCReport, QCSeverityFilter, RuleStatus,
    Severity,
};
use openreelio_core::timeline::Sequence;
use serde::Serialize;
use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Exit code for a report that breached the `--fail-on` threshold.
const EXIT_THRESHOLD_BREACHED: i32 = 1;

/// Exit code for a failure of the tool itself.
const EXIT_TOOL_FAILURE: i32 = 2;

/// Checks that are disabled unless explicitly requested via `--checks`.
///
/// Both encode expectations `verify` cannot confirm on its own: licence
/// paperwork lives outside the project file, and duration limits depend on the
/// delivery platform. Left on by default they would fail every healthy project.
const OPT_IN_CHECK_IDS: &[&str] = &["asset.license", "sequence.duration"];

/// Check ID of the loudness rule, wired to `--target-lufs`.
const LOUDNESS_CHECK_ID: &str = "audio.loudness";

/// Check ID of the peak rule, wired to `--max-true-peak`.
const PEAK_CHECK_ID: &str = "audio.peak";

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

    /// Lowest severity that fails the run: info, warning, error, critical
    #[arg(long, default_value = "error")]
    pub fail_on: String,

    /// Timeout for the rendered-file measurement pass, in seconds
    #[arg(long, default_value_t = 600)]
    pub timeout_sec: u64,

    /// Pretty-print the JSON output
    #[arg(long)]
    pub json_pretty: bool,
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
            std::process::exit(EXIT_TOOL_FAILURE)
        }
    }
}

/// Runs the verification, prints the report, and returns the process exit code.
///
/// Returning `Err` means the tool failed before it could produce a report; a
/// report that merely found problems returns `Ok` with a non-zero code.
fn run(args: VerifyArgs) -> anyhow::Result<i32> {
    let json_pretty = args.json_pretty;
    let (output_value, exit_code) = run_verify(args)?;

    if json_pretty {
        output::print_json_pretty(&output_value)?;
    } else {
        output::print_json(&output_value)?;
    }

    Ok(exit_code)
}

/// Runs the verification and returns the report document plus the exit code.
///
/// This is the print-free seam for in-process callers, which hand the returned
/// document straight to their own client. The document is exactly what the CLI
/// prints, so the two surfaces can never drift.
///
/// Returning `Err` means the tool failed before it could produce a report; a
/// report that merely found problems returns `Ok` with a non-zero code.
pub(crate) fn run_verify(args: VerifyArgs) -> anyhow::Result<(Value, i32)> {
    let fail_on = parse_severity(&args.fail_on)?;
    if args.timeout_sec == 0 {
        return Err(anyhow::anyhow!(
            "Invalid value for --timeout-sec: must be >= 1"
        ));
    }

    let project = super::load_project(&args.path)?;
    let sequence_id = super::resolve_sequence_id(&project, args.sequence.clone())?;
    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", sequence_id))?;

    let engine = QCEngine::new();
    let config = build_engine_config(&engine, &args)?;
    let selected_ids = enabled_check_ids(&engine, &config);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("Failed to create Tokio runtime: {error}"))?;
    runtime.block_on(engine.set_config(config));

    let mut warnings: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut measurement: Option<MeasurementReport> = None;

    if let Some(file) = args.file.as_ref() {
        if !file.exists() {
            return Err(anyhow::anyhow!(
                "Rendered file '{}' does not exist",
                file.display()
            ));
        }

        // FFmpeg is only required once a rendered file is in play; structural
        // runs must work on machines without it.
        let ffmpeg_info = ensure_ffmpeg()?;
        let runner = FFmpegRunner::new(ffmpeg_info);
        let options = MeasureOptions {
            timeout: Duration::from_secs(args.timeout_sec),
            ..Default::default()
        };

        match runtime.block_on(measure_rendered_file_detailed(&runner, file, &options)) {
            Ok(report) => {
                warnings.extend(report.notes.iter().cloned());
                measurement = Some(report);
            }
            Err(error) => {
                // A failed measurement leaves the rendered checks unrun; the
                // structural half of the report is still worth emitting.
                errors.push(format!("Rendered-file measurement failed: {error}"));
            }
        }
    }

    let measurement_failed = args.file.is_some() && measurement.is_none();

    let mut report = runtime.block_on(async {
        match measurement.as_ref() {
            Some(measured) => {
                engine
                    .check_with_measurements(
                        sequence,
                        &project.state,
                        measured.measurements.clone(),
                    )
                    .await
            }
            None => engine.check(sequence, &project.state).await,
        }
    })?;

    // Black pixels only become an error once they are known to sit over a hole
    // in the timeline, which needs both halves of the report. The tolerance is
    // the same one the rules use, so it comes from the shared context rather
    // than a second definition of "one frame".
    let frame_duration_sec = QCContext::from_sequence(sequence).frame_duration_sec();
    crossref_black_ranges_with_gaps(&mut report, sequence, frame_duration_sec);

    for failure in &report.errored_rules {
        errors.push(format!(
            "Check '{}' failed to run: {}",
            failure.rule_name, failure.message
        ));
    }

    let output_value = build_output(
        OutputInputs {
            sequence,
            sequence_id: &sequence_id,
            report: &report,
            engine: &engine,
            selected_ids: &selected_ids,
            measurement: measurement.as_ref(),
            rendered_file: args.file.as_deref(),
            structural_only: args.structural_only,
        },
        warnings,
        errors,
    );

    let breached = report
        .violations
        .iter()
        .any(|violation| violation.severity.meets_threshold(fail_on));

    let exit_code = if breached {
        EXIT_THRESHOLD_BREACHED
    } else if measurement_failed || !report.errored_rules.is_empty() {
        EXIT_TOOL_FAILURE
    } else {
        0
    };

    Ok((output_value, exit_code))
}

// ── Configuration ───────────────────────────────────────────────────────

/// Parses a severity threshold name.
fn parse_severity(raw: &str) -> anyhow::Result<Severity> {
    match raw.trim().to_lowercase().as_str() {
        "info" => Ok(Severity::Info),
        "warning" | "warn" => Ok(Severity::Warning),
        "error" => Ok(Severity::Error),
        "critical" => Ok(Severity::Critical),
        other => Err(anyhow::anyhow!(
            "Invalid value for --fail-on: expected info, warning, error, or critical (got '{}')",
            other
        )),
    }
}

/// Builds the engine configuration from the selection and threshold arguments.
fn build_engine_config(engine: &QCEngine, args: &VerifyArgs) -> anyhow::Result<QCEngineConfig> {
    let mut config = QCEngineConfig {
        // Informational findings carry the metrics agents steer by, so the
        // report keeps every severity and lets `--fail-on` decide the verdict.
        severity_filter: QCSeverityFilter::All,
        ..Default::default()
    };

    let known_ids: Vec<String> = engine
        .rules()
        .iter()
        .map(|rule| rule.check_id().to_string())
        .collect();

    if let Some(requested) = args.checks.as_ref() {
        let requested = normalize_ids(requested);
        // An empty selection would disable every rule and report a clean run
        // over nothing checked, which an agent reads as "verified".
        if requested.is_empty() {
            return Err(anyhow::anyhow!(
                "Invalid value for --checks: at least one check ID is required"
            ));
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

    if let Some(skipped) = args.skip.as_ref() {
        for id in normalize_ids(skipped) {
            if !known_ids.contains(&id) {
                return Err(unknown_check_error(&id, &known_ids));
            }
            if let Some(rule) = engine.get_rule_by_check_id(&id) {
                config.disable_rule(rule.name());
            }
        }
    }

    if let Some(target_lufs) = args.target_lufs {
        if !target_lufs.is_finite() {
            return Err(anyhow::anyhow!(
                "Invalid value for --target-lufs: must be a finite number"
            ));
        }
        set_param(
            engine,
            &mut config,
            LOUDNESS_CHECK_ID,
            "target_lufs",
            target_lufs,
        );
    }

    if let Some(max_true_peak) = args.max_true_peak {
        if !max_true_peak.is_finite() {
            return Err(anyhow::anyhow!(
                "Invalid value for --max-true-peak: must be a finite number"
            ));
        }
        set_param(engine, &mut config, PEAK_CHECK_ID, "peak_db", max_true_peak);
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

fn unknown_check_error(id: &str, known_ids: &[String]) -> anyhow::Error {
    anyhow::anyhow!(
        "Unknown check '{}'. Available checks: {}",
        id,
        known_ids.join(", ")
    )
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

fn flush_stdout() {
    let _ = std::io::stdout().flush();
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

/// One check, whether it passed, failed, was skipped, or errored.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckEntry {
    id: String,
    rule: String,
    category: String,
    status: &'static str,
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
}

/// Assembles the CLI output document.
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
            "{} rendered check(s) were skipped; pass --file <RENDER> to run them",
            rendered_skipped
        ));
    }

    // The verdict follows the findings, not the diagnostics: a clean run that
    // simply had nothing rendered to inspect is still "ok".
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

            let status = match outcome.status {
                RuleStatus::Skipped => "skipped",
                RuleStatus::Errored => "errored",
                RuleStatus::Ran => {
                    if max_severity.is_some_and(|severity| severity >= Severity::Error) {
                        "failed"
                    } else {
                        "passed"
                    }
                }
            };

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
                passed: matches!(outcome.status, RuleStatus::Ran)
                    && max_severity.is_none_or(|severity| severity < Severity::Error),
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
fn to_edit_script(fix: &openreelio_core::qc::ViolationFix) -> Option<Value> {
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
    use openreelio_core::qc::ViolationFix;

    #[test]
    fn test_parse_severity_should_accept_every_threshold_name() {
        assert_eq!(parse_severity("info").expect("info"), Severity::Info);
        assert_eq!(
            parse_severity("WARNING").expect("warning"),
            Severity::Warning
        );
        assert_eq!(parse_severity(" error ").expect("error"), Severity::Error);
        assert_eq!(
            parse_severity("critical").expect("critical"),
            Severity::Critical
        );
        assert!(parse_severity("nonsense").is_err());
    }

    #[test]
    fn test_default_config_should_disable_only_the_opt_in_checks() {
        let engine = QCEngine::new();
        let args = VerifyArgs {
            path: PathBuf::from("."),
            sequence: None,
            file: None,
            structural_only: true,
            checks: None,
            skip: None,
            target_lufs: None,
            max_true_peak: None,
            fail_on: "error".to_string(),
            timeout_sec: 600,
            json_pretty: false,
        };

        let config = build_engine_config(&engine, &args).expect("config builds");
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
        let mut args = VerifyArgs {
            path: PathBuf::from("."),
            sequence: None,
            file: None,
            structural_only: true,
            checks: Some(vec!["timeline.gap".to_string()]),
            skip: None,
            target_lufs: None,
            max_true_peak: None,
            fail_on: "error".to_string(),
            timeout_sec: 600,
            json_pretty: false,
        };

        let config = build_engine_config(&engine, &args).expect("config builds");
        assert_eq!(enabled_check_ids(&engine, &config), vec!["timeline.gap"]);

        args.checks = Some(vec!["nope.not.a.check".to_string()]);
        assert!(build_engine_config(&engine, &args).is_err());
    }

    #[test]
    fn test_skip_argument_should_disable_the_named_check() {
        let engine = QCEngine::new();
        let args = VerifyArgs {
            path: PathBuf::from("."),
            sequence: None,
            file: None,
            structural_only: true,
            checks: None,
            skip: Some(vec!["timeline.gap".to_string()]),
            target_lufs: None,
            max_true_peak: None,
            fail_on: "error".to_string(),
            timeout_sec: 600,
            json_pretty: false,
        };

        let config = build_engine_config(&engine, &args).expect("config builds");

        assert!(!enabled_check_ids(&engine, &config).contains(&"timeline.gap".to_string()));
    }

    #[test]
    fn test_loudness_target_should_reach_the_rule_configuration() {
        let engine = QCEngine::new();
        let args = VerifyArgs {
            path: PathBuf::from("."),
            sequence: None,
            file: None,
            structural_only: false,
            checks: None,
            skip: None,
            target_lufs: Some(-16.0),
            max_true_peak: Some(-2.0),
            fail_on: "error".to_string(),
            timeout_sec: 600,
            json_pretty: false,
        };

        let config = build_engine_config(&engine, &args).expect("config builds");

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

    #[test]
    fn test_empty_checks_selection_should_be_rejected() {
        let engine = QCEngine::new();
        let args = VerifyArgs {
            path: PathBuf::from("."),
            sequence: None,
            file: None,
            structural_only: true,
            checks: Some(vec![String::new(), "  ".to_string()]),
            skip: None,
            target_lufs: None,
            max_true_peak: None,
            fail_on: "error".to_string(),
            timeout_sec: 600,
            json_pretty: false,
        };

        assert!(build_engine_config(&engine, &args).is_err());
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

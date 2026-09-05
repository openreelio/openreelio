//! QC Rules
//!
//! Built-in quality control rules for video editing validation.
//! Each rule implements the QCRule trait for consistent checking.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::caption_group::{group_caption_findings, CaptionFinding, CaptionGroup};
use super::context::QCContext;
use super::violation::{merged_span_duration_sec, QCViolation, Severity, ViolationFix};
use crate::core::captions::{
    CaptionPosition, CaptionStyle, CustomPosition, TextAlignment, VerticalPosition,
    CAPTION_SIDE_MARGIN_PERCENT, CAPTION_WRAP_BOX_WIDTH_PERCENT,
};
use crate::core::project::ProjectState;
use crate::core::timeline::{Clip, Sequence, Track};
use crate::core::CoreResult;

/// Configuration for QC rules
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleConfig {
    /// Whether the rule is enabled
    pub enabled: bool,
    /// Severity override (if set, overrides the rule's default)
    pub severity_override: Option<Severity>,
    /// Rule-specific parameters
    pub params: HashMap<String, serde_json::Value>,
}

impl Default for RuleConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            severity_override: None,
            params: HashMap::new(),
        }
    }
}

impl RuleConfig {
    /// Creates a disabled config
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            ..Default::default()
        }
    }

    /// Gets a parameter value as a specific type
    pub fn get_param<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.params
            .get(key)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }

    /// Sets a parameter value
    pub fn set_param<T: Serialize>(&mut self, key: &str, value: T) {
        if let Ok(v) = serde_json::to_value(value) {
            self.params.insert(key.to_string(), v);
        }
    }
}

/// What a rule inspects.
///
/// Structural rules read the timeline alone; rendered rules need measurements
/// taken from an exported file, so they are unavailable until one exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckCategory {
    /// Derived from the project state (timeline, assets, captions)
    Structural,
    /// Derived from measurements of a rendered file
    Rendered,
}

impl std::fmt::Display for CheckCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CheckCategory::Structural => write!(f, "structural"),
            CheckCategory::Rendered => write!(f, "rendered"),
        }
    }
}

/// Trait for all QC rules
#[async_trait]
pub trait QCRule: Send + Sync {
    /// Returns the unique name of this rule
    fn name(&self) -> &str;

    /// Returns the stable, dotted identifier reported to agents
    ///
    /// Rule names are Rust type names; check IDs are the vocabulary the CLI and
    /// agent surfaces use (`timeline.gap`, `audio.loudness`, …). Defaults to
    /// the rule name so custom rules stay usable without extra work.
    fn check_id(&self) -> &str {
        self.name()
    }

    /// Returns what this rule inspects
    fn category(&self) -> CheckCategory {
        CheckCategory::Structural
    }

    /// Returns a human-readable description
    fn description(&self) -> &str;

    /// Returns the default severity for violations from this rule
    fn default_severity(&self) -> Severity;

    /// Checks the sequence for violations
    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>>;

    /// Returns why this rule cannot run against `context`, or `None` when it can.
    ///
    /// The engine records such rules in the report's skipped rules, so a rule
    /// that is missing its inputs is never mistaken for a rule that passed.
    fn skip_reason(&self, _context: &QCContext) -> Option<String> {
        None
    }

    /// Attempts to auto-fix a violation (if supported)
    async fn auto_fix(&self, violation: &QCViolation) -> Option<ViolationFix> {
        violation.suggested_fix.clone()
    }

    /// Returns whether this rule supports auto-fix
    fn supports_auto_fix(&self) -> bool {
        false
    }
}

/// Collects clips on video tracks that overlap the given timeline range.
///
/// Each hit carries the track that owns it: every clip-scoped edit command
/// takes a `trackId`, so a rule that loses it cannot suggest an executable fix.
fn video_clips_in_range(sequence: &Sequence, start_sec: f64, end_sec: f64) -> Vec<(&Track, &Clip)> {
    sequence
        .tracks
        .iter()
        .filter(|track| track.is_video())
        .flat_map(|track| track.clips.iter().map(move |clip| (track, clip)))
        .filter(|(_, clip)| clip.place.timeline_in_sec < end_sec && clip.timeline_end() > start_sec)
        .collect()
}

/// Returns a clip's playback speed, guarding the zero and non-finite cases.
fn safe_clip_speed(clip: &Clip) -> f64 {
    let speed = clip.speed as f64;
    if speed.is_finite() && speed > 0.0 {
        speed
    } else {
        1.0
    }
}

// ============================================================================
// BlackFrameRule - Detects black frames at start/end
// ============================================================================

/// Rule that reports black ranges found in the rendered sequence
///
/// Black detection is a pixel-level measurement, so this rule reads the ranges
/// produced by the render measurement pass instead of inspecting the timeline.
/// Luma/pixel thresholds belong to that pass; this rule only applies the
/// duration threshold that decides which ranges are worth reporting.
#[derive(Debug, Default)]
pub struct BlackFrameRule;

impl BlackFrameRule {
    /// Creates a new BlackFrameRule
    pub fn new() -> Self {
        Self
    }

    /// Minimum duration to flag (seconds)
    const DEFAULT_MIN_DURATION: f64 = 0.1;

    /// Builds the slip that pushes a clip's source past its leading black.
    ///
    /// Leading black is removed by moving the source window forward, not by
    /// trimming the clip: a trim shortens the clip and leaves a hole where the
    /// black was, and rippling the hole shut would shift one track out of sync
    /// with every other. A slip keeps the timeline placement and duration
    /// exactly as they are and only changes which frames are shown.
    ///
    /// Returns `None` unless the source has `black_duration` of unused footage
    /// after the clip's out point, since a slip past the end of the media would
    /// trade black for a frozen or missing tail.
    fn slip_past_leading_black(
        sequence: &Sequence,
        track: &Track,
        clip: &Clip,
        state: &ProjectState,
        black_duration_sec: f64,
    ) -> Option<ViolationFix> {
        // A measured black range is matched to any clip it overlaps, so it can
        // outlast the clip it starts on. Black that runs past the clip's own
        // out point is not leading black on this clip: slipping by the whole
        // range would discard picture the edit asked for, so only the part
        // inside the clip counts, and a clip that is black end to end has no
        // leading black to slip past at all.
        let clip_duration_sec = clip.duration();
        if !clip_duration_sec.is_finite() || black_duration_sec >= clip_duration_sec {
            return None;
        }

        // Timeline seconds map to source seconds through the clip's speed.
        let source_shift = black_duration_sec.min(clip_duration_sec) * safe_clip_speed(clip);
        if !source_shift.is_finite() || source_shift <= 0.0 {
            return None;
        }

        let asset_duration = state.get_asset(&clip.asset_id)?.duration_sec?;
        let new_source_out = clip.range.source_out_sec + source_shift;
        if !asset_duration.is_finite() || new_source_out > asset_duration {
            return None;
        }

        Some(
            ViolationFix::new(
                format!(
                    "Slip the clip's source {:.2}s forward, past the leading black",
                    source_shift
                ),
                vec![serde_json::json!({
                    "type": "TrimClip",
                    "sequenceId": sequence.id,
                    "trackId": track.id,
                    "clipId": clip.id,
                    "newSourceIn": clip.range.source_in_sec + source_shift,
                    "newSourceOut": new_source_out
                })],
            )
            // The black is measured, but whether the frames behind it are the
            // ones the edit wants is a judgement this rule cannot make.
            .with_confidence(0.6),
        )
    }
}

#[async_trait]
impl QCRule for BlackFrameRule {
    fn name(&self) -> &str {
        "BlackFrameRule"
    }

    fn check_id(&self) -> &str {
        "render.black_frames"
    }

    fn category(&self) -> CheckCategory {
        CheckCategory::Rendered
    }

    fn description(&self) -> &str {
        "Reports black ranges detected in the rendered sequence"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn skip_reason(&self, context: &QCContext) -> Option<String> {
        let Some(measurements) = context.measurements.as_ref() else {
            return Some("no rendered measurements available".to_string());
        };
        // A file with no picture reports no black frames, which is not the same
        // as a picture that is never black. `render.missing_video` owns that
        // finding; this check has nothing to look at.
        if measurements.has_video_stream() == Some(false) {
            return Some("the measured file has no video stream".to_string());
        }
        None
    }

    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let Some(measurements) = context.measurements.as_ref() else {
            // The engine reports this rule as skipped (see `skip_reason`); an
            // empty result here only guards direct single-rule invocations.
            return Ok(Vec::new());
        };

        let min_duration = config
            .get_param::<f64>("min_duration")
            .unwrap_or(Self::DEFAULT_MIN_DURATION);

        let severity = config.severity_override.unwrap_or(self.default_severity());
        let frame_tolerance = context.frame_duration_sec();

        let mut violations = Vec::new();

        for &(start_sec, end_sec) in &measurements.black_ranges {
            let black_duration = end_sec - start_sec;
            if !black_duration.is_finite() || black_duration < min_duration {
                continue;
            }

            let overlapping = video_clips_in_range(sequence, start_sec, end_sec);
            let entity_ids: Vec<String> = overlapping
                .iter()
                .map(|(_, clip)| clip.id.clone())
                .collect();

            let mut violation = QCViolation::new(
                self.name(),
                severity,
                format!(
                    "Black frames detected for {:.2}s at {:.2}s",
                    black_duration, start_sec
                ),
            )
            .with_location(start_sec, end_sec)
            .with_entities(entity_ids)
            .with_details(if overlapping.is_empty() {
                "No video clip covers this range; the timeline may have a gap here.".to_string()
            } else {
                format!("{} video clip(s) cover this range.", overlapping.len())
            });

            // Only black that begins at a clip's own head can be slipped away:
            // black in the middle of a clip has no source window to move past
            // it without changing what the surrounding frames show.
            let head_clip = overlapping.iter().find(|(_, clip)| {
                (clip.place.timeline_in_sec - start_sec).abs() <= frame_tolerance
            });

            if let Some((track, clip)) = head_clip {
                if let Some(fix) =
                    Self::slip_past_leading_black(sequence, track, clip, state, black_duration)
                {
                    violation = violation.with_fix(fix);
                }
            }

            violations.push(violation);
        }

        Ok(violations)
    }

    fn supports_auto_fix(&self) -> bool {
        true
    }
}

// ============================================================================
// AudioPeakRule - Detects audio clipping/peaks
// ============================================================================

/// Rule that detects audio peaks that may cause clipping
///
/// Peak level is a property of the rendered program, so this rule reads the
/// measured peak instead of guessing from timeline structure. True peak is
/// preferred; sample peak is used only when the measurement pass could not
/// compute a true peak (it under-reports inter-sample overs).
#[derive(Debug, Default)]
pub struct AudioPeakRule;

impl AudioPeakRule {
    /// Creates a new AudioPeakRule
    pub fn new() -> Self {
        Self
    }

    /// Default peak threshold in dB
    const DEFAULT_PEAK_DB: f64 = -1.0;

    /// Default warning threshold in dB
    const DEFAULT_WARN_DB: f64 = -3.0;

    /// Master volume limits accepted by `SetMasterVolumeCommand`
    const MASTER_MIN_VOLUME_DB: f64 = -60.0;
    const MASTER_MAX_VOLUME_DB: f64 = 6.0;

    /// Returns the measured peak in dB and the label describing its kind.
    fn measured_peak(context: &QCContext) -> Option<(f64, &'static str)> {
        let measurements = context.measurements.as_ref()?;

        if let Some(true_peak) = measurements.true_peak_dbtp {
            return Some((true_peak, "true peak"));
        }
        measurements
            .sample_peak_db
            .map(|sample_peak| (sample_peak, "sample peak"))
    }
}

#[async_trait]
impl QCRule for AudioPeakRule {
    fn name(&self) -> &str {
        "AudioPeakRule"
    }

    fn check_id(&self) -> &str {
        "audio.peak"
    }

    fn category(&self) -> CheckCategory {
        CheckCategory::Rendered
    }

    fn description(&self) -> &str {
        "Detects audio peaks that may cause clipping or distortion"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn skip_reason(&self, context: &QCContext) -> Option<String> {
        if context.measurements.is_none() {
            return Some("no rendered measurements available".to_string());
        }
        if Self::measured_peak(context).is_none() {
            return Some("no audio peak measurement available".to_string());
        }
        None
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let Some((measured_peak, peak_kind)) = Self::measured_peak(context) else {
            // The engine reports this rule as skipped (see `skip_reason`); an
            // empty result here only guards direct single-rule invocations.
            return Ok(Vec::new());
        };

        let peak_db = config
            .get_param::<f64>("peak_db")
            .unwrap_or(Self::DEFAULT_PEAK_DB);
        let warn_db = config
            .get_param::<f64>("warn_db")
            .unwrap_or(Self::DEFAULT_WARN_DB);

        // The measurement covers the whole rendered program, so violations are
        // located across the render's own length rather than attributed to one
        // clip.
        let program_end = sequence.output_duration();
        let mut violations = Vec::new();

        if measured_peak > peak_db {
            let severity = config.severity_override.unwrap_or(Severity::Critical);

            // The measurement reflects the program as rendered, so the headroom
            // is recovered by lowering the master output rather than one clip.
            let target_volume_db = (sequence.master_volume_db as f64
                + (peak_db - measured_peak - 0.5))
                .clamp(Self::MASTER_MIN_VOLUME_DB, Self::MASTER_MAX_VOLUME_DB);

            let fix = ViolationFix::new(
                format!("Lower master volume to {:.1} dB", target_volume_db),
                vec![serde_json::json!({
                    "type": "SetMasterVolume",
                    "sequenceId": sequence.id,
                    "volumeDb": target_volume_db
                })],
            )
            .with_confidence(0.85);

            violations.push(
                QCViolation::new(
                    self.name(),
                    severity,
                    format!(
                        "Audio clipping detected ({:.1} dB {})",
                        measured_peak, peak_kind
                    ),
                )
                .with_location(0.0, program_end)
                .with_details(format!(
                    "Peak exceeds threshold of {:.1} dB. May cause distortion.",
                    peak_db
                ))
                .with_fix(fix),
            );
        } else if measured_peak > warn_db {
            let severity = config.severity_override.unwrap_or(Severity::Warning);

            violations.push(
                QCViolation::new(
                    self.name(),
                    severity,
                    format!(
                        "High audio level detected ({:.1} dB {})",
                        measured_peak, peak_kind
                    ),
                )
                .with_location(0.0, program_end)
                .with_details(format!(
                    "Peak is within {:.1} dB of the {:.1} dB ceiling.",
                    peak_db - measured_peak,
                    peak_db
                )),
            );
        }

        Ok(violations)
    }

    fn supports_auto_fix(&self) -> bool {
        true
    }
}

// ============================================================================
// AudioLoudnessRule - Checks program loudness against a delivery target
// ============================================================================

/// Rule that compares measured integrated loudness against a delivery target
///
/// Platforms normalise playback to a fixed integrated loudness, so a program
/// that lands far from the target is either turned down (wasting the mix) or
/// turned up (revealing noise). Only the rendered program has a meaningful
/// integrated loudness, so this rule reads the measurement pass.
///
/// Findings are warnings at any deviation: the target is a delivery convention
/// rather than a property of correct output. True-peak and clipping checks stay
/// errors because they describe damage to the signal itself.
#[derive(Debug, Default)]
pub struct AudioLoudnessRule;

impl AudioLoudnessRule {
    /// Creates a new AudioLoudnessRule
    pub fn new() -> Self {
        Self
    }

    /// Default delivery target in LUFS (streaming platform convention)
    pub const DEFAULT_TARGET_LUFS: f64 = -14.0;

    /// Deviation tolerated without comment, in LU
    const DEFAULT_TOLERANCE_LU: f64 = 1.0;

    /// Peak ceiling assumed when judging whether a boost is safe, in dB
    const SAFE_PEAK_CEILING_DB: f64 = -1.0;

    /// Master volume limits accepted by `SetMasterVolumeCommand`
    const MASTER_MIN_VOLUME_DB: f64 = -60.0;
    const MASTER_MAX_VOLUME_DB: f64 = 6.0;
}

#[async_trait]
impl QCRule for AudioLoudnessRule {
    fn name(&self) -> &str {
        "AudioLoudnessRule"
    }

    fn check_id(&self) -> &str {
        "audio.loudness"
    }

    fn category(&self) -> CheckCategory {
        CheckCategory::Rendered
    }

    fn description(&self) -> &str {
        "Compares measured integrated loudness against the delivery target"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn skip_reason(&self, context: &QCContext) -> Option<String> {
        let Some(measurements) = context.measurements.as_ref() else {
            return Some("no rendered measurements available".to_string());
        };
        if measurements.integrated_lufs.is_none() {
            return Some("no integrated loudness measurement available".to_string());
        }
        None
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let Some(measurements) = context.measurements.as_ref() else {
            // The engine reports this rule as skipped (see `skip_reason`).
            return Ok(Vec::new());
        };
        let Some(integrated_lufs) = measurements.integrated_lufs else {
            return Ok(Vec::new());
        };

        let target_lufs = config
            .get_param::<f64>("target_lufs")
            .unwrap_or(Self::DEFAULT_TARGET_LUFS);
        let tolerance_lu = config
            .get_param::<f64>("tolerance_lu")
            .unwrap_or(Self::DEFAULT_TOLERANCE_LU)
            .abs();

        let deviation = integrated_lufs - target_lufs;
        if !deviation.is_finite() || deviation.abs() <= tolerance_lu {
            return Ok(Vec::new());
        }

        // Every deviation is a warning, however large. A loudness target is a
        // platform convention, not a property of correct output — a master
        // mixed for cinema is not broken because it misses a streaming target —
        // so `error` stays reserved for the objectively broken (true-peak overs,
        // clipping). A caller that treats a specific target as a hard
        // requirement can raise the grade with `severity_override`.
        let severity = config.severity_override.unwrap_or(self.default_severity());

        let direction = if deviation > 0.0 { "above" } else { "below" };
        let mut violation = QCViolation::new(
            self.name(),
            severity,
            format!(
                "Integrated loudness is {:.1} LUFS, {:.1} LU {} the {:.1} LUFS target",
                integrated_lufs,
                deviation.abs(),
                direction,
                target_lufs
            ),
        )
        // Loudness is integrated over the rendered file, so the finding spans
        // the length that file has.
        .with_location(0.0, sequence.output_duration())
        .with_metric("integratedLufs", integrated_lufs)
        .with_metric("targetLufs", target_lufs)
        .with_metric("deviationLu", (deviation * 100.0).round() / 100.0);

        if let Some(range) = measurements.loudness_range_lu {
            violation = violation.with_metric("loudnessRangeLu", range);
        }

        // A boost is only safe while the measured peak keeps enough headroom;
        // otherwise the correction has to happen in the mix, not the master.
        let measured_peak = measurements.true_peak_dbtp.or(measurements.sample_peak_db);
        let boost_would_clip = deviation < 0.0
            && measured_peak.is_some_and(|peak| peak - deviation > Self::SAFE_PEAK_CEILING_DB);

        if boost_would_clip {
            violation = violation.with_details(format!(
                "Raising the master by {:.1} dB would push the measured peak of {:.1} dB past \
                 {:.1} dB; rebalance the mix or apply a limiter instead.",
                -deviation,
                measured_peak.unwrap_or_default(),
                Self::SAFE_PEAK_CEILING_DB
            ));
        } else {
            let target_volume_db = (sequence.master_volume_db as f64 - deviation)
                .clamp(Self::MASTER_MIN_VOLUME_DB, Self::MASTER_MAX_VOLUME_DB);

            violation = violation
                .with_details(format!(
                    "Loudness normalisation will change playback level by {:.1} LU.",
                    -deviation
                ))
                .with_fix(
                    ViolationFix::new(
                        format!("Set master volume to {:.1} dB", target_volume_db),
                        vec![serde_json::json!({
                            "type": "SetMasterVolume",
                            "sequenceId": sequence.id,
                            "volumeDb": target_volume_db
                        })],
                    )
                    .with_confidence(0.7),
                );
        }

        Ok(vec![violation])
    }

    fn supports_auto_fix(&self) -> bool {
        true
    }
}

// ============================================================================
// RenderDurationRule - Checks the measured file against the sequence
// ============================================================================

/// Rule that checks whether the measured file is actually this sequence
///
/// Every other rendered rule grades the file it was handed as though it were
/// the deliverable. Nothing else asks the prior question: is this file the
/// timeline at all? A stale render from before the last edit, or a render that
/// died partway and left a truncated file, measures perfectly well and passes
/// every check while describing a program nobody edited.
///
/// The comparison is against [`Sequence::output_duration`] — the length the
/// export pipeline actually writes — and not against [`Sequence::duration`],
/// which counts disabled clips and muted tracks the render drops. Comparing
/// against the editing extent would fail correct renders of any sequence that
/// ends on a disabled clip. The rule also anchors the other rendered checks:
/// their timestamps are only comparable to the timeline while the file holds
/// the stretch it is declared to hold.
///
/// A caller measuring a partial render declares that stretch as a
/// [`MeasuredWindow`](crate::core::qc::MeasuredWindow), and the comparison is
/// against the window instead. A mismatch there is graded as a warning: the
/// window is the caller's own claim about a file it rendered deliberately, so
/// the finding is a disagreement to look at rather than a missing deliverable.
#[derive(Debug, Default)]
pub struct RenderDurationRule;

impl RenderDurationRule {
    /// Creates a new RenderDurationRule
    pub fn new() -> Self {
        Self
    }

    /// Smallest divergence worth reporting, in seconds
    ///
    /// Container timestamps, a trailing partial GOP and audio priming all move
    /// the reported duration by fractions of a second without anything being
    /// wrong. This is an absolute limit on purpose: the sources of drift do not
    /// grow with the running time, so scaling the tolerance to the length of
    /// the program only buys a long render the right to lose whole minutes of
    /// picture and still pass.
    const DEFAULT_TOLERANCE_SEC: f64 = 0.5;

    /// Frames of drift tolerated on sequences slow enough that 0.5s is tighter
    /// than a couple of frames.
    ///
    /// At 30 fps this is 0.067s and the absolute default dominates; at 2 fps a
    /// single frame is half a second and a correct render would otherwise trip
    /// the rule.
    const DEFAULT_TOLERANCE_FRAMES: f64 = 2.0;

    /// Returns the divergence tolerated for this run, in seconds.
    ///
    /// An explicitly configured `tolerance_sec` is honoured exactly — a caller
    /// asking for frame accuracy gets frame accuracy, and no floor quietly
    /// widens it back out. Without one, the default is the larger of the
    /// absolute limit and a couple of frames.
    fn tolerance_sec(config: &RuleConfig, context: &QCContext) -> f64 {
        if let Some(configured) = config.get_param::<f64>("tolerance_sec") {
            if configured.is_finite() {
                return configured.abs();
            }
        }

        let frame_allowance = Self::DEFAULT_TOLERANCE_FRAMES * context.frame_duration_sec();
        Self::DEFAULT_TOLERANCE_SEC.max(frame_allowance)
    }
}

#[async_trait]
impl QCRule for RenderDurationRule {
    fn name(&self) -> &str {
        "RenderDurationRule"
    }

    fn check_id(&self) -> &str {
        "render.duration_mismatch"
    }

    fn category(&self) -> CheckCategory {
        CheckCategory::Rendered
    }

    fn description(&self) -> &str {
        "Checks that the measured file's duration matches the sequence"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn skip_reason(&self, context: &QCContext) -> Option<String> {
        let Some(measurements) = context.measurements.as_ref() else {
            return Some("no rendered measurements available".to_string());
        };
        if measurements.file_duration_sec.is_none() {
            return Some("measured file reported no usable duration".to_string());
        }
        None
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let Some(file_duration) = context
            .measurements
            .as_ref()
            .and_then(|measurements| measurements.file_duration_sec)
        else {
            // The engine reports this rule as skipped (see `skip_reason`).
            return Ok(Vec::new());
        };

        // The render's own output length, so a correct render can never trip
        // this rule. See `Sequence::output_duration`.
        let output_duration = sequence.output_duration();
        if !output_duration.is_finite() || output_duration <= 0.0 {
            // An empty sequence has no duration to match; `sequence.empty`
            // owns that finding.
            return Ok(Vec::new());
        }

        // A caller that declared which seconds the file holds is graded against
        // that window: a 30s excerpt of a 90s edit is not a truncated render of
        // the deliverable, it is exactly the render that was asked for.
        let (span_start, span_end) = context.measured_span(output_duration);
        let expected_duration = context.expected_file_duration_sec(output_duration);
        let windowed = context.measured_window.is_some();
        if expected_duration <= 0.0 {
            // Only an empty sequence reaches here: a declared window the
            // program does not contain is refused before any check runs (see
            // `check_window_overlaps` in `core::qc::verify`), because a report
            // whose rendered checks all graded an empty span reads as a clean
            // verdict on a file nobody looked at. An empty edit is
            // `sequence.empty`'s finding, not this rule's.
            return Ok(Vec::new());
        }

        let tolerance_sec = Self::tolerance_sec(config, context);

        let delta = file_duration - expected_duration;
        if !delta.is_finite() || delta.abs() <= tolerance_sec {
            return Ok(Vec::new());
        }

        // A file shorter than the timeline is missing program: it is truncated,
        // stale, or a partial render, and it is not the deliverable whatever
        // the reason. A longer file is suspicious but still contains the whole
        // program, so it is graded as a warning.
        //
        // A declared window changes what a mismatch means. The window is the
        // caller's own claim about a file it rendered on purpose, and encoders
        // round a requested range outward by a frame or two; the finding is
        // then "your declaration and your file disagree", which is worth
        // seeing and is not a broken deliverable. So it warns either way.
        let severity = config.severity_override.unwrap_or(if windowed {
            Severity::Warning
        } else if delta < 0.0 {
            self.default_severity()
        } else {
            Severity::Warning
        });

        let subject = if windowed {
            format!("the declared window {span_start:.2}s-{span_end:.2}s")
        } else {
            "the sequence".to_string()
        };
        let message = if delta < 0.0 {
            format!(
                "Rendered file is {:.2}s shorter than {} ({:.2}s vs {:.2}s)",
                -delta, subject, file_duration, expected_duration
            )
        } else {
            format!(
                "Rendered file is {:.2}s longer than {} ({:.2}s vs {:.2}s)",
                delta, subject, file_duration, expected_duration
            )
        };

        let details = if windowed {
            "The file does not hold as much timeline as the caller declared, so the rendered \
             findings are offset from the timeline by the difference. Re-declare the window to \
             match the render, or render the window again."
                .to_string()
        } else {
            "The measured file does not match the timeline, so every other rendered check \
             describes a different program. Re-render the sequence and verify again."
                .to_string()
        };

        let mut violation = QCViolation::new(self.name(), severity, message)
            .with_location(span_start, span_end)
            .with_details(details)
            .with_metric("fileDurationSec", (file_duration * 1000.0).round() / 1000.0)
            .with_metric(
                "sequenceDurationSec",
                (output_duration * 1000.0).round() / 1000.0,
            )
            .with_metric(
                "expectedDurationSec",
                (expected_duration * 1000.0).round() / 1000.0,
            )
            .with_metric("deltaSec", (delta * 1000.0).round() / 1000.0)
            .with_metric("toleranceSec", (tolerance_sec * 1000.0).round() / 1000.0);

        if windowed {
            violation = violation
                .with_metric("windowStartSec", (span_start * 1000.0).round() / 1000.0)
                .with_metric("windowEndSec", (span_end * 1000.0).round() / 1000.0);
        }

        Ok(vec![violation])
    }
}

// ============================================================================
// MissingVideoStreamRule - Checks the render carries the picture at all
// ============================================================================

/// Returns whether the export is expected to write a picture for this sequence.
///
/// Everything on a contributing video, overlay or caption track draws into the
/// frame — including title cards and adjustment layers, which have no media of
/// their own — so a single enabled clip on one of them is what makes a
/// video-less render wrong.
fn sequence_expects_picture(sequence: &Sequence) -> bool {
    sequence
        .tracks
        .iter()
        .filter(|track| track.contributes_to_output() && !track.is_audio())
        .flat_map(|track| track.clips.iter())
        .any(|clip| clip.enabled)
}

/// Counts the clips that put something on screen.
fn picture_clip_count(sequence: &Sequence) -> usize {
    sequence
        .tracks
        .iter()
        .filter(|track| track.contributes_to_output() && !track.is_audio())
        .flat_map(|track| track.clips.iter())
        .filter(|clip| clip.enabled)
        .count()
}

/// Rule that catches a render which never wrote the picture
///
/// Every other rendered rule reads a detection list, and an empty list is
/// ambiguous: a file with no video stream reports no black frames and no
/// freezes, exactly like a file whose picture is fine. Those rules are skipped
/// once the stream table says there is nothing to look at, and this rule states
/// the finding they can no longer make — a sequence full of picture that
/// rendered to an audio-only file is broken output, however cleanly the audio
/// measures.
#[derive(Debug, Default)]
pub struct MissingVideoStreamRule;

impl MissingVideoStreamRule {
    /// Creates a new MissingVideoStreamRule
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl QCRule for MissingVideoStreamRule {
    fn name(&self) -> &str {
        "MissingVideoStreamRule"
    }

    fn check_id(&self) -> &str {
        "render.missing_video"
    }

    fn category(&self) -> CheckCategory {
        CheckCategory::Rendered
    }

    fn description(&self) -> &str {
        "Checks that a sequence with picture rendered a video stream"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn skip_reason(&self, context: &QCContext) -> Option<String> {
        let Some(measurements) = context.measurements.as_ref() else {
            return Some("no rendered measurements available".to_string());
        };
        if measurements.streams.is_none() {
            return Some("the measured file's stream table was not recorded".to_string());
        }
        None
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let Some(measurements) = context.measurements.as_ref() else {
            // The engine reports this rule as skipped (see `skip_reason`).
            return Ok(Vec::new());
        };
        let Some(has_video) = measurements.has_video_stream() else {
            return Ok(Vec::new());
        };

        // A sequence that asks for no picture is correctly rendered without
        // one; only the contradiction is a finding.
        if has_video || !sequence_expects_picture(sequence) {
            return Ok(Vec::new());
        }

        let severity = config.severity_override.unwrap_or(self.default_severity());
        let clip_count = picture_clip_count(sequence);
        let has_audio = measurements
            .streams
            .map(|streams| streams.has_audio)
            .unwrap_or(false);

        Ok(vec![QCViolation::new(
            self.name(),
            severity,
            format!(
                "Rendered file has no video stream, but the sequence puts {} clip(s) on screen",
                clip_count
            ),
        )
        .with_location(0.0, sequence.output_duration())
        .with_details(
            "The file carries no picture at all, so every picture check has nothing to grade and \
             the deliverable is not the sequence. Re-render the sequence and verify again."
                .to_string(),
        )
        .with_metric("pictureClipCount", clip_count)
        .with_metric("hasVideoStream", false)
        .with_metric("hasAudioStream", has_audio)])
    }
}

// ============================================================================
// RenderResolutionRule - Checks the rendered frame against the canvas
// ============================================================================

/// Rule that compares the rendered frame against the sequence canvas
///
/// The measurement pass probes the written frame size and rate; without a rule
/// reading them, a 9:16 edit delivered as a 16:9 file measures perfectly and
/// passes. The grades follow what the difference costs:
///
/// * a different frame **shape** is [`Severity::Error`] — the picture was
///   cropped or padded into a frame the edit was never composed for
/// * the same shape at a different **size** is [`Severity::Info`] — a proxy or
///   a delivery size, reported so the choice is visible, never failed
/// * a different **frame rate** is [`Severity::Warning`] — the motion cadence
///   was resampled on the way out, which is a delivery defect rather than a
///   broken picture
#[derive(Debug, Default)]
pub struct RenderResolutionRule;

impl RenderResolutionRule {
    /// Creates a new RenderResolutionRule
    pub fn new() -> Self {
        Self
    }

    /// Aspect divergence tolerated, as a fraction of the canvas aspect
    ///
    /// Wide enough to absorb the rounding in a 480p proxy of a 16:9 canvas
    /// (854/480 against 1920/1080), far too narrow to absorb 4:3 against 16:9.
    const DEFAULT_ASPECT_TOLERANCE: f64 = 0.02;

    /// Frame-rate divergence tolerated, as a fraction of the sequence rate
    ///
    /// Absorbs the NTSC pairs a container reports interchangeably (29.97
    /// against 30, 23.976 against 24) while still catching 25 against 30.
    const DEFAULT_FPS_TOLERANCE: f64 = 0.02;
}

#[async_trait]
impl QCRule for RenderResolutionRule {
    fn name(&self) -> &str {
        "RenderResolutionRule"
    }

    fn check_id(&self) -> &str {
        "render.resolution_mismatch"
    }

    fn category(&self) -> CheckCategory {
        CheckCategory::Rendered
    }

    fn description(&self) -> &str {
        "Compares the rendered frame size, shape and rate against the sequence"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn skip_reason(&self, context: &QCContext) -> Option<String> {
        let Some(measurements) = context.measurements.as_ref() else {
            return Some("no rendered measurements available".to_string());
        };
        if measurements.streams.is_none() {
            return Some("the measured file's stream table was not recorded".to_string());
        }
        if measurements.video_stream().is_none() {
            return Some("the measured file has no video stream".to_string());
        }
        None
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let Some(video) = context
            .measurements
            .as_ref()
            .and_then(|measurements| measurements.video_stream())
        else {
            // The engine reports this rule as skipped (see `skip_reason`).
            return Ok(Vec::new());
        };

        let aspect_tolerance = config
            .get_param::<f64>("aspect_tolerance")
            .unwrap_or(Self::DEFAULT_ASPECT_TOLERANCE)
            .abs();
        let fps_tolerance = config
            .get_param::<f64>("fps_tolerance")
            .unwrap_or(Self::DEFAULT_FPS_TOLERANCE)
            .abs();

        let program_end = sequence.output_duration();
        let canvas_width = context.canvas_width;
        let canvas_height = context.canvas_height;
        let canvas_aspect = (canvas_width > 0 && canvas_height > 0)
            .then(|| f64::from(canvas_width) / f64::from(canvas_height));

        let mut violations = Vec::new();

        if let (Some(canvas_aspect), Some(file_aspect)) = (canvas_aspect, video.aspect_ratio()) {
            let divergence = (file_aspect - canvas_aspect).abs() / canvas_aspect;

            if divergence > aspect_tolerance {
                let severity = config.severity_override.unwrap_or(self.default_severity());

                violations.push(
                    QCViolation::new(
                        self.name(),
                        severity,
                        format!(
                            "Rendered frame is {}x{} ({:.2}:1), not the shape of the {}x{} canvas \
                             ({:.2}:1)",
                            video.width,
                            video.height,
                            file_aspect,
                            canvas_width,
                            canvas_height,
                            canvas_aspect
                        ),
                    )
                    .with_location(0.0, program_end)
                    .with_details(
                        "A frame in the wrong shape either crops the composition or pads it with \
                         bars, so the file is not the edit that was composed. Re-render with the \
                         sequence canvas, or change the canvas if the delivery shape is the one \
                         that is wanted."
                            .to_string(),
                    )
                    .with_metric("fileWidth", video.width)
                    .with_metric("fileHeight", video.height)
                    .with_metric("canvasWidth", canvas_width)
                    .with_metric("canvasHeight", canvas_height)
                    .with_metric("fileAspect", (file_aspect * 1000.0).round() / 1000.0)
                    .with_metric("canvasAspect", (canvas_aspect * 1000.0).round() / 1000.0),
                );
            } else if video.width != canvas_width || video.height != canvas_height {
                let severity = config.severity_override.unwrap_or(Severity::Info);

                violations.push(
                    QCViolation::new(
                        self.name(),
                        severity,
                        format!(
                            "Rendered at {}x{} for a {}x{} canvas",
                            video.width, video.height, canvas_width, canvas_height
                        ),
                    )
                    .with_location(0.0, program_end)
                    .with_details(
                        "The frame shape matches, so this is a scaled render — a proxy, or a \
                         delivery size. Re-render at the canvas size if the full-resolution \
                         master was the deliverable."
                            .to_string(),
                    )
                    .with_metric("fileWidth", video.width)
                    .with_metric("fileHeight", video.height)
                    .with_metric("canvasWidth", canvas_width)
                    .with_metric("canvasHeight", canvas_height),
                );
            }
        }

        if video.fps.is_finite() && video.fps > 0.0 {
            let divergence = (video.fps - context.fps).abs() / context.fps;

            if divergence > fps_tolerance {
                let severity = config.severity_override.unwrap_or(Severity::Warning);

                violations.push(
                    QCViolation::new(
                        self.name(),
                        severity,
                        format!(
                            "Rendered at {:.3} fps for a {:.3} fps sequence",
                            video.fps, context.fps
                        ),
                    )
                    .with_location(0.0, program_end)
                    .with_details(
                        "Frame timing was resampled on the way out, so the cadence of motion in \
                         the file is not the one the timeline was cut to."
                            .to_string(),
                    )
                    .with_metric("fileFps", (video.fps * 1000.0).round() / 1000.0)
                    .with_metric("sequenceFps", (context.fps * 1000.0).round() / 1000.0),
                );
            }
        }

        Ok(violations)
    }
}

// ============================================================================
// FrozenProgramRule - Checks the rendered picture actually moves
// ============================================================================

/// Rule that reports how much of the rendered program never moves
///
/// The measurement pass detects frozen stretches; without a rule reading them,
/// a render that stalled on one frame — a dropped video chain, an encoder that
/// repeated the first picture, a still written where the edit has motion —
/// measures clean and passes.
///
/// Grading follows the same shape as the black rule: coverage of the program as
/// a whole decides, not the length of any one stretch. Held frames, title cards
/// and stills are all legitimately frozen, so a minority of frozen time is
/// reported as [`Severity::Info`] without a verdict; a program that is frozen
/// for most of its running time is [`Severity::Error`].
///
/// Freeze ranges reach this rule already translated into timeline seconds, and
/// the program they are measured against is the stretch the file holds — the
/// whole output, or the declared window of a partial render.
#[derive(Debug, Default)]
pub struct FrozenProgramRule;

impl FrozenProgramRule {
    /// Creates a new FrozenProgramRule
    pub fn new() -> Self {
        Self
    }

    /// Fraction of the program that may be frozen before the render is broken
    const DEFAULT_FRACTION_ERROR: f64 = 0.5;
}

#[async_trait]
impl QCRule for FrozenProgramRule {
    fn name(&self) -> &str {
        "FrozenProgramRule"
    }

    fn check_id(&self) -> &str {
        "render.frozen"
    }

    fn category(&self) -> CheckCategory {
        CheckCategory::Rendered
    }

    fn description(&self) -> &str {
        "Reports how much of the rendered program shows a frozen picture"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    fn skip_reason(&self, context: &QCContext) -> Option<String> {
        let Some(measurements) = context.measurements.as_ref() else {
            return Some("no rendered measurements available".to_string());
        };
        if measurements.has_video_stream() == Some(false) {
            return Some("the measured file has no video stream".to_string());
        }
        None
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let Some(measurements) = context.measurements.as_ref() else {
            // The engine reports this rule as skipped (see `skip_reason`).
            return Ok(Vec::new());
        };
        if measurements.freeze_ranges.is_empty() {
            return Ok(Vec::new());
        }

        let output_duration = sequence.output_duration();
        if !output_duration.is_finite() || output_duration <= 0.0 {
            // An empty sequence has no program to freeze; `sequence.empty` owns
            // that finding.
            return Ok(Vec::new());
        }

        // The program this file covers, which is the declared window for a
        // partial render: judging an excerpt's frozen share against the whole
        // edit would call every short excerpt clean.
        let (span_start, span_end) = context.measured_span(output_duration);
        let program_duration = context.expected_file_duration_sec(output_duration);
        if program_duration <= 0.0 {
            return Ok(Vec::new());
        }

        let error_fraction = config
            .get_param::<f64>("frozen_fraction")
            .unwrap_or(Self::DEFAULT_FRACTION_ERROR)
            .abs();

        // Overlapping detections must not add up past the program they are
        // measured against, and a file longer than the timeline cannot freeze
        // more of the program than the program has.
        let frozen_sec =
            merged_span_duration_sec(&measurements.freeze_ranges).min(program_duration);
        let fraction = frozen_sec / program_duration;
        let longest_sec = measurements
            .freeze_ranges
            .iter()
            .map(|(start, end)| end - start)
            .filter(|duration| duration.is_finite())
            .fold(0.0_f64, f64::max);

        let is_broken = fraction >= error_fraction;
        let severity = config.severity_override.unwrap_or(if is_broken {
            Severity::Error
        } else {
            Severity::Info
        });

        let details = if is_broken {
            "The picture does not move for most of the running time, so the render stalled on a \
             frame rather than writing the edit. Re-render the sequence and verify again."
                .to_string()
        } else {
            "Held frames, stills and title cards are frozen by construction; inspect the timeline \
             if none of those belong here."
                .to_string()
        };

        Ok(vec![QCViolation::new(
            self.name(),
            severity,
            format!(
                "Frozen picture covers {:.0}% of the program ({:.2}s across {} range(s))",
                fraction * 100.0,
                frozen_sec,
                measurements.freeze_ranges.len()
            ),
        )
        .with_location(span_start, span_end)
        .with_details(details)
        .with_metric("frozenSec", (frozen_sec * 1000.0).round() / 1000.0)
        .with_metric("programFraction", (fraction * 1000.0).round() / 1000.0)
        .with_metric("rangeCount", measurements.freeze_ranges.len())
        .with_metric(
            "longestFrozenSec",
            (longest_sec * 1000.0).round() / 1000.0,
        )])
    }
}

// ============================================================================
// AudioClippingRule - Checks the mix for flat-topped samples
// ============================================================================

/// Rule that reports the flatness the audio statistics pass measured
///
/// `astats` counts runs of samples pinned at the signal's extreme level, which
/// is what a clipped or hard-limited master looks like from the outside. The
/// peak rule reads how loud the program got; nothing else read whether the
/// waveform survived getting there, so a render clipped flat measured clean and
/// passed.
///
/// Findings stay at [`Severity::Warning`]: a deliberately limited master is
/// flat by design, and only a listener can tell that apart from damage.
/// `audio.peak` keeps the objectively broken half — a signal over the ceiling.
#[derive(Debug, Default)]
pub struct AudioClippingRule;

impl AudioClippingRule {
    /// Creates a new AudioClippingRule
    pub fn new() -> Self {
        Self
    }

    /// Flatness above which the runs stop looking like ordinary programme peaks
    ///
    /// `astats` reports flatness in dB over the ratio of flat runs to samples
    /// at the extremes, so a healthy mix sits at or near zero.
    const DEFAULT_FLAT_FACTOR: f64 = 10.0;
}

#[async_trait]
impl QCRule for AudioClippingRule {
    fn name(&self) -> &str {
        "AudioClippingRule"
    }

    fn check_id(&self) -> &str {
        "audio.clipping"
    }

    fn category(&self) -> CheckCategory {
        CheckCategory::Rendered
    }

    fn description(&self) -> &str {
        "Reports flat-topped samples that indicate a clipped or limited master"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    fn skip_reason(&self, context: &QCContext) -> Option<String> {
        let Some(measurements) = context.measurements.as_ref() else {
            return Some("no rendered measurements available".to_string());
        };
        if measurements.flat_factor.is_none() {
            return Some("no audio flatness measurement available".to_string());
        }
        None
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let Some(measurements) = context.measurements.as_ref() else {
            // The engine reports this rule as skipped (see `skip_reason`).
            return Ok(Vec::new());
        };
        let Some(flat_factor) = measurements.flat_factor else {
            return Ok(Vec::new());
        };

        let threshold = config
            .get_param::<f64>("flat_factor")
            .unwrap_or(Self::DEFAULT_FLAT_FACTOR);

        if !flat_factor.is_finite() || flat_factor <= threshold {
            return Ok(Vec::new());
        }

        let severity = config.severity_override.unwrap_or(self.default_severity());
        let measured_peak = measurements.true_peak_dbtp.or(measurements.sample_peak_db);

        let mut violation = QCViolation::new(
            self.name(),
            severity,
            format!(
                "Audio flatness factor is {:.1}, above the {:.1} threshold",
                flat_factor, threshold
            ),
        )
        .with_location(0.0, sequence.output_duration())
        .with_details(
            "Runs of samples sit pinned at the signal's extreme level, which is how clipping and \
             hard limiting look from outside. Check the mix before delivery; a master limited on \
             purpose reads the same way."
                .to_string(),
        )
        .with_metric("flatFactor", (flat_factor * 1000.0).round() / 1000.0)
        .with_metric("thresholdFlatFactor", threshold);

        if let Some(peak) = measured_peak {
            violation = violation.with_metric("measuredPeakDb", (peak * 100.0).round() / 100.0);
        }

        Ok(vec![violation])
    }
}

// ============================================================================
// CaptionSafeAreaRule - Ensures captions are in safe area
// ============================================================================

/// Rule that ensures captions remain within the title-safe area
///
/// Works purely from timeline structure: caption clips carry their position and
/// style as untyped JSON, which is deserialized defensively so a legacy or
/// partially written blob degrades to the caption defaults instead of failing
/// the whole check.
///
/// Both anchoring modes are measured against the canvas rather than merely
/// compared to a margin, because the margin alone does not say where the block
/// ends up. A preset anchor holds the block's near *edge* on its margin line
/// and grows inward, so the margin protects the edge it names and the failure
/// mode is a tall block reaching across the frame toward the opposite one. A
/// custom anchor centers the block on the point the author chose, so a large
/// enough font overruns the edge in both directions.
///
/// Horizontal extent is modelled for both, but they wrap differently: a preset
/// caption wraps inside [`CAPTION_WRAP_BOX_WIDTH_PERCENT`], a custom one at the
/// frame edge, and text with no break opportunity at all - CJK, a bare URL -
/// does not wrap anywhere and simply bleeds off the side.
#[derive(Debug, Default)]
pub struct CaptionSafeAreaRule;

impl CaptionSafeAreaRule {
    /// Creates a new CaptionSafeAreaRule
    pub fn new() -> Self {
        Self
    }

    /// Default title-safe margin (percentage of canvas)
    const DEFAULT_MARGIN_PERCENT: f64 = 10.0;

    /// Action-safe margin (percentage of canvas)
    ///
    /// Text outside this band risks being cropped by overscan and covered by
    /// platform UI overlays, so breaching it is reported at the rule severity
    /// while breaching only the title-safe margin stays informational.
    const ACTION_SAFE_MARGIN_PERCENT: f64 = 5.0;

    /// Average glyph advance as a fraction of the font size
    ///
    /// Core has no text shaping, so rendered text width can only be
    /// approximated; half an em is the usual figure for mixed-case Latin and is
    /// intentionally coarse.
    const GLYPH_ADVANCE_FACTOR: f64 = 0.5;

    /// Maximum estimated text-box width as a percentage of canvas width
    ///
    /// Keeps a pathological font size from putting a nonsense span in the
    /// violation message. It is not free: because the line count is derived
    /// from the same width, a caption more than five canvases wide is reported
    /// with fewer lines - and so less height - than it would really have. That
    /// understates an already-reported breach rather than hiding one, since a
    /// block that long has breached the band several lines earlier.
    const MAX_TEXT_BOX_WIDTH_PERCENT: f64 = 500.0;

    /// Line height as a multiple of the font size (typographic default)
    const LINE_HEIGHT_FACTOR: f64 = 1.2;

    /// Reads the caption font size in pixels from the clip's style JSON.
    fn font_size_px(style: Option<&serde_json::Value>) -> f64 {
        let default_size = f64::from(CaptionStyle::default().font_size);

        let Some(value) = style else {
            return default_size;
        };

        if let Ok(parsed) = serde_json::from_value::<CaptionStyle>(value.clone()) {
            return f64::from(parsed.font_size);
        }

        // Partial style blobs are common (only the edited fields are stored),
        // so fall back to reading the single field this rule needs.
        value
            .get("fontSize")
            .or_else(|| value.get("font_size"))
            .and_then(serde_json::Value::as_f64)
            .filter(|size| size.is_finite() && *size > 0.0)
            .unwrap_or(default_size)
    }

    /// Returns the estimated text box size as (width, height) percentages.
    ///
    /// Both axes scale with the font size and the canvas, because that is what
    /// the renderer does: a caption is burned in at an absolute size, so the
    /// same text occupies twice the width on a 1080-wide vertical canvas that
    /// it does on a 1920-wide landscape one.
    ///
    /// `wrap_box_width_percent` is how wide the renderer lets the text run
    /// before breaking it: [`CAPTION_WRAP_BOX_WIDTH_PERCENT`] for a preset
    /// caption, whose ASS event carries side margins, and the full frame for a
    /// custom one, which is positioned with `\pos` and so has no margins to
    /// wrap inside. Text that fits nowhere is not turned into extra lines
    /// unless it *can* break: libass needs a break opportunity, so a run
    /// without one - unspaced CJK, a bare URL - stays on one line and runs off
    /// the side, which is a horizontal breach and is reported as one.
    fn estimate_text_box_percent(
        clip: &Clip,
        canvas_width: u32,
        canvas_height: u32,
        wrap_box_width_percent: f64,
    ) -> (f64, f64) {
        let label = clip.label.as_deref().unwrap_or_default();
        let char_count = label.chars().count() as f64;

        let font_size = Self::font_size_px(clip.caption_style.as_ref());

        let canvas_width = if canvas_width > 0 { canvas_width } else { 1 };
        let unwrapped_width_percent =
            char_count * font_size * Self::GLYPH_ADVANCE_FACTOR / f64::from(canvas_width) * 100.0;

        let (width_percent, line_count) = if label.chars().any(char::is_whitespace) {
            let bounded = unwrapped_width_percent.min(Self::MAX_TEXT_BOX_WIDTH_PERCENT);
            (
                bounded.min(wrap_box_width_percent),
                (bounded / wrap_box_width_percent).ceil().max(1.0),
            )
        } else {
            // Deliberately uncapped: the whole point of this branch is that the
            // width is the breach, so clamping it would clamp away the finding.
            (unwrapped_width_percent, 1.0)
        };

        let canvas_height = if canvas_height > 0 { canvas_height } else { 1 };
        let height_percent =
            line_count * font_size * Self::LINE_HEIGHT_FACTOR / f64::from(canvas_height) * 100.0;

        (width_percent, height_percent)
    }

    /// Reads the caption's horizontal alignment from its style JSON.
    ///
    /// Mirrors the render path's alias list; anything unrecognized is centered,
    /// which is the renderer's own default.
    fn alignment(style: Option<&serde_json::Value>) -> TextAlignment {
        let Some(value) = style.and_then(serde_json::Value::as_object) else {
            return TextAlignment::Center;
        };

        let raw = ["alignment", "textAlign", "text_align"]
            .iter()
            .find_map(|key| value.get(*key))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();

        match raw.as_str() {
            "left" => TextAlignment::Left,
            "right" => TextAlignment::Right,
            _ => TextAlignment::Center,
        }
    }

    /// Returns the horizontal span a text box of `width_percent` occupies.
    ///
    /// Matches both render paths: a left-aligned run starts at the anchor,
    /// a right-aligned one ends there, and a centered one straddles it.
    fn horizontal_span(
        anchor_percent: f64,
        width_percent: f64,
        alignment: &TextAlignment,
    ) -> (f64, f64) {
        match alignment {
            TextAlignment::Left => (anchor_percent, anchor_percent + width_percent),
            TextAlignment::Right => (anchor_percent - width_percent, anchor_percent),
            TextAlignment::Center => (
                anchor_percent - width_percent / 2.0,
                anchor_percent + width_percent / 2.0,
            ),
        }
    }

    /// Returns the vertical span a preset caption occupies, as (top, bottom).
    ///
    /// A preset margin is a gap to the block's near *edge*, not to its center:
    /// "10% from the bottom" puts the bottom of the last line a tenth of the
    /// canvas above the bottom edge, and the block grows upward from there.
    /// So the margin always protects the edge it names, and what a large font
    /// or a wrapped caption threatens is the *opposite* edge.
    fn preset_vertical_span(
        vertical: &VerticalPosition,
        margin_percent: f64,
        box_height_percent: f64,
    ) -> (f64, f64) {
        match vertical {
            VerticalPosition::Top => (margin_percent, margin_percent + box_height_percent),
            VerticalPosition::Center => (
                50.0 - box_height_percent / 2.0,
                50.0 + box_height_percent / 2.0,
            ),
            VerticalPosition::Bottom => (
                100.0 - margin_percent - box_height_percent,
                100.0 - margin_percent,
            ),
        }
    }

    /// Returns the horizontal anchor a preset caption uses for `alignment`.
    ///
    /// Mirrors `caption_preset_anchor_x` on the render side: a left- or
    /// right-aligned preset caption sits on its side margin rather than in the
    /// middle of the frame.
    fn preset_anchor_x_percent(alignment: &TextAlignment) -> f64 {
        match alignment {
            TextAlignment::Left => CAPTION_SIDE_MARGIN_PERCENT,
            TextAlignment::Right => 100.0 - CAPTION_SIDE_MARGIN_PERCENT,
            TextAlignment::Center => 50.0,
        }
    }

    /// Centers a box of `size_percent` inside the safe band, without panicking
    /// when the box is wider than the band itself.
    fn clamp_center(center_percent: f64, size_percent: f64, margin_percent: f64) -> f64 {
        let min = margin_percent + size_percent / 2.0;
        let max = 100.0 - margin_percent - size_percent / 2.0;

        if min > max {
            50.0
        } else {
            center_percent.clamp(min, max)
        }
    }
}

/// Which safe band a caption breached.
///
/// The grouping key, and the only thing that separates two findings on the same
/// track: a title-safe breach is informational while an action-safe one is
/// graded, so they cannot share a violation. Which *way* a caption breached its
/// band — a margin below the line, a block reaching across the frame, a custom
/// anchor off the edge — is recorded per cue instead, because the repair is the
/// same move in every case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SafeAreaBand {
    /// Outside the action-safe band: at risk of being cropped or covered
    ActionSafe,
    /// Inside action-safe but outside title-safe: a style note, not a defect
    TitleSafe,
}

impl SafeAreaBand {
    /// Summary line for a group of `count` cues that breached this band.
    fn summary(self, count: usize) -> String {
        match self {
            SafeAreaBand::ActionSafe => {
                format!("{count} caption(s) on this track fall outside the action-safe area")
            }
            SafeAreaBand::TitleSafe => format!(
                "{count} caption(s) on this track fall outside the title-safe area but inside the \
                 action-safe one"
            ),
        }
    }
}

/// Smallest band height sampled for a caption, as a percentage of the canvas.
///
/// A tiny font would otherwise crop to a strip a pixel or two tall, whose mean
/// says more about the encoder's chroma than about what sits behind the words.
const MIN_CAPTION_BAND_HEIGHT_PERCENT: f64 = 3.0;

/// Returns the horizontal band a caption occupies, as `(top, bottom)`
/// percentages of canvas height.
///
/// Shares [`CaptionSafeAreaRule`]'s block estimate rather than restating it, so
/// the band the contrast check samples is the same block the safe-area check
/// grades: two different guesses at where a caption sits would let one rule
/// clear a caption the other one measured somewhere else. The span is widened
/// to [`MIN_CAPTION_BAND_HEIGHT_PERCENT`] and clamped to the frame, so it is
/// always a crop FFmpeg can take.
pub(crate) fn caption_band_percent(
    clip: &Clip,
    canvas_width: u32,
    canvas_height: u32,
) -> (f64, f64) {
    let position = clip
        .caption_position
        .as_ref()
        .and_then(|value| serde_json::from_value::<CaptionPosition>(value.clone()).ok())
        .unwrap_or_default();

    let (top, bottom) = match &position {
        CaptionPosition::Preset {
            vertical,
            margin_percent,
        } => {
            let (_, box_height) = CaptionSafeAreaRule::estimate_text_box_percent(
                clip,
                canvas_width,
                canvas_height,
                CAPTION_WRAP_BOX_WIDTH_PERCENT,
            );
            CaptionSafeAreaRule::preset_vertical_span(vertical, *margin_percent, box_height)
        }
        CaptionPosition::Custom(custom) => {
            let (_, box_height) = CaptionSafeAreaRule::estimate_text_box_percent(
                clip,
                canvas_width,
                canvas_height,
                100.0,
            );
            (
                custom.y_percent - box_height / 2.0,
                custom.y_percent + box_height / 2.0,
            )
        }
    };

    let (top, bottom) = if top.is_finite() && bottom.is_finite() && bottom > top {
        (top, bottom)
    } else {
        // A pathological style produced no usable block; fall back to the band
        // the caption defaults put the words in.
        (100.0 - 10.0 - MIN_CAPTION_BAND_HEIGHT_PERCENT, 90.0)
    };

    let deficit = MIN_CAPTION_BAND_HEIGHT_PERCENT - (bottom - top);
    let (top, bottom) = if deficit > 0.0 {
        (top - deficit / 2.0, bottom + deficit / 2.0)
    } else {
        (top, bottom)
    };

    let top = top.clamp(0.0, 100.0 - MIN_CAPTION_BAND_HEIGHT_PERCENT);
    let bottom = bottom.clamp(top + MIN_CAPTION_BAND_HEIGHT_PERCENT, 100.0);

    (top, bottom)
}

#[async_trait]
impl QCRule for CaptionSafeAreaRule {
    fn name(&self) -> &str {
        "CaptionSafeAreaRule"
    }

    fn check_id(&self) -> &str {
        "caption.safe_area"
    }

    fn description(&self) -> &str {
        "Ensures captions are positioned within the title-safe area"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let mut violations = Vec::new();

        let title_safe_margin = config
            .get_param::<f64>("margin_percent")
            .unwrap_or(Self::DEFAULT_MARGIN_PERCENT);
        let action_safe_margin = Self::ACTION_SAFE_MARGIN_PERCENT;

        let severity = config.severity_override.unwrap_or(self.default_severity());

        for track in &sequence.tracks {
            if !track.is_caption() {
                continue;
            }

            let mut action_safe: Vec<CaptionFinding> = Vec::new();
            let mut title_safe: Vec<CaptionFinding> = Vec::new();

            for clip in &track.clips {
                // A missing or unreadable position renders with the caption
                // default, so the check follows the same fallback.
                let position = clip
                    .caption_position
                    .as_ref()
                    .and_then(|value| serde_json::from_value::<CaptionPosition>(value.clone()).ok())
                    .unwrap_or_default();

                let (band, reason, message, details, suggested_position) = match &position {
                    CaptionPosition::Preset {
                        vertical,
                        margin_percent,
                    } => {
                        // The middle row sits mid-canvas, where an edge margin
                        // has no meaning; it is still measured below for a
                        // block tall enough to reach an edge on its own.
                        let margin_is_meaningful = *vertical != VerticalPosition::Center;

                        if margin_is_meaningful && *margin_percent < action_safe_margin {
                            (
                                SafeAreaBand::ActionSafe,
                                "action_safe_margin",
                                "Caption positioned outside the action-safe area".to_string(),
                                format!(
                                    "Margin of {:.1}% is below the {:.1}% action-safe margin",
                                    margin_percent, action_safe_margin
                                ),
                                CaptionPosition::Preset {
                                    vertical: vertical.clone(),
                                    margin_percent: title_safe_margin,
                                },
                            )
                        } else if margin_is_meaningful && *margin_percent < title_safe_margin {
                            (
                                SafeAreaBand::TitleSafe,
                                "title_safe_margin",
                                "Caption positioned outside the title-safe area".to_string(),
                                format!(
                                    "Margin of {:.1}% is below the {:.1}% title-safe margin but within the action-safe area",
                                    margin_percent, title_safe_margin
                                ),
                                CaptionPosition::Preset {
                                    vertical: vertical.clone(),
                                    margin_percent: title_safe_margin,
                                },
                            )
                        } else {
                            // The margin clears both bands, and because it is a
                            // gap to the block's near edge that edge is safe by
                            // construction. What is not is the far one: the
                            // block grows inward, one wrapped line at a time,
                            // until a large enough font or a long enough
                            // caption reaches across the frame. Text with no
                            // break opportunity does not wrap at all and runs
                            // off the side instead, so both axes are measured.
                            if context.canvas_height == 0 {
                                continue;
                            }

                            let (box_width, box_height) = Self::estimate_text_box_percent(
                                clip,
                                context.canvas_width,
                                context.canvas_height,
                                CAPTION_WRAP_BOX_WIDTH_PERCENT,
                            );
                            let alignment = Self::alignment(clip.caption_style.as_ref());
                            let (left, right) = Self::horizontal_span(
                                Self::preset_anchor_x_percent(&alignment),
                                box_width,
                                &alignment,
                            );
                            let (top, bottom) =
                                Self::preset_vertical_span(vertical, *margin_percent, box_height);
                            let upper_bound = 100.0 - action_safe_margin;

                            if left >= action_safe_margin
                                && right <= upper_bound
                                && top >= action_safe_margin
                                && bottom <= upper_bound
                            {
                                continue;
                            }

                            (
                                SafeAreaBand::ActionSafe,
                                "text_block",
                                "Caption text extends outside the action-safe area".to_string(),
                                format!(
                                    "Estimated text block spans x {:.1}%-{:.1}%, y {:.1}%-{:.1}% at {:.0}px on a {}x{}px canvas, outside the {:.1}%-{:.1}% safe band (block size is an approximation)",
                                    left,
                                    right,
                                    top,
                                    bottom,
                                    Self::font_size_px(clip.caption_style.as_ref()),
                                    context.canvas_width,
                                    context.canvas_height,
                                    action_safe_margin,
                                    upper_bound
                                ),
                                // Nothing a margin can do makes a block taller
                                // than the safe band fit, so the suggestion
                                // centers it: the margin that leaves the block
                                // sitting on the action-safe line.
                                CaptionPosition::Preset {
                                    vertical: vertical.clone(),
                                    margin_percent: title_safe_margin.min(45.0),
                                },
                            )
                        }
                    }
                    CaptionPosition::Custom(custom) => {
                        // A custom caption is positioned with `\pos`, which
                        // disables the event margins, so libass wraps it only
                        // where it meets the frame edge.
                        let (box_width, box_height) = Self::estimate_text_box_percent(
                            clip,
                            context.canvas_width,
                            context.canvas_height,
                            100.0,
                        );
                        let alignment = Self::alignment(clip.caption_style.as_ref());

                        let (left, right) =
                            Self::horizontal_span(custom.x_percent, box_width, &alignment);
                        let top = custom.y_percent - box_height / 2.0;
                        let bottom = custom.y_percent + box_height / 2.0;

                        let upper_bound = 100.0 - action_safe_margin;
                        if left >= action_safe_margin
                            && right <= upper_bound
                            && top >= action_safe_margin
                            && bottom <= upper_bound
                        {
                            continue;
                        }

                        // The fix has to be expressed in the same anchoring the
                        // renderer reads, so the clamped center is converted
                        // back into a left/right/center anchor.
                        let clamped_center_x =
                            Self::clamp_center((left + right) / 2.0, box_width, action_safe_margin);
                        let fixed_x = match alignment {
                            TextAlignment::Left => clamped_center_x - box_width / 2.0,
                            TextAlignment::Right => clamped_center_x + box_width / 2.0,
                            TextAlignment::Center => clamped_center_x,
                        };

                        (
                            SafeAreaBand::ActionSafe,
                            "custom_anchor",
                            "Caption positioned outside the action-safe area".to_string(),
                            format!(
                                "Estimated text box spans x {:.1}%-{:.1}%, y {:.1}%-{:.1}%, outside the {:.1}%-{:.1}% safe band (box size is an approximation)",
                                left, right, top, bottom, action_safe_margin, upper_bound
                            ),
                            CaptionPosition::Custom(CustomPosition {
                                x_percent: fixed_x,
                                y_percent: Self::clamp_center(
                                    custom.y_percent,
                                    box_height,
                                    action_safe_margin,
                                ),
                            }),
                        )
                    }
                };

                let mut finding = CaptionFinding::new(
                    clip.id.clone(),
                    clip.place.timeline_in_sec,
                    clip.timeline_end(),
                )
                .with_metric("reason", reason)
                .with_metric("issue", message)
                .with_metric("detail", details);

                if let Ok(position_json) = serde_json::to_value(&suggested_position) {
                    finding = finding.with_commands(
                        vec![serde_json::json!({
                            "type": "UpdateCaption",
                            "sequenceId": sequence.id,
                            "trackId": track.id,
                            "clipId": clip.id,
                            "position": position_json
                        })],
                        // Moving a caption back inside the band is the whole
                        // repair; nothing about the cue is left to decide.
                        true,
                    );
                }

                match band {
                    SafeAreaBand::ActionSafe => action_safe.push(finding),
                    SafeAreaBand::TitleSafe => title_safe.push(finding),
                }
            }

            // One violation per band per track, not one per cue: a machine
            // transcript anchored two percent too low is one mistake, and a
            // report that states it once with a plan covering every cue is the
            // one an agent can actually act on.
            for (band, findings) in [
                (SafeAreaBand::ActionSafe, action_safe),
                (SafeAreaBand::TitleSafe, title_safe),
            ] {
                let band_severity = match band {
                    SafeAreaBand::ActionSafe => severity,
                    SafeAreaBand::TitleSafe => Severity::Info,
                };
                violations.extend(group_caption_findings(
                    CaptionGroup {
                        rule_name: self.name(),
                        severity: band_severity,
                        track_id: &track.id,
                        details: "Each listed cue carries its own measurement under `cues`. The \
                                  suggested fix moves every one of them back inside the band in a \
                                  single plan."
                            .to_string(),
                        fix_description: "Move every listed caption inside the safe area"
                            .to_string(),
                        confidence: 0.95,
                    },
                    findings,
                    |count| band.summary(count),
                ));
            }
        }

        Ok(violations)
    }

    fn supports_auto_fix(&self) -> bool {
        true
    }
}

// ============================================================================
// CutRhythmRule - Checks cut timing rhythm
// ============================================================================

/// Rule that checks if cuts follow a consistent rhythm
#[derive(Debug, Default)]
pub struct CutRhythmRule;

impl CutRhythmRule {
    /// Creates a new CutRhythmRule
    pub fn new() -> Self {
        Self
    }

    /// Default minimum cut duration (seconds)
    const DEFAULT_MIN_CUT_SEC: f64 = 1.0;

    /// Default maximum cut duration (seconds)
    const DEFAULT_MAX_CUT_SEC: f64 = 10.0;
}

#[async_trait]
impl QCRule for CutRhythmRule {
    fn name(&self) -> &str {
        "CutRhythmRule"
    }

    fn check_id(&self) -> &str {
        "shot.cut_rhythm"
    }

    fn description(&self) -> &str {
        "Checks if video cuts maintain appropriate rhythm and pacing"
    }

    fn default_severity(&self) -> Severity {
        Severity::Info
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        _context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let mut violations = Vec::new();

        let min_cut = config
            .get_param::<f64>("min_cut_sec")
            .unwrap_or(Self::DEFAULT_MIN_CUT_SEC);
        let max_cut = config
            .get_param::<f64>("max_cut_sec")
            .unwrap_or(Self::DEFAULT_MAX_CUT_SEC);

        let severity = config.severity_override.unwrap_or(self.default_severity());

        // Check video tracks for cut rhythm
        for track in &sequence.tracks {
            if !track.is_video() {
                continue;
            }

            for clip in &track.clips {
                let duration = clip.duration();

                if duration < min_cut {
                    let violation = QCViolation::new(
                        self.name(),
                        severity,
                        format!("Cut too short ({:.1}s < {:.1}s minimum)", duration, min_cut),
                    )
                    .with_location(clip.place.timeline_in_sec, clip.timeline_end())
                    .with_entities(vec![clip.id.clone()])
                    .with_details(
                        "Very short cuts may feel jarring to viewers. Consider extending.",
                    );

                    violations.push(violation);
                } else if duration > max_cut {
                    let violation = QCViolation::new(
                        self.name(),
                        severity,
                        format!("Cut too long ({:.1}s > {:.1}s maximum)", duration, max_cut),
                    )
                    .with_location(clip.place.timeline_in_sec, clip.timeline_end())
                    .with_entities(vec![clip.id.clone()])
                    .with_details("Long cuts may lose viewer attention. Consider splitting.");

                    violations.push(violation);
                }
            }
        }

        Ok(violations)
    }
}

// ============================================================================
// LicenseRule - Checks asset license compliance
// ============================================================================

/// Rule that checks if all assets have proper licensing
#[derive(Debug, Default)]
pub struct LicenseRule;

impl LicenseRule {
    /// Creates a new LicenseRule
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl QCRule for LicenseRule {
    fn name(&self) -> &str {
        "LicenseRule"
    }

    fn check_id(&self) -> &str {
        "asset.license"
    }

    fn description(&self) -> &str {
        "Verifies all assets have valid licensing for intended use"
    }

    fn default_severity(&self) -> Severity {
        Severity::Critical
    }

    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
        _context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let mut violations = Vec::new();

        let severity = config.severity_override.unwrap_or(self.default_severity());
        let check_commercial = config.get_param::<bool>("check_commercial").unwrap_or(true);

        // Get all unique assets used in sequence
        let mut used_asset_ids = std::collections::HashSet::<String>::new();
        for track in &sequence.tracks {
            for clip in &track.clips {
                used_asset_ids.insert(clip.asset_id.clone());
            }
        }

        // Check license for each used asset
        for asset_id in used_asset_ids {
            if let Some(asset) = state.get_asset(&asset_id) {
                // Check if license info exists
                if asset.license.proof_path.is_none() {
                    let violation = QCViolation::new(
                        self.name(),
                        Severity::Warning,
                        format!("Asset '{}' missing license proof", asset.uri),
                    )
                    .with_entities(vec![asset_id.clone()])
                    .with_details("Consider adding license documentation for this asset");

                    violations.push(violation);
                }

                // Check commercial use if required
                if check_commercial
                    && !asset
                        .license
                        .allowed_use
                        .contains(&"commercial".to_string())
                {
                    let violation = QCViolation::new(
                        self.name(),
                        severity,
                        format!(
                            "Asset '{}' may not be licensed for commercial use",
                            asset.uri
                        ),
                    )
                    .with_entities(vec![asset_id.clone()])
                    .with_details(format!(
                        "Allowed uses: {:?}. Verify licensing before commercial distribution.",
                        asset.license.allowed_use
                    ));

                    violations.push(violation);
                }

                // Check license expiration
                if let Some(expires) = &asset.license.expires_at {
                    if let Ok(expires_at) = chrono::DateTime::parse_from_rfc3339(expires) {
                        if expires_at.with_timezone(&chrono::Utc) < chrono::Utc::now() {
                            let violation = QCViolation::new(
                                self.name(),
                                Severity::Critical,
                                format!("Asset '{}' license has expired", asset.uri),
                            )
                            .with_entities(vec![asset_id.clone()])
                            .with_details(format!(
                                "License expired on {}. Renew or replace asset.",
                                expires
                            ));

                            violations.push(violation);
                        }
                    }
                }
            }
        }

        Ok(violations)
    }
}

// ============================================================================
// AspectRatioRule - Checks aspect ratio consistency
// ============================================================================

/// Rule that checks if all clips match the sequence aspect ratio
///
/// Reports the mismatch and stops there. The export pipeline fits every source
/// into the canvas with `force_original_aspect_ratio=decrease` plus a pad, so a
/// mismatch shows as bars rather than as broken output.
///
/// A reframe fix is possible in principle — the export now composites
/// `SetClipTransform`, so a scale-and-crop suggestion would render — but
/// choosing *which* part of a mismatched frame to keep is a judgement about the
/// picture, not arithmetic this rule can do. No such fix is implemented yet, so
/// the rule reports and leaves the framing decision to the caller.
#[derive(Debug, Default)]
pub struct AspectRatioRule;

impl AspectRatioRule {
    /// Creates a new AspectRatioRule
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl QCRule for AspectRatioRule {
    fn name(&self) -> &str {
        "AspectRatioRule"
    }

    fn check_id(&self) -> &str {
        "clip.aspect_ratio"
    }

    fn description(&self) -> &str {
        "Verifies all video clips match the sequence aspect ratio"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
        _context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let mut violations = Vec::new();

        let severity = config.severity_override.unwrap_or(self.default_severity());
        let tolerance = config.get_param::<f64>("tolerance").unwrap_or(0.01);

        let seq_aspect = sequence.format.canvas.width as f64 / sequence.format.canvas.height as f64;

        // Check all video clips
        for track in &sequence.tracks {
            if !track.is_video() {
                continue;
            }

            for clip in &track.clips {
                if let Some(asset) = state.get_asset(&clip.asset_id) {
                    if let Some(video_info) = asset.video.as_ref() {
                        let asset_aspect = video_info.width as f64 / video_info.height as f64;
                        let diff = (asset_aspect - seq_aspect).abs();

                        if diff > tolerance {
                            let violation = QCViolation::new(
                                self.name(),
                                severity,
                                format!(
                                    "Aspect ratio mismatch: {:.2}:1 vs {:.2}:1",
                                    asset_aspect, seq_aspect
                                ),
                            )
                            .with_location(clip.place.timeline_in_sec, clip.timeline_end())
                            .with_entities(vec![clip.id.clone()])
                            .with_details(format!(
                                "Asset {}x{} doesn't match sequence {}x{}. Export fits the source \
                                 into the canvas and pads the remainder, so this shows as bars \
                                 rather than as a broken picture; reframe the shot or change the \
                                 sequence canvas if that is not wanted.",
                                video_info.width,
                                video_info.height,
                                sequence.format.canvas.width,
                                sequence.format.canvas.height
                            ))
                            .with_metric("assetAspect", (asset_aspect * 1000.0).round() / 1000.0)
                            .with_metric("sequenceAspect", (seq_aspect * 1000.0).round() / 1000.0)
                            .with_metric("trackId", track.id.clone());

                            violations.push(violation);
                        }
                    }
                }
            }
        }

        Ok(violations)
    }
}

// ============================================================================
// DurationRule - Checks total sequence duration
// ============================================================================

/// Rule that checks if sequence duration meets requirements
#[derive(Debug, Default)]
pub struct DurationRule;

impl DurationRule {
    /// Creates a new DurationRule
    pub fn new() -> Self {
        Self
    }

    /// Default Shorts duration limits
    const SHORTS_MIN_SEC: f64 = 15.0;
    const SHORTS_MAX_SEC: f64 = 60.0;
}

#[async_trait]
impl QCRule for DurationRule {
    fn name(&self) -> &str {
        "DurationRule"
    }

    fn check_id(&self) -> &str {
        "sequence.duration"
    }

    fn description(&self) -> &str {
        "Checks if sequence duration meets platform requirements"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    async fn check(
        &self,
        sequence: &Sequence,
        _state: &ProjectState,
        config: &RuleConfig,
        _context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let mut violations = Vec::new();

        let severity = config.severity_override.unwrap_or(self.default_severity());

        // Get duration limits from config or use Shorts defaults
        let min_duration = config
            .get_param::<f64>("min_sec")
            .unwrap_or(Self::SHORTS_MIN_SEC);
        let max_duration = config
            .get_param::<f64>("max_sec")
            .unwrap_or(Self::SHORTS_MAX_SEC);

        // Calculate total sequence duration
        let mut duration: f64 = 0.0;
        for track in &sequence.tracks {
            for clip in &track.clips {
                duration = duration.max(clip.timeline_end());
            }
        }

        if duration < min_duration {
            let violation = QCViolation::new(
                self.name(),
                severity,
                format!(
                    "Sequence too short ({:.1}s < {:.1}s minimum)",
                    duration, min_duration
                ),
            )
            .with_details(format!(
                "Add {:.1}s more content to meet minimum duration",
                min_duration - duration
            ));

            violations.push(violation);
        } else if duration > max_duration {
            let violation = QCViolation::new(
                self.name(),
                severity,
                format!(
                    "Sequence too long ({:.1}s > {:.1}s maximum)",
                    duration, max_duration
                ),
            )
            .with_details(format!(
                "Remove {:.1}s of content to meet maximum duration",
                duration - max_duration
            ));

            violations.push(violation);
        }

        Ok(violations)
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::qc::context::{
        MeasuredStreams, MeasuredVideoStream, MeasuredWindow, RenderMeasurements,
    };
    use crate::core::timeline::{SequenceFormat, Track};

    // ========================================================================
    // Test Fixtures
    // ========================================================================

    /// Builds a 1920x1080 sequence with a single video clip on one video track
    fn sequence_with_video_clip(timeline_in_sec: f64, duration_sec: f64) -> Sequence {
        let mut sequence = Sequence::new("QC Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("V1");
        track.add_clip(Clip::with_range("asset_001", 0.0, duration_sec).place_at(timeline_in_sec));
        sequence.add_track(track);
        sequence
    }

    /// Builds a 1920x1080 sequence with a single caption clip
    fn sequence_with_caption(
        label: &str,
        position: Option<serde_json::Value>,
        style: Option<serde_json::Value>,
    ) -> Sequence {
        let mut sequence = Sequence::new("QC Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("C1");

        let mut clip = Clip::with_range("caption_asset", 0.0, 2.0);
        clip.label = Some(label.to_string());
        clip.caption_position = position;
        clip.caption_style = style;
        track.add_clip(clip);

        sequence.add_track(track);
        sequence
    }

    /// Reads the first per-cue entry out of a grouped caption violation.
    ///
    /// `caption.safe_area` reports one violation per track and puts each cue's
    /// own measurement under `cues`, so a test about a single caption asks for
    /// that cue rather than for prose on the group.
    fn first_cue(violation: &QCViolation) -> &serde_json::Value {
        violation.metrics["cues"]
            .as_array()
            .and_then(|cues| cues.first())
            .expect("a grouped caption violation lists its cues")
    }

    fn measurements_with_black_ranges(ranges: Vec<(f64, f64)>) -> RenderMeasurements {
        RenderMeasurements {
            black_ranges: ranges,
            ..Default::default()
        }
    }

    fn measurements_with_true_peak(true_peak_dbtp: f64) -> RenderMeasurements {
        RenderMeasurements {
            true_peak_dbtp: Some(true_peak_dbtp),
            ..Default::default()
        }
    }

    /// Registers a 1920x1080 video asset of the given source length.
    fn state_with_video_asset(asset_id: &str, duration_sec: Option<f64>) -> ProjectState {
        use crate::core::assets::{Asset, VideoInfo};

        let mut asset = Asset::new_video(
            "clip.mp4",
            "clip.mp4",
            VideoInfo {
                width: 1920,
                height: 1080,
                codec: "h264".to_string(),
                ..Default::default()
            },
        );
        asset.id = asset_id.to_string();
        asset.duration_sec = duration_sec;

        let mut state = ProjectState::new("QC Test");
        state.assets.insert(asset.id.clone(), asset);
        state
    }

    // ========================================================================
    // RuleConfig Tests
    // ========================================================================

    #[test]
    fn test_rule_config_default() {
        let config = RuleConfig::default();
        assert!(config.enabled);
        assert!(config.severity_override.is_none());
        assert!(config.params.is_empty());
    }

    #[test]
    fn test_rule_config_disabled() {
        let config = RuleConfig::disabled();
        assert!(!config.enabled);
    }

    #[test]
    fn test_rule_config_get_set_param() {
        let mut config = RuleConfig::default();
        config.set_param("threshold", 0.5);
        config.set_param("enabled", true);

        assert_eq!(config.get_param::<f64>("threshold"), Some(0.5));
        assert_eq!(config.get_param::<bool>("enabled"), Some(true));
        assert_eq!(config.get_param::<f64>("nonexistent"), None);
    }

    #[test]
    fn test_rule_config_serialization() {
        let mut config = RuleConfig {
            severity_override: Some(Severity::Error),
            ..Default::default()
        };
        config.set_param("threshold", 10.0);

        let json = serde_json::to_string(&config).unwrap();
        let parsed: RuleConfig = serde_json::from_str(&json).unwrap();

        assert!(parsed.enabled);
        assert_eq!(parsed.severity_override, Some(Severity::Error));
        assert_eq!(parsed.get_param::<f64>("threshold"), Some(10.0));
    }

    // ========================================================================
    // BlackFrameRule Tests
    // ========================================================================

    #[test]
    fn test_black_frame_rule_properties() {
        let rule = BlackFrameRule::new();
        assert_eq!(rule.name(), "BlackFrameRule");
        assert_eq!(rule.default_severity(), Severity::Warning);
        assert!(rule.supports_auto_fix());
    }

    #[tokio::test]
    async fn test_black_frame_rule_should_report_ranges_when_measurements_are_provided() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = state_with_video_asset("asset_001", Some(20.0));
        let context = QCContext::from_sequence(&sequence)
            // The 0.02s range is below the default 0.1s duration threshold
            .with_measurements(measurements_with_black_ranges(vec![
                (0.0, 0.6),
                (2.0, 2.02),
            ]));

        let violations = BlackFrameRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        let location = violations[0].location.as_ref().expect("located violation");
        assert_eq!(location.start_sec, 0.0);
        assert_eq!(location.end_sec, 0.6);
        assert_eq!(violations[0].affected_entities.len(), 1);
        assert!(
            violations[0].auto_fixable,
            "black at a clip's head can be slipped past when the source has room"
        );
    }

    /// Feature: Black frame fixes
    /// Scenario: should suggest a slip the command layer can execute
    #[tokio::test]
    async fn test_black_frame_rule_should_suggest_a_slip_with_every_field_trim_clip_requires() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = state_with_video_asset("asset_001", Some(20.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_black_ranges(vec![(0.0, 0.6)]));

        let violations = BlackFrameRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        let command = &violations[0].suggested_fix.as_ref().expect("fix").commands[0];

        assert_eq!(command["type"], "TrimClip");
        assert_eq!(command["sequenceId"], sequence.id);
        assert_eq!(
            command["trackId"], sequence.tracks[0].id,
            "TrimClip is rejected without a trackId"
        );
        assert_eq!(command["clipId"], sequence.tracks[0].clips[0].id);
        // A slip moves both ends of the source window, so the clip keeps its
        // place and length and no other track moves.
        assert!((command["newSourceIn"].as_f64().expect("newSourceIn") - 0.6).abs() < 1e-9);
        assert!((command["newSourceOut"].as_f64().expect("newSourceOut") - 5.6).abs() < 1e-9);
        assert!(
            command.get("trimStart").is_none(),
            "trimStart is not a field TrimClipPayload accepts"
        );
    }

    /// Feature: Black frame fixes
    /// Scenario: should stay silent when the source cannot absorb the slip
    #[tokio::test]
    async fn test_black_frame_rule_should_not_suggest_a_slip_past_the_end_of_the_source() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        // Only 5.2s of source behind a 5.0s clip: slipping 0.6s forward would
        // run off the end and trade black for a frozen or missing tail.
        let state = state_with_video_asset("asset_001", Some(5.2));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_black_ranges(vec![(0.0, 0.6)]));

        let violations = BlackFrameRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert!(!violations[0].auto_fixable);
        assert!(violations[0].suggested_fix.is_none());
    }

    /// Feature: Black frame fixes
    /// Scenario: should stay silent when the source length is unknown
    #[tokio::test]
    async fn test_black_frame_rule_should_not_suggest_a_slip_without_a_known_source_length() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = state_with_video_asset("asset_001", None);
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_black_ranges(vec![(0.0, 0.6)]));

        let violations = BlackFrameRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations[0].suggested_fix.is_none());
    }

    /// Feature: Black frame fixes
    /// Scenario: should not suggest anything for black in the middle of a clip
    #[tokio::test]
    async fn test_black_frame_rule_should_not_suggest_a_slip_for_mid_clip_black() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = state_with_video_asset("asset_001", Some(20.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_black_ranges(vec![(2.0, 2.8)]));

        let violations = BlackFrameRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert!(violations[0].suggested_fix.is_none());
    }

    /// Feature: Black frame fixes
    /// Scenario: should stay silent when the black outlasts the clip it starts on
    #[tokio::test]
    async fn test_black_frame_rule_should_not_suggest_a_slip_when_black_outlives_the_clip() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        // 120s of source, so the asset-end guard would happily accept a 10s
        // slip: only the clip's own length can reject it.
        let state = state_with_video_asset("asset_001", Some(120.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_black_ranges(vec![(0.0, 10.0)]));

        let violations = BlackFrameRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert!(
            violations[0].suggested_fix.is_none(),
            "black covering the whole clip leaves no picture to slip to"
        );
    }

    /// Feature: Black frame fixes
    /// Scenario: should slip below the clip's duration but not at it
    #[tokio::test]
    async fn test_black_frame_rule_should_bound_the_slip_by_the_clip_duration() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = state_with_video_asset("asset_001", Some(120.0));

        let inside = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_black_ranges(vec![(0.0, 4.9)]));
        let violations = BlackFrameRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &inside)
            .await
            .expect("rule runs");
        let command = &violations[0].suggested_fix.as_ref().expect("fix").commands[0];
        assert!((command["newSourceIn"].as_f64().expect("newSourceIn") - 4.9).abs() < 1e-9);

        // Exactly the clip's duration: the whole clip is black, so there is no
        // frame left to slip to.
        let at_boundary = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_black_ranges(vec![(0.0, 5.0)]));
        let violations = BlackFrameRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &at_boundary)
            .await
            .expect("rule runs");
        assert!(violations[0].suggested_fix.is_none());
    }

    #[tokio::test]
    async fn test_black_frame_rule_should_respect_min_duration_config() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_black_ranges(vec![(0.0, 0.6)]));

        let mut config = RuleConfig::default();
        config.set_param("min_duration", 1.0);

        let violations = BlackFrameRule::new()
            .check(&sequence, &state, &config, &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    #[tokio::test]
    async fn test_black_frame_rule_should_skip_when_measurements_are_missing() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence);

        let rule = BlackFrameRule::new();
        assert!(rule.skip_reason(&context).is_some());

        let violations = rule
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");
        assert!(violations.is_empty());
    }

    // ========================================================================
    // AudioPeakRule Tests
    // ========================================================================

    #[test]
    fn test_audio_peak_rule_properties() {
        let rule = AudioPeakRule::new();
        assert_eq!(rule.name(), "AudioPeakRule");
        assert_eq!(rule.default_severity(), Severity::Error);
        assert!(rule.supports_auto_fix());
    }

    #[tokio::test]
    async fn test_audio_peak_rule_should_report_clipping_from_measured_true_peak() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_true_peak(-0.2));

        let violations = AudioPeakRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Critical);
        assert!(violations[0].message.contains("true peak"));

        let fix = violations[0].suggested_fix.as_ref().expect("fix suggested");
        assert_eq!(fix.commands[0]["type"], "SetMasterVolume");
    }

    #[tokio::test]
    async fn test_audio_peak_rule_should_warn_below_ceiling() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_true_peak(-2.0));

        let violations = AudioPeakRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert!(!violations[0].auto_fixable);
    }

    #[tokio::test]
    async fn test_audio_peak_rule_should_fall_back_to_sample_peak() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence).with_measurements(RenderMeasurements {
            sample_peak_db: Some(-0.2),
            ..Default::default()
        });

        let violations = AudioPeakRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert!(violations[0].message.contains("sample peak"));
    }

    #[tokio::test]
    async fn test_audio_peak_rule_should_skip_when_peak_is_not_measured() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        let state = ProjectState::new("QC Test");
        let rule = AudioPeakRule::new();

        let no_measurements = QCContext::from_sequence(&sequence);
        assert!(rule.skip_reason(&no_measurements).is_some());

        // Measurements without any peak figure (for example a silent render)
        let no_peak =
            QCContext::from_sequence(&sequence).with_measurements(RenderMeasurements::default());
        assert!(rule.skip_reason(&no_peak).is_some());

        let violations = rule
            .check(&sequence, &state, &RuleConfig::default(), &no_peak)
            .await
            .expect("rule runs");
        assert!(violations.is_empty());
    }

    // ========================================================================
    // CaptionSafeAreaRule Tests
    // ========================================================================

    #[test]
    fn test_caption_safe_area_rule_properties() {
        let rule = CaptionSafeAreaRule::new();
        assert_eq!(rule.name(), "CaptionSafeAreaRule");
        assert_eq!(rule.default_severity(), Severity::Warning);
        assert!(rule.supports_auto_fix());
    }

    #[tokio::test]
    async fn test_caption_safe_area_rule_should_flag_custom_position_near_bottom_edge() {
        let sequence = sequence_with_caption(
            "Caption near the bottom edge",
            Some(serde_json::json!({
                "type": "custom",
                "xPercent": 50.0,
                "yPercent": 98.0
            })),
            None,
        );
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence);

        let violations = CaptionSafeAreaRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert!(violations[0].auto_fixable);

        let fix = violations[0].suggested_fix.as_ref().expect("fix suggested");
        assert_eq!(fix.commands[0]["type"], "UpdateCaption");
        assert_eq!(fix.commands[0]["position"]["type"], "custom");
    }

    #[tokio::test]
    async fn test_caption_safe_area_rule_should_pass_preset_at_title_safe_margin() {
        let sequence = sequence_with_caption(
            "Caption inside the safe area",
            Some(serde_json::json!({
                "type": "preset",
                "vertical": "bottom",
                "marginPercent": 10.0
            })),
            None,
        );
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence);

        let violations = CaptionSafeAreaRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    #[tokio::test]
    async fn test_caption_safe_area_rule_should_flag_preset_below_action_safe_margin() {
        let sequence = sequence_with_caption(
            "Caption at the very edge",
            Some(serde_json::json!({
                "type": "preset",
                "vertical": "top",
                "marginPercent": 1.0
            })),
            None,
        );
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence);

        let violations = CaptionSafeAreaRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert_eq!(
            violations[0]
                .suggested_fix
                .as_ref()
                .expect("fix suggested")
                .commands[0]["position"]["marginPercent"],
            10.0
        );
    }

    #[tokio::test]
    async fn test_caption_safe_area_rule_should_flag_preset_whose_text_block_leaves_the_canvas() {
        // The margin itself is safe; the type is not. A preset places the
        // block's center on the margin line, so an oversized font breaches the
        // edge the margin was chosen to protect.
        let sequence = sequence_with_caption(
            "Caption set in an enormous font",
            Some(serde_json::json!({
                "type": "preset",
                "vertical": "bottom",
                "marginPercent": 10.0
            })),
            Some(serde_json::json!({ "fontSize": 500 })),
        );
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence);

        let violations = CaptionSafeAreaRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert!(
            violations[0]
                .message
                .contains("outside the action-safe area"),
            "{}",
            violations[0].message
        );
    }

    #[tokio::test]
    async fn test_caption_safe_area_rule_should_grow_a_wrapped_caption_inward_from_its_margin() {
        // A preset margin is a gap to the block's near edge, so a caption that
        // wraps grows *away* from the edge the margin protects. The estimate
        // used to center the block on the margin line instead, which pushed
        // half of every wrapped block past that edge and reported a breach that
        // the renderer never produces.
        let long_caption = "This caption is far too long to fit on a single line of video and \
                            keeps going well past the point where any reasonable reader would \
                            have stopped following it";
        let position = serde_json::json!({
            "type": "preset",
            "vertical": "bottom",
            "marginPercent": 10.0
        });

        let sequence = sequence_with_caption(
            long_caption,
            Some(position.clone()),
            Some(serde_json::json!({ "fontSize": 48 })),
        );
        let (box_width, box_height) = CaptionSafeAreaRule::estimate_text_box_percent(
            &sequence.tracks[0].clips[0],
            1920,
            1080,
            CAPTION_WRAP_BOX_WIDTH_PERCENT,
        );
        assert!(
            box_width <= CAPTION_WRAP_BOX_WIDTH_PERCENT,
            "a wrapped caption cannot be wider than its wrap box, got {box_width}"
        );

        // Height is line count times line height, not one line stretched.
        let single_line_height = 48.0 * 1.2 / 1080.0 * 100.0;
        let line_count = (box_height / single_line_height).round();
        assert!(
            line_count >= 3.0,
            "this caption must wrap into at least three lines, got {line_count}"
        );
        assert!(
            (box_height - line_count * single_line_height).abs() < 1e-9,
            "height must be a whole number of lines, got {box_height}"
        );

        // The margin names the bottom of the block; the block grows upward.
        let (top, bottom) =
            CaptionSafeAreaRule::preset_vertical_span(&VerticalPosition::Bottom, 10.0, box_height);
        assert!(
            (bottom - 90.0).abs() < 1e-9,
            "the margin must place the block's bottom edge, got {bottom}"
        );
        assert!(
            (top - (90.0 - box_height)).abs() < 1e-9,
            "the block must grow inward from that edge, got {top}"
        );

        // And so a caption this size does not breach anything.
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence);
        let violations = CaptionSafeAreaRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");
        assert!(
            violations.is_empty(),
            "a wrapped caption that stays inside the frame is not a breach: {:?}",
            violations
                .iter()
                .map(|violation| violation.details.clone())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn test_caption_safe_area_rule_should_report_a_block_that_grows_across_the_frame() {
        // The failure mode a bottom-anchored block really has: enough lines at
        // a large enough size and it reaches the *opposite* edge.
        let sequence = sequence_with_caption(
            "This caption is far too long to fit on a single line of video and keeps going",
            Some(serde_json::json!({
                "type": "preset",
                "vertical": "bottom",
                "marginPercent": 10.0
            })),
            Some(serde_json::json!({ "fontSize": 200 })),
        );

        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence);
        let violations = CaptionSafeAreaRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        let detail = first_cue(&violations[0])["detail"]
            .as_str()
            .expect("each cue carries its own measurement")
            .to_string();
        assert!(
            detail.contains("spans x") && detail.contains("y "),
            "both axes must be reported: {detail}"
        );
        assert!(
            detail.contains("-"),
            "the breach must be a negative top edge: {detail}"
        );
    }

    #[tokio::test]
    async fn test_caption_safe_area_rule_should_report_an_unbreakable_run_that_bleeds_off_the_side()
    {
        // libass needs a break opportunity. A run without one - unspaced CJK, a
        // bare URL - does not wrap at the box, it runs past it, so the wrap box
        // must not be allowed to hide the width.
        let url = "https://example.com/watch/a-very-long-permalink-slug-that-never-breaks-anywhere";
        let sequence = sequence_with_caption(
            url,
            Some(serde_json::json!({
                "type": "preset",
                "vertical": "bottom",
                "marginPercent": 10.0
            })),
            Some(serde_json::json!({ "fontSize": 96 })),
        );

        let (box_width, box_height) = CaptionSafeAreaRule::estimate_text_box_percent(
            &sequence.tracks[0].clips[0],
            1920,
            1080,
            CAPTION_WRAP_BOX_WIDTH_PERCENT,
        );
        assert!(
            box_width > CAPTION_WRAP_BOX_WIDTH_PERCENT,
            "an unbreakable run must be measured past the wrap box, got {box_width}"
        );
        assert!(
            (box_height - 96.0 * 1.2 / 1080.0 * 100.0).abs() < 1e-9,
            "an unbreakable run stays on one line, got {box_height}"
        );

        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence);
        let violations = CaptionSafeAreaRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        let cue = first_cue(&violations[0]);
        assert!(
            cue["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("spans x")),
            "the breach must be reported on the horizontal axis: {cue}"
        );
    }
    #[tokio::test]
    async fn test_caption_safe_area_rule_should_measure_a_left_aligned_custom_anchor_from_its_edge()
    {
        // A left-aligned run starts at its anchor, so a 10% anchor is safe and
        // a 90% anchor is not — the centered reading would judge both the
        // other way round.
        let safe = sequence_with_caption(
            "Dr. Jane Doe",
            Some(serde_json::json!({ "type": "custom", "xPercent": 10.0, "yPercent": 84.0 })),
            Some(serde_json::json!({ "fontSize": 40, "alignment": "left" })),
        );
        let state = ProjectState::new("QC Test");

        let violations = CaptionSafeAreaRule::new()
            .check(
                &safe,
                &state,
                &RuleConfig::default(),
                &QCContext::from_sequence(&safe),
            )
            .await
            .expect("rule runs");
        assert!(violations.is_empty(), "{violations:?}");

        let overflowing = sequence_with_caption(
            "Dr. Jane Doe",
            Some(serde_json::json!({ "type": "custom", "xPercent": 90.0, "yPercent": 84.0 })),
            Some(serde_json::json!({ "fontSize": 40, "alignment": "left" })),
        );

        let violations = CaptionSafeAreaRule::new()
            .check(
                &overflowing,
                &state,
                &RuleConfig::default(),
                &QCContext::from_sequence(&overflowing),
            )
            .await
            .expect("rule runs");
        assert_eq!(violations.len(), 1);

        // The fix must re-anchor in the same terms the renderer reads, so the
        // suggested x stays a left edge rather than a center.
        let fixed_x = violations[0]
            .suggested_fix
            .as_ref()
            .expect("fix suggested")
            .commands[0]["position"]["xPercent"]
            .as_f64()
            .expect("x percent");
        assert!(fixed_x < 90.0, "{fixed_x}");
    }

    #[tokio::test]
    async fn test_caption_safe_area_rule_should_ignore_center_preset() {
        let sequence = sequence_with_caption(
            "Centered caption",
            Some(serde_json::json!({
                "type": "preset",
                "vertical": "center",
                "marginPercent": 0.0
            })),
            None,
        );
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence);

        let violations = CaptionSafeAreaRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    #[tokio::test]
    async fn test_caption_safe_area_rule_should_fall_back_to_default_position_when_unreadable() {
        let sequence = sequence_with_caption(
            "Caption without a stored position",
            Some(serde_json::json!({ "type": "unknown-variant" })),
            Some(serde_json::json!({ "fontSize": 64 })),
        );
        let state = ProjectState::new("QC Test");
        let context = QCContext::from_sequence(&sequence);

        let violations = CaptionSafeAreaRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        // The caption default (bottom, 5% margin) clears the action-safe margin
        // but sits inside the title-safe margin, so it is informational only.
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Info);
    }

    // ========================================================================
    // CutRhythmRule Tests
    // ========================================================================

    #[test]
    fn test_cut_rhythm_rule_properties() {
        let rule = CutRhythmRule::new();
        assert_eq!(rule.name(), "CutRhythmRule");
        assert_eq!(rule.default_severity(), Severity::Info);
        assert!(!rule.supports_auto_fix());
    }

    // ========================================================================
    // LicenseRule Tests
    // ========================================================================

    #[test]
    fn test_license_rule_properties() {
        let rule = LicenseRule::new();
        assert_eq!(rule.name(), "LicenseRule");
        assert_eq!(rule.default_severity(), Severity::Critical);
        assert!(!rule.supports_auto_fix());
    }

    // ========================================================================
    // AspectRatioRule Tests
    // ========================================================================

    #[test]
    fn test_aspect_ratio_rule_properties() {
        let rule = AspectRatioRule::new();
        assert_eq!(rule.name(), "AspectRatioRule");
        assert_eq!(rule.default_severity(), Severity::Warning);
        assert!(
            !rule.supports_auto_fix(),
            "reframing is a judgement about the picture; no auto-fix is implemented yet"
        );
    }

    /// Feature: Aspect ratio mismatch
    /// Scenario: should report the mismatch without an unexecutable fix
    #[tokio::test]
    async fn test_aspect_ratio_rule_should_report_the_mismatch_and_offer_no_fix() {
        let sequence = sequence_with_video_clip(0.0, 5.0);
        // A 4:3 source in a 16:9 sequence.
        let mut state = state_with_video_asset("asset_001", Some(20.0));
        if let Some(asset) = state.assets.get_mut("asset_001") {
            if let Some(video) = asset.video.as_mut() {
                video.width = 1440;
                video.height = 1080;
            }
        }

        let context = QCContext::from_sequence(&sequence);
        let violations = AspectRatioRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert!(
            !violations[0].auto_fixable,
            "reframing is a judgement about the picture; no auto-fix is implemented yet"
        );
        assert!(violations[0].suggested_fix.is_none());
        assert_eq!(violations[0].metrics["trackId"], sequence.tracks[0].id);
    }

    // ========================================================================
    // RenderDurationRule Tests
    // ========================================================================

    #[test]
    fn test_render_duration_rule_properties() {
        let rule = RenderDurationRule::new();
        assert_eq!(rule.name(), "RenderDurationRule");
        assert_eq!(rule.check_id(), "render.duration_mismatch");
        assert_eq!(rule.category(), CheckCategory::Rendered);
        assert_eq!(rule.default_severity(), Severity::Error);
    }

    fn measurements_of_length(file_duration_sec: f64) -> RenderMeasurements {
        RenderMeasurements {
            file_duration_sec: Some(file_duration_sec),
            ..Default::default()
        }
    }

    /// Feature: Render/sequence duration match
    /// Scenario: should error when the rendered file is truncated
    #[tokio::test]
    async fn test_render_duration_rule_should_error_when_the_file_is_shorter() {
        let sequence = sequence_with_video_clip(0.0, 60.0);
        let state = state_with_video_asset("asset_001", Some(60.0));
        let context =
            QCContext::from_sequence(&sequence).with_measurements(measurements_of_length(12.0));

        let violations = RenderDurationRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(
            violations[0].severity,
            Severity::Error,
            "a file missing 48s of program is not the deliverable"
        );
        assert!(violations[0].message.contains("shorter"));
        assert_eq!(violations[0].metrics["fileDurationSec"], 12.0);
        assert_eq!(violations[0].metrics["sequenceDurationSec"], 60.0);
        assert!(
            violations[0].suggested_fix.is_none(),
            "the answer is to re-render, not to edit the timeline"
        );
    }

    /// Feature: Render/sequence duration match
    /// Scenario: should warn when the rendered file runs past the sequence
    #[tokio::test]
    async fn test_render_duration_rule_should_warn_when_the_file_is_longer() {
        let sequence = sequence_with_video_clip(0.0, 60.0);
        let state = state_with_video_asset("asset_001", Some(60.0));
        let context =
            QCContext::from_sequence(&sequence).with_measurements(measurements_of_length(75.0));

        let violations = RenderDurationRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(
            violations[0].severity,
            Severity::Warning,
            "a longer file still contains the whole program"
        );
        assert!(violations[0].message.contains("longer"));
    }

    /// Feature: Render/sequence duration match
    /// Scenario: should tolerate container-level rounding
    #[tokio::test]
    async fn test_render_duration_rule_should_tolerate_small_divergence() {
        let sequence = sequence_with_video_clip(0.0, 60.0);
        let state = state_with_video_asset("asset_001", Some(60.0));
        // 0.3s is the scale container timestamps and audio priming move a
        // correct render by, and is under the 0.5s default.
        let context =
            QCContext::from_sequence(&sequence).with_measurements(measurements_of_length(60.3));

        let violations = RenderDurationRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    /// Feature: Render/sequence duration match
    /// Scenario: should catch a long render that lost seconds of program
    ///
    /// Regression: the tolerance was floored at 2% of the sequence, so the
    /// longer the program the more of it a render could silently drop. A
    /// fifty-minute export was allowed to lose a full minute and still pass.
    #[tokio::test]
    async fn test_render_duration_rule_should_catch_a_long_render_missing_five_seconds() {
        const LONG_SEQUENCE_SEC: f64 = 3_000.0;

        let sequence = sequence_with_video_clip(0.0, LONG_SEQUENCE_SEC);
        let state = state_with_video_asset("asset_001", Some(LONG_SEQUENCE_SEC));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_of_length(LONG_SEQUENCE_SEC - 5.0));

        let violations = RenderDurationRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(
            violations.len(),
            1,
            "five seconds of missing program stays missing however long the program is"
        );
        assert_eq!(violations[0].severity, Severity::Error);
        assert_eq!(violations[0].metrics["deltaSec"], -5.0);
        assert_eq!(
            violations[0].metrics["toleranceSec"], 0.5,
            "the tolerance must not scale with the length of the sequence"
        );
    }

    /// Feature: Render/sequence duration match
    /// Scenario: should honour an explicitly configured tolerance exactly
    #[tokio::test]
    async fn test_render_duration_rule_should_honour_an_explicit_tolerance() {
        let sequence = sequence_with_video_clip(0.0, 3_000.0);
        let state = state_with_video_asset("asset_001", Some(3_000.0));

        let mut config = RuleConfig::default();
        config.set_param("tolerance_sec", 0.05);

        // Half a second used to sit inside both the absolute default and the
        // 2% floor; a caller asking for frame accuracy gets frame accuracy.
        let tight =
            QCContext::from_sequence(&sequence).with_measurements(measurements_of_length(2_999.5));
        let violations = RenderDurationRule::new()
            .check(&sequence, &state, &config, &tight)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].metrics["toleranceSec"], 0.05);

        // The same configuration still passes a render inside the window it
        // asked for.
        let within =
            QCContext::from_sequence(&sequence).with_measurements(measurements_of_length(3_000.01));
        let violations = RenderDurationRule::new()
            .check(&sequence, &state, &config, &within)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    /// Feature: Render/sequence duration match
    /// Scenario: should widen the default to a couple of frames on a slow sequence
    #[tokio::test]
    async fn test_render_duration_rule_should_allow_two_frames_on_a_slow_sequence() {
        let mut sequence = sequence_with_video_clip(0.0, 60.0);
        // Two frames at 2 fps is a full second, longer than the absolute floor.
        sequence.format.fps.num = 2;
        sequence.format.fps.den = 1;

        let state = state_with_video_asset("asset_001", Some(60.0));
        let context =
            QCContext::from_sequence(&sequence).with_measurements(measurements_of_length(60.8));

        let violations = RenderDurationRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(
            violations.is_empty(),
            "a render inside two frames of the sequence is the deliverable: {violations:?}"
        );
    }

    // ========================================================================
    // MissingVideoStreamRule Tests
    // ========================================================================

    /// Measurements from a file carrying the given streams.
    fn measurements_with_streams(
        video: Option<MeasuredVideoStream>,
        has_audio: bool,
        file_duration_sec: f64,
    ) -> RenderMeasurements {
        RenderMeasurements {
            file_duration_sec: Some(file_duration_sec),
            streams: Some(MeasuredStreams { video, has_audio }),
            ..Default::default()
        }
    }

    fn stream_1080p() -> MeasuredVideoStream {
        MeasuredVideoStream {
            width: 1920,
            height: 1080,
            fps: 30.0,
        }
    }

    #[test]
    fn test_missing_video_stream_rule_properties() {
        let rule = MissingVideoStreamRule::new();
        assert_eq!(rule.check_id(), "render.missing_video");
        assert_eq!(rule.category(), CheckCategory::Rendered);
        assert_eq!(rule.default_severity(), Severity::Error);
    }

    /// Feature: Rendered stream presence
    /// Scenario: should error when a sequence full of picture rendered no video
    ///
    /// Regression: every picture check reads a detection list, and a file with
    /// no video stream produces empty lists — indistinguishable from a clean
    /// picture, so an audio-only render of a video sequence passed.
    #[tokio::test]
    async fn test_missing_video_stream_rule_should_error_on_an_audio_only_render() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_streams(None, true, 30.0));

        let violations = MissingVideoStreamRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Error);
        assert_eq!(violations[0].metrics["pictureClipCount"], 1);
        assert_eq!(violations[0].metrics["hasVideoStream"], false);
        assert!(violations[0].suggested_fix.is_none());
    }

    /// Feature: Rendered stream presence
    /// Scenario: should pass a render that carries the picture
    #[tokio::test]
    async fn test_missing_video_stream_rule_should_pass_when_video_was_written() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_streams(Some(stream_1080p()), true, 30.0));

        let violations = MissingVideoStreamRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    /// Feature: Rendered stream presence
    /// Scenario: should say nothing about a sequence that asks for no picture
    #[tokio::test]
    async fn test_missing_video_stream_rule_should_ignore_an_audio_only_sequence() {
        let mut sequence = Sequence::new("Audio only", SequenceFormat::youtube_1080());
        let mut track = Track::new_audio("A1");
        track.add_clip(Clip::with_range("asset_001", 0.0, 30.0));
        sequence.add_track(track);

        let state = state_with_video_asset("asset_001", Some(30.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_streams(None, true, 30.0));

        let violations = MissingVideoStreamRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    /// Feature: Rendered stream presence
    /// Scenario: should be skipped rather than passed without a stream table
    #[test]
    fn test_missing_video_stream_rule_should_skip_without_a_stream_table() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let rule = MissingVideoStreamRule::new();

        assert!(rule
            .skip_reason(&QCContext::from_sequence(&sequence))
            .is_some());
        assert!(rule
            .skip_reason(
                &QCContext::from_sequence(&sequence)
                    .with_measurements(RenderMeasurements::default())
            )
            .is_some());
    }

    /// Feature: Rendered stream presence
    /// Scenario: should stop the black check from passing over a picture-less file
    #[test]
    fn test_black_frame_rule_should_skip_when_the_file_has_no_video_stream() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_streams(None, true, 30.0));

        let reason = BlackFrameRule::new()
            .skip_reason(&context)
            .expect("a file with no picture leaves the black check nothing to grade");
        assert!(reason.contains("no video stream"), "got: {reason}");
    }

    // ========================================================================
    // RenderResolutionRule Tests
    // ========================================================================

    #[test]
    fn test_render_resolution_rule_properties() {
        let rule = RenderResolutionRule::new();
        assert_eq!(rule.check_id(), "render.resolution_mismatch");
        assert_eq!(rule.category(), CheckCategory::Rendered);
        assert_eq!(rule.default_severity(), Severity::Error);
    }

    /// Feature: Rendered frame format
    /// Scenario: should error when the render is a different shape than the canvas
    #[tokio::test]
    async fn test_render_resolution_rule_should_error_on_a_landscape_render_of_a_vertical_edit() {
        let mut sequence = sequence_with_video_clip(0.0, 30.0);
        sequence.format.canvas.width = 1080;
        sequence.format.canvas.height = 1920;

        let state = state_with_video_asset("asset_001", Some(30.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_streams(Some(stream_1080p()), true, 30.0));

        let violations = RenderResolutionRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(
            violations[0].severity,
            Severity::Error,
            "a vertical edit delivered landscape is cropped or barred, not the edit"
        );
        assert_eq!(violations[0].metrics["fileWidth"], 1920);
        assert_eq!(violations[0].metrics["canvasWidth"], 1080);
    }

    /// Feature: Rendered frame format
    /// Scenario: should report a proxy-sized render without failing it
    #[tokio::test]
    async fn test_render_resolution_rule_should_report_a_scaled_render_as_informational() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let proxy = MeasuredVideoStream {
            width: 854,
            height: 480,
            fps: 30.0,
        };
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_streams(Some(proxy), true, 30.0));

        let violations = RenderResolutionRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(
            violations[0].severity,
            Severity::Info,
            "a 480p proxy of a 16:9 canvas is a deliberate size, not a broken frame"
        );
    }

    /// Feature: Rendered frame format
    /// Scenario: should pass a render written at the canvas size
    #[tokio::test]
    async fn test_render_resolution_rule_should_pass_a_canvas_sized_render() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_streams(Some(stream_1080p()), true, 30.0));

        let violations = RenderResolutionRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty(), "got: {violations:?}");
    }

    /// Feature: Rendered frame format
    /// Scenario: should warn when the frame rate was resampled on the way out
    #[tokio::test]
    async fn test_render_resolution_rule_should_warn_on_a_resampled_frame_rate() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let slow = MeasuredVideoStream {
            width: 1920,
            height: 1080,
            fps: 25.0,
        };
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_streams(Some(slow), true, 30.0));

        let violations = RenderResolutionRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert_eq!(violations[0].metrics["fileFps"], 25.0);
    }

    /// Feature: Rendered frame format
    /// Scenario: should not mistake NTSC rounding for a resampled rate
    #[tokio::test]
    async fn test_render_resolution_rule_should_tolerate_ntsc_frame_rates() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let ntsc = MeasuredVideoStream {
            width: 1920,
            height: 1080,
            fps: 29.97,
        };
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_streams(Some(ntsc), true, 30.0));

        let violations = RenderResolutionRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty(), "got: {violations:?}");
    }

    // ========================================================================
    // FrozenProgramRule Tests
    // ========================================================================

    #[test]
    fn test_frozen_program_rule_properties() {
        let rule = FrozenProgramRule::new();
        assert_eq!(rule.check_id(), "render.frozen");
        assert_eq!(rule.category(), CheckCategory::Rendered);
        assert_eq!(rule.default_severity(), Severity::Error);
    }

    fn measurements_with_freeze_ranges(ranges: Vec<(f64, f64)>) -> RenderMeasurements {
        RenderMeasurements {
            freeze_ranges: ranges,
            streams: Some(MeasuredStreams {
                video: Some(stream_1080p()),
                has_audio: true,
            }),
            ..Default::default()
        }
    }

    /// Feature: Frozen program detection
    /// Scenario: should error when the picture never moves
    ///
    /// Regression: freezes were measured and no rule read them, so a render
    /// that stalled on a single frame passed every check.
    #[tokio::test]
    async fn test_frozen_program_rule_should_error_when_the_program_never_moves() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_freeze_ranges(vec![(0.0, 30.0)]));

        let violations = FrozenProgramRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Error);
        assert_eq!(violations[0].metrics["programFraction"], 1.0);
        assert_eq!(violations[0].metrics["frozenSec"], 30.0);
    }

    /// Feature: Frozen program detection
    /// Scenario: should error when separate frozen stretches cover the program
    #[tokio::test]
    async fn test_frozen_program_rule_should_add_up_separate_frozen_stretches() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        // Three stretches of a fifth of the program each: none alarming alone.
        let context = QCContext::from_sequence(&sequence).with_measurements(
            measurements_with_freeze_ranges(vec![(0.0, 6.0), (10.0, 16.0), (20.0, 26.0)]),
        );

        let violations = FrozenProgramRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Error);
        assert_eq!(violations[0].metrics["programFraction"], 0.6);
    }

    /// Feature: Frozen program detection
    /// Scenario: should leave a held frame informational
    #[tokio::test]
    async fn test_frozen_program_rule_should_leave_a_held_frame_informational() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_freeze_ranges(vec![(4.0, 7.0)]));

        let violations = FrozenProgramRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(
            violations[0].severity,
            Severity::Info,
            "a three-second hold is a title card, not a broken render"
        );
    }

    /// Feature: Frozen program detection
    /// Scenario: should stay quiet on a moving picture
    #[tokio::test]
    async fn test_frozen_program_rule_should_pass_a_moving_picture() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_with_freeze_ranges(Vec::new()));

        let violations = FrozenProgramRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    // ========================================================================
    // AudioClippingRule Tests
    // ========================================================================

    #[test]
    fn test_audio_clipping_rule_properties() {
        let rule = AudioClippingRule::new();
        assert_eq!(rule.check_id(), "audio.clipping");
        assert_eq!(rule.category(), CheckCategory::Rendered);
        assert_eq!(rule.default_severity(), Severity::Warning);
    }

    /// Feature: Audio flatness
    /// Scenario: should warn when the master is flat-topped
    ///
    /// Regression: `astats` flatness was measured and no rule read it, so a
    /// render clipped flat measured clean.
    #[tokio::test]
    async fn test_audio_clipping_rule_should_warn_on_flat_topped_samples() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let context = QCContext::from_sequence(&sequence).with_measurements(RenderMeasurements {
            flat_factor: Some(24.0),
            true_peak_dbtp: Some(-0.1),
            ..Default::default()
        });

        let violations = AudioClippingRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Warning);
        assert_eq!(violations[0].metrics["flatFactor"], 24.0);
        assert_eq!(violations[0].metrics["measuredPeakDb"], -0.1);
    }

    /// Feature: Audio flatness
    /// Scenario: should stay quiet on an unclipped mix
    #[tokio::test]
    async fn test_audio_clipping_rule_should_pass_an_unclipped_mix() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let state = state_with_video_asset("asset_001", Some(30.0));
        let context = QCContext::from_sequence(&sequence).with_measurements(RenderMeasurements {
            flat_factor: Some(0.0),
            ..Default::default()
        });

        let violations = AudioClippingRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
    }

    /// Feature: Audio flatness
    /// Scenario: should be skipped rather than passed without a measurement
    #[test]
    fn test_audio_clipping_rule_should_skip_without_a_flatness_measurement() {
        let sequence = sequence_with_video_clip(0.0, 30.0);
        let rule = AudioClippingRule::new();

        assert!(rule
            .skip_reason(&QCContext::from_sequence(&sequence))
            .is_some());
        assert!(rule
            .skip_reason(
                &QCContext::from_sequence(&sequence)
                    .with_measurements(RenderMeasurements::default())
            )
            .is_some());
    }

    /// Feature: Render/sequence duration match
    /// Scenario: should pass a correct render of a sequence with a disabled tail
    ///
    /// Regression: the rule compared the file against the editing extent, which
    /// counts clips the export drops. A correct render of a timeline ending on
    /// a disabled clip is shorter than that extent, so verify reported a
    /// `render.duration_mismatch` ERROR on a file that was exactly right.
    #[tokio::test]
    async fn test_render_duration_rule_should_pass_when_a_disabled_tail_clip_shortens_the_render() {
        let mut sequence = sequence_with_video_clip(0.0, 60.0);
        let mut tail_track = Track::new_video("V2");
        let mut disabled_tail = Clip::with_range("asset_002", 0.0, 30.0).place_at(60.0);
        disabled_tail.enabled = false;
        tail_track.add_clip(disabled_tail);
        sequence.add_track(tail_track);

        // The editor still reaches 90s; the export stops at 60s and so does the
        // file it writes.
        assert_eq!(sequence.duration(), 90.0);
        assert_eq!(sequence.output_duration(), 60.0);

        let state = state_with_video_asset("asset_001", Some(60.0));
        let context =
            QCContext::from_sequence(&sequence).with_measurements(measurements_of_length(60.0));

        let violations = RenderDurationRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(
            violations.is_empty(),
            "a render matching the export's own output length is the deliverable: {violations:?}"
        );
    }

    /// Feature: Render/sequence duration match
    /// Scenario: should still catch a truncated render of that same sequence
    #[tokio::test]
    async fn test_render_duration_rule_should_still_catch_truncation_past_a_disabled_tail() {
        let mut sequence = sequence_with_video_clip(0.0, 60.0);
        let mut tail_track = Track::new_video("V2");
        let mut disabled_tail = Clip::with_range("asset_002", 0.0, 30.0).place_at(60.0);
        disabled_tail.enabled = false;
        tail_track.add_clip(disabled_tail);
        sequence.add_track(tail_track);

        let state = state_with_video_asset("asset_001", Some(60.0));
        let context =
            QCContext::from_sequence(&sequence).with_measurements(measurements_of_length(12.0));

        let violations = RenderDurationRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Error);
        assert_eq!(
            violations[0].metrics["sequenceDurationSec"], 60.0,
            "the rule grades against the length the export writes"
        );
    }

    /// Feature: Render/sequence duration match
    /// Scenario: should be skipped rather than silently passed without a probe
    #[tokio::test]
    async fn test_render_duration_rule_should_skip_when_the_file_duration_is_unknown() {
        let sequence = sequence_with_video_clip(0.0, 60.0);
        let state = state_with_video_asset("asset_001", Some(60.0));
        let rule = RenderDurationRule::new();

        let no_measurements = QCContext::from_sequence(&sequence);
        assert!(rule.skip_reason(&no_measurements).is_some());

        let no_duration =
            QCContext::from_sequence(&sequence).with_measurements(RenderMeasurements::default());
        assert!(rule.skip_reason(&no_duration).is_some());

        let violations = rule
            .check(&sequence, &state, &RuleConfig::default(), &no_duration)
            .await
            .expect("rule runs");
        assert!(violations.is_empty());
    }

    /// Feature: Verifying a partial render
    /// Scenario: should leave a window outside the sequence to the caller check
    ///
    /// Clipping `--file-range 100 130` to a 60-second edit leaves nothing, and
    /// every rendered rule graded against that empty span reports `passed` — a
    /// clean verdict on a file nobody looked at. The refusal belongs where it
    /// can stop the whole run (`check_window_overlaps` in `core::qc::verify`),
    /// not in one rule's findings, so this rule stays quiet and the run never
    /// gets this far.
    #[tokio::test]
    async fn test_render_duration_rule_should_stay_quiet_when_the_window_clips_to_nothing() {
        let sequence = sequence_with_video_clip(0.0, 60.0);
        let state = state_with_video_asset("asset_001", Some(60.0));
        let context = QCContext::from_sequence(&sequence)
            .with_measurements(measurements_of_length(30.0))
            .with_measured_window(MeasuredWindow::new(100.0, 130.0));

        assert!(RenderDurationRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs")
            .is_empty());
    }

    /// Feature: Verifying a partial render
    /// Scenario: should still say nothing about a whole-sequence run of an
    /// empty edit, which `sequence.empty` owns
    #[tokio::test]
    async fn test_render_duration_rule_should_stay_quiet_without_a_declared_window() {
        let sequence = sequence_with_video_clip(0.0, 60.0);
        let state = state_with_video_asset("asset_001", Some(60.0));
        let context =
            QCContext::from_sequence(&sequence).with_measurements(measurements_of_length(60.0));

        assert!(RenderDurationRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs")
            .is_empty());
    }

    // ========================================================================
    // DurationRule Tests
    // ========================================================================

    #[test]
    fn test_duration_rule_properties() {
        let rule = DurationRule::new();
        assert_eq!(rule.name(), "DurationRule");
        assert_eq!(rule.default_severity(), Severity::Error);
        assert!(!rule.supports_auto_fix());
    }
}

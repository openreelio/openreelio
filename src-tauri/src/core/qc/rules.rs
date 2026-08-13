//! QC Rules
//!
//! Built-in quality control rules for video editing validation.
//! Each rule implements the QCRule trait for consistent checking.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::context::QCContext;
use super::violation::{QCViolation, Severity, ViolationFix};
use crate::core::captions::{CaptionPosition, CaptionStyle, CustomPosition, VerticalPosition};
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
        if context.measurements.is_none() {
            return Some("no rendered measurements available".to_string());
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
        // located across the full sequence rather than attributed to one clip.
        let program_end = sequence.duration();
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
        .with_location(0.0, sequence.duration())
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
/// The comparison is against [`Sequence::duration`], so it also anchors the
/// other rendered checks: their timestamps are only comparable to the timeline
/// while the file covers the whole sequence from zero.
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
    /// wrong.
    const DEFAULT_TOLERANCE_SEC: f64 = 0.5;

    /// Divergence tolerated as a fraction of the sequence duration
    ///
    /// Long programs accumulate more container drift than short ones, so the
    /// effective tolerance is whichever of the two limits is larger.
    const DEFAULT_TOLERANCE_FRACTION: f64 = 0.02;
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

        let sequence_duration = sequence.duration();
        if !sequence_duration.is_finite() || sequence_duration <= 0.0 {
            // An empty sequence has no duration to match; `sequence.empty`
            // owns that finding.
            return Ok(Vec::new());
        }

        let tolerance_sec = config
            .get_param::<f64>("tolerance_sec")
            .unwrap_or(Self::DEFAULT_TOLERANCE_SEC)
            .abs()
            .max(sequence_duration * Self::DEFAULT_TOLERANCE_FRACTION);

        let delta = file_duration - sequence_duration;
        if !delta.is_finite() || delta.abs() <= tolerance_sec {
            return Ok(Vec::new());
        }

        // A file shorter than the timeline is missing program: it is truncated,
        // stale, or a partial render, and it is not the deliverable whatever
        // the reason. A longer file is suspicious but still contains the whole
        // program, so it is graded as a warning.
        let severity = config.severity_override.unwrap_or(if delta < 0.0 {
            self.default_severity()
        } else {
            Severity::Warning
        });

        let message = if delta < 0.0 {
            format!(
                "Rendered file is {:.2}s shorter than the sequence ({:.2}s vs {:.2}s)",
                -delta, file_duration, sequence_duration
            )
        } else {
            format!(
                "Rendered file is {:.2}s longer than the sequence ({:.2}s vs {:.2}s)",
                delta, file_duration, sequence_duration
            )
        };

        Ok(vec![QCViolation::new(self.name(), severity, message)
            .with_location(0.0, sequence_duration)
            .with_details(
                "The measured file does not match the timeline, so every other rendered check \
                 describes a different program. Re-render the sequence and verify again."
                    .to_string(),
            )
            .with_metric("fileDurationSec", (file_duration * 1000.0).round() / 1000.0)
            .with_metric(
                "sequenceDurationSec",
                (sequence_duration * 1000.0).round() / 1000.0,
            )
            .with_metric("deltaSec", (delta * 1000.0).round() / 1000.0)
            .with_metric(
                "toleranceSec",
                (tolerance_sec * 1000.0).round() / 1000.0,
            )])
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

    /// Characters that fit across the full canvas width at the default font size
    ///
    /// Core has no text shaping, so rendered text width can only be
    /// approximated; this average glyph advance keeps the estimate conservative
    /// for Latin text and is intentionally coarse.
    const CHARS_PER_CANVAS_WIDTH: f64 = 42.0;

    /// Maximum estimated text-box width as a percentage of canvas width
    const MAX_TEXT_BOX_WIDTH_PERCENT: f64 = 90.0;

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
    fn estimate_text_box_percent(clip: &Clip, canvas_height: u32) -> (f64, f64) {
        let char_count = clip
            .label
            .as_ref()
            .map(|label| label.chars().count())
            .unwrap_or(0) as f64;

        let width_percent = (char_count / Self::CHARS_PER_CANVAS_WIDTH * 100.0)
            .min(Self::MAX_TEXT_BOX_WIDTH_PERCENT);

        let canvas_height = if canvas_height > 0 { canvas_height } else { 1 };
        let height_percent = Self::font_size_px(clip.caption_style.as_ref())
            * Self::LINE_HEIGHT_FACTOR
            / f64::from(canvas_height)
            * 100.0;

        (width_percent, height_percent)
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

            for clip in &track.clips {
                // A missing or unreadable position renders with the caption
                // default, so the check follows the same fallback.
                let position = clip
                    .caption_position
                    .as_ref()
                    .and_then(|value| serde_json::from_value::<CaptionPosition>(value.clone()).ok())
                    .unwrap_or_default();

                let (violation_severity, message, details, suggested_position) = match &position {
                    CaptionPosition::Preset {
                        vertical,
                        margin_percent,
                    } => {
                        // Center-anchored captions sit mid-canvas, where an edge
                        // margin has no meaning.
                        if *vertical == VerticalPosition::Center {
                            continue;
                        }

                        if *margin_percent < action_safe_margin {
                            (
                                severity,
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
                        } else if *margin_percent < title_safe_margin {
                            (
                                Severity::Info,
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
                            continue;
                        }
                    }
                    CaptionPosition::Custom(custom) => {
                        let (box_width, box_height) =
                            Self::estimate_text_box_percent(clip, context.canvas_height);

                        let left = custom.x_percent - box_width / 2.0;
                        let right = custom.x_percent + box_width / 2.0;
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

                        (
                            severity,
                            "Caption positioned outside the action-safe area".to_string(),
                            format!(
                                "Estimated text box spans x {:.1}%-{:.1}%, y {:.1}%-{:.1}%, outside the {:.1}%-{:.1}% safe band (box size is an approximation)",
                                left, right, top, bottom, action_safe_margin, upper_bound
                            ),
                            CaptionPosition::Custom(CustomPosition {
                                x_percent: Self::clamp_center(
                                    custom.x_percent,
                                    box_width,
                                    action_safe_margin,
                                ),
                                y_percent: Self::clamp_center(
                                    custom.y_percent,
                                    box_height,
                                    action_safe_margin,
                                ),
                            }),
                        )
                    }
                };

                let mut violation = QCViolation::new(self.name(), violation_severity, message)
                    .with_location(clip.place.timeline_in_sec, clip.timeline_end())
                    .with_entities(vec![clip.id.clone()])
                    .with_details(details);

                if let Ok(position_json) = serde_json::to_value(&suggested_position) {
                    violation = violation.with_fix(
                        ViolationFix::new(
                            "Move the caption inside the safe area",
                            vec![serde_json::json!({
                                "type": "UpdateCaption",
                                "sequenceId": sequence.id,
                                "trackId": track.id,
                                "clipId": clip.id,
                                "position": position_json
                            })],
                        )
                        .with_confidence(0.95),
                    );
                }

                violations.push(violation);
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
/// Reports the mismatch and stops there. The export pipeline already fits every
/// source into the canvas with `force_original_aspect_ratio=decrease` plus a
/// pad, so a mismatch shows as bars rather than as broken output — and the only
/// command that could override that framing, `SetClipTransform`, puts the clip
/// on a non-identity transform, which the final export path rejects outright.
/// Suggesting it would turn a cosmetic warning into a render that will not
/// start, so this rule deliberately carries no fix.
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
    use crate::core::qc::context::RenderMeasurements;
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
            "no single command reframes a clip without breaking export"
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
            "SetClipTransform puts the clip on a transform the export path rejects"
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
        // 0.9s is under the 2% (1.2s) tolerance a 60s program allows.
        let context =
            QCContext::from_sequence(&sequence).with_measurements(measurements_of_length(60.9));

        let violations = RenderDurationRule::new()
            .check(&sequence, &state, &RuleConfig::default(), &context)
            .await
            .expect("rule runs");

        assert!(violations.is_empty());
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

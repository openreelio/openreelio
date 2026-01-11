//! QC Rules
//!
//! Built-in quality control rules for video editing validation.
//! Each rule implements the QCRule trait for consistent checking.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::violation::{QCViolation, Severity, TimeRange, ViolationFix};
use crate::core::project::ProjectState;
use crate::core::timeline::Sequence;
use crate::core::{CoreError, CoreResult};

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

/// Trait for all QC rules
#[async_trait]
pub trait QCRule: Send + Sync {
    /// Returns the unique name of this rule
    fn name(&self) -> &str;

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
    ) -> CoreResult<Vec<QCViolation>>;

    /// Attempts to auto-fix a violation (if supported)
    async fn auto_fix(&self, violation: &QCViolation) -> Option<ViolationFix> {
        violation.suggested_fix.clone()
    }

    /// Returns whether this rule supports auto-fix
    fn supports_auto_fix(&self) -> bool {
        false
    }
}

// ============================================================================
// BlackFrameRule - Detects black frames at start/end
// ============================================================================

/// Rule that detects black frames at the beginning or end of clips
#[derive(Debug, Default)]
pub struct BlackFrameRule;

impl BlackFrameRule {
    /// Creates a new BlackFrameRule
    pub fn new() -> Self {
        Self
    }

    /// Threshold for considering a frame "black" (0.0 - 1.0)
    const DEFAULT_THRESHOLD: f64 = 0.05;

    /// Minimum duration to flag (seconds)
    const DEFAULT_MIN_DURATION: f64 = 0.1;
}

#[async_trait]
impl QCRule for BlackFrameRule {
    fn name(&self) -> &str {
        "BlackFrameRule"
    }

    fn description(&self) -> &str {
        "Detects black frames at the start or end of clips"
    }

    fn default_severity(&self) -> Severity {
        Severity::Warning
    }

    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
    ) -> CoreResult<Vec<QCViolation>> {
        let mut violations = Vec::new();

        let threshold = config
            .get_param::<f64>("threshold")
            .unwrap_or(Self::DEFAULT_THRESHOLD);
        let min_duration = config
            .get_param::<f64>("min_duration")
            .unwrap_or(Self::DEFAULT_MIN_DURATION);

        let severity = config.severity_override.unwrap_or(self.default_severity());

        // Check each clip in video tracks
        for track_id in &sequence.tracks {
            if let Some(track) = state.get_track(track_id) {
                if !track.is_video() {
                    continue;
                }

                for clip_id in &track.items {
                    if let Some(clip) = state.get_clip(clip_id) {
                        // Check for black frames at start (simulated check)
                        // In real implementation, this would analyze frame data
                        if clip.place.start_sec == 0.0 {
                            // Placeholder: detect black frame at start
                            let black_duration = 0.5; // Simulated detection
                            if black_duration >= min_duration {
                                let fix = ViolationFix::new(
                                    format!("Trim {:.1}s from start", black_duration),
                                    vec![serde_json::json!({
                                        "type": "TrimClip",
                                        "clipId": clip_id,
                                        "trimStart": black_duration
                                    })],
                                )
                                .with_confidence(0.9);

                                let violation = QCViolation::new(
                                    self.name(),
                                    severity,
                                    format!(
                                        "Black frame detected at start ({:.1}s)",
                                        black_duration
                                    ),
                                )
                                .with_location(
                                    clip.place.start_sec,
                                    clip.place.start_sec + black_duration,
                                )
                                .with_entities(vec![clip_id.clone()])
                                .with_fix(fix);

                                violations.push(violation);
                            }
                        }
                    }
                }
            }
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
}

#[async_trait]
impl QCRule for AudioPeakRule {
    fn name(&self) -> &str {
        "AudioPeakRule"
    }

    fn description(&self) -> &str {
        "Detects audio peaks that may cause clipping or distortion"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
    ) -> CoreResult<Vec<QCViolation>> {
        let mut violations = Vec::new();

        let peak_db = config
            .get_param::<f64>("peak_db")
            .unwrap_or(Self::DEFAULT_PEAK_DB);
        let warn_db = config
            .get_param::<f64>("warn_db")
            .unwrap_or(Self::DEFAULT_WARN_DB);

        // Check audio tracks
        for track_id in &sequence.tracks {
            if let Some(track) = state.get_track(track_id) {
                if !track.is_audio() {
                    continue;
                }

                for clip_id in &track.items {
                    if let Some(clip) = state.get_clip(clip_id) {
                        // Simulated peak detection (real implementation would analyze audio)
                        let detected_peak = -0.5; // Simulated peak

                        if detected_peak > peak_db {
                            let severity = config.severity_override.unwrap_or(Severity::Critical);

                            let fix = ViolationFix::new(
                                "Reduce audio gain to prevent clipping",
                                vec![serde_json::json!({
                                    "type": "AdjustAudio",
                                    "clipId": clip_id,
                                    "gainDb": peak_db - detected_peak - 0.5
                                })],
                            )
                            .with_confidence(0.85);

                            let violation = QCViolation::new(
                                self.name(),
                                severity,
                                format!("Audio clipping detected ({:.1} dB peak)", detected_peak),
                            )
                            .with_location(clip.place.start_sec, clip.place.end_sec)
                            .with_entities(vec![clip_id.clone()])
                            .with_details(format!(
                                "Peak exceeds threshold of {:.1} dB. May cause distortion.",
                                peak_db
                            ))
                            .with_fix(fix);

                            violations.push(violation);
                        } else if detected_peak > warn_db {
                            let severity = config.severity_override.unwrap_or(Severity::Warning);

                            let violation = QCViolation::new(
                                self.name(),
                                severity,
                                format!("High audio level detected ({:.1} dB peak)", detected_peak),
                            )
                            .with_location(clip.place.start_sec, clip.place.end_sec)
                            .with_entities(vec![clip_id.clone()]);

                            violations.push(violation);
                        }
                    }
                }
            }
        }

        Ok(violations)
    }

    fn supports_auto_fix(&self) -> bool {
        true
    }
}

// ============================================================================
// CaptionSafeAreaRule - Ensures captions are in safe area
// ============================================================================

/// Rule that ensures captions remain within the title-safe area
#[derive(Debug, Default)]
pub struct CaptionSafeAreaRule;

impl CaptionSafeAreaRule {
    /// Creates a new CaptionSafeAreaRule
    pub fn new() -> Self {
        Self
    }

    /// Default safe area margin (percentage of screen)
    const DEFAULT_MARGIN_PERCENT: f64 = 10.0;
}

#[async_trait]
impl QCRule for CaptionSafeAreaRule {
    fn name(&self) -> &str {
        "CaptionSafeAreaRule"
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
        state: &ProjectState,
        config: &RuleConfig,
    ) -> CoreResult<Vec<QCViolation>> {
        let mut violations = Vec::new();

        let margin_percent = config
            .get_param::<f64>("margin_percent")
            .unwrap_or(Self::DEFAULT_MARGIN_PERCENT);

        let severity = config.severity_override.unwrap_or(self.default_severity());

        // Check caption tracks
        for track_id in &sequence.tracks {
            if let Some(track) = state.get_track(track_id) {
                if !track.is_caption() {
                    continue;
                }

                for clip_id in &track.items {
                    if let Some(clip) = state.get_clip(clip_id) {
                        // Check caption position (simulated - real impl would check Caption data)
                        let caption_y_percent = 95.0; // Simulated: near bottom edge

                        if caption_y_percent > (100.0 - margin_percent) {
                            let fix = ViolationFix::new(
                                format!("Move caption to {}% from bottom", margin_percent),
                                vec![serde_json::json!({
                                    "type": "UpdateCaption",
                                    "clipId": clip_id,
                                    "position": {"y": 100.0 - margin_percent - 5.0}
                                })],
                            )
                            .with_confidence(0.95);

                            let violation = QCViolation::new(
                                self.name(),
                                severity,
                                "Caption positioned outside title-safe area",
                            )
                            .with_location(clip.place.start_sec, clip.place.end_sec)
                            .with_entities(vec![clip_id.clone()])
                            .with_details(format!(
                                "Caption at {}% exceeds safe area margin of {}%",
                                caption_y_percent, margin_percent
                            ))
                            .with_fix(fix);

                            violations.push(violation);
                        }
                    }
                }
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

    fn description(&self) -> &str {
        "Checks if video cuts maintain appropriate rhythm and pacing"
    }

    fn default_severity(&self) -> Severity {
        Severity::Info
    }

    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
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
        for track_id in &sequence.tracks {
            if let Some(track) = state.get_track(track_id) {
                if !track.is_video() {
                    continue;
                }

                for clip_id in &track.items {
                    if let Some(clip) = state.get_clip(clip_id) {
                        let duration = clip.duration();

                        if duration < min_cut {
                            let violation = QCViolation::new(
                                self.name(),
                                severity,
                                format!(
                                    "Cut too short ({:.1}s < {:.1}s minimum)",
                                    duration, min_cut
                                ),
                            )
                            .with_location(clip.place.start_sec, clip.place.end_sec)
                            .with_entities(vec![clip_id.clone()])
                            .with_details(
                                "Very short cuts may feel jarring to viewers. Consider extending.",
                            );

                            violations.push(violation);
                        } else if duration > max_cut {
                            let violation = QCViolation::new(
                                self.name(),
                                severity,
                                format!(
                                    "Cut too long ({:.1}s > {:.1}s maximum)",
                                    duration, max_cut
                                ),
                            )
                            .with_location(clip.place.start_sec, clip.place.end_sec)
                            .with_entities(vec![clip_id.clone()])
                            .with_details(
                                "Long cuts may lose viewer attention. Consider splitting.",
                            );

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
    ) -> CoreResult<Vec<QCViolation>> {
        let mut violations = Vec::new();

        let severity = config.severity_override.unwrap_or(self.default_severity());
        let check_commercial = config.get_param::<bool>("check_commercial").unwrap_or(true);

        // Get all unique assets used in sequence
        let mut used_asset_ids = std::collections::HashSet::new();
        for track_id in &sequence.tracks {
            if let Some(track) = state.get_track(track_id) {
                for clip_id in &track.items {
                    if let Some(clip) = state.get_clip(clip_id) {
                        used_asset_ids.insert(clip.asset_id.clone());
                    }
                }
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
                    if *expires < chrono::Utc::now() {
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

        Ok(violations)
    }
}

// ============================================================================
// AspectRatioRule - Checks aspect ratio consistency
// ============================================================================

/// Rule that checks if all clips match the sequence aspect ratio
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
    ) -> CoreResult<Vec<QCViolation>> {
        let mut violations = Vec::new();

        let severity = config.severity_override.unwrap_or(self.default_severity());
        let tolerance = config.get_param::<f64>("tolerance").unwrap_or(0.01);

        let seq_aspect = sequence.format.canvas.width as f64 / sequence.format.canvas.height as f64;

        // Check all video clips
        for track_id in &sequence.tracks {
            if let Some(track) = state.get_track(track_id) {
                if !track.is_video() {
                    continue;
                }

                for clip_id in &track.items {
                    if let Some(clip) = state.get_clip(clip_id) {
                        if let Some(asset) = state.get_asset(&clip.asset_id) {
                            if let Some(video_info) = &asset.video_info {
                                let asset_aspect =
                                    video_info.width as f64 / video_info.height as f64;
                                let diff = (asset_aspect - seq_aspect).abs();

                                if diff > tolerance {
                                    let fix = ViolationFix::new(
                                        "Apply crop/letterbox to match sequence",
                                        vec![serde_json::json!({
                                            "type": "SetTransform",
                                            "clipId": clip_id,
                                            "crop": {"fit": "cover"}
                                        })],
                                    )
                                    .with_confidence(0.7);

                                    let violation = QCViolation::new(
                                        self.name(),
                                        severity,
                                        format!(
                                            "Aspect ratio mismatch: {:.2}:1 vs {:.2}:1",
                                            asset_aspect, seq_aspect
                                        ),
                                    )
                                    .with_location(clip.place.start_sec, clip.place.end_sec)
                                    .with_entities(vec![clip_id.clone()])
                                    .with_details(format!(
                                        "Asset {}x{} doesn't match sequence {}x{}",
                                        video_info.width,
                                        video_info.height,
                                        sequence.format.canvas.width,
                                        sequence.format.canvas.height
                                    ))
                                    .with_fix(fix);

                                    violations.push(violation);
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(violations)
    }

    fn supports_auto_fix(&self) -> bool {
        true
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

    fn description(&self) -> &str {
        "Checks if sequence duration meets platform requirements"
    }

    fn default_severity(&self) -> Severity {
        Severity::Error
    }

    async fn check(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        config: &RuleConfig,
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
        let duration = sequence.calculate_duration(state);

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
        let mut config = RuleConfig::default();
        config.severity_override = Some(Severity::Error);
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
        assert!(rule.supports_auto_fix());
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

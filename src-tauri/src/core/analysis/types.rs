//! Analysis Pipeline Types
//!
//! Data structures for the reference video analysis pipeline (ADR-048).
//! All types are exported to TypeScript via tauri-specta.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::annotations::models::{ShotResult, TranscriptSegment};

/// Finite decibel floor used for silent audio serialization.
pub const SILENCE_FLOOR_DB: f64 = -90.0;

// =============================================================================
// Silence Region
// =============================================================================

/// A detected region of silence in the audio track
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SilenceRegion {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
}

impl SilenceRegion {
    /// Creates a new silence region
    pub fn new(start_sec: f64, end_sec: f64) -> Self {
        Self { start_sec, end_sec }
    }

    /// Returns the duration in seconds
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }
}

// =============================================================================
// Audio Profile
// =============================================================================

/// Audio characteristics extracted from a video's audio track.
///
/// Contains rhythm, loudness, and spectral data used for
/// content segmentation and style matching.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioProfile {
    /// Estimated beats per minute (null if no clear rhythm detected)
    pub bpm: Option<f64>,
    /// Spectral center frequency in Hz (higher = brighter/more treble)
    pub spectral_centroid_hz: f64,
    /// Per-second RMS loudness values in dB
    pub loudness_profile: Vec<f64>,
    /// Maximum loudness in dB
    pub peak_db: f64,
    /// Regions where audio is below -40 dB for > 0.5s
    pub silence_regions: Vec<SilenceRegion>,
}

impl AudioProfile {
    /// Creates an empty audio profile (for silent/no-audio videos)
    pub fn silent(duration_sec: f64) -> Self {
        let silence = if duration_sec > 0.0 {
            vec![SilenceRegion::new(0.0, duration_sec)]
        } else {
            vec![]
        };
        Self {
            bpm: None,
            spectral_centroid_hz: 0.0,
            loudness_profile: Vec::new(),
            peak_db: SILENCE_FLOOR_DB,
            silence_regions: silence,
        }
    }
}

// =============================================================================
// Content Segment
// =============================================================================

/// Classification type for a video content segment
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SegmentType {
    /// Dialogue/interview/narration section
    Talk,
    /// Music/performance section
    Performance,
    /// Reaction/cutaway section
    Reaction,
    /// Short transitional section
    Transition,
    /// Establishing/wide shot section
    Establishing,
    /// Quick-cut montage section
    Montage,
}

impl std::fmt::Display for SegmentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Talk => write!(f, "talk"),
            Self::Performance => write!(f, "performance"),
            Self::Reaction => write!(f, "reaction"),
            Self::Transition => write!(f, "transition"),
            Self::Establishing => write!(f, "establishing"),
            Self::Montage => write!(f, "montage"),
        }
    }
}

/// A classified time segment of video content
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContentSegment {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Classification type
    pub segment_type: SegmentType,
    /// Classification confidence (0.0 - 1.0)
    pub confidence: f64,
    /// Heuristic signals that contributed to classification
    pub features: serde_json::Value,
}

impl ContentSegment {
    /// Creates a new content segment
    pub fn new(start_sec: f64, end_sec: f64, segment_type: SegmentType, confidence: f64) -> Self {
        Self {
            start_sec,
            end_sec,
            segment_type,
            confidence,
            features: serde_json::Value::Object(serde_json::Map::new()),
        }
    }

    /// Sets the features map
    pub fn with_features(mut self, features: serde_json::Value) -> Self {
        self.features = features;
        self
    }

    /// Returns the duration in seconds
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }
}

// =============================================================================
// Frame Analysis
// =============================================================================

/// Camera angle classification for a shot
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CameraAngle {
    /// Wide/establishing shot
    Wide,
    /// Medium shot (waist up)
    Medium,
    /// Close-up shot (head/shoulders)
    Close,
    /// Extreme close-up (detail)
    ExtremeClose,
    /// Unable to determine (local fallback)
    Unknown,
}

/// Subject position within the frame
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SubjectPosition {
    /// Subject centered in frame
    Center,
    /// Subject on the left
    Left,
    /// Subject on the right
    Right,
    /// Subject in upper portion
    Top,
    /// Subject in lower portion
    Bottom,
    /// Unable to determine (local fallback)
    Unknown,
}

/// Camera or subject motion direction
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MotionDirection {
    /// No significant motion
    Static,
    /// Camera pans left
    PanLeft,
    /// Camera pans right
    PanRight,
    /// Camera tilts up
    TiltUp,
    /// Camera tilts down
    TiltDown,
    /// Camera zooms in
    ZoomIn,
    /// Camera zooms out
    ZoomOut,
    /// Unable to determine (local fallback)
    Unknown,
}

/// Visual composition analysis for a single shot's keyframe
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FrameAnalysis {
    /// Index of the shot this analysis corresponds to
    pub shot_index: usize,
    /// Detected camera angle
    pub camera_angle: CameraAngle,
    /// Detected subject position
    pub subject_position: SubjectPosition,
    /// Detected motion direction
    pub motion_direction: MotionDirection,
    /// Visual complexity score (0.0 = static/simple, 1.0 = complex/dynamic)
    pub visual_complexity: f64,
}

impl FrameAnalysis {
    /// Creates a frame analysis with unknown visual properties (local fallback)
    pub fn local_fallback(shot_index: usize, visual_complexity: f64) -> Self {
        Self {
            shot_index,
            camera_angle: CameraAngle::Unknown,
            subject_position: SubjectPosition::Unknown,
            motion_direction: MotionDirection::Unknown,
            visual_complexity: visual_complexity.clamp(0.0, 1.0),
        }
    }
}

// =============================================================================
// Video Metadata
// =============================================================================

/// Basic metadata about the analyzed video file
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VideoMetadata {
    /// Duration in seconds
    pub duration_sec: f64,
    /// Video width in pixels
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Video height in pixels
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Frame rate (fps)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    /// Video codec name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    /// Whether the file has an audio stream
    pub has_audio: bool,
}

impl VideoMetadata {
    /// Creates metadata with just duration
    pub fn new(duration_sec: f64) -> Self {
        Self {
            duration_sec,
            width: None,
            height: None,
            fps: None,
            codec: None,
            has_audio: false,
        }
    }

    /// Sets video dimensions
    pub fn with_dimensions(mut self, width: u32, height: u32) -> Self {
        self.width = Some(width);
        self.height = Some(height);
        self
    }

    /// Sets frame rate
    pub fn with_fps(mut self, fps: f64) -> Self {
        self.fps = Some(fps);
        self
    }

    /// Sets codec name
    pub fn with_codec(mut self, codec: &str) -> Self {
        self.codec = Some(codec.to_string());
        self
    }

    /// Sets whether audio is present
    pub fn with_audio(mut self, has_audio: bool) -> Self {
        self.has_audio = has_audio;
        self
    }
}

// =============================================================================
// Analysis Options
// =============================================================================

/// Options controlling which analysis sub-jobs to run
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOptions {
    /// Run shot/scene detection
    #[serde(default = "default_true")]
    pub shots: bool,
    /// Run speech-to-text transcription
    #[serde(default)]
    pub transcript: bool,
    /// Run audio profiling (BPM, loudness, spectral)
    #[serde(default = "default_true")]
    pub audio: bool,
    /// Run content segmentation (talk/performance/montage)
    #[serde(default = "default_true")]
    pub segments: bool,
    /// Run visual frame analysis
    #[serde(default)]
    pub visual: bool,
    /// Skip Vision API calls, use FFmpeg-only local analysis
    #[serde(default)]
    pub local_only: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AnalysisOptions {
    fn default() -> Self {
        Self {
            shots: true,
            transcript: false,
            audio: true,
            segments: true,
            visual: false,
            local_only: false,
        }
    }
}

impl AnalysisOptions {
    /// Returns true if any analysis type is enabled
    pub fn has_any(&self) -> bool {
        self.shots || self.transcript || self.audio || self.segments || self.visual
    }
}

// =============================================================================
// Analysis Bundle
// =============================================================================

/// Aggregated results from all analysis sub-jobs for a single asset.
///
/// This is the primary output artifact of the analysis pipeline.
/// Stored at `{project}/.openreelio/analysis/{asset_id}/bundle.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisBundle {
    /// Asset ID this bundle belongs to
    pub asset_id: String,
    /// Shot detection results
    pub shots: Option<Vec<ShotResult>>,
    /// Transcript segments
    pub transcript: Option<Vec<TranscriptSegment>>,
    /// Audio profiling results
    pub audio_profile: Option<AudioProfile>,
    /// Content segmentation results
    pub segments: Option<Vec<ContentSegment>>,
    /// Visual frame analysis results
    pub frame_analysis: Option<Vec<FrameAnalysis>>,
    /// Video file metadata
    pub metadata: VideoMetadata,
    /// Errors from failed sub-jobs (key = analysis type name)
    #[serde(default)]
    pub errors: HashMap<String, String>,
    /// ISO 8601 timestamp when analysis was performed
    pub analyzed_at: String,
}

impl AnalysisBundle {
    /// Creates a new empty bundle for an asset
    pub fn new(asset_id: &str, metadata: VideoMetadata) -> Self {
        Self {
            asset_id: asset_id.to_string(),
            shots: None,
            transcript: None,
            audio_profile: None,
            segments: None,
            frame_analysis: None,
            metadata,
            errors: HashMap::new(),
            analyzed_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// Records an error for a specific analysis type
    pub fn add_error(&mut self, analysis_type: &str, error: String) {
        self.errors.insert(analysis_type.to_string(), error);
    }

    /// Returns true if any results are populated
    pub fn has_results(&self) -> bool {
        self.shots.is_some()
            || self.transcript.is_some()
            || self.audio_profile.is_some()
            || self.segments.is_some()
            || self.frame_analysis.is_some()
    }

    /// Returns true if all requested analyses completed without errors
    pub fn is_complete(&self) -> bool {
        self.errors.is_empty()
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // SilenceRegion Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_calculate_silence_region_duration() {
        let region = SilenceRegion::new(1.5, 3.2);
        assert!((region.duration() - 1.7).abs() < 0.001);
    }

    // -------------------------------------------------------------------------
    // AudioProfile Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_create_silent_audio_profile_when_no_audio_stream() {
        let profile = AudioProfile::silent(10.0);
        assert!(profile.bpm.is_none());
        assert_eq!(profile.spectral_centroid_hz, 0.0);
        assert!(profile.loudness_profile.is_empty());
        assert_eq!(profile.peak_db, SILENCE_FLOOR_DB);
        assert_eq!(profile.silence_regions.len(), 1);
        assert_eq!(profile.silence_regions[0].start_sec, 0.0);
        assert_eq!(profile.silence_regions[0].end_sec, 10.0);
    }

    #[test]
    fn should_serialize_audio_profile_to_camel_case_json() {
        let profile = AudioProfile {
            bpm: Some(120.0),
            spectral_centroid_hz: 2500.0,
            loudness_profile: vec![-20.0, -18.5, -22.0],
            peak_db: -0.5,
            silence_regions: vec![SilenceRegion::new(5.0, 6.5)],
        };

        let json = serde_json::to_string(&profile).unwrap();
        assert!(json.contains("\"spectralCentroidHz\":2500.0"));
        assert!(json.contains("\"loudnessProfile\""));
        assert!(json.contains("\"peakDb\":-0.5"));
        assert!(json.contains("\"silenceRegions\""));
    }

    // -------------------------------------------------------------------------
    // SegmentType Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_serialize_segment_type_to_snake_case() {
        let cases = vec![
            (SegmentType::Talk, "\"talk\""),
            (SegmentType::Performance, "\"performance\""),
            (SegmentType::Reaction, "\"reaction\""),
            (SegmentType::Transition, "\"transition\""),
            (SegmentType::Establishing, "\"establishing\""),
            (SegmentType::Montage, "\"montage\""),
        ];

        for (segment_type, expected) in cases {
            let json = serde_json::to_string(&segment_type).unwrap();
            assert_eq!(json, expected, "SegmentType::{:?}", segment_type);
        }
    }

    // -------------------------------------------------------------------------
    // ContentSegment Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_create_content_segment_with_features() {
        let features = serde_json::json!({
            "avgLoudness": -18.5,
            "cutFrequency": 0.3,
        });

        let segment =
            ContentSegment::new(0.0, 10.0, SegmentType::Talk, 0.85).with_features(features.clone());

        assert_eq!(segment.start_sec, 0.0);
        assert_eq!(segment.end_sec, 10.0);
        assert_eq!(segment.segment_type, SegmentType::Talk);
        assert_eq!(segment.confidence, 0.85);
        assert_eq!(segment.features, features);
    }

    #[test]
    fn should_calculate_segment_duration() {
        let segment = ContentSegment::new(2.5, 7.5, SegmentType::Performance, 0.9);
        assert_eq!(segment.duration(), 5.0);
    }

    // -------------------------------------------------------------------------
    // FrameAnalysis Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_serialize_camera_angle_to_snake_case() {
        let cases = vec![
            (CameraAngle::Wide, "\"wide\""),
            (CameraAngle::Medium, "\"medium\""),
            (CameraAngle::Close, "\"close\""),
            (CameraAngle::ExtremeClose, "\"extreme_close\""),
            (CameraAngle::Unknown, "\"unknown\""),
        ];

        for (angle, expected) in cases {
            let json = serde_json::to_string(&angle).unwrap();
            assert_eq!(json, expected, "CameraAngle::{:?}", angle);
        }
    }

    #[test]
    fn should_serialize_motion_direction_to_snake_case() {
        let cases = vec![
            (MotionDirection::Static, "\"static\""),
            (MotionDirection::PanLeft, "\"pan_left\""),
            (MotionDirection::PanRight, "\"pan_right\""),
            (MotionDirection::ZoomIn, "\"zoom_in\""),
            (MotionDirection::ZoomOut, "\"zoom_out\""),
            (MotionDirection::Unknown, "\"unknown\""),
        ];

        for (direction, expected) in cases {
            let json = serde_json::to_string(&direction).unwrap();
            assert_eq!(json, expected, "MotionDirection::{:?}", direction);
        }
    }

    #[test]
    fn should_create_local_fallback_frame_analysis() {
        let analysis = FrameAnalysis::local_fallback(3, 0.75);
        assert_eq!(analysis.shot_index, 3);
        assert_eq!(analysis.camera_angle, CameraAngle::Unknown);
        assert_eq!(analysis.subject_position, SubjectPosition::Unknown);
        assert_eq!(analysis.motion_direction, MotionDirection::Unknown);
        assert_eq!(analysis.visual_complexity, 0.75);
    }

    #[test]
    fn should_clamp_visual_complexity_to_valid_range() {
        let analysis = FrameAnalysis::local_fallback(0, 1.5);
        assert_eq!(analysis.visual_complexity, 1.0);

        let analysis = FrameAnalysis::local_fallback(0, -0.5);
        assert_eq!(analysis.visual_complexity, 0.0);
    }

    // -------------------------------------------------------------------------
    // VideoMetadata Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_create_video_metadata_with_builder() {
        let meta = VideoMetadata::new(120.5)
            .with_dimensions(1920, 1080)
            .with_fps(30.0)
            .with_codec("h264")
            .with_audio(true);

        assert_eq!(meta.duration_sec, 120.5);
        assert_eq!(meta.width, Some(1920));
        assert_eq!(meta.height, Some(1080));
        assert_eq!(meta.fps, Some(30.0));
        assert_eq!(meta.codec, Some("h264".to_string()));
        assert!(meta.has_audio);
    }

    // -------------------------------------------------------------------------
    // AnalysisOptions Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_have_sensible_defaults_for_analysis_options() {
        let opts = AnalysisOptions::default();
        assert!(opts.shots);
        assert!(!opts.transcript);
        assert!(opts.audio);
        assert!(opts.segments);
        assert!(!opts.visual);
        assert!(!opts.local_only);
        assert!(opts.has_any());
    }

    #[test]
    fn should_detect_when_no_analysis_types_enabled() {
        let opts = AnalysisOptions {
            shots: false,
            transcript: false,
            audio: false,
            segments: false,
            visual: false,
            local_only: false,
        };
        assert!(!opts.has_any());
    }

    // -------------------------------------------------------------------------
    // AnalysisBundle Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_create_empty_bundle() {
        let bundle = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        assert_eq!(bundle.asset_id, "asset_001");
        assert!(bundle.shots.is_none());
        assert!(bundle.transcript.is_none());
        assert!(bundle.audio_profile.is_none());
        assert!(bundle.segments.is_none());
        assert!(bundle.frame_analysis.is_none());
        assert!(bundle.errors.is_empty());
        assert!(!bundle.has_results());
        assert!(bundle.is_complete());
    }

    #[test]
    fn should_record_errors_in_bundle() {
        let mut bundle = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        bundle.add_error("transcript", "Whisper not available".to_string());

        assert!(!bundle.is_complete());
        assert_eq!(bundle.errors.len(), 1);
        assert!(bundle.errors.contains_key("transcript"));
    }

    #[test]
    fn should_roundtrip_full_bundle_via_json() {
        let mut bundle = AnalysisBundle::new(
            "asset_001",
            VideoMetadata::new(120.0)
                .with_dimensions(1920, 1080)
                .with_fps(30.0)
                .with_codec("h264")
                .with_audio(true),
        );

        bundle.shots = Some(vec![
            ShotResult::new(0.0, 5.0, 0.9),
            ShotResult::new(5.0, 12.0, 0.85),
        ]);

        bundle.audio_profile = Some(AudioProfile {
            bpm: Some(128.0),
            spectral_centroid_hz: 3200.0,
            loudness_profile: vec![-18.0, -16.5, -20.0],
            peak_db: -0.3,
            silence_regions: vec![SilenceRegion::new(10.0, 11.5)],
        });

        bundle.segments = Some(vec![
            ContentSegment::new(0.0, 5.0, SegmentType::Talk, 0.8),
            ContentSegment::new(5.0, 12.0, SegmentType::Performance, 0.9),
        ]);

        bundle.frame_analysis = Some(vec![
            FrameAnalysis {
                shot_index: 0,
                camera_angle: CameraAngle::Medium,
                subject_position: SubjectPosition::Center,
                motion_direction: MotionDirection::Static,
                visual_complexity: 0.3,
            },
            FrameAnalysis::local_fallback(1, 0.7),
        ]);

        let json = serde_json::to_string_pretty(&bundle).unwrap();
        let parsed: AnalysisBundle = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.asset_id, "asset_001");
        assert_eq!(parsed.shots.as_ref().unwrap().len(), 2);
        assert_eq!(parsed.audio_profile.as_ref().unwrap().bpm, Some(128.0));
        assert_eq!(parsed.segments.as_ref().unwrap().len(), 2);
        assert_eq!(parsed.frame_analysis.as_ref().unwrap().len(), 2);
        assert!(parsed.errors.is_empty());
    }

    #[test]
    fn should_roundtrip_bundle_with_partial_nulls() {
        let bundle = AnalysisBundle::new("asset_002", VideoMetadata::new(30.0));

        let json = serde_json::to_string(&bundle).unwrap();
        assert!(json.contains("\"shots\":null"));
        assert!(json.contains("\"transcript\":null"));
        assert!(json.contains("\"audioProfile\":null"));
        assert!(json.contains("\"segments\":null"));
        assert!(json.contains("\"frameAnalysis\":null"));
        assert!(json.contains("\"errors\":{}"));

        let parsed: AnalysisBundle = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.asset_id, "asset_002");
        assert!(parsed.shots.is_none());
        assert!(parsed.audio_profile.is_none());
        assert!(parsed.segments.is_none());
        assert!(parsed.frame_analysis.is_none());
    }

    #[test]
    fn should_serialize_silent_audio_profile_with_finite_peak_db() {
        let profile = AudioProfile::silent(8.0);

        let json = serde_json::to_string(&profile).unwrap();
        let parsed: AudioProfile = serde_json::from_str(&json).unwrap();

        assert!(json.contains("\"bpm\":null"));
        assert_eq!(parsed.peak_db, SILENCE_FLOOR_DB);
    }

    #[test]
    fn should_roundtrip_bundle_with_errors() {
        let mut bundle = AnalysisBundle::new("asset_003", VideoMetadata::new(45.0));
        bundle.shots = Some(vec![ShotResult::new(0.0, 45.0, 1.0)]);
        bundle.add_error("transcript", "Whisper crashed".to_string());
        bundle.add_error("visual", "Vision API unavailable".to_string());

        let json = serde_json::to_string(&bundle).unwrap();
        let parsed: AnalysisBundle = serde_json::from_str(&json).unwrap();

        assert!(parsed.shots.is_some());
        assert!(parsed.transcript.is_none());
        assert_eq!(parsed.errors.len(), 2);
        assert_eq!(parsed.errors["transcript"], "Whisper crashed");
        assert_eq!(parsed.errors["visual"], "Vision API unavailable");
    }
}

//! Analysis Pipeline Types
//!
//! Data structures for the reference video analysis pipeline (ADR-048).
//! All types are exported to TypeScript via tauri-specta.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::annotations::models::{ShotResult, TranscriptSegment, TranscriptWord};

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

/// A detected region of speech / non-silence in the audio track.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRegion {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
}

impl SpeechRegion {
    /// Creates a new speech region
    pub fn new(start_sec: f64, end_sec: f64) -> Self {
        Self { start_sec, end_sec }
    }

    /// Returns the duration in seconds
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }
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
    /// Version of the loudness/peak measurement that produced this profile.
    ///
    /// Profiles cached by an older measurement are dropped on load rather than
    /// trusted; see [`AUDIO_MEASUREMENT_VERSION`]. Legacy bundles carry no
    /// field and deserialize as version 0.
    #[serde(default)]
    pub measurement_version: u32,
    /// Estimated beats per minute (null if no clear rhythm detected)
    pub bpm: Option<f64>,
    /// Spectral center frequency in Hz (higher = brighter/more treble)
    pub spectral_centroid_hz: f64,
    /// Per-second momentary loudness values in LUFS.
    ///
    /// Sampled at 1 Hz (one value per second), so `loudness_profile[i]`
    /// represents the average momentary loudness during the i-th second of
    /// audio. Windows the meter reports as digital silence are dropped rather
    /// than averaged in, so the profile can be shorter than the audio.
    pub loudness_profile: Vec<f64>,
    /// Peak level in dB relative to full scale.
    ///
    /// True peak when the FFmpeg build measures it, otherwise the sample peak.
    /// Falls back to [`SILENCE_FLOOR_DB`] only when nothing could be measured.
    pub peak_db: f64,
    /// Integrated program loudness in LUFS (EBU R128), when it was measured.
    #[serde(default)]
    pub integrated_lufs: Option<f64>,
    /// Loudness range in LU (EBU R128), when it was measured.
    #[serde(default)]
    pub loudness_range_lu: Option<f64>,
    /// True peak in dBTP, when the FFmpeg build measured it.
    #[serde(default)]
    pub true_peak_dbtp: Option<f64>,
    /// Regions where audio is below -40 dB for > 0.5s
    pub silence_regions: Vec<SilenceRegion>,
    /// Regions where audio is above the silence threshold (derived speech / non-silence)
    #[serde(default)]
    pub speech_regions: Vec<SpeechRegion>,
}

/// Current version of the audio loudness/peak measurement.
///
/// Bumped whenever a fix changes the numbers a profile reports, so bundles
/// cached by the older measurement are recomputed instead of served. Version 1
/// fixed a pass that silently measured nothing: `ebur128=metadata=1` demotes
/// its per-frame log to VERBOSE while the pass runs at `-loglevel info`, so
/// every profile reported `peakDb: -90` with an empty loudness profile.
pub const AUDIO_MEASUREMENT_VERSION: u32 = 1;

impl Default for AudioProfile {
    /// An empty profile stamped with the current measurement version.
    ///
    /// Useful as the base of a struct-update expression when only a few fields
    /// matter; [`AudioProfile::silent`] is the one to use when the asset really
    /// has no audible content over a known duration.
    fn default() -> Self {
        Self::silent(0.0)
    }
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
            measurement_version: AUDIO_MEASUREMENT_VERSION,
            bpm: None,
            spectral_centroid_hz: 0.0,
            loudness_profile: Vec::new(),
            peak_db: SILENCE_FLOOR_DB,
            integrated_lufs: None,
            loudness_range_lu: None,
            true_peak_dbtp: None,
            silence_regions: silence,
            speech_regions: Vec::new(),
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
// Perception Provider Metadata
// =============================================================================

/// Metadata describing the model that produced semantic perception signals.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PerceptionProviderMetadata {
    /// Provider identifier, e.g. "openai" or "local"
    pub provider: String,
    /// Model identifier used by the provider
    pub model: String,
    /// ISO 8601 timestamp when this perception result was produced
    pub analyzed_at: String,
}

impl PerceptionProviderMetadata {
    /// Creates provider metadata with the current timestamp.
    pub fn new(provider: &str, model: &str) -> Self {
        Self {
            provider: provider.to_string(),
            model: model.to_string(),
            analyzed_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

/// Semantic visual observation for a representative frame/keyframe.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FrameObservation {
    /// Index of the shot this observation describes
    pub shot_index: usize,
    /// Source-relative timestamp represented by the observed image
    pub time_sec: f64,
    /// Absolute or workspace-relative path to the analyzed image
    pub image_path: String,
    /// Natural-language description of what is visible
    pub description: String,
    /// People or subject categories visible in the frame
    #[serde(default)]
    pub subjects: Vec<String>,
    /// Observable actions or motion implied by the frame
    #[serde(default)]
    pub actions: Vec<String>,
    /// Setting or environment label
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setting: Option<String>,
    /// OCR text visible in the frame
    #[serde(default)]
    pub visible_text: Vec<String>,
    /// Object or prop labels visible in the frame
    #[serde(default)]
    pub objects: Vec<String>,
    /// Short note explaining how this shot may be useful in an edit
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit_usefulness: Option<String>,
    /// Provider confidence (0.0 - 1.0)
    pub confidence: f64,
    /// Provider/model that produced this observation
    pub provider: PerceptionProviderMetadata,
}

/// Speaker-aware transcript range used by `TranscriptDetail`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSegment {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Speaker identifier
    pub speaker_id: String,
    /// Segment text
    pub text: String,
    /// Provider confidence (0.0 - 1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

/// Full transcript details beyond the legacy segment list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDetail {
    /// Complete transcript text
    pub full: String,
    /// Word-level timings, estimated or provider supplied
    #[serde(default)]
    pub words: Vec<TranscriptWord>,
    /// Speaker-aware transcript ranges
    #[serde(default)]
    pub speaker_segments: Vec<SpeakerSegment>,
    /// Provider/model that produced this transcript detail
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<PerceptionProviderMetadata>,
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
// Contact Sheet
// =============================================================================

/// A generated contact sheet image composed from representative shot keyframes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContactSheetArtifact {
    /// Absolute path to the generated contact sheet image.
    pub path: String,
    /// Number of keyframes included in the sheet.
    pub frame_count: usize,
    /// Number of grid columns.
    pub columns: usize,
    /// Number of grid rows.
    pub rows: usize,
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
    /// Analysis schema version. Version 2 adds transcript detail and frame observations.
    #[serde(default = "legacy_analysis_schema_version")]
    pub schema_version: u32,
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
    /// Semantic observations produced by a vision-capable provider.
    #[serde(default)]
    pub frame_observations: Option<Vec<FrameObservation>>,
    /// Full transcript, words, and speaker-aware segments when available.
    #[serde(default)]
    pub transcript_detail: Option<TranscriptDetail>,
    /// Representative-frame contact sheet artifact
    #[serde(default)]
    pub contact_sheet: Option<ContactSheetArtifact>,
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
            schema_version: current_analysis_schema_version(),
            asset_id: asset_id.to_string(),
            shots: None,
            transcript: None,
            audio_profile: None,
            segments: None,
            frame_analysis: None,
            frame_observations: None,
            transcript_detail: None,
            contact_sheet: None,
            metadata,
            errors: HashMap::new(),
            analyzed_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// Drops a cached audio profile produced by an older measurement.
    ///
    /// Returns `true` when a profile was discarded. The loudness/peak pass has
    /// shipped wrong numbers before — a whole class of bundles carries
    /// `peakDb: -90` with an empty loudness profile — and nothing else in the
    /// bundle can tell a stale profile from a fresh one. Dropping it here makes
    /// the next `analysis audio` / `analyze_asset` run recompute it, while every
    /// other slot the bundle paid for survives.
    pub fn drop_outdated_audio_profile(&mut self) -> bool {
        let outdated = self
            .audio_profile
            .as_ref()
            .is_some_and(|profile| profile.measurement_version < AUDIO_MEASUREMENT_VERSION);

        if outdated {
            self.audio_profile = None;
        }

        outdated
    }

    /// Records an error for a specific analysis type
    pub fn add_error(&mut self, analysis_type: &str, error: String) {
        self.errors.insert(analysis_type.to_string(), error);
    }

    /// Returns true if any results are populated
    pub fn has_results(&self) -> bool {
        self.shots.is_some()
            || self.transcript.is_some()
            || self.transcript_detail.is_some()
            || self.audio_profile.is_some()
            || self.segments.is_some()
            || self.frame_analysis.is_some()
            || self.frame_observations.is_some()
            || self.contact_sheet.is_some()
    }

    /// Returns true if all requested analyses completed without errors
    pub fn is_complete(&self) -> bool {
        self.errors.is_empty()
    }

    /// Restores result slots that this bundle does not populate from `previous`.
    ///
    /// A run that enables only some sub-jobs produces a bundle whose other
    /// slots are `None`. Writing that bundle over an existing one would discard
    /// results a previous run already paid for, so callers that re-save a
    /// partial run merge the older results back in first.
    ///
    /// Only empty slots are filled: freshly produced results, metadata, errors,
    /// and the analysis timestamp always win.
    ///
    /// A slot whose sub-job is recorded in [`Self::errors`] is never restored.
    /// That job ran and failed in this bundle, so the older result is not
    /// "missing", it is superseded — republishing it under a fresh
    /// `analyzed_at` would present stale data as current, which is exactly
    /// wrong when the failure came from media that changed underneath.
    pub fn backfill_missing_from(&mut self, previous: &AnalysisBundle) {
        if self.shots.is_none() && !self.job_failed("shots") {
            self.shots = previous.shots.clone();
        }
        if self.transcript.is_none() && !self.job_failed("transcript") {
            self.transcript = previous.transcript.clone();
        }
        if self.transcript_detail.is_none() && !self.job_failed("transcript") {
            self.transcript_detail = previous.transcript_detail.clone();
        }
        if self.audio_profile.is_none() && !self.job_failed("audio") {
            self.audio_profile = previous.audio_profile.clone();
        }
        if self.segments.is_none() && !self.job_failed("segments") {
            self.segments = previous.segments.clone();
        }

        // Everything below addresses shots by position, so it may only be
        // restored once the shot list itself is settled: an older reading of
        // shot 3 describes this bundle's shot 3 only when both bundles cut the
        // source the same way.
        if !shot_boundaries_match(self.shots.as_deref(), previous.shots.as_deref()) {
            return;
        }
        if self.frame_analysis.is_none() && !self.job_failed("visual") {
            self.frame_analysis = previous.frame_analysis.clone();
        }
        if self.frame_observations.is_none() && !self.job_failed("visual") {
            self.frame_observations = previous.frame_observations.clone();
        }
        if self.contact_sheet.is_none() && !self.job_failed("contact_sheet") {
            self.contact_sheet = previous.contact_sheet.clone();
        }
    }

    /// Replaces the shot list, dropping results the new cuts orphan.
    ///
    /// [`Self::frame_analysis`], [`Self::frame_observations`] and
    /// [`Self::contact_sheet`] address shots by position, so a different cut
    /// list invalidates them: keeping them would let `analysis report` attach
    /// one shot's visual reading to a different shot. They are dropped whenever
    /// the boundaries change and kept when a re-detection reproduces them.
    ///
    /// Keyframe thumbnails travel the other way. A caller that detects
    /// boundaries without extracting keyframes (`analysis shots`) supplies
    /// shots with no `keyframe_path`, so the path already recorded for an
    /// identical boundary is carried forward rather than nulled out. That is
    /// sound because the file a path names still holds the frame cut from those
    /// boundaries: keyframe extraction re-cuts any file whose shot moved rather
    /// than leaving one shot's frame under another's index.
    pub fn replace_shots(&mut self, shots: Vec<ShotResult>) {
        let mut shots = shots;
        let Some(previous) = self.shots.take() else {
            self.shots = Some(shots);
            return;
        };

        for shot in shots.iter_mut() {
            if shot.keyframe_path.is_some() {
                continue;
            }
            let Some(matching) = previous
                .iter()
                .find(|candidate| same_shot_boundary(candidate, shot))
            else {
                continue;
            };
            shot.keyframe_path = matching.keyframe_path.clone();
            shot.keyframe_selection_method = matching.keyframe_selection_method.clone();
        }

        if !shot_boundaries_match(Some(&shots), Some(&previous)) {
            self.frame_analysis = None;
            self.frame_observations = None;
            self.contact_sheet = None;
        }

        self.shots = Some(shots);
    }

    /// Returns whether this bundle's cut list is still `shots`.
    ///
    /// Frame analysis, frame observations and the contact sheet address shots by
    /// position, so a result computed against one cut list only describes this
    /// bundle while it stores that same list. A producer that worked from a copy
    /// of the bundle — a provider call that runs outside the bundle lock, for
    /// instance — must check this before publishing position-indexed results
    /// back, or a re-detection that landed in the meantime would attach one
    /// shot's reading to another.
    pub fn has_shot_boundaries(&self, shots: Option<&[ShotResult]>) -> bool {
        shot_boundaries_match(self.shots.as_deref(), shots)
    }

    /// Returns whether this bundle recorded a failure for `analysis_type`.
    ///
    /// Keys match the ones the analysis pipeline passes to [`Self::add_error`]:
    /// `shots`, `audio`, `transcript`, `segments`, `visual`, `contact_sheet`.
    fn job_failed(&self, analysis_type: &str) -> bool {
        self.errors.contains_key(analysis_type)
    }
}

/// Tolerance used when deciding whether two shot lists describe the same cuts.
///
/// Boundaries come from FFmpeg timestamps that round-trip through JSON, so an
/// exact float comparison would report a change that never happened.
const SHOT_BOUNDARY_EPSILON_SEC: f64 = 0.001;

/// Returns whether two shots cover the same span of the source.
fn same_shot_boundary(left: &ShotResult, right: &ShotResult) -> bool {
    (left.start_sec - right.start_sec).abs() <= SHOT_BOUNDARY_EPSILON_SEC
        && (left.end_sec - right.end_sec).abs() <= SHOT_BOUNDARY_EPSILON_SEC
}

/// Returns whether two shot lists describe the same cuts.
///
/// Only boundaries are compared: results indexed by shot position stay valid
/// when a re-detection reproduces the same cut list, even if confidence scores
/// or keyframe paths differ. Two absent lists match — neither indexes anything.
fn shot_boundaries_match(left: Option<&[ShotResult]>, right: Option<&[ShotResult]>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same_shot_boundary(left, right))
        }
        (None, None) => true,
        _ => false,
    }
}

fn current_analysis_schema_version() -> u32 {
    2
}

fn legacy_analysis_schema_version() -> u32 {
    1
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
            speech_regions: vec![SpeechRegion::new(0.0, 5.0), SpeechRegion::new(6.5, 10.0)],
            ..Default::default()
        };

        let json = serde_json::to_string(&profile).unwrap();
        assert!(json.contains("\"spectralCentroidHz\":2500.0"));
        assert!(json.contains("\"loudnessProfile\""));
        assert!(json.contains("\"peakDb\":-0.5"));
        assert!(json.contains("\"silenceRegions\""));
    }

    /// Feature: audio profile measurement versioning
    /// Scenario: a bundle cached before the loudness fix is loaded
    ///   Given a bundle whose audio profile predates the current measurement
    ///   When the bundle is normalised on load
    ///   Then the stale profile is dropped so the next run recomputes it,
    ///   while every other slot the bundle paid for survives
    #[test]
    fn should_drop_an_audio_profile_measured_by_a_superseded_pass() {
        let mut bundle = AnalysisBundle::new("asset_1", VideoMetadata::new(10.0));
        bundle.transcript = Some(Vec::new());
        bundle.audio_profile = Some(AudioProfile {
            measurement_version: AUDIO_MEASUREMENT_VERSION - 1,
            peak_db: SILENCE_FLOOR_DB,
            ..Default::default()
        });

        assert!(bundle.drop_outdated_audio_profile());
        assert!(bundle.audio_profile.is_none());
        assert!(
            bundle.transcript.is_some(),
            "only the audio profile is stale; the rest of the bundle must survive"
        );
    }

    /// Feature: audio profile measurement versioning
    /// Scenario: a bundle carries a profile from the current measurement
    ///   Given an audio profile stamped with the current version
    ///   When the bundle is normalised on load
    ///   Then the profile is kept, so a good measurement is not thrown away
    #[test]
    fn should_keep_an_audio_profile_measured_by_the_current_pass() {
        let mut bundle = AnalysisBundle::new("asset_1", VideoMetadata::new(10.0));
        bundle.audio_profile = Some(AudioProfile::silent(10.0));

        assert!(!bundle.drop_outdated_audio_profile());
        assert!(bundle.audio_profile.is_some());
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
        assert_eq!(bundle.schema_version, 2);
        assert!(bundle.shots.is_none());
        assert!(bundle.transcript.is_none());
        assert!(bundle.transcript_detail.is_none());
        assert!(bundle.audio_profile.is_none());
        assert!(bundle.segments.is_none());
        assert!(bundle.frame_analysis.is_none());
        assert!(bundle.frame_observations.is_none());
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
    fn should_restore_missing_slots_when_backfilling_a_partial_bundle() {
        let mut previous = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        previous.audio_profile = Some(AudioProfile::silent(60.0));
        previous.shots = Some(vec![ShotResult::new(0.0, 60.0, 1.0)]);

        let mut partial = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        partial.shots = Some(vec![
            ShotResult::new(0.0, 30.0, 0.9),
            ShotResult::new(30.0, 60.0, 0.9),
        ]);

        partial.backfill_missing_from(&previous);

        // Fresh results win, untouched slots are restored.
        assert_eq!(partial.shots.as_ref().unwrap().len(), 2);
        assert!(partial.audio_profile.is_some());
    }

    #[test]
    fn should_not_backfill_a_slot_whose_sub_job_failed_in_the_fresh_run() {
        let mut previous = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        previous.audio_profile = Some(AudioProfile::silent(60.0));
        previous.shots = Some(vec![ShotResult::new(0.0, 60.0, 1.0)]);

        // The fresh run asked for both jobs; audio failed, shots was not run.
        let mut fresh = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        fresh.add_error("audio", "Audio analysis failed (exit 1)".to_string());

        fresh.backfill_missing_from(&previous);

        assert!(
            fresh.audio_profile.is_none(),
            "a failed sub-job must not republish the previous result as current"
        );
        assert!(
            fresh.shots.is_some(),
            "slots that simply were not run are still restored"
        );
    }

    #[test]
    fn should_not_backfill_visual_slots_when_visual_analysis_failed() {
        let mut previous = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        previous.frame_analysis = Some(vec![FrameAnalysis::local_fallback(0, 0.5)]);
        previous.frame_observations = Some(Vec::new());

        let mut fresh = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        fresh.add_error("visual", "Vision API timeout".to_string());

        fresh.backfill_missing_from(&previous);

        assert!(fresh.frame_analysis.is_none());
        assert!(fresh.frame_observations.is_none());
    }

    #[test]
    fn should_not_backfill_shot_indexed_slots_when_the_cut_list_changed() {
        let mut previous = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        previous.shots = Some(vec![ShotResult::new(0.0, 60.0, 1.0)]);
        previous.frame_analysis = Some(vec![FrameAnalysis::local_fallback(0, 0.5)]);
        previous.frame_observations = Some(Vec::new());
        previous.contact_sheet = Some(ContactSheetArtifact {
            path: "sheet.jpg".to_string(),
            frame_count: 1,
            columns: 1,
            rows: 1,
        });

        let mut fresh = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        fresh.shots = Some(vec![
            ShotResult::new(0.0, 30.0, 0.9),
            ShotResult::new(30.0, 60.0, 0.9),
        ]);

        fresh.backfill_missing_from(&previous);

        assert!(
            fresh.frame_analysis.is_none(),
            "frame analysis indexes shots by position and must not survive new cuts"
        );
        assert!(fresh.frame_observations.is_none());
        assert!(
            fresh.contact_sheet.is_none(),
            "the contact sheet renders the previous keyframes and is stale after new cuts"
        );
    }

    #[test]
    fn should_backfill_shot_indexed_slots_when_the_cut_list_is_reproduced() {
        let mut previous = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        previous.shots = Some(vec![ShotResult::new(0.0, 60.0, 1.0)]);
        previous.frame_analysis = Some(vec![FrameAnalysis::local_fallback(0, 0.5)]);

        let mut fresh = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        // Same cuts, different confidence: the readings still describe shot 0.
        fresh.shots = Some(vec![ShotResult::new(0.0, 60.0, 0.75)]);

        fresh.backfill_missing_from(&previous);

        assert!(fresh.frame_analysis.is_some());
    }

    #[test]
    fn should_drop_shot_indexed_slots_when_replacing_shots_with_different_cuts() {
        let mut bundle = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        bundle.shots = Some(vec![ShotResult::new(0.0, 60.0, 1.0)]);
        bundle.frame_analysis = Some(vec![FrameAnalysis::local_fallback(0, 0.5)]);
        bundle.frame_observations = Some(Vec::new());
        bundle.contact_sheet = Some(ContactSheetArtifact {
            path: "sheet.jpg".to_string(),
            frame_count: 1,
            columns: 1,
            rows: 1,
        });

        bundle.replace_shots(vec![
            ShotResult::new(0.0, 20.0, 0.9),
            ShotResult::new(20.0, 60.0, 0.9),
        ]);

        assert_eq!(bundle.shots.as_ref().unwrap().len(), 2);
        assert!(bundle.frame_analysis.is_none());
        assert!(bundle.frame_observations.is_none());
        assert!(bundle.contact_sheet.is_none());
    }

    #[test]
    fn should_carry_keyframes_forward_when_replacing_shots_with_the_same_cuts() {
        let mut bundle = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        bundle.shots = Some(vec![ShotResult::new(0.0, 60.0, 1.0)
            .with_keyframe("keyframes/shot_000.jpg")
            .with_keyframe_selection_method(
                crate::core::annotations::models::KeyframeSelectionMethod::Thumbnail,
            )]);
        bundle.contact_sheet = Some(ContactSheetArtifact {
            path: "sheet.jpg".to_string(),
            frame_count: 1,
            columns: 1,
            rows: 1,
        });

        // `analysis shots` re-detects boundaries without extracting keyframes.
        bundle.replace_shots(vec![ShotResult::new(0.0, 60.0, 0.9)]);

        let shots = bundle.shots.as_ref().unwrap();
        assert_eq!(
            shots[0].keyframe_path.as_deref(),
            Some("keyframes/shot_000.jpg"),
            "a keyframe-less re-detection must not erase existing thumbnails"
        );
        assert_eq!(
            shots[0].keyframe_selection_method,
            Some(crate::core::annotations::models::KeyframeSelectionMethod::Thumbnail)
        );
        assert!(
            bundle.contact_sheet.is_some(),
            "unchanged cuts keep the sheet that renders them"
        );
    }

    #[test]
    fn should_prefer_freshly_extracted_keyframes_over_the_cached_ones() {
        let mut bundle = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        bundle.shots = Some(vec![
            ShotResult::new(0.0, 60.0, 1.0).with_keyframe("old.jpg")
        ]);

        bundle.replace_shots(vec![
            ShotResult::new(0.0, 60.0, 0.9).with_keyframe("new.jpg")
        ]);

        assert_eq!(
            bundle.shots.as_ref().unwrap()[0].keyframe_path.as_deref(),
            Some("new.jpg")
        );
    }

    #[test]
    fn should_not_backfill_errors_or_metadata_from_a_previous_bundle() {
        let mut previous = AnalysisBundle::new("asset_001", VideoMetadata::new(60.0));
        previous.add_error("audio", "FFmpeg missing".to_string());

        let mut fresh = AnalysisBundle::new("asset_001", VideoMetadata::new(90.0));
        fresh.backfill_missing_from(&previous);

        assert!(fresh.errors.is_empty());
        assert_eq!(fresh.metadata.duration_sec, 90.0);
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
            speech_regions: vec![SpeechRegion::new(0.0, 10.0), SpeechRegion::new(11.5, 12.0)],
            ..Default::default()
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
        bundle.contact_sheet = Some(ContactSheetArtifact {
            path: "/tmp/contact-sheet.jpg".to_string(),
            frame_count: 2,
            columns: 2,
            rows: 1,
        });
        bundle.frame_observations = Some(vec![FrameObservation {
            shot_index: 0,
            time_sec: 2.5,
            image_path: "/tmp/keyframes/0.jpg".to_string(),
            description: "A host is speaking to camera in a studio.".to_string(),
            subjects: vec!["host".to_string()],
            actions: vec!["speaking".to_string()],
            setting: Some("studio".to_string()),
            visible_text: vec!["OPENREELIO".to_string()],
            objects: vec!["microphone".to_string()],
            edit_usefulness: Some("Strong opener or explanation beat.".to_string()),
            confidence: 0.86,
            provider: PerceptionProviderMetadata::new("openai", "gpt-4.1-mini"),
        }]);
        bundle.transcript_detail = Some(TranscriptDetail {
            full: "Hello from the studio".to_string(),
            words: crate::core::annotations::models::estimate_word_timings(&[
                TranscriptSegment::new(0.0, 2.0, "Hello from the studio", 0.9),
            ]),
            speaker_segments: vec![SpeakerSegment {
                start_sec: 0.0,
                end_sec: 2.0,
                speaker_id: "speaker_1".to_string(),
                text: "Hello from the studio".to_string(),
                confidence: Some(0.9),
            }],
            provider: Some(PerceptionProviderMetadata::new(
                "openai",
                "gpt-4o-transcribe-diarize",
            )),
        });

        let json = serde_json::to_string_pretty(&bundle).unwrap();
        let parsed: AnalysisBundle = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.asset_id, "asset_001");
        assert_eq!(parsed.schema_version, 2);
        assert_eq!(parsed.shots.as_ref().unwrap().len(), 2);
        assert_eq!(parsed.audio_profile.as_ref().unwrap().bpm, Some(128.0));
        assert_eq!(parsed.segments.as_ref().unwrap().len(), 2);
        assert_eq!(parsed.frame_analysis.as_ref().unwrap().len(), 2);
        assert_eq!(parsed.frame_observations.as_ref().unwrap().len(), 1);
        assert_eq!(
            parsed.transcript_detail.as_ref().unwrap().speaker_segments[0].speaker_id,
            "speaker_1"
        );
        assert_eq!(parsed.contact_sheet.as_ref().unwrap().frame_count, 2);
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
        assert!(json.contains("\"frameObservations\":null"));
        assert!(json.contains("\"transcriptDetail\":null"));
        assert!(json.contains("\"contactSheet\":null"));
        assert!(json.contains("\"errors\":{}"));

        let parsed: AnalysisBundle = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.asset_id, "asset_002");
        assert!(parsed.shots.is_none());
        assert!(parsed.audio_profile.is_none());
        assert!(parsed.segments.is_none());
        assert!(parsed.frame_analysis.is_none());
        assert!(parsed.frame_observations.is_none());
        assert!(parsed.transcript_detail.is_none());
        assert!(parsed.contact_sheet.is_none());
    }

    #[test]
    fn should_read_legacy_bundle_without_v2_fields() {
        let json = r#"{
            "assetId": "asset_legacy",
            "shots": null,
            "transcript": null,
            "audioProfile": null,
            "segments": null,
            "frameAnalysis": null,
            "contactSheet": null,
            "metadata": { "durationSec": 10.0, "hasAudio": true },
            "errors": {},
            "analyzedAt": "2026-03-07T00:00:00Z"
        }"#;

        let parsed: AnalysisBundle = serde_json::from_str(json).unwrap();

        assert_eq!(parsed.schema_version, 1);
        assert!(parsed.frame_observations.is_none());
        assert!(parsed.transcript_detail.is_none());
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

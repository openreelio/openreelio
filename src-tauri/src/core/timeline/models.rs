//! Timeline Model Definitions
//!
//! Defines Sequence, Track, Clip and related types for timeline management.
//! Uses denormalized structure for efficient Event Sourcing operations.

use serde::{Deserialize, Serialize};
use specta::Type;
use tracing::warn;

use crate::core::{AssetId, ClipId, Color, EffectId, Point2D, Ratio, SequenceId, TimeSec, TrackId};

// =============================================================================
// Sequence Format
// =============================================================================

/// Sequence format specification
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SequenceFormat {
    /// Canvas size
    pub canvas: Canvas,
    /// Frame rate
    pub fps: Ratio,
    /// Audio sample rate in Hz
    pub audio_sample_rate: u32,
    /// Number of audio channels
    pub audio_channels: u8,
}

impl SequenceFormat {
    /// Creates a format from raw parameters
    pub fn new(
        width: u32,
        height: u32,
        fps_num: i32,
        fps_den: i32,
        audio_sample_rate: u32,
    ) -> Self {
        let canvas = if width == 0 || height == 0 {
            warn!(
                "SequenceFormat created with invalid dimensions {}x{}, defaulting to 1920x1080",
                width, height
            );
            Canvas::new(1920, 1080)
        } else {
            Canvas::new(width, height)
        };

        // Ratio::new now handles zero denominator
        let fps = Ratio::new(fps_num, fps_den);

        Self {
            canvas,
            fps,
            audio_sample_rate,
            audio_channels: 2,
        }
    }

    /// Creates a format for YouTube Shorts (1080x1920, 30fps)
    pub fn shorts_1080() -> Self {
        Self {
            canvas: Canvas::new(1080, 1920),
            fps: Ratio::new(30, 1),
            audio_sample_rate: 48000,
            audio_channels: 2,
        }
    }

    /// Creates a format for YouTube landscape (1920x1080, 30fps)
    pub fn youtube_1080() -> Self {
        Self {
            canvas: Canvas::new(1920, 1080),
            fps: Ratio::new(30, 1),
            audio_sample_rate: 48000,
            audio_channels: 2,
        }
    }

    /// Creates a format for 4K video (3840x2160, 30fps)
    pub fn uhd_4k() -> Self {
        Self {
            canvas: Canvas::new(3840, 2160),
            fps: Ratio::new(30, 1),
            audio_sample_rate: 48000,
            audio_channels: 2,
        }
    }

    /// Creates a format for YouTube Shorts (alias)
    pub fn youtube_shorts() -> Self {
        Self::shorts_1080()
    }

    /// Creates a format for YouTube 4K (alias)
    pub fn youtube_4k() -> Self {
        Self::uhd_4k()
    }
}

impl Default for SequenceFormat {
    fn default() -> Self {
        Self::shorts_1080()
    }
}

/// Canvas size
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
}

impl Canvas {
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// Returns the aspect ratio as a float.
    /// Returns 0.0 if height is zero to prevent division by zero.
    pub fn aspect_ratio(&self) -> f64 {
        if self.height == 0 {
            return 0.0;
        }
        self.width as f64 / self.height as f64
    }

    /// Returns true if dimensions are valid (non-zero width and height)
    pub fn is_valid(&self) -> bool {
        self.width > 0 && self.height > 0
    }
}

// =============================================================================
// Marker
// =============================================================================

/// Marker type enumeration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MarkerType {
    Generic,
    Chapter,
    Hook,
    Cta,
    Todo,
}

/// Timeline marker
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub time_sec: TimeSec,
    pub label: String,
    pub color: Color,
    pub marker_type: MarkerType,
}

impl Marker {
    pub fn new(time_sec: TimeSec, label: &str) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            time_sec,
            label: label.to_string(),
            color: Color::rgb(1.0, 0.8, 0.0), // Yellow
            marker_type: MarkerType::Generic,
        }
    }
}

// =============================================================================
// Sequence
// =============================================================================

/// Sequence (timeline container)
/// Uses denormalized structure - tracks are stored directly, not as IDs
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub id: SequenceId,
    pub name: String,
    pub format: SequenceFormat,
    /// Tracks stored directly for efficient Event Sourcing
    pub tracks: Vec<Track>,
    pub markers: Vec<Marker>,
    /// Master output volume in dB (-60.0 to +6.0, 0.0 = unity gain)
    #[serde(default)]
    pub master_volume_db: f32,
    pub created_at: String,
    pub modified_at: String,
}

impl Sequence {
    /// Creates a new sequence with the given name and format
    pub fn new(name: &str, format: SequenceFormat) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: ulid::Ulid::new().to_string(),
            name: name.to_string(),
            format,
            tracks: vec![],
            markers: vec![],
            master_volume_db: 0.0,
            created_at: now.clone(),
            modified_at: now,
        }
    }

    /// Adds a track to the sequence
    pub fn add_track(&mut self, track: Track) {
        self.tracks.push(track);
        self.modified_at = chrono::Utc::now().to_rfc3339();
    }

    /// Removes a track by ID
    pub fn remove_track(&mut self, track_id: &TrackId) -> bool {
        if let Some(pos) = self.tracks.iter().position(|t| &t.id == track_id) {
            self.tracks.remove(pos);
            self.modified_at = chrono::Utc::now().to_rfc3339();
            true
        } else {
            false
        }
    }

    /// Gets a track by ID
    pub fn get_track(&self, track_id: &str) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == track_id)
    }

    /// Gets a mutable track by ID
    pub fn get_track_mut(&mut self, track_id: &str) -> Option<&mut Track> {
        self.tracks.iter_mut().find(|t| t.id == track_id)
    }

    /// Adds a marker to the sequence
    pub fn add_marker(&mut self, marker: Marker) {
        self.markers.push(marker);
        self.modified_at = chrono::Utc::now().to_rfc3339();
    }

    /// Removes a marker by ID and returns it if found
    pub fn remove_marker(&mut self, marker_id: &str) -> Option<Marker> {
        if let Some(pos) = self.markers.iter().position(|m| m.id == marker_id) {
            self.modified_at = chrono::Utc::now().to_rfc3339();
            Some(self.markers.remove(pos))
        } else {
            None
        }
    }

    /// Gets a marker by ID
    pub fn get_marker(&self, marker_id: &str) -> Option<&Marker> {
        self.markers.iter().find(|m| m.id == marker_id)
    }

    /// Calculates the total duration of the sequence
    pub fn duration(&self) -> TimeSec {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(|c| c.place.timeline_out_sec())
            .fold(0.0, f64::max)
    }

    // -------------------------------------------------------------------------
    // Edit Point & Marker Navigation (S27-002)
    // -------------------------------------------------------------------------

    /// Epsilon tolerance for floating-point time comparisons (1 microsecond).
    const TIME_EPSILON: f64 = 1e-6;

    /// Collects all edit points (clip boundaries) across all tracks.
    ///
    /// Edit points include timeline start (0.0) and every clip in/out boundary.
    /// Returns a sorted, deduplicated vector.
    ///
    /// Note: boundaries of **all** clips are included regardless of their
    /// `enabled` state. This matches NLE convention where disabled clips
    /// remain navigable so the editor can quickly re-enable them.
    pub fn collect_edit_points(&self) -> Vec<f64> {
        let mut points = Vec::new();
        for track in &self.tracks {
            for clip in &track.clips {
                points.push(clip.place.timeline_in_sec);
                points.push(clip.place.timeline_out_sec());
            }
        }
        points.push(0.0);
        points.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        points.dedup_by(|a, b| (*a - *b).abs() < Self::TIME_EPSILON);
        points
    }

    /// Collects sorted marker times.
    pub fn collect_marker_times(&self) -> Vec<f64> {
        let mut times: Vec<f64> = self.markers.iter().map(|m| m.time_sec).collect();
        times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        times
    }

    /// Finds the next edit point (clip boundary) strictly after `current_time`.
    ///
    /// Searches across all tracks. Returns `None` if at or past the last edit point.
    /// Includes disabled clips (see [`collect_edit_points`](Self::collect_edit_points)).
    pub fn next_edit_point(&self, current_time: f64) -> Option<f64> {
        self.collect_edit_points()
            .into_iter()
            .find(|&p| p > current_time + Self::TIME_EPSILON)
    }

    /// Finds the previous edit point (clip boundary) strictly before `current_time`.
    ///
    /// Searches across all tracks. Returns `None` if at or before the first edit point.
    /// Includes disabled clips (see [`collect_edit_points`](Self::collect_edit_points)).
    pub fn prev_edit_point(&self, current_time: f64) -> Option<f64> {
        self.collect_edit_points()
            .into_iter()
            .rev()
            .find(|&p| p < current_time - Self::TIME_EPSILON)
    }

    /// Finds the next marker position strictly after `current_time`.
    ///
    /// Returns `None` if there are no markers after the current position.
    pub fn next_marker(&self, current_time: f64) -> Option<f64> {
        self.collect_marker_times()
            .into_iter()
            .find(|&t| t > current_time + Self::TIME_EPSILON)
    }

    /// Finds the previous marker position strictly before `current_time`.
    ///
    /// Returns `None` if there are no markers before the current position.
    pub fn prev_marker(&self, current_time: f64) -> Option<f64> {
        self.collect_marker_times()
            .into_iter()
            .rev()
            .find(|&t| t < current_time - Self::TIME_EPSILON)
    }
}

// =============================================================================
// Track
// =============================================================================

/// Track type/kind enumeration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
    Caption,
    Overlay,
}

/// Blend mode for video tracks and clips
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Add,
    Subtract,
    Darken,
    Lighten,
    ColorBurn,
    ColorDodge,
    LinearBurn,
    LinearDodge,
    SoftLight,
    HardLight,
    VividLight,
    LinearLight,
    PinLight,
    Difference,
    Exclusion,
}

/// Track (contains clips directly for denormalized storage)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: TrackId,
    pub kind: TrackKind,
    pub name: String,
    /// Clips stored directly for efficient Event Sourcing
    pub clips: Vec<Clip>,
    pub blend_mode: BlendMode,
    /// Present for modern projects; true only for protected default timeline tracks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_base_track: Option<bool>,
    pub muted: bool,
    pub locked: bool,
    pub visible: bool,
    /// When true, this track shifts in sync during insert/ripple edits on other tracks.
    #[serde(default)]
    pub sync_lock: bool,
    /// Volume for audio tracks (0.0 - 2.0, 1.0 = 100%)
    pub volume: f32,
}

impl Track {
    /// Creates a new track with the given name and kind
    pub fn new(name: &str, kind: TrackKind) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            kind,
            name: name.to_string(),
            clips: vec![],
            blend_mode: BlendMode::Normal,
            is_base_track: Some(false),
            muted: false,
            locked: false,
            visible: true,
            sync_lock: false,
            volume: 1.0,
        }
    }

    /// Marks whether this track is a protected default/base track.
    pub fn with_base_track(mut self, is_base_track: bool) -> Self {
        self.is_base_track = Some(is_base_track);
        self
    }

    /// Creates a new video track
    pub fn new_video(name: &str) -> Self {
        Self::new(name, TrackKind::Video)
    }

    /// Creates a new audio track
    pub fn new_audio(name: &str) -> Self {
        Self::new(name, TrackKind::Audio)
    }

    /// Creates a new caption track
    pub fn new_caption(name: &str) -> Self {
        Self::new(name, TrackKind::Caption)
    }

    /// Adds a clip to the track
    pub fn add_clip(&mut self, clip: Clip) {
        self.clips.push(clip);
    }

    /// Removes a clip by ID
    pub fn remove_clip(&mut self, clip_id: &ClipId) -> Option<Clip> {
        if let Some(pos) = self.clips.iter().position(|c| &c.id == clip_id) {
            Some(self.clips.remove(pos))
        } else {
            None
        }
    }

    /// Gets a clip by ID
    pub fn get_clip(&self, clip_id: &str) -> Option<&Clip> {
        self.clips.iter().find(|c| c.id == clip_id)
    }

    /// Gets a mutable clip by ID
    pub fn get_clip_mut(&mut self, clip_id: &str) -> Option<&mut Clip> {
        self.clips.iter_mut().find(|c| c.id == clip_id)
    }

    /// Returns true if this is a video track
    pub fn is_video(&self) -> bool {
        matches!(self.kind, TrackKind::Video | TrackKind::Overlay)
    }

    /// Returns true if this is an audio track
    pub fn is_audio(&self) -> bool {
        matches!(self.kind, TrackKind::Audio)
    }

    /// Returns true if this is a caption track
    pub fn is_caption(&self) -> bool {
        matches!(self.kind, TrackKind::Caption)
    }
}

// =============================================================================
// Clip Range and Placement
// =============================================================================

/// Clip range within source asset
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipRange {
    /// Start time within source (seconds)
    pub source_in_sec: TimeSec,
    /// End time within source (seconds)
    pub source_out_sec: TimeSec,
}

impl ClipRange {
    pub fn new(source_in: TimeSec, source_out: TimeSec) -> Self {
        Self {
            source_in_sec: source_in,
            source_out_sec: source_out,
        }
    }

    /// Returns the duration of the range
    pub fn duration(&self) -> TimeSec {
        self.source_out_sec - self.source_in_sec
    }
}

impl Default for ClipRange {
    fn default() -> Self {
        Self::new(0.0, 0.0)
    }
}

/// Clip placement on timeline
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPlace {
    /// Start time on timeline (seconds)
    pub timeline_in_sec: TimeSec,
    /// Duration on timeline (seconds) - may differ from source due to speed
    pub duration_sec: TimeSec,
}

impl ClipPlace {
    pub fn new(timeline_in: TimeSec, duration: TimeSec) -> Self {
        let duration_sec = if duration < 0.0 {
            warn!(
                "ClipPlace created with negative duration {}, clamping to 0.0",
                duration
            );
            0.0
        } else {
            duration
        };

        Self {
            timeline_in_sec: timeline_in,
            duration_sec,
        }
    }

    /// Returns the end time on timeline
    pub fn timeline_out_sec(&self) -> TimeSec {
        self.timeline_in_sec + self.duration_sec
    }

    /// Checks if this placement overlaps with another
    pub fn overlaps(&self, other: &ClipPlace) -> bool {
        self.timeline_in_sec < other.timeline_out_sec()
            && self.timeline_out_sec() > other.timeline_in_sec
    }

    /// Checks if a time point is within this placement.
    /// Uses half-open interval [start, end) semantics - includes start, excludes end.
    /// For inclusive end checking, use `contains_inclusive()`.
    pub fn contains(&self, time_sec: TimeSec) -> bool {
        time_sec >= self.timeline_in_sec && time_sec < self.timeline_out_sec()
    }

    /// Checks if a time point is within this placement (inclusive end).
    /// Uses closed interval [start, end] semantics.
    pub fn contains_inclusive(&self, time_sec: TimeSec) -> bool {
        time_sec >= self.timeline_in_sec && time_sec <= self.timeline_out_sec()
    }
}

impl Default for ClipPlace {
    fn default() -> Self {
        Self::new(0.0, 0.0)
    }
}

// =============================================================================
// Transform
// =============================================================================

/// 2D Transform for clips
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    /// Position (normalized 0.0-1.0, center = 0.5, 0.5)
    pub position: Point2D,
    /// Scale (1.0 = 100%)
    pub scale: Point2D,
    /// Rotation in degrees
    pub rotation_deg: f64,
    /// Anchor point (normalized 0.0-1.0)
    pub anchor: Point2D,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            position: Point2D::center(),
            scale: Point2D::new(1.0, 1.0),
            rotation_deg: 0.0,
            anchor: Point2D::center(),
        }
    }
}

// =============================================================================
// Audio Settings
// =============================================================================

/// Audio fade curve type for fade-in and fade-out effects.
/// Each type produces a distinct gain curve shape.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FadeType {
    /// Linear ramp (straight line)
    #[default]
    Linear,
    /// Constant gain crossfade (linear amplitude)
    ConstantGain,
    /// Constant power crossfade (equal energy, smooth)
    ConstantPower,
    /// Exponential curve (slow start, fast end for fade-in)
    Exponential,
    /// S-curve (smooth start and end)
    SCurve,
}

impl FadeType {
    /// Returns the FFmpeg afade type string for this fade type.
    pub fn to_ffmpeg_type(&self) -> &'static str {
        match self {
            FadeType::Linear => "tri",
            FadeType::ConstantGain => "tri",
            FadeType::ConstantPower => "qsin",
            FadeType::Exponential => "exp",
            FadeType::SCurve => "cub",
        }
    }
}

/// Audio settings for clips
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    /// Volume in dB (-60 to +6)
    pub volume_db: f32,
    /// Pan (-1.0 left, 0.0 center, 1.0 right)
    pub pan: f32,
    /// Whether audio is muted
    pub muted: bool,
    /// Fade-in duration in timeline seconds
    #[serde(default)]
    pub fade_in_sec: TimeSec,
    /// Fade-out duration in timeline seconds
    #[serde(default)]
    pub fade_out_sec: TimeSec,
    /// Fade-in curve type
    #[serde(default)]
    pub fade_in_type: FadeType,
    /// Fade-out curve type
    #[serde(default)]
    pub fade_out_type: FadeType,
    /// Volume automation keyframes (overrides flat volume_db when non-empty).
    /// Sorted by time_offset. Values in dB, times relative to clip start.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub volume_keyframes: Vec<AudioKeyframe>,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            volume_db: 0.0,
            pan: 0.0,
            muted: false,
            fade_in_sec: 0.0,
            fade_out_sec: 0.0,
            fade_in_type: FadeType::default(),
            fade_out_type: FadeType::default(),
            volume_keyframes: Vec::new(),
        }
    }
}

impl AudioSettings {
    /// Returns true when volume automation keyframes are active.
    pub fn has_volume_automation(&self) -> bool {
        self.volume_keyframes.len() >= 2
    }

    /// Evaluates the volume at a given time offset (seconds from clip start).
    /// Returns volume in dB. Falls back to flat `volume_db` when no keyframes.
    pub fn evaluate_volume_at(&self, time_offset: f64) -> f64 {
        if !self.has_volume_automation() {
            return self.volume_db as f64;
        }
        AudioKeyframe::interpolate(&self.volume_keyframes, time_offset)
    }
}

// =============================================================================
// Time Remapping (Variable Speed Keyframes)
// =============================================================================

/// Interpolation method for time remap keyframes.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum KeyframeInterpolation {
    /// Constant speed between keyframes (linear source-time mapping)
    #[default]
    Linear,
    /// Smooth ease via cubic bezier (control points define the curve shape)
    Bezier {
        /// Control point 1 x (0.0-1.0, normalized within the keyframe segment)
        cp1x: f64,
        /// Control point 1 y (0.0-1.0, normalized within source-time range)
        cp1y: f64,
        /// Control point 2 x (0.0-1.0)
        cp2x: f64,
        /// Control point 2 y (0.0-1.0)
        cp2y: f64,
    },
    /// Hold at the current source time until the next keyframe
    Hold,
}

/// A single keyframe in a time remap curve.
///
/// Maps a timeline position to a source position: "at `timeline_time` seconds
/// into the clip, show the frame from `source_time` seconds in the source."
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimeRemapKeyframe {
    /// Position on the timeline (seconds from clip start, 0-based)
    pub timeline_time: f64,
    /// Corresponding position in the source media (seconds)
    pub source_time: f64,
    /// How to interpolate to the next keyframe
    #[serde(default)]
    pub interpolation: KeyframeInterpolation,
}

/// A complete time remap curve for variable-speed playback.
///
/// When active on a clip, this replaces the constant `speed` field.
/// The curve defines a mapping from timeline time to source time via keyframes.
/// Between keyframes, interpolation determines how source time progresses.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimeRemapCurve {
    /// Ordered keyframes (must be sorted by `timeline_time`)
    pub keyframes: Vec<TimeRemapKeyframe>,
}

impl TimeRemapCurve {
    /// Creates a new time remap curve from keyframes.
    /// Keyframes are sorted by timeline_time on creation.
    pub fn new(mut keyframes: Vec<TimeRemapKeyframe>) -> Self {
        keyframes.sort_by(|a, b| {
            a.timeline_time
                .partial_cmp(&b.timeline_time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Self { keyframes }
    }

    /// Returns true if the curve has at least 2 keyframes (minimum for a ramp).
    pub fn is_valid(&self) -> bool {
        self.keyframes.len() >= 2
    }

    /// Evaluates the curve at a given timeline time (seconds from clip start).
    /// Returns the corresponding source time.
    pub fn evaluate(&self, timeline_time: f64) -> f64 {
        if self.keyframes.is_empty() {
            return timeline_time;
        }

        // Before first keyframe: extrapolate from first keyframe
        if timeline_time <= self.keyframes[0].timeline_time {
            return self.keyframes[0].source_time;
        }

        // After last keyframe: extrapolate from last keyframe
        let last = &self.keyframes[self.keyframes.len() - 1];
        if timeline_time >= last.timeline_time {
            return last.source_time;
        }

        // Find the segment containing timeline_time
        for i in 0..self.keyframes.len() - 1 {
            let kf0 = &self.keyframes[i];
            let kf1 = &self.keyframes[i + 1];

            if timeline_time >= kf0.timeline_time && timeline_time < kf1.timeline_time {
                let segment_duration = kf1.timeline_time - kf0.timeline_time;
                if segment_duration <= 0.0 {
                    return kf0.source_time;
                }

                let t = (timeline_time - kf0.timeline_time) / segment_duration;

                return match &kf0.interpolation {
                    KeyframeInterpolation::Linear => {
                        kf0.source_time + t * (kf1.source_time - kf0.source_time)
                    }
                    KeyframeInterpolation::Bezier {
                        cp1x,
                        cp1y,
                        cp2x,
                        cp2y,
                    } => {
                        let bezier_t = cubic_bezier_t(*cp1x, *cp2x, t);
                        let source_range = kf1.source_time - kf0.source_time;
                        let y = cubic_bezier_y(*cp1y, *cp2y, bezier_t);
                        kf0.source_time + y * source_range
                    }
                    KeyframeInterpolation::Hold => kf0.source_time,
                };
            }
        }

        // Fallback (should not reach here)
        last.source_time
    }

    /// Computes the total source duration covered by this curve.
    /// Returns the absolute difference between first and last source times.
    pub fn source_duration(&self) -> f64 {
        if self.keyframes.len() < 2 {
            return 0.0;
        }
        let first = self.keyframes[0].source_time;
        let last = self.keyframes[self.keyframes.len() - 1].source_time;
        (last - first).abs()
    }

    /// Returns the (min, max) source time range covered by this curve.
    pub fn source_range(&self) -> (f64, f64) {
        if self.keyframes.is_empty() {
            return (0.0, 0.0);
        }
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        for kf in &self.keyframes {
            if kf.source_time < min {
                min = kf.source_time;
            }
            if kf.source_time > max {
                max = kf.source_time;
            }
        }
        (min, max)
    }

    /// Computes the total timeline duration of this curve.
    pub fn timeline_duration(&self) -> f64 {
        if self.keyframes.len() < 2 {
            return 0.0;
        }
        let first = self.keyframes[0].timeline_time;
        let last = self.keyframes[self.keyframes.len() - 1].timeline_time;
        last - first
    }
}

/// Solve for t in cubic bezier x(t) = target_x using Newton's method.
/// The bezier is defined as: x(t) = 3(1-t)²t·cp1x + 3(1-t)t²·cp2x + t³
fn cubic_bezier_t(cp1x: f64, cp2x: f64, target_x: f64) -> f64 {
    let mut t = target_x; // Initial guess
    for _ in 0..8 {
        let t2 = t * t;
        let t3 = t2 * t;
        let mt = 1.0 - t;
        let mt2 = mt * mt;

        // x(t) = 3·mt²·t·cp1x + 3·mt·t²·cp2x + t³
        let x = 3.0 * mt2 * t * cp1x + 3.0 * mt * t2 * cp2x + t3;
        let dx = 3.0 * mt2 * cp1x + 6.0 * mt * t * (cp2x - cp1x) + 3.0 * t2 * (1.0 - cp2x);

        if dx.abs() < 1e-12 {
            break;
        }
        t -= (x - target_x) / dx;
        t = t.clamp(0.0, 1.0);
    }
    t
}

/// Evaluate cubic bezier y at parameter t.
/// y(t) = 3(1-t)²t·cp1y + 3(1-t)t²·cp2y + t³
fn cubic_bezier_y(cp1y: f64, cp2y: f64, t: f64) -> f64 {
    let mt = 1.0 - t;
    let mt2 = mt * mt;
    let t2 = t * t;
    3.0 * mt2 * t * cp1y + 3.0 * mt * t2 * cp2y + t * t2
}

// =============================================================================
// Audio Volume Keyframes
// =============================================================================

/// A single volume automation keyframe on an audio clip.
///
/// Defines a volume value at a specific time offset from clip start.
/// When multiple keyframes exist, the volume is interpolated between them
/// using the specified interpolation method.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioKeyframe {
    /// Time offset from clip start in seconds (must be >= 0)
    pub time_offset: f64,
    /// Volume value in dB (typically -60.0 to +6.0, -inf for silence)
    pub value_db: f64,
    /// How to interpolate to the next keyframe
    #[serde(default)]
    pub interpolation: KeyframeInterpolation,
}

impl AudioKeyframe {
    /// Creates a new audio keyframe.
    pub fn new(time_offset: f64, value_db: f64, interpolation: KeyframeInterpolation) -> Self {
        Self {
            time_offset,
            value_db,
            interpolation,
        }
    }

    /// Interpolates volume at a given time offset within a sorted keyframe list.
    /// Returns the interpolated volume in dB.
    pub fn interpolate(keyframes: &[AudioKeyframe], time_offset: f64) -> f64 {
        if keyframes.is_empty() {
            return 0.0; // 0 dB = unity gain
        }

        // Before first keyframe: hold first value
        if time_offset <= keyframes[0].time_offset {
            return keyframes[0].value_db;
        }

        // After last keyframe: hold last value
        let last = &keyframes[keyframes.len() - 1];
        if time_offset >= last.time_offset {
            return last.value_db;
        }

        // Find the segment containing time_offset
        for i in 0..keyframes.len() - 1 {
            let kf0 = &keyframes[i];
            let kf1 = &keyframes[i + 1];

            if time_offset >= kf0.time_offset && time_offset < kf1.time_offset {
                let segment_duration = kf1.time_offset - kf0.time_offset;
                if segment_duration <= 0.0 {
                    return kf0.value_db;
                }

                let t = (time_offset - kf0.time_offset) / segment_duration;

                return match &kf0.interpolation {
                    KeyframeInterpolation::Linear => {
                        kf0.value_db + t * (kf1.value_db - kf0.value_db)
                    }
                    KeyframeInterpolation::Bezier {
                        cp1x,
                        cp1y,
                        cp2x,
                        cp2y,
                    } => {
                        let bezier_t = cubic_bezier_t(*cp1x, *cp2x, t);
                        let value_range = kf1.value_db - kf0.value_db;
                        let y = cubic_bezier_y(*cp1y, *cp2y, bezier_t);
                        kf0.value_db + y * value_range
                    }
                    KeyframeInterpolation::Hold => kf0.value_db,
                };
            }
        }

        // Fallback (should not reach here)
        last.value_db
    }

    /// Sorts a keyframe list by time_offset in place.
    pub fn sort_by_time(keyframes: &mut [AudioKeyframe]) {
        keyframes.sort_by(|a, b| {
            a.time_offset
                .partial_cmp(&b.time_offset)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    /// Generates FFmpeg volume filter expression from keyframes.
    ///
    /// Produces a piecewise-linear `volume` filter using FFmpeg's nested
    /// `if(lt(t,T),expr,fallback)` expressions. dB values are converted to
    /// linear amplitude (10^(dB/20)) since FFmpeg `volume` defaults to linear.
    ///
    /// Commas inside `if()` expressions are function argument separators and
    /// must NOT be escaped — matches the pattern in `build_time_remap_setpts`.
    pub fn to_ffmpeg_volume_expr(keyframes: &[AudioKeyframe]) -> Option<String> {
        if keyframes.len() < 2 {
            return None;
        }

        // Interpolate in dB space (matching AudioKeyframe::interpolate()),
        // then convert the final dB expression to linear amplitude for FFmpeg.
        // FFmpeg volume filter expects linear multiplier, so we wrap with
        // pow(10, dB_expr/20) at the end.
        let mut parts: Vec<(f64, String)> = Vec::new();

        for i in 0..keyframes.len() - 1 {
            let kf0 = &keyframes[i];
            let kf1 = &keyframes[i + 1];

            let db0 = kf0.value_db;
            let db1 = kf1.value_db;
            let t0 = kf0.time_offset;
            let t1 = kf1.time_offset;
            let dt = t1 - t0;

            if dt <= 0.0 {
                continue;
            }

            let db_segment_expr = match &kf0.interpolation {
                KeyframeInterpolation::Linear | KeyframeInterpolation::Bezier { .. } => {
                    // Bezier is approximated as linear for FFmpeg (no native
                    // bezier support in volume filter expressions).
                    if (db1 - db0).abs() < 1e-9 {
                        format!("{:.6}", db0)
                    } else {
                        let slope_db = (db1 - db0) / dt;
                        format!("({:.6}+{:.6}*(t-{:.6}))", db0, slope_db, t0)
                    }
                }
                KeyframeInterpolation::Hold => {
                    format!("{:.6}", db0)
                }
            };

            // Convert dB expression to linear: pow(10, dB/20)
            let linear_segment = format!("pow(10,{}/20)", db_segment_expr);
            parts.push((t1, linear_segment));
        }

        if parts.is_empty() {
            return None;
        }

        // Build nested if: if(lt(t,t1), expr0, if(lt(t,t2), expr1, ... last_val))
        let last_linear = db_to_linear(keyframes[keyframes.len() - 1].value_db);

        let mut expr = format!("{:.6}", last_linear);
        for (threshold, segment_expr) in parts.iter().rev() {
            expr = format!("if(lt(t,{:.6}),{},{})", threshold, segment_expr, expr);
        }

        // Before first keyframe: hold first value
        let first_linear = db_to_linear(keyframes[0].value_db);
        let first_t = keyframes[0].time_offset;
        if first_t > 0.0 {
            expr = format!("if(lt(t,{:.6}),{:.6},{})", first_t, first_linear, expr);
        }

        Some(format!("volume={}", expr))
    }
}

/// Converts dB to linear amplitude: 10^(dB/20)
fn db_to_linear(db: f64) -> f64 {
    if db <= -60.0 {
        0.0 // Treat -60 dB and below as silence
    } else {
        10.0_f64.powf(db / 20.0)
    }
}

// =============================================================================
// Clip
// =============================================================================

/// Clip (media segment on timeline)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: ClipId,
    pub asset_id: AssetId,
    /// Range within the source asset
    pub range: ClipRange,
    /// Placement on the timeline
    pub place: ClipPlace,
    pub transform: Transform,
    /// Opacity (0.0 - 1.0)
    pub opacity: f32,
    /// Blend mode for compositing (default: Normal)
    #[serde(default)]
    pub blend_mode: BlendMode,
    /// Playback speed (1.0 = normal)
    pub speed: f32,
    /// Playback direction (true = reverse)
    #[serde(default)]
    pub reverse: bool,
    /// Whether this clip is a freeze frame (single frame looped for duration)
    #[serde(default)]
    pub freeze_frame: bool,
    /// Optional time remap curve for variable-speed playback.
    /// When present and valid, overrides the constant `speed` field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_remap: Option<TimeRemapCurve>,
    pub effects: Vec<EffectId>,
    pub audio: AudioSettings,
    /// Optional label for organization
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Optional color for UI
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    /// Optional caption style override for caption track clips.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption_style: Option<serde_json::Value>,
    /// Optional caption position override for caption track clips.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption_position: Option<serde_json::Value>,
    /// Whether this clip is enabled (disabled clips are skipped during render/preview)
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Link group ID for audio-video linked editing.
    /// Clips sharing the same link_group_id are selected/moved together.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_group_id: Option<String>,
}

/// Serde default helper that returns `true`
fn default_true() -> bool {
    true
}

impl Clip {
    /// Creates a new clip from an asset ID with default values
    pub fn new(asset_id: &str) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            asset_id: asset_id.to_string(),
            range: ClipRange::default(),
            place: ClipPlace::default(),
            transform: Transform::default(),
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            speed: 1.0,
            reverse: false,
            freeze_frame: false,
            time_remap: None,
            effects: vec![],
            audio: AudioSettings::default(),
            label: None,
            color: None,
            caption_style: None,
            caption_position: None,
            enabled: true,
            link_group_id: None,
        }
    }

    /// Creates a new clip with specific range
    pub fn with_range(asset_id: &str, mut source_in: TimeSec, mut source_out: TimeSec) -> Self {
        if source_in > source_out {
            warn!(
                "Clip created with source_in > source_out ({} > {}), swapping",
                source_in, source_out
            );
            std::mem::swap(&mut source_in, &mut source_out);
        }

        // Prevent negative duration
        if source_in < 0.0 {
            warn!(
                "Clip created with negative source_in {}, clamping to 0.0",
                source_in
            );
            source_in = 0.0;
            if source_out < 0.0 {
                source_out = 0.0;
            }
        }

        let duration = source_out - source_in;
        Self {
            id: ulid::Ulid::new().to_string(),
            asset_id: asset_id.to_string(),
            range: ClipRange::new(source_in, source_out),
            place: ClipPlace::new(0.0, duration),
            transform: Transform::default(),
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            speed: 1.0,
            reverse: false,
            freeze_frame: false,
            time_remap: None,
            effects: vec![],
            audio: AudioSettings::default(),
            label: None,
            color: None,
            caption_style: None,
            caption_position: None,
            enabled: true,
            link_group_id: None,
        }
    }

    /// Places the clip at a specific timeline position
    pub fn place_at(mut self, timeline_in: TimeSec) -> Self {
        self.place.timeline_in_sec = timeline_in;
        self
    }

    /// Returns the effective playback speed, falling back to 1.0 for invalid values.
    pub fn safe_speed(&self) -> f64 {
        if self.speed > 0.0 {
            self.speed as f64
        } else {
            1.0
        }
    }

    /// Sets the clip range from source
    pub fn with_source_range(mut self, source_in: TimeSec, source_out: TimeSec) -> Self {
        self.range = ClipRange::new(source_in, source_out);
        self.place.duration_sec = self.range.duration() / self.safe_speed();
        self
    }

    /// Returns the effective duration considering speed or time remap.
    ///
    /// When a valid time remap curve is active, the timeline duration comes from
    /// the curve. Otherwise falls back to `source_duration / speed`.
    pub fn duration(&self) -> TimeSec {
        if let Some(ref remap) = self.time_remap {
            if remap.is_valid() {
                return remap.timeline_duration();
            }
        }
        self.range.duration() / self.safe_speed()
    }

    /// Returns the timeline end position
    pub fn timeline_end(&self) -> TimeSec {
        self.place.timeline_out_sec()
    }

    /// Checks if this clip contains the given timeline position.
    /// Uses half-open interval [start, end) - includes start, excludes exact end.
    pub fn contains_time(&self, time_sec: TimeSec) -> bool {
        self.place.contains(time_sec)
    }

    /// Checks if this clip contains the given timeline position (inclusive end).
    /// Uses closed interval [start, end] semantics.
    pub fn contains_time_inclusive(&self, time_sec: TimeSec) -> bool {
        self.place.contains_inclusive(time_sec)
    }

    /// Converts a timeline time to source time.
    ///
    /// When a valid time remap curve is active, evaluates the curve to find the
    /// source time. Otherwise uses the constant speed mapping.
    pub fn timeline_to_source(&self, timeline_sec: TimeSec) -> TimeSec {
        let offset = timeline_sec - self.place.timeline_in_sec;
        if let Some(ref remap) = self.time_remap {
            if remap.is_valid() {
                return remap.evaluate(offset);
            }
        }
        let source_time = if self.reverse {
            self.range.source_out_sec - (offset * self.safe_speed())
        } else {
            self.range.source_in_sec + (offset * self.safe_speed())
        };

        source_time.clamp(self.range.source_in_sec, self.range.source_out_sec)
    }

    /// Returns true if this clip has an active time remap curve.
    pub fn has_time_remap(&self) -> bool {
        self.time_remap.as_ref().is_some_and(|r| r.is_valid())
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sequence_creation() {
        let seq = Sequence::new("Main", SequenceFormat::shorts_1080());

        assert!(!seq.id.is_empty());
        assert_eq!(seq.name, "Main");
        assert_eq!(seq.format.canvas.width, 1080);
        assert_eq!(seq.format.canvas.height, 1920);
        assert!(seq.tracks.is_empty());
    }

    #[test]
    fn test_sequence_add_track() {
        let mut seq = Sequence::new("Main", SequenceFormat::youtube_1080());
        let track = Track::new_video("Video 1");
        let track_id = track.id.clone();

        seq.add_track(track);

        assert_eq!(seq.tracks.len(), 1);
        assert!(seq.get_track(&track_id).is_some());
    }

    #[test]
    fn test_sequence_duration() {
        let mut seq = Sequence::new("Main", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let clip1 = Clip::new("asset_1")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        let clip2 = Clip::new("asset_2")
            .with_source_range(0.0, 5.0)
            .place_at(10.0);

        track.add_clip(clip1);
        track.add_clip(clip2);
        seq.add_track(track);

        assert_eq!(seq.duration(), 15.0);
    }

    #[test]
    fn test_track_creation() {
        let video_track = Track::new_video("Video 1");
        let audio_track = Track::new_audio("Audio 1");
        let caption_track = Track::new_caption("Captions");

        assert_eq!(video_track.kind, TrackKind::Video);
        assert_eq!(audio_track.kind, TrackKind::Audio);
        assert_eq!(caption_track.kind, TrackKind::Caption);
        assert!(video_track.visible);
        assert!(!video_track.muted);
        assert!(video_track.is_video());
        assert!(audio_track.is_audio());
    }

    #[test]
    fn test_track_add_remove_clip() {
        let mut track = Track::new_video("Video 1");

        let clip = Clip::new("asset_1").with_source_range(0.0, 10.0);
        let clip_id = clip.id.clone();

        track.add_clip(clip);
        assert_eq!(track.clips.len(), 1);
        assert!(track.get_clip(&clip_id).is_some());

        let removed = track.remove_clip(&clip_id);
        assert!(removed.is_some());
        assert!(track.clips.is_empty());
    }

    #[test]
    fn test_clip_creation() {
        let clip = Clip::new("asset_123");

        assert!(!clip.id.is_empty());
        assert_eq!(clip.asset_id, "asset_123");
        assert_eq!(clip.opacity, 1.0);
        assert_eq!(clip.speed, 1.0);
    }

    #[test]
    fn test_clip_with_range() {
        let clip = Clip::with_range("asset_123", 5.0, 15.0);

        assert_eq!(clip.range.source_in_sec, 5.0);
        assert_eq!(clip.range.source_out_sec, 15.0);
        assert_eq!(clip.duration(), 10.0);
        assert_eq!(clip.place.duration_sec, 10.0);
    }

    #[test]
    fn test_clip_placement() {
        let clip = Clip::new("asset_123")
            .with_source_range(0.0, 10.0)
            .place_at(5.0);

        assert_eq!(clip.place.timeline_in_sec, 5.0);
        assert_eq!(clip.timeline_end(), 15.0);
    }

    #[test]
    fn test_clip_speed() {
        let mut clip = Clip::with_range("asset_123", 0.0, 10.0);
        clip.speed = 2.0;
        clip.place.duration_sec = clip.duration();

        assert_eq!(clip.duration(), 5.0); // 10 seconds at 2x speed
    }

    #[test]
    fn test_clip_place_overlap() {
        let place1 = ClipPlace::new(0.0, 10.0);
        let place2 = ClipPlace::new(5.0, 10.0);
        let place3 = ClipPlace::new(10.0, 10.0);

        assert!(place1.overlaps(&place2));
        assert!(!place1.overlaps(&place3)); // Touching but not overlapping
    }

    #[test]
    fn test_clip_contains_time() {
        let clip = Clip::new("asset_123")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);

        // Half-open interval [0, 10) - includes start, excludes end
        assert!(clip.contains_time(0.0));
        assert!(clip.contains_time(5.0));
        assert!(clip.contains_time(9.999)); // Just before end
        assert!(!clip.contains_time(10.0)); // Exact end is excluded
        assert!(!clip.contains_time(11.0));

        // Closed interval [0, 10] - includes both ends
        assert!(clip.contains_time_inclusive(0.0));
        assert!(clip.contains_time_inclusive(5.0));
        assert!(clip.contains_time_inclusive(10.0)); // End is included
        assert!(!clip.contains_time_inclusive(10.001));
    }

    #[test]
    fn test_timeline_to_source() {
        let clip = Clip::new("asset_123")
            .with_source_range(10.0, 20.0)
            .place_at(5.0);

        // At timeline 5.0, we should be at source 10.0
        assert_eq!(clip.timeline_to_source(5.0), 10.0);
        // At timeline 10.0, we should be at source 15.0
        assert_eq!(clip.timeline_to_source(10.0), 15.0);
    }

    #[test]
    fn test_timeline_to_source_with_reverse() {
        let mut clip = Clip::new("asset_123")
            .with_source_range(10.0, 20.0)
            .place_at(5.0);
        clip.reverse = true;

        assert_eq!(clip.timeline_to_source(5.0), 20.0);
        assert_eq!(clip.timeline_to_source(10.0), 15.0);
        assert_eq!(clip.timeline_to_source(15.0), 10.0);
    }

    #[test]
    fn test_sequence_format_presets() {
        let shorts = SequenceFormat::shorts_1080();
        assert_eq!(shorts.canvas.width, 1080);
        assert_eq!(shorts.canvas.height, 1920);

        let youtube = SequenceFormat::youtube_1080();
        assert_eq!(youtube.canvas.width, 1920);
        assert_eq!(youtube.canvas.height, 1080);

        let uhd = SequenceFormat::uhd_4k();
        assert_eq!(uhd.canvas.width, 3840);
        assert_eq!(uhd.canvas.height, 2160);
    }

    #[test]
    fn test_transform_default() {
        let t = Transform::default();

        assert_eq!(t.position, Point2D::center());
        assert_eq!(t.scale.x, 1.0);
        assert_eq!(t.scale.y, 1.0);
        assert_eq!(t.rotation_deg, 0.0);
    }

    #[test]
    fn test_clip_serialization() {
        let clip = Clip::with_range("asset_123", 0.0, 10.0).place_at(5.0);

        let json = serde_json::to_string(&clip).unwrap();
        let parsed: Clip = serde_json::from_str(&json).unwrap();

        assert_eq!(clip.id, parsed.id);
        assert_eq!(clip.asset_id, parsed.asset_id);
        assert_eq!(clip.place.timeline_in_sec, parsed.place.timeline_in_sec);
    }

    #[test]
    fn test_sequence_serialization() {
        let mut seq = Sequence::new("Main", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        track.add_clip(Clip::with_range("asset_1", 0.0, 10.0));
        seq.add_track(track);

        let json = serde_json::to_string(&seq).unwrap();
        let parsed: Sequence = serde_json::from_str(&json).unwrap();

        assert_eq!(seq.id, parsed.id);
        assert_eq!(parsed.tracks.len(), 1);
        assert_eq!(parsed.tracks[0].clips.len(), 1);
    }

    #[test]
    fn test_track_kind() {
        let track = Track::new("Test", TrackKind::Overlay);
        assert!(track.is_video());
        assert!(!track.is_audio());
    }

    #[test]
    fn test_canvas_aspect_ratio() {
        let canvas_16_9 = Canvas::new(1920, 1080);
        assert!((canvas_16_9.aspect_ratio() - 16.0 / 9.0).abs() < 0.001);

        let canvas_9_16 = Canvas::new(1080, 1920);
        assert!((canvas_9_16.aspect_ratio() - 9.0 / 16.0).abs() < 0.001);
    }

    // =========================================================================
    // Edge Case / Defensive Tests
    // =========================================================================

    #[test]
    fn test_canvas_aspect_ratio_zero_height() {
        // Division by zero protection
        let canvas = Canvas::new(1920, 0);
        assert_eq!(canvas.aspect_ratio(), 0.0);
        assert!(!canvas.is_valid());
    }

    #[test]
    fn test_canvas_aspect_ratio_zero_width() {
        let canvas = Canvas::new(0, 1080);
        assert_eq!(canvas.aspect_ratio(), 0.0);
        assert!(!canvas.is_valid());
    }

    #[test]
    fn test_canvas_is_valid() {
        assert!(Canvas::new(1920, 1080).is_valid());
        assert!(!Canvas::new(0, 1080).is_valid());
        assert!(!Canvas::new(1920, 0).is_valid());
        assert!(!Canvas::new(0, 0).is_valid());
    }

    #[test]
    fn test_clip_place_overlap_edge_cases() {
        // Adjacent clips (touching but not overlapping)
        // [0, 10) and [10, 20) - these share a boundary but don't overlap
        let place1 = ClipPlace::new(0.0, 10.0);
        let place2 = ClipPlace::new(10.0, 10.0);
        assert!(
            !place1.overlaps(&place2),
            "Adjacent clips should not overlap"
        );
        assert!(
            !place2.overlaps(&place1),
            "Adjacent clips should not overlap (reverse)"
        );

        // Zero duration clip at a point INSIDE another clip's interval - does overlap
        // Point at 5.0 overlaps with interval [0, 10) because 5.0 < 10.0 AND 5.0 > 0.0
        let zero_inside = ClipPlace::new(5.0, 0.0);
        let normal = ClipPlace::new(0.0, 10.0);
        assert!(
            zero_inside.overlaps(&normal),
            "Zero duration clip inside interval overlaps"
        );

        // Zero duration clip at the END boundary - does NOT overlap
        // Point at 10.0 with interval [0, 10): 10.0 < 10.0 = false, so no overlap
        let zero_at_end = ClipPlace::new(10.0, 0.0);
        assert!(
            !zero_at_end.overlaps(&normal),
            "Zero duration clip at end boundary does not overlap"
        );

        // Zero duration clip at the START boundary - does NOT overlap
        // Point at 0.0 with interval [0, 10): 0.0 > 0.0 = false, so no overlap
        let zero_at_start = ClipPlace::new(0.0, 0.0);
        assert!(
            !zero_at_start.overlaps(&normal),
            "Zero duration clip at start boundary does not overlap"
        );

        // Two zero duration clips at same position - do NOT overlap
        // Both at 5.0: 5.0 < 5.0 = false, so no overlap
        let zero_a = ClipPlace::new(5.0, 0.0);
        let zero_b = ClipPlace::new(5.0, 0.0);
        assert!(
            !zero_a.overlaps(&zero_b),
            "Two zero duration clips at same point do not overlap"
        );
    }

    #[test]
    fn test_clip_range_duration_edge_cases() {
        // Normal range
        let range = ClipRange::new(5.0, 15.0);
        assert_eq!(range.duration(), 10.0);

        // Zero duration
        let zero_range = ClipRange::new(5.0, 5.0);
        assert_eq!(zero_range.duration(), 0.0);

        // Inverted range (source_out < source_in) - caller should prevent this
        let inverted = ClipRange::new(15.0, 5.0);
        assert_eq!(inverted.duration(), -10.0); // Negative duration indicates invalid state
    }

    #[test]
    fn test_clip_with_range_swaps_inverted() {
        // Clip::with_range should swap source_in > source_out
        let clip = Clip::with_range("asset", 15.0, 5.0);
        assert_eq!(clip.range.source_in_sec, 5.0);
        assert_eq!(clip.range.source_out_sec, 15.0);
    }

    #[test]
    fn test_clip_with_range_clamps_negative() {
        // Clip::with_range should clamp negative values to 0
        let clip = Clip::with_range("asset", -5.0, 10.0);
        assert_eq!(clip.range.source_in_sec, 0.0);
        assert_eq!(clip.range.source_out_sec, 10.0);
    }

    #[test]
    fn test_clip_timeline_to_source_with_speed() {
        // Test with 2x speed - source advances faster than timeline
        let mut clip = Clip::with_range("asset", 0.0, 20.0).place_at(0.0);
        clip.speed = 2.0;

        // At timeline 0, source is 0
        assert_eq!(clip.timeline_to_source(0.0), 0.0);
        // At timeline 5 with 2x speed, source is 10
        assert_eq!(clip.timeline_to_source(5.0), 10.0);

        // Test with 0.5x speed - source advances slower
        clip.speed = 0.5;
        // At timeline 10 with 0.5x speed, source is 5
        assert_eq!(clip.timeline_to_source(10.0), 5.0);
    }

    #[test]
    fn test_sequence_duration_empty() {
        let seq = Sequence::new("Empty", SequenceFormat::youtube_1080());
        assert_eq!(seq.duration(), 0.0);
    }

    #[test]
    fn test_sequence_duration_empty_tracks() {
        let mut seq = Sequence::new("WithTracks", SequenceFormat::youtube_1080());
        seq.add_track(Track::new_video("Video 1"));
        seq.add_track(Track::new_audio("Audio 1"));
        assert_eq!(seq.duration(), 0.0);
    }

    #[test]
    fn test_track_remove_nonexistent_clip() {
        let mut track = Track::new_video("Video 1");
        let result = track.remove_clip(&"nonexistent".to_string());
        assert!(result.is_none());
    }

    #[test]
    fn test_sequence_remove_nonexistent_track() {
        let mut seq = Sequence::new("Test", SequenceFormat::youtube_1080());
        let result = seq.remove_track(&"nonexistent".to_string());
        assert!(!result);
    }

    #[test]
    fn test_marker_creation() {
        let marker = Marker::new(5.0, "Test Marker");
        assert!(!marker.id.is_empty());
        assert_eq!(marker.time_sec, 5.0);
        assert_eq!(marker.label, "Test Marker");
        assert_eq!(marker.marker_type, MarkerType::Generic);
    }

    // =========================================================================
    // Time Remap Tests
    // =========================================================================

    #[test]
    fn test_time_remap_linear_2x_speed() {
        // Scenario: Two keyframes mapping 2s of timeline to 4s of source = 2x speed
        let curve = TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 2.0,
                source_time: 4.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]);

        assert!(curve.is_valid());
        assert!((curve.evaluate(0.0) - 0.0).abs() < 1e-6);
        assert!((curve.evaluate(1.0) - 2.0).abs() < 1e-6);
        assert!((curve.evaluate(2.0) - 4.0).abs() < 1e-6);
        assert!((curve.timeline_duration() - 2.0).abs() < 1e-6);
        assert!((curve.source_duration() - 4.0).abs() < 1e-6);
    }

    #[test]
    fn test_time_remap_linear_slow_motion() {
        // Scenario: 4s of timeline maps to 2s of source = 0.5x speed
        let curve = TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 4.0,
                source_time: 2.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]);

        assert!((curve.evaluate(2.0) - 1.0).abs() < 1e-6);
        assert!((curve.evaluate(4.0) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn test_time_remap_multi_segment_speed_ramp() {
        // Scenario: 0→1s at 1x, 1→2s at 3x (speed ramp)
        let curve = TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 1.0,
                source_time: 1.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 2.0,
                source_time: 4.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]);

        // First segment: 1x speed
        assert!((curve.evaluate(0.5) - 0.5).abs() < 1e-6);
        // Second segment: 3x speed
        assert!((curve.evaluate(1.5) - 2.5).abs() < 1e-6);
    }

    #[test]
    fn test_time_remap_bezier_smooth_ramp() {
        // Scenario: Bezier interpolation should produce values between endpoints
        let curve = TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Bezier {
                    cp1x: 0.42,
                    cp1y: 0.0,
                    cp2x: 0.58,
                    cp2y: 1.0,
                },
            },
            TimeRemapKeyframe {
                timeline_time: 2.0,
                source_time: 4.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]);

        let mid = curve.evaluate(1.0);
        // Bezier ease: at t=0.5 on the x-axis, the y value should be
        // between 0 and 4 but NOT exactly 2.0 (that would be linear)
        assert!(mid > 0.0 && mid < 4.0);
        // Endpoints should be exact
        assert!((curve.evaluate(0.0) - 0.0).abs() < 1e-6);
        assert!((curve.evaluate(2.0) - 4.0).abs() < 1e-6);
    }

    #[test]
    fn test_time_remap_hold_interpolation() {
        // Scenario: Hold interpolation holds source time until next keyframe
        let curve = TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 1.0,
                interpolation: KeyframeInterpolation::Hold,
            },
            TimeRemapKeyframe {
                timeline_time: 2.0,
                source_time: 5.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]);

        // Hold: any point between 0 and 2 returns source_time of first keyframe
        assert!((curve.evaluate(0.0) - 1.0).abs() < 1e-6);
        assert!((curve.evaluate(0.5) - 1.0).abs() < 1e-6);
        assert!((curve.evaluate(1.0) - 1.0).abs() < 1e-6);
        assert!((curve.evaluate(1.999) - 1.0).abs() < 1e-6);
        // At the second keyframe
        assert!((curve.evaluate(2.0) - 5.0).abs() < 1e-6);
    }

    #[test]
    fn test_time_remap_json_roundtrip() {
        let curve = TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 2.0,
                source_time: 4.0,
                interpolation: KeyframeInterpolation::Bezier {
                    cp1x: 0.25,
                    cp1y: 0.1,
                    cp2x: 0.75,
                    cp2y: 0.9,
                },
            },
        ]);

        let json = serde_json::to_string(&curve).unwrap();
        let deserialized: TimeRemapCurve = serde_json::from_str(&json).unwrap();

        assert_eq!(curve, deserialized);
    }

    #[test]
    fn test_time_remap_invalid_single_keyframe() {
        let curve = TimeRemapCurve::new(vec![TimeRemapKeyframe {
            timeline_time: 0.0,
            source_time: 0.0,
            interpolation: KeyframeInterpolation::Linear,
        }]);

        assert!(!curve.is_valid());
    }

    #[test]
    fn test_time_remap_empty_curve() {
        let curve = TimeRemapCurve::new(vec![]);
        assert!(!curve.is_valid());
        assert!((curve.evaluate(1.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_clip_duration_with_time_remap() {
        let mut clip = Clip::new("asset_1")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        // Without time remap: 10s / 1.0 speed = 10s
        assert!((clip.duration() - 10.0).abs() < 1e-6);

        // With time remap: timeline duration is 5s (regardless of source range)
        clip.time_remap = Some(TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 5.0,
                source_time: 10.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]));
        assert!((clip.duration() - 5.0).abs() < 1e-6);
    }

    #[test]
    fn test_clip_timeline_to_source_with_time_remap() {
        let mut clip = Clip::new("asset_1")
            .with_source_range(0.0, 10.0)
            .place_at(5.0);
        clip.time_remap = Some(TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 2.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 4.0,
                source_time: 8.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]));

        // timeline_sec=5.0, clip starts at 5.0, offset=0.0 → source 2.0
        assert!((clip.timeline_to_source(5.0) - 2.0).abs() < 1e-6);
        // timeline_sec=7.0, offset=2.0 → source 5.0
        assert!((clip.timeline_to_source(7.0) - 5.0).abs() < 1e-6);
    }

    #[test]
    fn test_clip_has_time_remap() {
        let mut clip = Clip::new("asset_1");
        assert!(!clip.has_time_remap());

        clip.time_remap = Some(TimeRemapCurve::new(vec![TimeRemapKeyframe {
            timeline_time: 0.0,
            source_time: 0.0,
            interpolation: KeyframeInterpolation::Linear,
        }]));
        // Single keyframe is not valid
        assert!(!clip.has_time_remap());

        clip.time_remap = Some(TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 2.0,
                source_time: 4.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]));
        assert!(clip.has_time_remap());
    }

    // =========================================================================
    // AudioKeyframe Tests
    // =========================================================================

    #[test]
    fn audio_keyframe_should_hold_first_value_before_first_keyframe() {
        // Given keyframes: [1.0s: -6dB, 3.0s: 0dB]
        let keyframes = vec![
            AudioKeyframe::new(1.0, -6.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(3.0, 0.0, KeyframeInterpolation::Linear),
        ];

        // When evaluating at t=0.0 (before first keyframe)
        let result = AudioKeyframe::interpolate(&keyframes, 0.0);

        // Then it should hold the first keyframe's value
        assert!((result - (-6.0)).abs() < 1e-9);
    }

    #[test]
    fn audio_keyframe_should_hold_last_value_after_last_keyframe() {
        // Given keyframes: [0.0s: -6dB, 2.0s: 0dB]
        let keyframes = vec![
            AudioKeyframe::new(0.0, -6.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(2.0, 0.0, KeyframeInterpolation::Linear),
        ];

        // When evaluating at t=5.0 (after last keyframe)
        let result = AudioKeyframe::interpolate(&keyframes, 5.0);

        // Then it should hold the last keyframe's value
        assert!((result - 0.0).abs() < 1e-9);
    }

    #[test]
    fn audio_keyframe_should_interpolate_linearly_between_keyframes() {
        // Given two keyframes with linear interpolation
        let keyframes = vec![
            AudioKeyframe::new(0.0, -12.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(4.0, 0.0, KeyframeInterpolation::Linear),
        ];

        // When evaluating at midpoint t=2.0
        let result = AudioKeyframe::interpolate(&keyframes, 2.0);

        // Then it should be linearly interpolated: -12 + (0 - -12) * 0.5 = -6
        assert!((result - (-6.0)).abs() < 1e-9);
    }

    #[test]
    fn audio_keyframe_should_hold_value_with_hold_interpolation() {
        // Given two keyframes with Hold interpolation on the first
        let keyframes = vec![
            AudioKeyframe::new(0.0, -12.0, KeyframeInterpolation::Hold),
            AudioKeyframe::new(4.0, 0.0, KeyframeInterpolation::Linear),
        ];

        // When evaluating at t=2.0 (midpoint)
        let result = AudioKeyframe::interpolate(&keyframes, 2.0);

        // Then it should hold the first value (step function)
        assert!((result - (-12.0)).abs() < 1e-9);
    }

    #[test]
    fn audio_keyframe_should_interpolate_with_bezier_curve() {
        // Given two keyframes with Bezier interpolation (ease-in-out)
        let keyframes = vec![
            AudioKeyframe::new(
                0.0,
                -12.0,
                KeyframeInterpolation::Bezier {
                    cp1x: 0.42,
                    cp1y: 0.0,
                    cp2x: 0.58,
                    cp2y: 1.0,
                },
            ),
            AudioKeyframe::new(4.0, 0.0, KeyframeInterpolation::Linear),
        ];

        // When evaluating at t=2.0 (midpoint)
        let result = AudioKeyframe::interpolate(&keyframes, 2.0);

        // Then it should be smoothly interpolated (not exactly -6.0 due to bezier)
        assert!(result > -12.0 && result < 0.0);
    }

    #[test]
    fn audio_keyframe_should_sort_by_time_offset() {
        // Given unsorted keyframes
        let mut keyframes = vec![
            AudioKeyframe::new(3.0, 0.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(1.0, -6.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(0.0, -12.0, KeyframeInterpolation::Linear),
        ];

        // When sorting
        AudioKeyframe::sort_by_time(&mut keyframes);

        // Then keyframes should be ordered by time_offset
        assert!((keyframes[0].time_offset - 0.0).abs() < 1e-9);
        assert!((keyframes[1].time_offset - 1.0).abs() < 1e-9);
        assert!((keyframes[2].time_offset - 3.0).abs() < 1e-9);
    }

    #[test]
    fn audio_keyframe_should_generate_ffmpeg_volume_expr_for_linear_ramp() {
        // Given two keyframes: fade from 0dB to -12dB over 2 seconds
        let keyframes = vec![
            AudioKeyframe::new(0.0, 0.0, KeyframeInterpolation::Linear),
            AudioKeyframe::new(2.0, -12.0, KeyframeInterpolation::Linear),
        ];

        // When generating FFmpeg expression
        let expr = AudioKeyframe::to_ffmpeg_volume_expr(&keyframes);

        // Then it should produce a valid volume filter (no quotes, no escaped commas)
        assert!(expr.is_some());
        let expr = expr.unwrap();
        assert!(expr.starts_with("volume="));
        assert!(!expr.contains('\''), "Should not contain single quotes");
        assert!(!expr.contains("\\,"), "Commas should not be escaped");
        assert!(expr.contains("if(lt(t,"));
        // Expression must interpolate in dB space then convert to linear via pow(10, dB/20)
        assert!(
            expr.contains("pow(10,"),
            "Should use dB-to-linear conversion: pow(10, dB/20)"
        );
    }

    #[test]
    fn audio_keyframe_should_return_none_for_insufficient_keyframes() {
        // Given only one keyframe (need >= 2)
        let keyframes = vec![AudioKeyframe::new(0.0, 0.0, KeyframeInterpolation::Linear)];

        // When generating FFmpeg expression
        let expr = AudioKeyframe::to_ffmpeg_volume_expr(&keyframes);

        // Then it should return None
        assert!(expr.is_none());
    }

    #[test]
    fn audio_settings_should_evaluate_flat_volume_when_no_keyframes() {
        // Given AudioSettings with volume_db = -3.0 and no keyframes
        let settings = AudioSettings {
            volume_db: -3.0,
            ..Default::default()
        };

        // When evaluating volume at any time
        let result = settings.evaluate_volume_at(1.0);

        // Then it should return the flat volume_db value
        assert!((result - (-3.0)).abs() < 1e-9);
    }

    #[test]
    fn audio_settings_should_evaluate_keyframe_volume_when_automation_active() {
        // Given AudioSettings with volume keyframes
        let settings = AudioSettings {
            volume_db: 0.0,
            volume_keyframes: vec![
                AudioKeyframe::new(0.0, -12.0, KeyframeInterpolation::Linear),
                AudioKeyframe::new(4.0, 0.0, KeyframeInterpolation::Linear),
            ],
            ..Default::default()
        };

        // When evaluating at midpoint
        let result = settings.evaluate_volume_at(2.0);

        // Then it should use keyframe interpolation, not flat volume_db
        assert!((result - (-6.0)).abs() < 1e-9);
    }

    #[test]
    fn audio_keyframe_should_serialize_and_deserialize_via_json() {
        // Given an AudioKeyframe
        let kf = AudioKeyframe::new(1.5, -6.0, KeyframeInterpolation::Linear);

        // When serializing to JSON and back
        let json = serde_json::to_string(&kf).unwrap();
        let deserialized: AudioKeyframe = serde_json::from_str(&json).unwrap();

        // Then the round-trip should preserve all values
        assert!((deserialized.time_offset - 1.5).abs() < 1e-9);
        assert!((deserialized.value_db - (-6.0)).abs() < 1e-9);
        assert_eq!(deserialized.interpolation, KeyframeInterpolation::Linear);
    }

    // =========================================================================
    // Edit Point & Marker Navigation (S27-002)
    // =========================================================================

    /// Helper: creates a clip at the given timeline position with the given duration.
    fn nav_clip(timeline_in: f64, duration: f64) -> Clip {
        Clip::new("nav-test-asset")
            .with_source_range(0.0, duration)
            .place_at(timeline_in)
    }

    /// Helper: creates a sequence with given tracks and markers.
    fn nav_sequence(tracks: Vec<Track>, markers: Vec<Marker>) -> Sequence {
        let mut seq = Sequence::new("NavTest", SequenceFormat::youtube_1080());
        seq.tracks = tracks;
        seq.markers = markers;
        seq
    }

    // -- collect_edit_points --

    #[test]
    fn should_include_timeline_start_as_edit_point_when_no_clips_exist() {
        let seq = nav_sequence(vec![], vec![]);
        let points = seq.collect_edit_points();
        assert_eq!(points, vec![0.0]);
    }

    #[test]
    fn should_collect_clip_boundaries_from_single_track() {
        // Given a track with clips at [2..5] and [7..10]
        let mut track = Track::new_video("V1");
        track.clips = vec![nav_clip(2.0, 3.0), nav_clip(7.0, 3.0)];
        let seq = nav_sequence(vec![track], vec![]);

        // When collecting edit points
        let points = seq.collect_edit_points();

        // Then all boundaries should be present (including 0.0 start)
        assert_eq!(points, vec![0.0, 2.0, 5.0, 7.0, 10.0]);
    }

    #[test]
    fn should_collect_edit_points_across_all_tracks() {
        // Given: video track [0..3], audio track [1..4]
        let mut v = Track::new_video("V1");
        v.clips = vec![nav_clip(0.0, 3.0)];
        let mut a = Track::new_audio("A1");
        a.clips = vec![nav_clip(1.0, 3.0)];
        let seq = nav_sequence(vec![v, a], vec![]);

        let points = seq.collect_edit_points();
        // 0.0, 1.0, 3.0, 4.0
        assert_eq!(points, vec![0.0, 1.0, 3.0, 4.0]);
    }

    #[test]
    fn should_deduplicate_coincident_edit_points_across_tracks() {
        // Given: two clips on different tracks sharing boundary at 3.0
        let mut t1 = Track::new_video("V1");
        t1.clips = vec![nav_clip(0.0, 3.0)];
        let mut t2 = Track::new_video("V2");
        t2.clips = vec![nav_clip(3.0, 2.0)];
        let seq = nav_sequence(vec![t1, t2], vec![]);

        let points = seq.collect_edit_points();
        assert_eq!(points, vec![0.0, 3.0, 5.0]);
    }

    // -- next_edit_point / prev_edit_point --

    #[test]
    fn should_find_next_edit_point_after_current_time() {
        let mut track = Track::new_video("V1");
        track.clips = vec![nav_clip(2.0, 3.0), nav_clip(7.0, 3.0)];
        let seq = nav_sequence(vec![track], vec![]);

        // Edit points: 0.0, 2.0, 5.0, 7.0, 10.0
        assert_eq!(seq.next_edit_point(0.0), Some(2.0));
        assert_eq!(seq.next_edit_point(2.0), Some(5.0));
        assert_eq!(seq.next_edit_point(4.5), Some(5.0));
        assert_eq!(seq.next_edit_point(7.0), Some(10.0));
    }

    #[test]
    fn should_return_none_when_at_or_past_last_edit_point() {
        let mut track = Track::new_video("V1");
        track.clips = vec![nav_clip(0.0, 5.0)];
        let seq = nav_sequence(vec![track], vec![]);

        assert_eq!(seq.next_edit_point(5.0), None);
        assert_eq!(seq.next_edit_point(10.0), None);
    }

    #[test]
    fn should_find_prev_edit_point_before_current_time() {
        let mut track = Track::new_video("V1");
        track.clips = vec![nav_clip(2.0, 3.0), nav_clip(7.0, 3.0)];
        let seq = nav_sequence(vec![track], vec![]);

        // Edit points: 0.0, 2.0, 5.0, 7.0, 10.0
        assert_eq!(seq.prev_edit_point(10.0), Some(7.0));
        assert_eq!(seq.prev_edit_point(7.0), Some(5.0));
        assert_eq!(seq.prev_edit_point(3.0), Some(2.0));
        assert_eq!(seq.prev_edit_point(2.0), Some(0.0));
    }

    #[test]
    fn should_return_none_when_at_timeline_start() {
        let seq = nav_sequence(vec![], vec![]);
        assert_eq!(seq.prev_edit_point(0.0), None);
    }

    #[test]
    fn should_handle_playhead_between_edit_points() {
        let mut track = Track::new_video("V1");
        track.clips = vec![nav_clip(0.0, 5.0), nav_clip(10.0, 5.0)];
        let seq = nav_sequence(vec![track], vec![]);

        // Playhead at 7.0 (gap between clips)
        assert_eq!(seq.next_edit_point(7.0), Some(10.0));
        assert_eq!(seq.prev_edit_point(7.0), Some(5.0));
    }

    // -- next_marker / prev_marker --

    #[test]
    fn should_find_next_marker_after_current_time() {
        let markers = vec![
            Marker::new(2.0, "A"),
            Marker::new(5.0, "B"),
            Marker::new(8.0, "C"),
        ];
        let seq = nav_sequence(vec![], markers);

        assert_eq!(seq.next_marker(0.0), Some(2.0));
        assert_eq!(seq.next_marker(2.0), Some(5.0));
        assert_eq!(seq.next_marker(6.0), Some(8.0));
    }

    #[test]
    fn should_find_prev_marker_before_current_time() {
        let markers = vec![
            Marker::new(2.0, "A"),
            Marker::new(5.0, "B"),
            Marker::new(8.0, "C"),
        ];
        let seq = nav_sequence(vec![], markers);

        assert_eq!(seq.prev_marker(10.0), Some(8.0));
        assert_eq!(seq.prev_marker(8.0), Some(5.0));
        assert_eq!(seq.prev_marker(3.0), Some(2.0));
    }

    #[test]
    fn should_return_none_when_no_markers_exist() {
        let seq = nav_sequence(vec![], vec![]);
        assert_eq!(seq.next_marker(0.0), None);
        assert_eq!(seq.prev_marker(5.0), None);
    }

    #[test]
    fn should_return_none_when_past_last_marker() {
        let markers = vec![Marker::new(3.0, "Only")];
        let seq = nav_sequence(vec![], markers);
        assert_eq!(seq.next_marker(5.0), None);
    }

    #[test]
    fn should_return_none_when_before_first_marker() {
        let markers = vec![Marker::new(3.0, "Only")];
        let seq = nav_sequence(vec![], markers);
        assert_eq!(seq.prev_marker(1.0), None);
    }

    // -- Combined multi-track + markers --

    #[test]
    fn should_navigate_through_multi_track_timeline_with_markers() {
        // Given: Video [0..3], [5..8]; Audio [1..4]; Markers at 2.5 and 6.0
        let mut v = Track::new_video("V1");
        v.clips = vec![nav_clip(0.0, 3.0), nav_clip(5.0, 3.0)];
        let mut a = Track::new_audio("A1");
        a.clips = vec![nav_clip(1.0, 3.0)];
        let markers = vec![Marker::new(2.5, "Hook"), Marker::new(6.0, "Beat")];
        let seq = nav_sequence(vec![v, a], markers);

        // Edit points: 0.0, 1.0, 3.0, 4.0, 5.0, 8.0
        assert_eq!(
            seq.collect_edit_points(),
            vec![0.0, 1.0, 3.0, 4.0, 5.0, 8.0]
        );

        // Forward edit navigation
        assert_eq!(seq.next_edit_point(0.0), Some(1.0));
        assert_eq!(seq.next_edit_point(1.0), Some(3.0));

        // Backward edit navigation
        assert_eq!(seq.prev_edit_point(8.0), Some(5.0));
        assert_eq!(seq.prev_edit_point(5.0), Some(4.0));

        // Marker navigation
        assert_eq!(seq.next_marker(0.0), Some(2.5));
        assert_eq!(seq.next_marker(2.5), Some(6.0));
        assert_eq!(seq.prev_marker(6.0), Some(2.5));
    }
}

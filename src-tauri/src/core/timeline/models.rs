//! Timeline Model Definitions
//!
//! Defines Sequence, Track, Clip and related types for timeline management.
//! Uses denormalized structure for efficient Event Sourcing operations.

use serde::{Deserialize, Serialize};

use crate::core::{AssetId, ClipId, Color, EffectId, Point2D, Ratio, SequenceId, TimeSec, TrackId};

// =============================================================================
// Sequence Format
// =============================================================================

/// Sequence format specification
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
}

impl Default for SequenceFormat {
    fn default() -> Self {
        Self::shorts_1080()
    }
}

/// Canvas size
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
}

impl Canvas {
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// Returns the aspect ratio as a float
    pub fn aspect_ratio(&self) -> f64 {
        self.width as f64 / self.height as f64
    }
}

// =============================================================================
// Marker
// =============================================================================

/// Marker type enumeration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkerType {
    Generic,
    Chapter,
    Hook,
    Cta,
    Todo,
}

/// Timeline marker
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub id: SequenceId,
    pub name: String,
    pub format: SequenceFormat,
    /// Tracks stored directly for efficient Event Sourcing
    pub tracks: Vec<Track>,
    pub markers: Vec<Marker>,
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

    /// Calculates the total duration of the sequence
    pub fn duration(&self) -> TimeSec {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(|c| c.place.timeline_out_sec())
            .fold(0.0, f64::max)
    }
}

// =============================================================================
// Track
// =============================================================================

/// Track type/kind enumeration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
    Caption,
    Overlay,
}

/// Blend mode for video tracks
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    Normal,
    Multiply,
    Screen,
    Overlay,
    Add,
}

impl Default for BlendMode {
    fn default() -> Self {
        Self::Normal
    }
}

/// Track (contains clips directly for denormalized storage)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: TrackId,
    pub kind: TrackKind,
    pub name: String,
    /// Clips stored directly for efficient Event Sourcing
    pub clips: Vec<Clip>,
    pub blend_mode: BlendMode,
    pub muted: bool,
    pub locked: bool,
    pub visible: bool,
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
            muted: false,
            locked: false,
            visible: true,
            volume: 1.0,
        }
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
}

// =============================================================================
// Clip Range and Placement
// =============================================================================

/// Clip range within source asset
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipPlace {
    /// Start time on timeline (seconds)
    pub timeline_in_sec: TimeSec,
    /// Duration on timeline (seconds) - may differ from source due to speed
    pub duration_sec: TimeSec,
}

impl ClipPlace {
    pub fn new(timeline_in: TimeSec, duration: TimeSec) -> Self {
        Self {
            timeline_in_sec: timeline_in,
            duration_sec: duration,
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

    /// Checks if a time point is within this placement
    pub fn contains(&self, time_sec: TimeSec) -> bool {
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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

/// Audio settings for clips
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    /// Volume in dB (-60 to +6)
    pub volume_db: f32,
    /// Pan (-1.0 left, 0.0 center, 1.0 right)
    pub pan: f32,
    /// Whether audio is muted
    pub muted: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            volume_db: 0.0,
            pan: 0.0,
            muted: false,
        }
    }
}

// =============================================================================
// Clip
// =============================================================================

/// Clip (media segment on timeline)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    /// Playback speed (1.0 = normal)
    pub speed: f32,
    pub effects: Vec<EffectId>,
    pub audio: AudioSettings,
    /// Optional label for organization
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Optional color for UI
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
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
            speed: 1.0,
            effects: vec![],
            audio: AudioSettings::default(),
            label: None,
            color: None,
        }
    }

    /// Creates a new clip with specific range
    pub fn with_range(asset_id: &str, source_in: TimeSec, source_out: TimeSec) -> Self {
        let duration = source_out - source_in;
        Self {
            id: ulid::Ulid::new().to_string(),
            asset_id: asset_id.to_string(),
            range: ClipRange::new(source_in, source_out),
            place: ClipPlace::new(0.0, duration),
            transform: Transform::default(),
            opacity: 1.0,
            speed: 1.0,
            effects: vec![],
            audio: AudioSettings::default(),
            label: None,
            color: None,
        }
    }

    /// Places the clip at a specific timeline position
    pub fn place_at(mut self, timeline_in: TimeSec) -> Self {
        self.place.timeline_in_sec = timeline_in;
        self
    }

    /// Sets the clip range from source
    pub fn with_source_range(mut self, source_in: TimeSec, source_out: TimeSec) -> Self {
        self.range = ClipRange::new(source_in, source_out);
        self.place.duration_sec = self.range.duration() / self.speed as f64;
        self
    }

    /// Returns the effective duration considering speed
    pub fn duration(&self) -> TimeSec {
        self.range.duration() / self.speed as f64
    }

    /// Returns the timeline end position
    pub fn timeline_end(&self) -> TimeSec {
        self.place.timeline_out_sec()
    }

    /// Checks if this clip contains the given timeline position
    pub fn contains_time(&self, time_sec: TimeSec) -> bool {
        self.place.contains(time_sec)
    }

    /// Converts a timeline time to source time
    pub fn timeline_to_source(&self, timeline_sec: TimeSec) -> TimeSec {
        let offset = timeline_sec - self.place.timeline_in_sec;
        self.range.source_in_sec + (offset * self.speed as f64)
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

        assert!(clip.contains_time(0.0));
        assert!(clip.contains_time(5.0));
        assert!(clip.contains_time(10.0));
        assert!(!clip.contains_time(11.0));
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
}

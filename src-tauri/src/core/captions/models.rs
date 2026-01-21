//! Caption Data Models
//!
//! Defines data structures for captions and subtitles.
//!
//! # Overview
//!
//! Captions in OpenReelio support:
//! - Multiple caption tracks per timeline
//! - Individual caption styling
//! - SRT/VTT import/export
//! - FFmpeg subtitle filter generation

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// =============================================================================
// Type Aliases
// =============================================================================

/// Unique identifier for a caption
pub type CaptionId = String;

/// Unique identifier for a caption track
pub type CaptionTrackId = String;

// =============================================================================
// Caption Positioning
// =============================================================================

/// Vertical position of caption on screen
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum VerticalPosition {
    /// Bottom of screen (default for subtitles)
    #[default]
    Bottom,
    /// Top of screen
    Top,
    /// Center of screen
    Center,
}

/// Horizontal alignment of caption text
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TextAlignment {
    /// Left-aligned
    Left,
    /// Centered (default)
    #[default]
    Center,
    /// Right-aligned
    Right,
}

/// Custom position with x/y coordinates
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomPosition {
    /// X position as percentage (0-100) from left
    pub x_percent: f64,
    /// Y position as percentage (0-100) from top
    pub y_percent: f64,
}

impl Default for CustomPosition {
    fn default() -> Self {
        Self {
            x_percent: 50.0,
            y_percent: 90.0, // Near bottom
        }
    }
}

/// Caption position on screen
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum CaptionPosition {
    /// Preset vertical position
    #[serde(rename_all = "camelCase")]
    Preset {
        vertical: VerticalPosition,
        #[serde(alias = "margin_percent")]
        margin_percent: f64,
    },
    /// Custom x/y position
    Custom(CustomPosition),
}

impl Default for CaptionPosition {
    fn default() -> Self {
        Self::Preset {
            vertical: VerticalPosition::Bottom,
            margin_percent: 5.0,
        }
    }
}

// =============================================================================
// Caption Styling
// =============================================================================

/// RGBA color value (0-255 for each component)
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    /// Creates a new color from RGBA components
    pub fn rgba(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }

    /// Creates an opaque color from RGB components
    pub fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self::rgba(r, g, b, 255)
    }

    /// White color
    pub fn white() -> Self {
        Self::rgb(255, 255, 255)
    }

    /// Black color
    pub fn black() -> Self {
        Self::rgb(0, 0, 0)
    }

    /// Yellow color (common for subtitles)
    pub fn yellow() -> Self {
        Self::rgb(255, 255, 0)
    }

    /// Converts to hex string (e.g., "FFFFFF" or "FFFFFFFF" with alpha)
    pub fn to_hex(&self) -> String {
        if self.a == 255 {
            format!("{:02X}{:02X}{:02X}", self.r, self.g, self.b)
        } else {
            format!("{:02X}{:02X}{:02X}{:02X}", self.r, self.g, self.b, self.a)
        }
    }

    /// Converts to ASS/SSA color format (&HAABBGGRR)
    pub fn to_ass_color(&self) -> String {
        format!(
            "&H{:02X}{:02X}{:02X}{:02X}",
            255 - self.a,
            self.b,
            self.g,
            self.r
        )
    }
}

impl Default for Color {
    fn default() -> Self {
        Self::white()
    }
}

/// Font weight
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FontWeight {
    #[default]
    Normal,
    Bold,
    Light,
}

/// Caption text style
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionStyle {
    /// Font family name
    pub font_family: String,
    /// Font size in points
    pub font_size: u32,
    /// Font weight
    pub font_weight: FontWeight,
    /// Text color
    pub color: Color,
    /// Background/box color (None = transparent)
    pub background_color: Option<Color>,
    /// Outline/stroke color (None = no outline)
    pub outline_color: Option<Color>,
    /// Outline width in pixels
    pub outline_width: f32,
    /// Shadow color (None = no shadow)
    pub shadow_color: Option<Color>,
    /// Shadow offset in pixels
    pub shadow_offset: f32,
    /// Text alignment
    pub alignment: TextAlignment,
    /// Whether text is italic
    pub italic: bool,
    /// Whether text is underlined
    pub underline: bool,
}

impl Default for CaptionStyle {
    fn default() -> Self {
        Self {
            font_family: "Arial".to_string(),
            font_size: 48,
            font_weight: FontWeight::Normal,
            color: Color::white(),
            background_color: None,
            outline_color: Some(Color::black()),
            outline_width: 2.0,
            shadow_color: Some(Color::rgba(0, 0, 0, 128)),
            shadow_offset: 2.0,
            alignment: TextAlignment::Center,
            italic: false,
            underline: false,
        }
    }
}

impl CaptionStyle {
    /// Creates a minimal style with just white text
    pub fn minimal() -> Self {
        Self {
            outline_color: None,
            outline_width: 0.0,
            shadow_color: None,
            shadow_offset: 0.0,
            ..Default::default()
        }
    }

    /// Creates a style with background box
    pub fn with_background() -> Self {
        Self {
            background_color: Some(Color::rgba(0, 0, 0, 180)),
            outline_color: None,
            outline_width: 0.0,
            shadow_color: None,
            shadow_offset: 0.0,
            ..Default::default()
        }
    }

    /// Creates a yellow subtitle style
    pub fn yellow_subtitle() -> Self {
        Self {
            color: Color::yellow(),
            ..Default::default()
        }
    }
}

// =============================================================================
// Caption Entry
// =============================================================================

/// A single caption entry with text and timing
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    /// Unique identifier
    pub id: CaptionId,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Caption text (may contain line breaks)
    pub text: String,
    /// Optional per-caption style override
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_override: Option<CaptionStyle>,
    /// Optional per-caption position override
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position_override: Option<CaptionPosition>,
    /// Speaker identifier for multi-speaker captions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// Additional metadata
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, String>,
}

impl Caption {
    /// Creates a new caption with the given text and timing
    pub fn new(id: &str, start_sec: f64, end_sec: f64, text: &str) -> Self {
        Self {
            id: id.to_string(),
            start_sec,
            end_sec,
            text: text.to_string(),
            style_override: None,
            position_override: None,
            speaker: None,
            metadata: HashMap::new(),
        }
    }

    /// Creates a caption with auto-generated ID
    pub fn create(start_sec: f64, end_sec: f64, text: &str) -> Self {
        Self::new(&ulid::Ulid::new().to_string(), start_sec, end_sec, text)
    }

    /// Returns the duration of this caption in seconds
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }

    /// Returns true if the caption is visible at the given time
    pub fn is_visible_at(&self, time_sec: f64) -> bool {
        time_sec >= self.start_sec && time_sec < self.end_sec
    }

    /// Returns true if this caption overlaps with another
    pub fn overlaps(&self, other: &Caption) -> bool {
        self.start_sec < other.end_sec && self.end_sec > other.start_sec
    }

    /// Sets the speaker for this caption
    pub fn with_speaker(mut self, speaker: &str) -> Self {
        self.speaker = Some(speaker.to_string());
        self
    }

    /// Sets a style override for this caption
    pub fn with_style(mut self, style: CaptionStyle) -> Self {
        self.style_override = Some(style);
        self
    }
}

// =============================================================================
// Caption Track
// =============================================================================

/// A track containing multiple captions
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTrack {
    /// Unique identifier
    pub id: CaptionTrackId,
    /// Display name
    pub name: String,
    /// Language code (e.g., "en", "ko", "ja")
    pub language: String,
    /// Whether this track is visible
    pub visible: bool,
    /// Whether this track is locked (cannot be edited)
    pub locked: bool,
    /// Default style for captions in this track
    pub default_style: CaptionStyle,
    /// Default position for captions in this track
    pub default_position: CaptionPosition,
    /// List of captions in this track
    pub captions: Vec<Caption>,
    /// Track order (for display)
    pub order: u32,
}

impl CaptionTrack {
    /// Creates a new caption track
    pub fn new(id: &str, name: &str, language: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            language: language.to_string(),
            visible: true,
            locked: false,
            default_style: CaptionStyle::default(),
            default_position: CaptionPosition::default(),
            captions: vec![],
            order: 0,
        }
    }

    /// Creates a track with auto-generated ID
    pub fn create(name: &str, language: &str) -> Self {
        Self::new(&ulid::Ulid::new().to_string(), name, language)
    }

    /// Adds a caption to this track
    pub fn add_caption(&mut self, caption: Caption) {
        self.captions.push(caption);
        self.sort_captions();
    }

    /// Removes a caption by ID
    pub fn remove_caption(&mut self, caption_id: &str) -> Option<Caption> {
        if let Some(pos) = self.captions.iter().position(|c| c.id == caption_id) {
            Some(self.captions.remove(pos))
        } else {
            None
        }
    }

    /// Gets a caption by ID
    pub fn get_caption(&self, caption_id: &str) -> Option<&Caption> {
        self.captions.iter().find(|c| c.id == caption_id)
    }

    /// Gets a mutable caption by ID
    pub fn get_caption_mut(&mut self, caption_id: &str) -> Option<&mut Caption> {
        self.captions.iter_mut().find(|c| c.id == caption_id)
    }

    /// Sorts captions by start time
    pub fn sort_captions(&mut self) {
        self.captions.sort_by(|a, b| {
            a.start_sec
                .partial_cmp(&b.start_sec)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    /// Returns captions visible at the given time
    pub fn captions_at(&self, time_sec: f64) -> Vec<&Caption> {
        self.captions
            .iter()
            .filter(|c| c.is_visible_at(time_sec))
            .collect()
    }

    /// Returns captions in a time range
    pub fn captions_in_range(&self, start_sec: f64, end_sec: f64) -> Vec<&Caption> {
        self.captions
            .iter()
            .filter(|c| c.start_sec < end_sec && c.end_sec > start_sec)
            .collect()
    }

    /// Returns the total duration spanned by captions
    pub fn duration(&self) -> f64 {
        self.captions.last().map(|c| c.end_sec).unwrap_or(0.0)
    }

    /// Returns the full text of all captions
    pub fn full_text(&self) -> String {
        self.captions
            .iter()
            .map(|c| c.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Returns the number of captions
    pub fn len(&self) -> usize {
        self.captions.len()
    }

    /// Returns true if the track has no captions
    pub fn is_empty(&self) -> bool {
        self.captions.is_empty()
    }
}

impl Default for CaptionTrack {
    fn default() -> Self {
        Self::create("Subtitles", "en")
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // Color Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_color_creation() {
        let color = Color::rgba(255, 128, 64, 200);
        assert_eq!(color.r, 255);
        assert_eq!(color.g, 128);
        assert_eq!(color.b, 64);
        assert_eq!(color.a, 200);
    }

    #[test]
    fn test_color_hex() {
        let white = Color::white();
        assert_eq!(white.to_hex(), "FFFFFF");

        let semi_transparent = Color::rgba(255, 0, 0, 128);
        assert_eq!(semi_transparent.to_hex(), "FF000080");
    }

    #[test]
    fn test_color_ass_format() {
        let white = Color::white();
        // ASS format is &HAABBGGRR (alpha inverted)
        assert_eq!(white.to_ass_color(), "&H00FFFFFF");
    }

    // -------------------------------------------------------------------------
    // Caption Style Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_default_style() {
        let style = CaptionStyle::default();
        assert_eq!(style.font_family, "Arial");
        assert_eq!(style.font_size, 48);
        assert!(style.outline_color.is_some());
    }

    #[test]
    fn test_minimal_style() {
        let style = CaptionStyle::minimal();
        assert!(style.outline_color.is_none());
        assert!(style.shadow_color.is_none());
    }

    #[test]
    fn test_background_style() {
        let style = CaptionStyle::with_background();
        assert!(style.background_color.is_some());
    }

    // -------------------------------------------------------------------------
    // Caption Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_caption_creation() {
        let caption = Caption::new("cap1", 0.0, 5.0, "Hello World");
        assert_eq!(caption.id, "cap1");
        assert_eq!(caption.start_sec, 0.0);
        assert_eq!(caption.end_sec, 5.0);
        assert_eq!(caption.text, "Hello World");
    }

    #[test]
    fn test_caption_duration() {
        let caption = Caption::new("cap1", 1.5, 4.5, "Test");
        assert_eq!(caption.duration(), 3.0);
    }

    #[test]
    fn test_caption_visibility() {
        let caption = Caption::new("cap1", 2.0, 5.0, "Test");

        assert!(!caption.is_visible_at(1.0));
        assert!(caption.is_visible_at(2.0));
        assert!(caption.is_visible_at(3.5));
        assert!(caption.is_visible_at(4.99));
        assert!(!caption.is_visible_at(5.0));
    }

    #[test]
    fn test_caption_overlap() {
        let cap1 = Caption::new("cap1", 0.0, 3.0, "First");
        let cap2 = Caption::new("cap2", 2.0, 5.0, "Second");
        let cap3 = Caption::new("cap3", 4.0, 6.0, "Third");

        assert!(cap1.overlaps(&cap2)); // Overlapping
        assert!(!cap1.overlaps(&cap3)); // Not overlapping
    }

    #[test]
    fn test_caption_with_speaker() {
        let caption = Caption::create(0.0, 2.0, "Hello").with_speaker("John");
        assert_eq!(caption.speaker, Some("John".to_string()));
    }

    // -------------------------------------------------------------------------
    // Caption Track Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_track_creation() {
        let track = CaptionTrack::new("track1", "English Subtitles", "en");
        assert_eq!(track.id, "track1");
        assert_eq!(track.name, "English Subtitles");
        assert_eq!(track.language, "en");
        assert!(track.visible);
        assert!(!track.locked);
    }

    #[test]
    fn test_track_add_caption() {
        let mut track = CaptionTrack::default();

        track.add_caption(Caption::create(5.0, 8.0, "Second"));
        track.add_caption(Caption::create(0.0, 3.0, "First"));

        assert_eq!(track.len(), 2);
        // Should be sorted by time
        assert_eq!(track.captions[0].text, "First");
        assert_eq!(track.captions[1].text, "Second");
    }

    #[test]
    fn test_track_remove_caption() {
        let mut track = CaptionTrack::default();
        let cap = Caption::new("cap1", 0.0, 2.0, "Test");
        track.add_caption(cap);

        let removed = track.remove_caption("cap1");
        assert!(removed.is_some());
        assert_eq!(removed.unwrap().text, "Test");
        assert!(track.is_empty());
    }

    #[test]
    fn test_track_captions_at_time() {
        let mut track = CaptionTrack::default();
        track.add_caption(Caption::create(0.0, 2.0, "First"));
        track.add_caption(Caption::create(1.5, 3.5, "Second"));
        track.add_caption(Caption::create(4.0, 6.0, "Third"));

        let at_1 = track.captions_at(1.0);
        assert_eq!(at_1.len(), 1);
        assert_eq!(at_1[0].text, "First");

        let at_1_75 = track.captions_at(1.75);
        assert_eq!(at_1_75.len(), 2); // Both first and second

        let at_5 = track.captions_at(5.0);
        assert_eq!(at_5.len(), 1);
        assert_eq!(at_5[0].text, "Third");
    }

    #[test]
    fn test_track_captions_in_range() {
        let mut track = CaptionTrack::default();
        track.add_caption(Caption::create(0.0, 2.0, "First"));
        track.add_caption(Caption::create(3.0, 5.0, "Second"));
        track.add_caption(Caption::create(6.0, 8.0, "Third"));

        let in_range = track.captions_in_range(1.0, 4.0);
        assert_eq!(in_range.len(), 2); // First and Second
    }

    #[test]
    fn test_track_full_text() {
        let mut track = CaptionTrack::default();
        track.add_caption(Caption::create(0.0, 2.0, "Hello"));
        track.add_caption(Caption::create(2.0, 4.0, "World"));

        assert_eq!(track.full_text(), "Hello\nWorld");
    }

    #[test]
    fn test_track_duration() {
        let mut track = CaptionTrack::default();
        track.add_caption(Caption::create(0.0, 3.0, "First"));
        track.add_caption(Caption::create(5.0, 10.0, "Last"));

        assert_eq!(track.duration(), 10.0);
    }

    // -------------------------------------------------------------------------
    // Serialization Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_caption_serialization() {
        let caption = Caption::new("cap1", 1.5, 4.5, "Hello World");
        let json = serde_json::to_string(&caption).unwrap();
        let parsed: Caption = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, caption.id);
        assert_eq!(parsed.start_sec, caption.start_sec);
        assert_eq!(parsed.text, caption.text);
    }

    #[test]
    fn test_style_serialization() {
        let style = CaptionStyle::default();
        let json = serde_json::to_string(&style).unwrap();
        let parsed: CaptionStyle = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.font_family, style.font_family);
        assert_eq!(parsed.font_size, style.font_size);
    }

    #[test]
    fn test_position_serialization() {
        let preset = CaptionPosition::default();
        let json = serde_json::to_string(&preset).unwrap();
        assert!(json.contains("preset"));

        let custom = CaptionPosition::Custom(CustomPosition {
            x_percent: 25.0,
            y_percent: 75.0,
        });
        let json = serde_json::to_string(&custom).unwrap();
        assert!(json.contains("custom"));
    }
}

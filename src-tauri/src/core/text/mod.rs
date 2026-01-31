//! Text/Title System Module
//!
//! Provides data models and utilities for text overlays in video editing.
//! Text clips are visual elements that can be placed on the timeline with
//! customizable styling, positioning, shadows, and outlines.
//!
//! # Architecture
//!
//! Text is implemented as a special clip type that renders via FFmpeg's
//! `drawtext` filter. The text data is stored in `TextClipData` which
//! contains all styling and positioning information.
//!
//! # Example
//!
//! ```rust,ignore
//! use crate::core::text::{TextClipData, TextStyle, TextAlignment};
//!
//! let mut text = TextClipData::default();
//! text.content = "Hello World".to_string();
//! text.style.font_size = 72;
//! text.style.alignment = TextAlignment::Center;
//! ```

use serde::{Deserialize, Serialize};
use specta::Type;

// =============================================================================
// Text Alignment
// =============================================================================

/// Text alignment options for horizontal text positioning.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum TextAlignment {
    /// Align text to the left
    Left,
    /// Align text to the center (default)
    #[default]
    Center,
    /// Align text to the right
    Right,
}

// =============================================================================
// Text Style
// =============================================================================

/// Text styling configuration.
///
/// Controls the visual appearance of text including font, size, color,
/// and formatting options.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    /// Font family name (system font)
    /// Common values: "Arial", "Helvetica", "Times New Roman", "Georgia", "Courier New"
    pub font_family: String,

    /// Font size in points (12-200 typical range)
    pub font_size: u32,

    /// Text color in hex format (#RRGGBB or #RRGGBBAA)
    pub color: String,

    /// Background color (optional, for lower thirds or text boxes)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,

    /// Background padding in pixels (applies when background_color is set)
    #[serde(default = "default_background_padding")]
    pub background_padding: u32,

    /// Text alignment
    #[serde(default)]
    pub alignment: TextAlignment,

    /// Bold text
    #[serde(default)]
    pub bold: bool,

    /// Italic text
    #[serde(default)]
    pub italic: bool,

    /// Underline text
    #[serde(default)]
    pub underline: bool,

    /// Line height multiplier (1.0 = normal, 1.5 = 150% spacing)
    #[serde(default = "default_line_height")]
    pub line_height: f64,

    /// Letter spacing in pixels (0 = normal, positive = expanded, negative = condensed)
    #[serde(default)]
    pub letter_spacing: i32,
}

fn default_background_padding() -> u32 {
    10
}

fn default_line_height() -> f64 {
    1.2
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            font_family: "Arial".to_string(),
            font_size: 48,
            color: "#FFFFFF".to_string(),
            background_color: None,
            background_padding: default_background_padding(),
            alignment: TextAlignment::Center,
            bold: false,
            italic: false,
            underline: false,
            line_height: default_line_height(),
            letter_spacing: 0,
        }
    }
}

impl TextStyle {
    /// Creates a new TextStyle with default values.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the font family.
    pub fn with_font_family(mut self, family: impl Into<String>) -> Self {
        self.font_family = family.into();
        self
    }

    /// Sets the font size.
    pub fn with_font_size(mut self, size: u32) -> Self {
        self.font_size = size.clamp(1, 500);
        self
    }

    /// Sets the text color.
    pub fn with_color(mut self, color: impl Into<String>) -> Self {
        self.color = color.into();
        self
    }

    /// Sets bold formatting.
    pub fn with_bold(mut self, bold: bool) -> Self {
        self.bold = bold;
        self
    }

    /// Sets italic formatting.
    pub fn with_italic(mut self, italic: bool) -> Self {
        self.italic = italic;
        self
    }

    /// Sets the text alignment.
    pub fn with_alignment(mut self, alignment: TextAlignment) -> Self {
        self.alignment = alignment;
        self
    }

    /// Sets the background color for text box effect.
    pub fn with_background(mut self, color: impl Into<String>) -> Self {
        self.background_color = Some(color.into());
        self
    }
}

// =============================================================================
// Text Shadow
// =============================================================================

/// Text shadow effect configuration.
///
/// Creates a drop shadow behind the text for improved readability
/// or visual effect.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextShadow {
    /// Shadow color in hex format (#RRGGBB or #RRGGBBAA)
    pub color: String,

    /// Horizontal offset in pixels (positive = right)
    pub offset_x: i32,

    /// Vertical offset in pixels (positive = down)
    pub offset_y: i32,

    /// Shadow blur radius (0 = sharp shadow)
    /// Note: FFmpeg drawtext doesn't support blur, so this is for future use
    /// or canvas-based preview rendering.
    #[serde(default)]
    pub blur: u32,
}

impl Default for TextShadow {
    fn default() -> Self {
        Self {
            color: "#000000".to_string(),
            offset_x: 2,
            offset_y: 2,
            blur: 0,
        }
    }
}

impl TextShadow {
    /// Creates a new shadow with the specified offset.
    pub fn new(offset_x: i32, offset_y: i32) -> Self {
        Self {
            color: "#000000".to_string(),
            offset_x,
            offset_y,
            blur: 0,
        }
    }

    /// Creates a soft shadow (larger offset, semi-transparent).
    pub fn soft() -> Self {
        Self {
            color: "#00000080".to_string(),
            offset_x: 4,
            offset_y: 4,
            blur: 4,
        }
    }

    /// Creates a hard shadow (small offset, opaque).
    pub fn hard() -> Self {
        Self {
            color: "#000000".to_string(),
            offset_x: 2,
            offset_y: 2,
            blur: 0,
        }
    }

    /// Sets the shadow color.
    pub fn with_color(mut self, color: impl Into<String>) -> Self {
        self.color = color.into();
        self
    }
}

// =============================================================================
// Text Outline
// =============================================================================

/// Text outline (stroke) effect configuration.
///
/// Creates an outline around the text for improved readability,
/// especially on busy backgrounds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextOutline {
    /// Outline color in hex format (#RRGGBB or #RRGGBBAA)
    pub color: String,

    /// Outline width in pixels
    pub width: u32,
}

impl Default for TextOutline {
    fn default() -> Self {
        Self {
            color: "#000000".to_string(),
            width: 2,
        }
    }
}

impl TextOutline {
    /// Creates a new outline with the specified width.
    pub fn new(width: u32) -> Self {
        Self {
            color: "#000000".to_string(),
            width,
        }
    }

    /// Creates a thin outline.
    pub fn thin() -> Self {
        Self {
            color: "#000000".to_string(),
            width: 1,
        }
    }

    /// Creates a thick outline.
    pub fn thick() -> Self {
        Self {
            color: "#000000".to_string(),
            width: 4,
        }
    }

    /// Sets the outline color.
    pub fn with_color(mut self, color: impl Into<String>) -> Self {
        self.color = color.into();
        self
    }
}

// =============================================================================
// Text Position
// =============================================================================

/// Text position on screen using normalized coordinates.
///
/// Position is specified as normalized values (0.0 to 1.0) where:
/// - (0.0, 0.0) = top-left corner
/// - (0.5, 0.5) = center
/// - (1.0, 1.0) = bottom-right corner
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct TextPosition {
    /// X position (0.0 = left, 0.5 = center, 1.0 = right)
    pub x: f64,

    /// Y position (0.0 = top, 0.5 = center, 1.0 = bottom)
    pub y: f64,
}

impl Default for TextPosition {
    fn default() -> Self {
        Self { x: 0.5, y: 0.5 } // Center
    }
}

impl TextPosition {
    /// Creates a position at the specified normalized coordinates.
    pub fn new(x: f64, y: f64) -> Self {
        Self {
            x: x.clamp(0.0, 1.0),
            y: y.clamp(0.0, 1.0),
        }
    }

    /// Creates a position at the center of the screen.
    pub fn center() -> Self {
        Self { x: 0.5, y: 0.5 }
    }

    /// Creates a position at the top center (for titles).
    pub fn top() -> Self {
        Self { x: 0.5, y: 0.15 }
    }

    /// Creates a position at the bottom center (for lower thirds/captions).
    pub fn bottom() -> Self {
        Self { x: 0.5, y: 0.85 }
    }

    /// Creates a position at the lower third region.
    pub fn lower_third() -> Self {
        Self { x: 0.5, y: 0.80 }
    }

    /// Converts to pixel coordinates given canvas dimensions.
    ///
    /// # Arguments
    /// * `width` - Canvas width in pixels
    /// * `height` - Canvas height in pixels
    ///
    /// # Returns
    /// Tuple of (x, y) pixel coordinates
    pub fn to_pixels(&self, width: u32, height: u32) -> (i32, i32) {
        let x = (self.x * width as f64) as i32;
        let y = (self.y * height as f64) as i32;
        (x, y)
    }
}

// =============================================================================
// Text Clip Data
// =============================================================================

/// Complete text clip configuration.
///
/// Contains all properties needed to render a text overlay including
/// content, styling, positioning, and effects.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextClipData {
    /// The text content (can be multi-line with \n)
    pub content: String,

    /// Text styling (font, size, color, etc.)
    pub style: TextStyle,

    /// Position on screen (normalized coordinates)
    pub position: TextPosition,

    /// Optional shadow effect
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow: Option<TextShadow>,

    /// Optional outline/stroke effect
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outline: Option<TextOutline>,

    /// Rotation in degrees (clockwise)
    #[serde(default)]
    pub rotation: f64,

    /// Opacity (0.0 = transparent, 1.0 = opaque)
    #[serde(default = "default_opacity")]
    pub opacity: f64,
}

fn default_opacity() -> f64 {
    1.0
}

impl Default for TextClipData {
    fn default() -> Self {
        Self {
            content: "Title".to_string(),
            style: TextStyle::default(),
            position: TextPosition::default(),
            shadow: None,
            outline: None,
            rotation: 0.0,
            opacity: default_opacity(),
        }
    }
}

impl TextClipData {
    /// Creates a new text clip with default values.
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            ..Default::default()
        }
    }

    /// Creates a title-style text (large, centered at top).
    pub fn title(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            style: TextStyle::default().with_font_size(72).with_bold(true),
            position: TextPosition::top(),
            shadow: Some(TextShadow::soft()),
            outline: None,
            rotation: 0.0,
            opacity: 1.0,
        }
    }

    /// Creates a lower-third style text (positioned at bottom third).
    pub fn lower_third(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            style: TextStyle::default()
                .with_font_size(36)
                .with_background("#000000CC".to_string()),
            position: TextPosition::lower_third(),
            shadow: None,
            outline: None,
            rotation: 0.0,
            opacity: 1.0,
        }
    }

    /// Creates a subtitle-style text (positioned at bottom).
    pub fn subtitle(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            style: TextStyle::default()
                .with_font_size(32)
                .with_background("#000000AA".to_string()),
            position: TextPosition::bottom(),
            shadow: None,
            outline: Some(TextOutline::thin()),
            rotation: 0.0,
            opacity: 1.0,
        }
    }

    /// Sets the text content.
    pub fn with_content(mut self, content: impl Into<String>) -> Self {
        self.content = content.into();
        self
    }

    /// Sets the text style.
    pub fn with_style(mut self, style: TextStyle) -> Self {
        self.style = style;
        self
    }

    /// Sets the position.
    pub fn with_position(mut self, position: TextPosition) -> Self {
        self.position = position;
        self
    }

    /// Adds a shadow effect.
    pub fn with_shadow(mut self, shadow: TextShadow) -> Self {
        self.shadow = Some(shadow);
        self
    }

    /// Adds an outline effect.
    pub fn with_outline(mut self, outline: TextOutline) -> Self {
        self.outline = Some(outline);
        self
    }

    /// Sets the rotation angle in degrees.
    pub fn with_rotation(mut self, degrees: f64) -> Self {
        self.rotation = degrees % 360.0;
        self
    }

    /// Sets the opacity (0.0 - 1.0).
    pub fn with_opacity(mut self, opacity: f64) -> Self {
        self.opacity = opacity.clamp(0.0, 1.0);
        self
    }

    /// Validates the text clip data.
    ///
    /// Returns an error message if validation fails.
    pub fn validate(&self) -> Result<(), String> {
        // Content validation
        if self.content.is_empty() {
            return Err("Text content cannot be empty".to_string());
        }

        if self.content.len() > 10000 {
            return Err("Text content too long (max 10000 characters)".to_string());
        }

        // Style validation
        if self.style.font_size == 0 {
            return Err("Font size must be greater than 0".to_string());
        }

        if self.style.font_size > 500 {
            return Err("Font size too large (max 500)".to_string());
        }

        // Color validation (basic hex check)
        if !is_valid_hex_color(&self.style.color) {
            return Err(format!("Invalid text color format: {}", self.style.color));
        }

        if let Some(ref bg) = self.style.background_color {
            if !is_valid_hex_color(bg) {
                return Err(format!("Invalid background color format: {}", bg));
            }
        }

        // Shadow validation
        if let Some(ref shadow) = self.shadow {
            if !is_valid_hex_color(&shadow.color) {
                return Err(format!("Invalid shadow color format: {}", shadow.color));
            }
        }

        // Outline validation
        if let Some(ref outline) = self.outline {
            if !is_valid_hex_color(&outline.color) {
                return Err(format!("Invalid outline color format: {}", outline.color));
            }
            if outline.width > 50 {
                return Err("Outline width too large (max 50)".to_string());
            }
        }

        // Opacity validation
        if !self.opacity.is_finite() {
            return Err("Opacity must be a finite number".to_string());
        }

        // Rotation validation
        if !self.rotation.is_finite() {
            return Err("Rotation must be a finite number".to_string());
        }

        Ok(())
    }
}

/// Validates hex color format.
///
/// Accepts: #RGB, #RGBA, #RRGGBB, #RRGGBBAA
fn is_valid_hex_color(color: &str) -> bool {
    let color = color.trim();
    if !color.starts_with('#') {
        return false;
    }

    let hex = &color[1..];
    let len = hex.len();

    if len != 3 && len != 4 && len != 6 && len != 8 {
        return false;
    }

    hex.chars().all(|c| c.is_ascii_hexdigit())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // TextAlignment Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_text_alignment_default() {
        let alignment = TextAlignment::default();
        assert_eq!(alignment, TextAlignment::Center);
    }

    #[test]
    fn test_text_alignment_serialization() {
        assert_eq!(
            serde_json::to_string(&TextAlignment::Left).unwrap(),
            "\"left\""
        );
        assert_eq!(
            serde_json::to_string(&TextAlignment::Center).unwrap(),
            "\"center\""
        );
        assert_eq!(
            serde_json::to_string(&TextAlignment::Right).unwrap(),
            "\"right\""
        );
    }

    #[test]
    fn test_text_alignment_deserialization() {
        assert_eq!(
            serde_json::from_str::<TextAlignment>("\"left\"").unwrap(),
            TextAlignment::Left
        );
        assert_eq!(
            serde_json::from_str::<TextAlignment>("\"center\"").unwrap(),
            TextAlignment::Center
        );
        assert_eq!(
            serde_json::from_str::<TextAlignment>("\"right\"").unwrap(),
            TextAlignment::Right
        );
    }

    // -------------------------------------------------------------------------
    // TextStyle Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_text_style_default() {
        let style = TextStyle::default();
        assert_eq!(style.font_family, "Arial");
        assert_eq!(style.font_size, 48);
        assert_eq!(style.color, "#FFFFFF");
        assert_eq!(style.alignment, TextAlignment::Center);
        assert!(!style.bold);
        assert!(!style.italic);
        assert!(!style.underline);
        assert!(style.background_color.is_none());
    }

    #[test]
    fn test_text_style_builder() {
        let style = TextStyle::new()
            .with_font_family("Helvetica")
            .with_font_size(72)
            .with_color("#FF0000")
            .with_bold(true)
            .with_italic(true)
            .with_alignment(TextAlignment::Left)
            .with_background("#000000AA");

        assert_eq!(style.font_family, "Helvetica");
        assert_eq!(style.font_size, 72);
        assert_eq!(style.color, "#FF0000");
        assert!(style.bold);
        assert!(style.italic);
        assert_eq!(style.alignment, TextAlignment::Left);
        assert_eq!(style.background_color, Some("#000000AA".to_string()));
    }

    #[test]
    fn test_text_style_font_size_clamped() {
        let style = TextStyle::new().with_font_size(1000);
        assert_eq!(style.font_size, 500); // Max clamp

        let style = TextStyle::new().with_font_size(0);
        assert_eq!(style.font_size, 1); // Min clamp
    }

    #[test]
    fn test_text_style_serialization() {
        let style = TextStyle::default();
        let json = serde_json::to_string(&style).unwrap();
        let parsed: TextStyle = serde_json::from_str(&json).unwrap();

        assert_eq!(style.font_family, parsed.font_family);
        assert_eq!(style.font_size, parsed.font_size);
        assert_eq!(style.color, parsed.color);
    }

    // -------------------------------------------------------------------------
    // TextShadow Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_text_shadow_default() {
        let shadow = TextShadow::default();
        assert_eq!(shadow.color, "#000000");
        assert_eq!(shadow.offset_x, 2);
        assert_eq!(shadow.offset_y, 2);
        assert_eq!(shadow.blur, 0);
    }

    #[test]
    fn test_text_shadow_presets() {
        let soft = TextShadow::soft();
        assert_eq!(soft.offset_x, 4);
        assert_eq!(soft.offset_y, 4);
        assert_eq!(soft.blur, 4);

        let hard = TextShadow::hard();
        assert_eq!(hard.offset_x, 2);
        assert_eq!(hard.offset_y, 2);
        assert_eq!(hard.blur, 0);
    }

    #[test]
    fn test_text_shadow_builder() {
        let shadow = TextShadow::new(5, 5).with_color("#FF0000");
        assert_eq!(shadow.color, "#FF0000");
        assert_eq!(shadow.offset_x, 5);
        assert_eq!(shadow.offset_y, 5);
    }

    #[test]
    fn test_text_shadow_serialization() {
        let shadow = TextShadow::default();
        let json = serde_json::to_string(&shadow).unwrap();
        let parsed: TextShadow = serde_json::from_str(&json).unwrap();

        assert_eq!(shadow, parsed);
    }

    // -------------------------------------------------------------------------
    // TextOutline Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_text_outline_default() {
        let outline = TextOutline::default();
        assert_eq!(outline.color, "#000000");
        assert_eq!(outline.width, 2);
    }

    #[test]
    fn test_text_outline_presets() {
        let thin = TextOutline::thin();
        assert_eq!(thin.width, 1);

        let thick = TextOutline::thick();
        assert_eq!(thick.width, 4);
    }

    #[test]
    fn test_text_outline_builder() {
        let outline = TextOutline::new(3).with_color("#FFFFFF");
        assert_eq!(outline.color, "#FFFFFF");
        assert_eq!(outline.width, 3);
    }

    #[test]
    fn test_text_outline_serialization() {
        let outline = TextOutline::default();
        let json = serde_json::to_string(&outline).unwrap();
        let parsed: TextOutline = serde_json::from_str(&json).unwrap();

        assert_eq!(outline, parsed);
    }

    // -------------------------------------------------------------------------
    // TextPosition Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_text_position_default() {
        let pos = TextPosition::default();
        assert!((pos.x - 0.5).abs() < 0.001);
        assert!((pos.y - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_text_position_presets() {
        let center = TextPosition::center();
        assert!((center.x - 0.5).abs() < 0.001);
        assert!((center.y - 0.5).abs() < 0.001);

        let top = TextPosition::top();
        assert!((top.x - 0.5).abs() < 0.001);
        assert!((top.y - 0.15).abs() < 0.001);

        let bottom = TextPosition::bottom();
        assert!((bottom.x - 0.5).abs() < 0.001);
        assert!((bottom.y - 0.85).abs() < 0.001);

        let lower_third = TextPosition::lower_third();
        assert!((lower_third.x - 0.5).abs() < 0.001);
        assert!((lower_third.y - 0.80).abs() < 0.001);
    }

    #[test]
    fn test_text_position_clamped() {
        let pos = TextPosition::new(2.0, -1.0);
        assert_eq!(pos.x, 1.0); // Clamped to max
        assert_eq!(pos.y, 0.0); // Clamped to min
    }

    #[test]
    fn test_text_position_to_pixels() {
        let pos = TextPosition::new(0.5, 0.5);
        let (x, y) = pos.to_pixels(1920, 1080);
        assert_eq!(x, 960);
        assert_eq!(y, 540);

        let pos = TextPosition::new(0.0, 1.0);
        let (x, y) = pos.to_pixels(1920, 1080);
        assert_eq!(x, 0);
        assert_eq!(y, 1080);
    }

    #[test]
    fn test_text_position_serialization() {
        let pos = TextPosition::default();
        let json = serde_json::to_string(&pos).unwrap();
        let parsed: TextPosition = serde_json::from_str(&json).unwrap();

        assert_eq!(pos, parsed);
    }

    // -------------------------------------------------------------------------
    // TextClipData Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_text_clip_data_default() {
        let clip = TextClipData::default();
        assert_eq!(clip.content, "Title");
        assert_eq!(clip.style.font_family, "Arial");
        assert_eq!(clip.style.font_size, 48);
        assert!((clip.position.x - 0.5).abs() < 0.001);
        assert!((clip.position.y - 0.5).abs() < 0.001);
        assert!(clip.shadow.is_none());
        assert!(clip.outline.is_none());
        assert_eq!(clip.rotation, 0.0);
        assert_eq!(clip.opacity, 1.0);
    }

    #[test]
    fn test_text_clip_data_new() {
        let clip = TextClipData::new("Hello World");
        assert_eq!(clip.content, "Hello World");
    }

    #[test]
    fn test_text_clip_data_title_preset() {
        let clip = TextClipData::title("My Title");
        assert_eq!(clip.content, "My Title");
        assert_eq!(clip.style.font_size, 72);
        assert!(clip.style.bold);
        assert!((clip.position.y - 0.15).abs() < 0.001);
        assert!(clip.shadow.is_some());
    }

    #[test]
    fn test_text_clip_data_lower_third_preset() {
        let clip = TextClipData::lower_third("Speaker Name");
        assert_eq!(clip.content, "Speaker Name");
        assert_eq!(clip.style.font_size, 36);
        assert!(clip.style.background_color.is_some());
        assert!((clip.position.y - 0.80).abs() < 0.001);
    }

    #[test]
    fn test_text_clip_data_subtitle_preset() {
        let clip = TextClipData::subtitle("Caption text");
        assert_eq!(clip.content, "Caption text");
        assert_eq!(clip.style.font_size, 32);
        assert!(clip.style.background_color.is_some());
        assert!(clip.outline.is_some());
        assert!((clip.position.y - 0.85).abs() < 0.001);
    }

    #[test]
    fn test_text_clip_data_builder() {
        let clip = TextClipData::new("Test")
            .with_style(TextStyle::default().with_font_size(24))
            .with_position(TextPosition::bottom())
            .with_shadow(TextShadow::soft())
            .with_outline(TextOutline::thin())
            .with_rotation(45.0)
            .with_opacity(0.8);

        assert_eq!(clip.content, "Test");
        assert_eq!(clip.style.font_size, 24);
        assert!((clip.position.y - 0.85).abs() < 0.001);
        assert!(clip.shadow.is_some());
        assert!(clip.outline.is_some());
        assert_eq!(clip.rotation, 45.0);
        assert!((clip.opacity - 0.8).abs() < 0.001);
    }

    #[test]
    fn test_text_clip_data_opacity_clamped() {
        let clip = TextClipData::new("Test").with_opacity(1.5);
        assert_eq!(clip.opacity, 1.0);

        let clip = TextClipData::new("Test").with_opacity(-0.5);
        assert_eq!(clip.opacity, 0.0);
    }

    #[test]
    fn test_text_clip_data_rotation_wrapped() {
        let clip = TextClipData::new("Test").with_rotation(450.0);
        assert!((clip.rotation - 90.0).abs() < 0.001);
    }

    #[test]
    fn test_text_clip_data_serialization() {
        let clip = TextClipData::default();
        let json = serde_json::to_string(&clip).unwrap();
        let parsed: TextClipData = serde_json::from_str(&json).unwrap();

        assert_eq!(clip.content, parsed.content);
        assert_eq!(clip.style.font_size, parsed.style.font_size);
    }

    #[test]
    fn test_text_clip_data_serialization_with_effects() {
        let clip = TextClipData::new("Test")
            .with_shadow(TextShadow::default())
            .with_outline(TextOutline::default());

        let json = serde_json::to_string(&clip).unwrap();
        let parsed: TextClipData = serde_json::from_str(&json).unwrap();

        assert!(parsed.shadow.is_some());
        assert!(parsed.outline.is_some());
    }

    // -------------------------------------------------------------------------
    // Validation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_text_clip_data_validate_success() {
        let clip = TextClipData::default();
        assert!(clip.validate().is_ok());
    }

    #[test]
    fn test_text_clip_data_validate_empty_content() {
        let clip = TextClipData::new("");
        let result = clip.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn test_text_clip_data_validate_content_too_long() {
        let long_content = "x".repeat(10001);
        let clip = TextClipData::new(long_content);
        let result = clip.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too long"));
    }

    #[test]
    fn test_text_clip_data_validate_invalid_color() {
        let mut clip = TextClipData::default();
        clip.style.color = "invalid".to_string();
        let result = clip.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid text color"));
    }

    #[test]
    fn test_text_clip_data_validate_invalid_shadow_color() {
        let clip = TextClipData {
            shadow: Some(TextShadow {
                color: "not-a-color".to_string(),
                offset_x: 2,
                offset_y: 2,
                blur: 0,
            }),
            ..Default::default()
        };
        let result = clip.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("shadow color"));
    }

    #[test]
    fn test_text_clip_data_validate_outline_too_wide() {
        let clip = TextClipData {
            outline: Some(TextOutline {
                color: "#000000".to_string(),
                width: 100,
            }),
            ..Default::default()
        };
        let result = clip.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Outline width too large"));
    }

    // -------------------------------------------------------------------------
    // Hex Color Validation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_is_valid_hex_color() {
        // Valid formats
        assert!(is_valid_hex_color("#FFF"));
        assert!(is_valid_hex_color("#FFFF"));
        assert!(is_valid_hex_color("#FFFFFF"));
        assert!(is_valid_hex_color("#FFFFFFFF"));
        assert!(is_valid_hex_color("#abc"));
        assert!(is_valid_hex_color("#123456"));

        // Invalid formats
        assert!(!is_valid_hex_color("FFF")); // Missing #
        assert!(!is_valid_hex_color("#FF")); // Too short
        assert!(!is_valid_hex_color("#FFFFF")); // Wrong length
        assert!(!is_valid_hex_color("#GGGGG")); // Invalid hex chars
        assert!(!is_valid_hex_color("")); // Empty
        assert!(!is_valid_hex_color("red")); // Named color
    }
}

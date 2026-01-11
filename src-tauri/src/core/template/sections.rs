//! Template Sections
//!
//! Defines template sections, content types, and style configurations.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::core::types::Color;

/// Type of content for a template section
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentType {
    /// Video content
    Video,
    /// Audio content (music, voice)
    Audio,
    /// Image content
    Image,
    /// Text overlay
    Text,
    /// Caption/subtitle
    Caption,
    /// Animation/motion graphics
    Animation,
    /// B-roll footage
    BRoll,
    /// Talking head / face-cam
    TalkingHead,
    /// Screen recording
    ScreenRecording,
    /// Transition placeholder
    Transition,
}

impl ContentType {
    /// Returns whether this content type is visual
    pub fn is_visual(&self) -> bool {
        matches!(
            self,
            ContentType::Video
                | ContentType::Image
                | ContentType::Text
                | ContentType::Animation
                | ContentType::BRoll
                | ContentType::TalkingHead
                | ContentType::ScreenRecording
        )
    }

    /// Returns whether this content type is audio
    pub fn is_audio(&self) -> bool {
        matches!(self, ContentType::Audio)
    }
}

impl std::fmt::Display for ContentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ContentType::Video => write!(f, "Video"),
            ContentType::Audio => write!(f, "Audio"),
            ContentType::Image => write!(f, "Image"),
            ContentType::Text => write!(f, "Text"),
            ContentType::Caption => write!(f, "Caption"),
            ContentType::Animation => write!(f, "Animation"),
            ContentType::BRoll => write!(f, "B-Roll"),
            ContentType::TalkingHead => write!(f, "Talking Head"),
            ContentType::ScreenRecording => write!(f, "Screen Recording"),
            ContentType::Transition => write!(f, "Transition"),
        }
    }
}

/// Section-specific configuration
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SectionConfig {
    /// AI prompt hint for auto-fill
    pub ai_prompt_hint: Option<String>,
    /// Suggested search keywords
    pub search_keywords: Vec<String>,
    /// Effect presets to apply
    pub effect_presets: Vec<String>,
    /// Caption style override
    pub caption_style_id: Option<String>,
    /// Transition in type
    pub transition_in: Option<String>,
    /// Transition out type
    pub transition_out: Option<String>,
    /// Audio settings
    pub audio_config: HashMap<String, serde_json::Value>,
}

impl SectionConfig {
    /// Creates a new empty config
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the AI prompt hint
    pub fn with_ai_hint(mut self, hint: impl Into<String>) -> Self {
        self.ai_prompt_hint = Some(hint.into());
        self
    }

    /// Adds a search keyword
    pub fn with_keyword(mut self, keyword: impl Into<String>) -> Self {
        self.search_keywords.push(keyword.into());
        self
    }

    /// Adds an effect preset
    pub fn with_effect(mut self, effect_id: impl Into<String>) -> Self {
        self.effect_presets.push(effect_id.into());
        self
    }

    /// Sets the transition in
    pub fn with_transition_in(mut self, transition: impl Into<String>) -> Self {
        self.transition_in = Some(transition.into());
        self
    }

    /// Sets the transition out
    pub fn with_transition_out(mut self, transition: impl Into<String>) -> Self {
        self.transition_out = Some(transition.into());
        self
    }
}

/// A section within a template
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateSection {
    /// Section ID (unique within template)
    pub id: String,
    /// Display name
    pub name: String,
    /// Description of this section's purpose
    pub description: String,
    /// Content type expected
    pub content_type: ContentType,
    /// Duration range (min, max) in seconds
    pub duration_range: (f64, f64),
    /// Whether this section is required
    pub required: bool,
    /// Display order (lower = earlier)
    pub order: u32,
    /// Section-specific configuration
    pub config: SectionConfig,
    /// Allowed asset types (if empty, all allowed)
    pub allowed_asset_types: Vec<String>,
    /// Example/placeholder content URI
    pub placeholder_uri: Option<String>,
}

impl TemplateSection {
    /// Creates a new section
    pub fn new(name: impl Into<String>, content_type: ContentType) -> Self {
        let name = name.into();
        Self {
            id: ulid::Ulid::new().to_string(),
            name: name.clone(),
            description: String::new(),
            content_type,
            duration_range: (1.0, 10.0),
            required: true,
            order: 0,
            config: SectionConfig::default(),
            allowed_asset_types: Vec::new(),
            placeholder_uri: None,
        }
    }

    /// Sets the description
    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = desc.into();
        self
    }

    /// Sets the duration range
    pub fn with_duration_range(mut self, min_sec: f64, max_sec: f64) -> Self {
        self.duration_range = (min_sec, max_sec);
        self
    }

    /// Sets whether required
    pub fn with_required(mut self, required: bool) -> Self {
        self.required = required;
        self
    }

    /// Sets the order
    pub fn with_order(mut self, order: u32) -> Self {
        self.order = order;
        self
    }

    /// Sets the configuration
    pub fn with_config(mut self, config: SectionConfig) -> Self {
        self.config = config;
        self
    }

    /// Adds an allowed asset type
    pub fn with_allowed_asset_type(mut self, asset_type: impl Into<String>) -> Self {
        self.allowed_asset_types.push(asset_type.into());
        self
    }

    /// Sets the placeholder URI
    pub fn with_placeholder(mut self, uri: impl Into<String>) -> Self {
        self.placeholder_uri = Some(uri.into());
        self
    }

    /// Returns the minimum duration
    pub fn min_duration(&self) -> f64 {
        self.duration_range.0
    }

    /// Returns the maximum duration
    pub fn max_duration(&self) -> f64 {
        self.duration_range.1
    }

    /// Validates the section configuration
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("Section name cannot be empty".to_string());
        }

        if self.duration_range.0 < 0.0 {
            return Err("Minimum duration cannot be negative".to_string());
        }

        if self.duration_range.1 < self.duration_range.0 {
            return Err("Maximum duration cannot be less than minimum".to_string());
        }

        Ok(())
    }
}

/// Visual style settings for a template
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateStyle {
    /// Primary color
    pub primary_color: Color,
    /// Secondary color
    pub secondary_color: Color,
    /// Accent color
    pub accent_color: Color,
    /// Background color
    pub background_color: Color,
    /// Default font family
    pub font_family: String,
    /// Caption font family
    pub caption_font: String,
    /// Caption font size (px)
    pub caption_size: u32,
    /// Caption position (percent from top)
    pub caption_position_y: f32,
    /// Default transition duration (seconds)
    pub transition_duration: f64,
    /// Default transition type
    pub default_transition: String,
    /// Additional style properties
    pub custom_properties: HashMap<String, serde_json::Value>,
}

impl Default for TemplateStyle {
    fn default() -> Self {
        Self {
            primary_color: Color::from_hex("#FFFFFF"),
            secondary_color: Color::from_hex("#000000"),
            accent_color: Color::from_hex("#FF0000"),
            background_color: Color::from_hex("#000000"),
            font_family: "Inter".to_string(),
            caption_font: "Inter Bold".to_string(),
            caption_size: 48,
            caption_position_y: 75.0,
            transition_duration: 0.3,
            default_transition: "crossfade".to_string(),
            custom_properties: HashMap::new(),
        }
    }
}

impl TemplateStyle {
    /// Creates a new style with colors
    pub fn new(primary: Color, secondary: Color, accent: Color) -> Self {
        Self {
            primary_color: primary,
            secondary_color: secondary,
            accent_color: accent,
            ..Default::default()
        }
    }

    /// Creates a dark theme style
    pub fn dark_theme() -> Self {
        Self {
            primary_color: Color::from_hex("#FFFFFF"),
            secondary_color: Color::from_hex("#888888"),
            accent_color: Color::from_hex("#00AAFF"),
            background_color: Color::from_hex("#000000"),
            ..Default::default()
        }
    }

    /// Creates a light theme style
    pub fn light_theme() -> Self {
        Self {
            primary_color: Color::from_hex("#000000"),
            secondary_color: Color::from_hex("#666666"),
            accent_color: Color::from_hex("#0066CC"),
            background_color: Color::from_hex("#FFFFFF"),
            ..Default::default()
        }
    }

    /// Creates a vibrant/energetic style
    pub fn vibrant() -> Self {
        Self {
            primary_color: Color::from_hex("#FFFF00"),
            secondary_color: Color::from_hex("#FF00FF"),
            accent_color: Color::from_hex("#00FFFF"),
            background_color: Color::from_hex("#000000"),
            transition_duration: 0.15,
            ..Default::default()
        }
    }

    /// Sets the caption font
    pub fn with_caption_font(mut self, font: impl Into<String>, size: u32) -> Self {
        self.caption_font = font.into();
        self.caption_size = size;
        self
    }

    /// Sets the default transition
    pub fn with_transition(mut self, transition: impl Into<String>, duration: f64) -> Self {
        self.default_transition = transition.into();
        self.transition_duration = duration;
        self
    }

    /// Sets a custom property
    pub fn with_custom_property<T: Serialize>(mut self, key: impl Into<String>, value: T) -> Self {
        if let Ok(v) = serde_json::to_value(value) {
            self.custom_properties.insert(key.into(), v);
        }
        self
    }

    /// Gets a custom property
    pub fn get_custom_property<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.custom_properties
            .get(key)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // ContentType Tests
    // ========================================================================

    #[test]
    fn test_content_type_is_visual() {
        assert!(ContentType::Video.is_visual());
        assert!(ContentType::Image.is_visual());
        assert!(ContentType::BRoll.is_visual());
        assert!(!ContentType::Audio.is_visual()); // Audio is NOT visual
        assert!(!ContentType::Caption.is_visual());
    }

    #[test]
    fn test_content_type_is_audio() {
        assert!(ContentType::Audio.is_audio());
        assert!(!ContentType::Video.is_audio());
    }

    #[test]
    fn test_content_type_display() {
        assert_eq!(ContentType::Video.to_string(), "Video");
        assert_eq!(ContentType::BRoll.to_string(), "B-Roll");
        assert_eq!(ContentType::TalkingHead.to_string(), "Talking Head");
    }

    #[test]
    fn test_content_type_serialization() {
        assert_eq!(
            serde_json::to_string(&ContentType::Video).unwrap(),
            "\"video\""
        );
        assert_eq!(
            serde_json::to_string(&ContentType::BRoll).unwrap(),
            "\"b_roll\""
        );
        assert_eq!(
            serde_json::from_str::<ContentType>("\"talking_head\"").unwrap(),
            ContentType::TalkingHead
        );
    }

    // ========================================================================
    // SectionConfig Tests
    // ========================================================================

    #[test]
    fn test_section_config_default() {
        let config = SectionConfig::default();
        assert!(config.ai_prompt_hint.is_none());
        assert!(config.search_keywords.is_empty());
        assert!(config.effect_presets.is_empty());
    }

    #[test]
    fn test_section_config_builder() {
        let config = SectionConfig::new()
            .with_ai_hint("Find attention-grabbing content")
            .with_keyword("viral")
            .with_keyword("trending")
            .with_effect("zoom-in")
            .with_transition_in("fade")
            .with_transition_out("cut");

        assert_eq!(
            config.ai_prompt_hint,
            Some("Find attention-grabbing content".to_string())
        );
        assert_eq!(config.search_keywords.len(), 2);
        assert_eq!(config.effect_presets.len(), 1);
        assert_eq!(config.transition_in, Some("fade".to_string()));
        assert_eq!(config.transition_out, Some("cut".to_string()));
    }

    // ========================================================================
    // TemplateSection Tests
    // ========================================================================

    #[test]
    fn test_section_new() {
        let section = TemplateSection::new("Hook", ContentType::Video);

        assert!(!section.id.is_empty());
        assert_eq!(section.name, "Hook");
        assert_eq!(section.content_type, ContentType::Video);
        assert!(section.required);
    }

    #[test]
    fn test_section_builder() {
        let section = TemplateSection::new("Main Content", ContentType::BRoll)
            .with_description("Main video content")
            .with_duration_range(10.0, 30.0)
            .with_required(true)
            .with_order(2)
            .with_allowed_asset_type("video")
            .with_placeholder("placeholder.mp4");

        assert_eq!(section.description, "Main video content");
        assert_eq!(section.duration_range, (10.0, 30.0));
        assert!(section.required);
        assert_eq!(section.order, 2);
        assert_eq!(section.allowed_asset_types.len(), 1);
        assert_eq!(section.placeholder_uri, Some("placeholder.mp4".to_string()));
    }

    #[test]
    fn test_section_duration_helpers() {
        let section =
            TemplateSection::new("Test", ContentType::Video).with_duration_range(5.0, 15.0);

        assert_eq!(section.min_duration(), 5.0);
        assert_eq!(section.max_duration(), 15.0);
    }

    #[test]
    fn test_section_validate_success() {
        let section = TemplateSection::new("Valid Section", ContentType::Video)
            .with_duration_range(1.0, 10.0);

        assert!(section.validate().is_ok());
    }

    #[test]
    fn test_section_validate_empty_name() {
        let mut section = TemplateSection::new("Test", ContentType::Video);
        section.name = String::new();

        let result = section.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("name"));
    }

    #[test]
    fn test_section_validate_negative_duration() {
        let section =
            TemplateSection::new("Test", ContentType::Video).with_duration_range(-1.0, 10.0);

        let result = section.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("negative"));
    }

    #[test]
    fn test_section_validate_invalid_duration_range() {
        let section =
            TemplateSection::new("Test", ContentType::Video).with_duration_range(10.0, 5.0);

        let result = section.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("less than"));
    }

    #[test]
    fn test_section_serialization() {
        let section =
            TemplateSection::new("Hook", ContentType::Video).with_duration_range(3.0, 5.0);

        let json = serde_json::to_string(&section).unwrap();
        let parsed: TemplateSection = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.name, "Hook");
        assert_eq!(parsed.content_type, ContentType::Video);
        assert_eq!(parsed.duration_range, (3.0, 5.0));
    }

    // ========================================================================
    // TemplateStyle Tests
    // ========================================================================

    #[test]
    fn test_style_default() {
        let style = TemplateStyle::default();
        assert_eq!(style.font_family, "Inter");
        assert_eq!(style.caption_size, 48);
        assert_eq!(style.default_transition, "crossfade");
    }

    #[test]
    fn test_style_dark_theme() {
        let style = TemplateStyle::dark_theme();
        assert_eq!(style.background_color, Color::from_hex("#000000"));
    }

    #[test]
    fn test_style_light_theme() {
        let style = TemplateStyle::light_theme();
        assert_eq!(style.background_color, Color::from_hex("#FFFFFF"));
    }

    #[test]
    fn test_style_vibrant() {
        let style = TemplateStyle::vibrant();
        assert_eq!(style.transition_duration, 0.15);
    }

    #[test]
    fn test_style_builder() {
        let style = TemplateStyle::default()
            .with_caption_font("Arial Bold", 64)
            .with_transition("wipe", 0.5);

        assert_eq!(style.caption_font, "Arial Bold");
        assert_eq!(style.caption_size, 64);
        assert_eq!(style.default_transition, "wipe");
        assert_eq!(style.transition_duration, 0.5);
    }

    #[test]
    fn test_style_custom_properties() {
        let style = TemplateStyle::default()
            .with_custom_property("glow_enabled", true)
            .with_custom_property("glow_intensity", 0.8);

        assert_eq!(
            style.get_custom_property::<bool>("glow_enabled"),
            Some(true)
        );
        assert_eq!(
            style.get_custom_property::<f64>("glow_intensity"),
            Some(0.8)
        );
        assert_eq!(style.get_custom_property::<String>("nonexistent"), None);
    }

    #[test]
    fn test_style_serialization() {
        let style = TemplateStyle::dark_theme().with_caption_font("Montserrat", 56);

        let json = serde_json::to_string(&style).unwrap();
        let parsed: TemplateStyle = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.caption_font, "Montserrat");
        assert_eq!(parsed.caption_size, 56);
    }
}

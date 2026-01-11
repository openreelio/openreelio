//! Plugin API Traits
//!
//! Defines the interfaces that plugins can implement to extend OpenReelio.
//! Each trait represents a capability that plugins can provide.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::core::assets::LicenseInfo;
use crate::core::CoreResult;

// ============================================================================
// Common Types
// ============================================================================

/// Reference to an asset provided by a plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginAssetRef {
    /// Unique identifier within the plugin
    pub id: String,
    /// Display name
    pub name: String,
    /// Asset type (image, video, audio)
    pub asset_type: PluginAssetType,
    /// Thumbnail URL or data URI
    pub thumbnail: Option<String>,
    /// Duration in seconds (for video/audio)
    pub duration_sec: Option<f64>,
    /// File size in bytes
    pub size_bytes: Option<u64>,
    /// Tags for categorization
    pub tags: Vec<String>,
    /// Additional metadata
    pub metadata: serde_json::Value,
}

/// Asset type from plugin
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginAssetType {
    Image,
    Video,
    Audio,
    Font,
    Other,
}

/// Search query for plugin assets
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSearchQuery {
    /// Text query
    pub text: Option<String>,
    /// Asset type filter
    pub asset_type: Option<PluginAssetType>,
    /// Tags to match
    pub tags: Vec<String>,
    /// Duration range (min, max) in seconds
    pub duration_range: Option<(f64, f64)>,
    /// Maximum results
    pub limit: usize,
    /// Offset for pagination
    pub offset: usize,
}

impl Default for PluginSearchQuery {
    fn default() -> Self {
        Self {
            text: None,
            asset_type: None,
            tags: Vec::new(),
            duration_range: None,
            limit: 20,
            offset: 0,
        }
    }
}

/// Fetched asset data from plugin
#[derive(Debug, Clone)]
pub struct PluginFetchedAsset {
    /// Raw asset data
    pub data: Vec<u8>,
    /// MIME type
    pub mime_type: String,
    /// License information
    pub license: LicenseInfo,
    /// Original filename
    pub filename: Option<String>,
}

// ============================================================================
// AssetProvider Trait
// ============================================================================

/// Plugin capability for providing assets (images, videos, audio)
#[async_trait]
pub trait AssetProviderPlugin: Send + Sync {
    /// Returns the provider name
    fn name(&self) -> &str;

    /// Returns the provider description
    fn description(&self) -> &str;

    /// Searches for assets matching the query
    async fn search(&self, query: &PluginSearchQuery) -> CoreResult<Vec<PluginAssetRef>>;

    /// Fetches an asset by its reference ID
    async fn fetch(&self, asset_ref: &str) -> CoreResult<PluginFetchedAsset>;

    /// Returns categories/collections available
    async fn categories(&self) -> CoreResult<Vec<String>>;

    /// Checks if the provider is available (e.g., API key configured)
    fn is_available(&self) -> bool;
}

// ============================================================================
// EditAssistant Trait
// ============================================================================

/// Edit context provided to assistant plugins
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditContext {
    /// Current sequence ID
    pub sequence_id: String,
    /// Current playhead position in seconds
    pub playhead_sec: f64,
    /// Selected clip IDs
    pub selected_clips: Vec<String>,
    /// Current timeline duration in seconds
    pub duration_sec: f64,
    /// User's prompt/request
    pub prompt: String,
    /// Additional context
    pub context: serde_json::Value,
}

/// Edit suggestion from assistant plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditSuggestion {
    /// Unique suggestion ID
    pub id: String,
    /// Human-readable description
    pub description: String,
    /// Confidence score (0.0 - 1.0)
    pub confidence: f32,
    /// Commands to execute (serialized)
    pub commands: Vec<serde_json::Value>,
    /// Preview description
    pub preview_hint: Option<String>,
}

/// Plugin capability for providing edit suggestions
#[async_trait]
pub trait EditAssistantPlugin: Send + Sync {
    /// Returns the assistant name
    fn name(&self) -> &str;

    /// Returns the assistant description
    fn description(&self) -> &str;

    /// Generates edit suggestions based on context
    async fn suggest(&self, context: &EditContext) -> CoreResult<Vec<EditSuggestion>>;

    /// Returns supported prompt patterns/capabilities
    fn capabilities(&self) -> Vec<String>;
}

// ============================================================================
// EffectPresetProvider Trait
// ============================================================================

/// Effect preset from plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginEffectPreset {
    /// Unique preset ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Category (e.g., "transitions", "color", "motion")
    pub category: String,
    /// Description
    pub description: Option<String>,
    /// Thumbnail or preview
    pub thumbnail: Option<String>,
    /// Effect parameters
    pub params: serde_json::Value,
    /// Duration in seconds (for animations)
    pub duration_sec: Option<f64>,
    /// Tags
    pub tags: Vec<String>,
}

/// Plugin capability for providing effect presets
#[async_trait]
pub trait EffectPresetProviderPlugin: Send + Sync {
    /// Returns the provider name
    fn name(&self) -> &str;

    /// Returns all available presets
    async fn list_presets(&self) -> CoreResult<Vec<PluginEffectPreset>>;

    /// Gets a specific preset by ID
    async fn get_preset(&self, preset_id: &str) -> CoreResult<PluginEffectPreset>;

    /// Returns available categories
    async fn categories(&self) -> CoreResult<Vec<String>>;

    /// Searches presets by query
    async fn search(&self, query: &str) -> CoreResult<Vec<PluginEffectPreset>>;
}

// ============================================================================
// CaptionStyleProvider Trait
// ============================================================================

/// Caption style from plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginCaptionStyle {
    /// Unique style ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Style category
    pub category: String,
    /// Style parameters (font, colors, positioning)
    pub style: serde_json::Value,
    /// Preview image
    pub preview: Option<String>,
    /// Tags
    pub tags: Vec<String>,
}

/// Plugin capability for providing caption styles
#[async_trait]
pub trait CaptionStyleProviderPlugin: Send + Sync {
    /// Returns the provider name
    fn name(&self) -> &str;

    /// Returns all available styles
    async fn list_styles(&self) -> CoreResult<Vec<PluginCaptionStyle>>;

    /// Gets a specific style by ID
    async fn get_style(&self, style_id: &str) -> CoreResult<PluginCaptionStyle>;

    /// Returns available categories
    async fn categories(&self) -> CoreResult<Vec<String>>;
}

// ============================================================================
// TemplateProvider Trait
// ============================================================================

/// Template from plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginTemplate {
    /// Unique template ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Category (e.g., "shorts", "intro", "outro")
    pub category: String,
    /// Description
    pub description: Option<String>,
    /// Preview thumbnail
    pub thumbnail: Option<String>,
    /// Preview video URL
    pub preview_video: Option<String>,
    /// Template structure definition
    pub structure: serde_json::Value,
    /// Required placeholders
    pub placeholders: Vec<TemplatePlaceholder>,
    /// Duration in seconds
    pub duration_sec: f64,
    /// Tags
    pub tags: Vec<String>,
}

/// Placeholder in a template
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplatePlaceholder {
    /// Placeholder ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Type (video, image, text, audio)
    pub placeholder_type: String,
    /// Whether this placeholder is required
    pub required: bool,
    /// Description
    pub description: Option<String>,
    /// Default value
    pub default_value: Option<serde_json::Value>,
}

/// Plugin capability for providing templates
#[async_trait]
pub trait TemplateProviderPlugin: Send + Sync {
    /// Returns the provider name
    fn name(&self) -> &str;

    /// Returns all available templates
    async fn list_templates(&self) -> CoreResult<Vec<PluginTemplate>>;

    /// Gets a specific template by ID
    async fn get_template(&self, template_id: &str) -> CoreResult<PluginTemplate>;

    /// Returns available categories
    async fn categories(&self) -> CoreResult<Vec<String>>;

    /// Searches templates by query
    async fn search(&self, query: &str) -> CoreResult<Vec<PluginTemplate>>;
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // PluginAssetRef Tests
    // ========================================================================

    #[test]
    fn test_plugin_asset_ref_serialization() {
        let asset_ref = PluginAssetRef {
            id: "asset-001".to_string(),
            name: "Funny Meme".to_string(),
            asset_type: PluginAssetType::Image,
            thumbnail: Some("data:image/png;base64,abc123".to_string()),
            duration_sec: None,
            size_bytes: Some(1024),
            tags: vec!["meme".to_string(), "funny".to_string()],
            metadata: serde_json::json!({"source": "internal"}),
        };

        let json = serde_json::to_string(&asset_ref).unwrap();
        let parsed: PluginAssetRef = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, "asset-001");
        assert_eq!(parsed.name, "Funny Meme");
        assert_eq!(parsed.asset_type, PluginAssetType::Image);
        assert_eq!(parsed.tags.len(), 2);
    }

    #[test]
    fn test_plugin_asset_type_serialization() {
        assert_eq!(
            serde_json::to_string(&PluginAssetType::Image).unwrap(),
            "\"image\""
        );
        assert_eq!(
            serde_json::to_string(&PluginAssetType::Video).unwrap(),
            "\"video\""
        );
        assert_eq!(
            serde_json::to_string(&PluginAssetType::Audio).unwrap(),
            "\"audio\""
        );
    }

    // ========================================================================
    // PluginSearchQuery Tests
    // ========================================================================

    #[test]
    fn test_search_query_default() {
        let query = PluginSearchQuery::default();

        assert!(query.text.is_none());
        assert!(query.asset_type.is_none());
        assert!(query.tags.is_empty());
        assert!(query.duration_range.is_none());
        assert_eq!(query.limit, 20);
        assert_eq!(query.offset, 0);
    }

    #[test]
    fn test_search_query_with_filters() {
        let query = PluginSearchQuery {
            text: Some("cat".to_string()),
            asset_type: Some(PluginAssetType::Video),
            tags: vec!["animal".to_string()],
            duration_range: Some((1.0, 10.0)),
            limit: 50,
            offset: 10,
        };

        assert_eq!(query.text, Some("cat".to_string()));
        assert_eq!(query.asset_type, Some(PluginAssetType::Video));
        assert_eq!(query.duration_range, Some((1.0, 10.0)));
    }

    // ========================================================================
    // EditContext Tests
    // ========================================================================

    #[test]
    fn test_edit_context_serialization() {
        let context = EditContext {
            sequence_id: "seq-001".to_string(),
            playhead_sec: 5.5,
            selected_clips: vec!["clip-001".to_string()],
            duration_sec: 120.0,
            prompt: "Add a transition here".to_string(),
            context: serde_json::json!({}),
        };

        let json = serde_json::to_string(&context).unwrap();
        let parsed: EditContext = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.sequence_id, "seq-001");
        assert_eq!(parsed.playhead_sec, 5.5);
        assert_eq!(parsed.prompt, "Add a transition here");
    }

    // ========================================================================
    // EditSuggestion Tests
    // ========================================================================

    #[test]
    fn test_edit_suggestion_serialization() {
        let suggestion = EditSuggestion {
            id: "sug-001".to_string(),
            description: "Add cross-fade transition".to_string(),
            confidence: 0.85,
            commands: vec![serde_json::json!({
                "type": "ApplyEffect",
                "params": {"effect": "cross-fade", "duration": 0.5}
            })],
            preview_hint: Some("Smooth transition between clips".to_string()),
        };

        let json = serde_json::to_string(&suggestion).unwrap();
        let parsed: EditSuggestion = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, "sug-001");
        assert_eq!(parsed.confidence, 0.85);
        assert_eq!(parsed.commands.len(), 1);
    }

    // ========================================================================
    // PluginEffectPreset Tests
    // ========================================================================

    #[test]
    fn test_effect_preset_serialization() {
        let preset = PluginEffectPreset {
            id: "preset-001".to_string(),
            name: "Cinematic Color".to_string(),
            category: "color".to_string(),
            description: Some("Cinematic color grading".to_string()),
            thumbnail: None,
            params: serde_json::json!({
                "contrast": 1.2,
                "saturation": 0.9,
                "temperature": -500
            }),
            duration_sec: None,
            tags: vec!["cinematic".to_string(), "movie".to_string()],
        };

        let json = serde_json::to_string(&preset).unwrap();
        let parsed: PluginEffectPreset = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, "preset-001");
        assert_eq!(parsed.category, "color");
    }

    // ========================================================================
    // PluginCaptionStyle Tests
    // ========================================================================

    #[test]
    fn test_caption_style_serialization() {
        let style = PluginCaptionStyle {
            id: "style-001".to_string(),
            name: "YouTube Style".to_string(),
            category: "modern".to_string(),
            style: serde_json::json!({
                "fontFamily": "Arial",
                "fontSize": 24,
                "color": "#FFFFFF",
                "stroke": "#000000",
                "strokeWidth": 2
            }),
            preview: None,
            tags: vec!["youtube".to_string(), "clean".to_string()],
        };

        let json = serde_json::to_string(&style).unwrap();
        let parsed: PluginCaptionStyle = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, "style-001");
        assert_eq!(parsed.name, "YouTube Style");
    }

    // ========================================================================
    // PluginTemplate Tests
    // ========================================================================

    #[test]
    fn test_template_serialization() {
        let template = PluginTemplate {
            id: "template-001".to_string(),
            name: "Short Intro".to_string(),
            category: "intro".to_string(),
            description: Some("Quick intro for YouTube Shorts".to_string()),
            thumbnail: None,
            preview_video: None,
            structure: serde_json::json!({
                "layers": [
                    {"type": "video", "placeholder": "main_video"},
                    {"type": "text", "placeholder": "title"}
                ]
            }),
            placeholders: vec![
                TemplatePlaceholder {
                    id: "main_video".to_string(),
                    name: "Main Video".to_string(),
                    placeholder_type: "video".to_string(),
                    required: true,
                    description: Some("The main video clip".to_string()),
                    default_value: None,
                },
                TemplatePlaceholder {
                    id: "title".to_string(),
                    name: "Title Text".to_string(),
                    placeholder_type: "text".to_string(),
                    required: true,
                    description: None,
                    default_value: Some(serde_json::json!("My Title")),
                },
            ],
            duration_sec: 5.0,
            tags: vec!["intro".to_string(), "short".to_string()],
        };

        let json = serde_json::to_string(&template).unwrap();
        let parsed: PluginTemplate = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, "template-001");
        assert_eq!(parsed.placeholders.len(), 2);
        assert_eq!(parsed.duration_sec, 5.0);
    }

    #[test]
    fn test_template_placeholder_required() {
        let placeholder = TemplatePlaceholder {
            id: "bg".to_string(),
            name: "Background".to_string(),
            placeholder_type: "image".to_string(),
            required: false,
            description: None,
            default_value: Some(serde_json::json!("default_bg.png")),
        };

        assert!(!placeholder.required);
        assert!(placeholder.default_value.is_some());
    }
}

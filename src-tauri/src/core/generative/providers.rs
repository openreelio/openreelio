//! Generative AI Providers
//!
//! Provider abstraction for different AI generation services.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::audio::{MusicGenerationParams, MusicGenerationResult, TTSParams, TTSResult};
use super::image::{ImageGenerationParams, ImageGenerationResult};
use crate::core::{CoreError, CoreResult};

/// Capabilities supported by a provider
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCapability {
    /// Image generation
    ImageGeneration,
    /// Text-to-speech
    TextToSpeech,
    /// Music/audio generation
    MusicGeneration,
    /// Video generation (future)
    VideoGeneration,
    /// Image editing (inpainting, etc.)
    ImageEditing,
    /// Voice cloning
    VoiceCloning,
}

impl std::fmt::Display for ProviderCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderCapability::ImageGeneration => write!(f, "Image Generation"),
            ProviderCapability::TextToSpeech => write!(f, "Text-to-Speech"),
            ProviderCapability::MusicGeneration => write!(f, "Music Generation"),
            ProviderCapability::VideoGeneration => write!(f, "Video Generation"),
            ProviderCapability::ImageEditing => write!(f, "Image Editing"),
            ProviderCapability::VoiceCloning => write!(f, "Voice Cloning"),
        }
    }
}

/// Configuration for a generative provider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerativeProviderConfig {
    /// API key (if required)
    pub api_key: Option<String>,
    /// Base URL override
    pub base_url: Option<String>,
    /// Request timeout in seconds
    pub timeout_sec: u64,
    /// Maximum retries on failure
    pub max_retries: u32,
    /// Model ID to use (provider-specific)
    pub model_id: Option<String>,
    /// Additional provider-specific settings
    pub settings: HashMap<String, serde_json::Value>,
}

impl Default for GenerativeProviderConfig {
    fn default() -> Self {
        Self {
            api_key: None,
            base_url: None,
            timeout_sec: 60,
            max_retries: 3,
            model_id: None,
            settings: HashMap::new(),
        }
    }
}

impl GenerativeProviderConfig {
    /// Creates a new config with API key
    pub fn with_api_key(api_key: impl Into<String>) -> Self {
        Self {
            api_key: Some(api_key.into()),
            ..Default::default()
        }
    }

    /// Sets the model ID
    pub fn with_model(mut self, model_id: impl Into<String>) -> Self {
        self.model_id = Some(model_id.into());
        self
    }

    /// Sets a custom setting
    pub fn with_setting<T: Serialize>(mut self, key: impl Into<String>, value: T) -> Self {
        if let Ok(v) = serde_json::to_value(value) {
            self.settings.insert(key.into(), v);
        }
        self
    }

    /// Gets a setting value
    pub fn get_setting<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.settings
            .get(key)
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }
}

/// Trait for generative AI providers
#[async_trait]
pub trait GenerativeProvider: Send + Sync {
    /// Returns the provider name
    fn name(&self) -> &str;

    /// Returns supported capabilities
    fn capabilities(&self) -> Vec<ProviderCapability>;

    /// Checks if provider supports a capability
    fn supports(&self, capability: ProviderCapability) -> bool {
        self.capabilities().contains(&capability)
    }

    /// Checks if the provider is available (configured correctly)
    fn is_available(&self) -> bool;

    /// Generates an image
    async fn generate_image(
        &self,
        _params: &ImageGenerationParams,
    ) -> CoreResult<ImageGenerationResult> {
        Err(CoreError::NotSupported(format!(
            "{} does not support image generation",
            self.name()
        )))
    }

    /// Generates speech from text
    async fn generate_speech(&self, _params: &TTSParams) -> CoreResult<TTSResult> {
        Err(CoreError::NotSupported(format!(
            "{} does not support text-to-speech",
            self.name()
        )))
    }

    /// Generates music
    async fn generate_music(
        &self,
        _params: &MusicGenerationParams,
    ) -> CoreResult<MusicGenerationResult> {
        Err(CoreError::NotSupported(format!(
            "{} does not support music generation",
            self.name()
        )))
    }

    /// Gets available models for a capability
    async fn list_models(&self, _capability: ProviderCapability) -> CoreResult<Vec<ModelInfo>> {
        Ok(vec![])
    }
}

/// Information about an available model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    /// Model ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Description
    pub description: Option<String>,
    /// Capability this model supports
    pub capability: ProviderCapability,
    /// Cost tier (for UI display)
    pub cost_tier: CostTier,
    /// Whether this is the default model
    pub is_default: bool,
}

/// Cost tier for models
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostTier {
    Free,
    Low,
    Medium,
    High,
    Premium,
}

impl ModelInfo {
    /// Creates a new model info
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        capability: ProviderCapability,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: None,
            capability,
            cost_tier: CostTier::Medium,
            is_default: false,
        }
    }

    /// Sets the description
    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    /// Sets the cost tier
    pub fn with_cost_tier(mut self, tier: CostTier) -> Self {
        self.cost_tier = tier;
        self
    }

    /// Marks as default
    pub fn as_default(mut self) -> Self {
        self.is_default = true;
        self
    }
}

// ============================================================================
// Mock Provider for Testing
// ============================================================================

/// Mock provider for testing
#[derive(Debug)]
pub struct MockGenerativeProvider {
    name: String,
    capabilities: Vec<ProviderCapability>,
    available: bool,
}

impl MockGenerativeProvider {
    /// Creates a new mock provider
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            capabilities: vec![
                ProviderCapability::ImageGeneration,
                ProviderCapability::TextToSpeech,
                ProviderCapability::MusicGeneration,
            ],
            available: true,
        }
    }

    /// Sets availability
    pub fn with_available(mut self, available: bool) -> Self {
        self.available = available;
        self
    }

    /// Sets capabilities
    pub fn with_capabilities(mut self, caps: Vec<ProviderCapability>) -> Self {
        self.capabilities = caps;
        self
    }
}

#[async_trait]
impl GenerativeProvider for MockGenerativeProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn capabilities(&self) -> Vec<ProviderCapability> {
        self.capabilities.clone()
    }

    fn is_available(&self) -> bool {
        self.available
    }

    async fn generate_image(
        &self,
        params: &ImageGenerationParams,
    ) -> CoreResult<ImageGenerationResult> {
        if !self.supports(ProviderCapability::ImageGeneration) {
            return Err(CoreError::NotSupported(
                "Image generation not supported".to_string(),
            ));
        }

        // Return mock result
        Ok(ImageGenerationResult {
            id: ulid::Ulid::new().to_string(),
            prompt: params.prompt.clone(),
            image_data: vec![0u8; 100], // Mock data
            mime_type: "image/png".to_string(),
            width: params.width.unwrap_or(1024),
            height: params.height.unwrap_or(1024),
            model_used: "mock-model".to_string(),
            generation_time_ms: 100,
            metadata: HashMap::new(),
        })
    }

    async fn generate_speech(&self, params: &TTSParams) -> CoreResult<TTSResult> {
        if !self.supports(ProviderCapability::TextToSpeech) {
            return Err(CoreError::NotSupported("TTS not supported".to_string()));
        }

        Ok(TTSResult {
            id: ulid::Ulid::new().to_string(),
            text: params.text.clone(),
            audio_data: vec![0u8; 100], // Mock data
            mime_type: "audio/mp3".to_string(),
            duration_sec: params.text.len() as f64 * 0.05, // Rough estimate
            sample_rate: 44100,
            model_used: "mock-tts".to_string(),
            generation_time_ms: 50,
        })
    }

    async fn generate_music(
        &self,
        params: &MusicGenerationParams,
    ) -> CoreResult<MusicGenerationResult> {
        if !self.supports(ProviderCapability::MusicGeneration) {
            return Err(CoreError::NotSupported(
                "Music generation not supported".to_string(),
            ));
        }

        Ok(MusicGenerationResult {
            id: ulid::Ulid::new().to_string(),
            description: params.build_prompt(),
            audio_data: vec![0u8; 100], // Mock data
            mime_type: "audio/mp3".to_string(),
            duration_sec: params.duration_sec,
            sample_rate: 44100,
            bpm: params.bpm,
            model_used: "mock-music".to_string(),
            generation_time_ms: 200,
        })
    }

    async fn list_models(&self, capability: ProviderCapability) -> CoreResult<Vec<ModelInfo>> {
        let models = match capability {
            ProviderCapability::ImageGeneration => vec![
                ModelInfo::new("mock-sd", "Mock Stable Diffusion", capability)
                    .with_cost_tier(CostTier::Low)
                    .as_default(),
                ModelInfo::new("mock-dalle", "Mock DALL-E", capability)
                    .with_cost_tier(CostTier::High),
            ],
            ProviderCapability::TextToSpeech => {
                vec![ModelInfo::new("mock-tts", "Mock TTS", capability)
                    .with_cost_tier(CostTier::Low)
                    .as_default()]
            }
            ProviderCapability::MusicGeneration => {
                vec![
                    ModelInfo::new("mock-music", "Mock Music Generator", capability)
                        .with_cost_tier(CostTier::Medium)
                        .as_default(),
                ]
            }
            _ => vec![],
        };

        Ok(models)
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // ProviderCapability Tests
    // ========================================================================

    #[test]
    fn test_capability_display() {
        assert_eq!(
            ProviderCapability::ImageGeneration.to_string(),
            "Image Generation"
        );
        assert_eq!(
            ProviderCapability::TextToSpeech.to_string(),
            "Text-to-Speech"
        );
    }

    #[test]
    fn test_capability_serialization() {
        assert_eq!(
            serde_json::to_string(&ProviderCapability::ImageGeneration).unwrap(),
            "\"image_generation\""
        );
        assert_eq!(
            serde_json::from_str::<ProviderCapability>("\"text_to_speech\"").unwrap(),
            ProviderCapability::TextToSpeech
        );
    }

    // ========================================================================
    // GenerativeProviderConfig Tests
    // ========================================================================

    #[test]
    fn test_config_default() {
        let config = GenerativeProviderConfig::default();
        assert!(config.api_key.is_none());
        assert_eq!(config.timeout_sec, 60);
        assert_eq!(config.max_retries, 3);
    }

    #[test]
    fn test_config_with_api_key() {
        let config = GenerativeProviderConfig::with_api_key("sk-test-123");
        assert_eq!(config.api_key, Some("sk-test-123".to_string()));
    }

    #[test]
    fn test_config_builder() {
        let config = GenerativeProviderConfig::with_api_key("test")
            .with_model("dall-e-3")
            .with_setting("quality", "hd");

        assert_eq!(config.model_id, Some("dall-e-3".to_string()));
        assert_eq!(
            config.get_setting::<String>("quality"),
            Some("hd".to_string())
        );
    }

    // ========================================================================
    // ModelInfo Tests
    // ========================================================================

    #[test]
    fn test_model_info_new() {
        let model = ModelInfo::new(
            "test-model",
            "Test Model",
            ProviderCapability::ImageGeneration,
        );

        assert_eq!(model.id, "test-model");
        assert_eq!(model.name, "Test Model");
        assert_eq!(model.cost_tier, CostTier::Medium);
        assert!(!model.is_default);
    }

    #[test]
    fn test_model_info_builder() {
        let model = ModelInfo::new("test", "Test", ProviderCapability::TextToSpeech)
            .with_description("A test model")
            .with_cost_tier(CostTier::Low)
            .as_default();

        assert_eq!(model.description, Some("A test model".to_string()));
        assert_eq!(model.cost_tier, CostTier::Low);
        assert!(model.is_default);
    }

    // ========================================================================
    // MockGenerativeProvider Tests
    // ========================================================================

    #[test]
    fn test_mock_provider_new() {
        let provider = MockGenerativeProvider::new("MockProvider");

        assert_eq!(provider.name(), "MockProvider");
        assert!(provider.is_available());
        assert!(provider.supports(ProviderCapability::ImageGeneration));
    }

    #[test]
    fn test_mock_provider_availability() {
        let unavailable = MockGenerativeProvider::new("Test").with_available(false);
        assert!(!unavailable.is_available());
    }

    #[tokio::test]
    async fn test_mock_provider_generate_image() {
        let provider = MockGenerativeProvider::new("Test");
        let params = ImageGenerationParams::new("A sunset over mountains");

        let result = provider.generate_image(&params).await.unwrap();

        assert!(!result.id.is_empty());
        assert_eq!(result.prompt, "A sunset over mountains");
        assert!(!result.image_data.is_empty());
    }

    #[tokio::test]
    async fn test_mock_provider_generate_speech() {
        let provider = MockGenerativeProvider::new("Test");
        let params = TTSParams::new("Hello, world!");

        let result = provider.generate_speech(&params).await.unwrap();

        assert!(!result.id.is_empty());
        assert_eq!(result.text, "Hello, world!");
        assert!(!result.audio_data.is_empty());
    }

    #[tokio::test]
    async fn test_mock_provider_unsupported_capability() {
        let provider = MockGenerativeProvider::new("Test")
            .with_capabilities(vec![ProviderCapability::ImageGeneration]);

        let params = TTSParams::new("Test");
        let result = provider.generate_speech(&params).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_mock_provider_list_models() {
        let provider = MockGenerativeProvider::new("Test");

        let models = provider
            .list_models(ProviderCapability::ImageGeneration)
            .await
            .unwrap();
        assert!(!models.is_empty());
        assert!(models.iter().any(|m| m.is_default));
    }
}

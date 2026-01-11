//! Generative Engine
//!
//! Main engine for managing AI content generation.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use super::audio::{MusicGenerationParams, MusicGenerationResult, TTSParams, TTSResult};
use super::image::{ImageGenerationParams, ImageGenerationResult};
use super::providers::{
    GenerativeProvider, GenerativeProviderConfig, MockGenerativeProvider, ProviderCapability,
};
use crate::core::{CoreError, CoreResult};

/// Configuration for the generative engine
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerativeEngineConfig {
    /// Default provider for image generation
    pub default_image_provider: Option<String>,
    /// Default provider for TTS
    pub default_tts_provider: Option<String>,
    /// Default provider for music generation
    pub default_music_provider: Option<String>,
    /// Maximum concurrent generations
    pub max_concurrent: usize,
    /// Cache generated content
    pub cache_enabled: bool,
    /// Cache directory path
    pub cache_dir: Option<String>,
    /// Provider-specific configurations
    pub provider_configs: HashMap<String, GenerativeProviderConfig>,
}

impl Default for GenerativeEngineConfig {
    fn default() -> Self {
        Self {
            default_image_provider: None,
            default_tts_provider: None,
            default_music_provider: None,
            max_concurrent: 3,
            cache_enabled: true,
            cache_dir: None,
            provider_configs: HashMap::new(),
        }
    }
}

impl GenerativeEngineConfig {
    /// Sets the default image provider
    pub fn with_image_provider(mut self, provider: impl Into<String>) -> Self {
        self.default_image_provider = Some(provider.into());
        self
    }

    /// Sets the default TTS provider
    pub fn with_tts_provider(mut self, provider: impl Into<String>) -> Self {
        self.default_tts_provider = Some(provider.into());
        self
    }

    /// Sets provider config
    pub fn with_provider_config(
        mut self,
        provider: impl Into<String>,
        config: GenerativeProviderConfig,
    ) -> Self {
        self.provider_configs.insert(provider.into(), config);
        self
    }
}

/// Type of generation request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GenerationRequest {
    /// Image generation request
    Image(ImageGenerationParams),
    /// TTS request
    Speech(TTSParams),
    /// Music generation request
    Music(MusicGenerationParams),
}

impl GenerationRequest {
    /// Returns the required capability
    pub fn required_capability(&self) -> ProviderCapability {
        match self {
            GenerationRequest::Image(_) => ProviderCapability::ImageGeneration,
            GenerationRequest::Speech(_) => ProviderCapability::TextToSpeech,
            GenerationRequest::Music(_) => ProviderCapability::MusicGeneration,
        }
    }
}

/// Result of a generation request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GenerationResult {
    /// Image generation result
    Image(ImageGenerationResult),
    /// TTS result
    Speech(TTSResult),
    /// Music generation result
    Music(MusicGenerationResult),
}

impl GenerationResult {
    /// Returns the result ID
    pub fn id(&self) -> &str {
        match self {
            GenerationResult::Image(r) => &r.id,
            GenerationResult::Speech(r) => &r.id,
            GenerationResult::Music(r) => &r.id,
        }
    }

    /// Returns the generation time
    pub fn generation_time_ms(&self) -> u64 {
        match self {
            GenerationResult::Image(r) => r.generation_time_ms,
            GenerationResult::Speech(r) => r.generation_time_ms,
            GenerationResult::Music(r) => r.generation_time_ms,
        }
    }

    /// Returns the data as bytes
    pub fn data(&self) -> &[u8] {
        match self {
            GenerationResult::Image(r) => &r.image_data,
            GenerationResult::Speech(r) => &r.audio_data,
            GenerationResult::Music(r) => &r.audio_data,
        }
    }
}

/// Main generative AI engine
pub struct GenerativeEngine {
    /// Registered providers
    providers: Arc<RwLock<HashMap<String, Arc<dyn GenerativeProvider>>>>,
    /// Engine configuration
    config: Arc<RwLock<GenerativeEngineConfig>>,
    /// Generation history (recent results)
    history: Arc<RwLock<Vec<GenerationResult>>>,
    /// Maximum history size
    max_history: usize,
}

impl GenerativeEngine {
    /// Creates a new generative engine
    pub fn new() -> Self {
        // Pre-populate providers with mock provider for testing
        let mut providers_map: HashMap<String, Arc<dyn GenerativeProvider>> = HashMap::new();
        let mock_provider = Arc::new(MockGenerativeProvider::new("mock"));
        providers_map.insert(mock_provider.name().to_string(), mock_provider);

        Self {
            providers: Arc::new(RwLock::new(providers_map)),
            config: Arc::new(RwLock::new(GenerativeEngineConfig::default())),
            history: Arc::new(RwLock::new(Vec::new())),
            max_history: 100,
        }
    }

    /// Creates a new engine with config
    pub fn with_config(config: GenerativeEngineConfig) -> Self {
        // Pre-populate providers with mock provider for testing
        let mut providers_map: HashMap<String, Arc<dyn GenerativeProvider>> = HashMap::new();
        let mock_provider = Arc::new(MockGenerativeProvider::new("mock"));
        providers_map.insert(mock_provider.name().to_string(), mock_provider);

        Self {
            providers: Arc::new(RwLock::new(providers_map)),
            config: Arc::new(RwLock::new(config)),
            history: Arc::new(RwLock::new(Vec::new())),
            max_history: 100,
        }
    }

    /// Registers a provider
    pub async fn register_provider(&self, provider: Arc<dyn GenerativeProvider>) {
        let mut providers = self.providers.write().await;
        providers.insert(provider.name().to_string(), provider);
    }

    /// Gets a provider by name
    pub async fn get_provider(&self, name: &str) -> Option<Arc<dyn GenerativeProvider>> {
        let providers = self.providers.read().await;
        providers.get(name).cloned()
    }

    /// Lists all providers
    pub async fn list_providers(&self) -> Vec<String> {
        let providers = self.providers.read().await;
        providers.keys().cloned().collect()
    }

    /// Lists providers with a specific capability
    pub async fn providers_with_capability(&self, capability: ProviderCapability) -> Vec<String> {
        let providers = self.providers.read().await;
        providers
            .iter()
            .filter(|(_, p)| p.supports(capability))
            .map(|(name, _)| name.clone())
            .collect()
    }

    /// Gets the default provider for a capability
    pub async fn default_provider_for(
        &self,
        capability: ProviderCapability,
    ) -> Option<Arc<dyn GenerativeProvider>> {
        let config = self.config.read().await;

        let default_name = match capability {
            ProviderCapability::ImageGeneration => config.default_image_provider.clone(),
            ProviderCapability::TextToSpeech => config.default_tts_provider.clone(),
            ProviderCapability::MusicGeneration => config.default_music_provider.clone(),
            _ => None,
        };

        if let Some(name) = default_name {
            if let Some(provider) = self.get_provider(&name).await {
                if provider.supports(capability) {
                    return Some(provider);
                }
            }
        }

        // Fall back to first available provider with capability
        let providers = self.providers.read().await;
        for (_, provider) in providers.iter() {
            if provider.supports(capability) && provider.is_available() {
                return Some(provider.clone());
            }
        }

        None
    }

    /// Generates content based on request
    pub async fn generate(&self, request: GenerationRequest) -> CoreResult<GenerationResult> {
        let capability = request.required_capability();
        let provider = self.default_provider_for(capability).await.ok_or_else(|| {
            CoreError::NotSupported(format!("No provider available for {:?}", capability))
        })?;

        let result = match request {
            GenerationRequest::Image(params) => {
                params.validate().map_err(CoreError::ValidationError)?;
                let result = provider.generate_image(&params).await?;
                GenerationResult::Image(result)
            }
            GenerationRequest::Speech(params) => {
                params.validate().map_err(CoreError::ValidationError)?;
                let result = provider.generate_speech(&params).await?;
                GenerationResult::Speech(result)
            }
            GenerationRequest::Music(params) => {
                params.validate().map_err(CoreError::ValidationError)?;
                let result = provider.generate_music(&params).await?;
                GenerationResult::Music(result)
            }
        };

        // Add to history
        self.add_to_history(result.clone()).await;

        Ok(result)
    }

    /// Generates content with a specific provider
    pub async fn generate_with_provider(
        &self,
        provider_name: &str,
        request: GenerationRequest,
    ) -> CoreResult<GenerationResult> {
        let provider = self
            .get_provider(provider_name)
            .await
            .ok_or_else(|| CoreError::NotFound(format!("Provider not found: {}", provider_name)))?;

        let capability = request.required_capability();
        if !provider.supports(capability) {
            return Err(CoreError::NotSupported(format!(
                "Provider {} does not support {:?}",
                provider_name, capability
            )));
        }

        let result = match request {
            GenerationRequest::Image(params) => {
                params.validate().map_err(CoreError::ValidationError)?;
                let result = provider.generate_image(&params).await?;
                GenerationResult::Image(result)
            }
            GenerationRequest::Speech(params) => {
                params.validate().map_err(CoreError::ValidationError)?;
                let result = provider.generate_speech(&params).await?;
                GenerationResult::Speech(result)
            }
            GenerationRequest::Music(params) => {
                params.validate().map_err(CoreError::ValidationError)?;
                let result = provider.generate_music(&params).await?;
                GenerationResult::Music(result)
            }
        };

        self.add_to_history(result.clone()).await;

        Ok(result)
    }

    /// Adds a result to history
    async fn add_to_history(&self, result: GenerationResult) {
        let mut history = self.history.write().await;
        history.push(result);

        // Trim if over max
        while history.len() > self.max_history {
            history.remove(0);
        }
    }

    /// Gets recent generation history
    pub async fn get_history(&self, limit: usize) -> Vec<GenerationResult> {
        let history = self.history.read().await;
        history.iter().rev().take(limit).cloned().collect()
    }

    /// Clears generation history
    pub async fn clear_history(&self) {
        let mut history = self.history.write().await;
        history.clear();
    }

    /// Gets the engine configuration
    pub async fn get_config(&self) -> GenerativeEngineConfig {
        self.config.read().await.clone()
    }

    /// Sets the engine configuration
    pub async fn set_config(&self, config: GenerativeEngineConfig) {
        let mut cfg = self.config.write().await;
        *cfg = config;
    }

    /// Convenience method for image generation
    pub async fn generate_image(
        &self,
        params: ImageGenerationParams,
    ) -> CoreResult<ImageGenerationResult> {
        match self.generate(GenerationRequest::Image(params)).await? {
            GenerationResult::Image(result) => Ok(result),
            _ => unreachable!(),
        }
    }

    /// Convenience method for TTS
    pub async fn generate_speech(&self, params: TTSParams) -> CoreResult<TTSResult> {
        match self.generate(GenerationRequest::Speech(params)).await? {
            GenerationResult::Speech(result) => Ok(result),
            _ => unreachable!(),
        }
    }

    /// Convenience method for music generation
    pub async fn generate_music(
        &self,
        params: MusicGenerationParams,
    ) -> CoreResult<MusicGenerationResult> {
        match self.generate(GenerationRequest::Music(params)).await? {
            GenerationResult::Music(result) => Ok(result),
            _ => unreachable!(),
        }
    }
}

impl Default for GenerativeEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // GenerativeEngineConfig Tests
    // ========================================================================

    #[test]
    fn test_config_default() {
        let config = GenerativeEngineConfig::default();
        assert_eq!(config.max_concurrent, 3);
        assert!(config.cache_enabled);
        assert!(config.default_image_provider.is_none());
    }

    #[test]
    fn test_config_builder() {
        let config = GenerativeEngineConfig::default()
            .with_image_provider("openai")
            .with_tts_provider("elevenlabs");

        assert_eq!(config.default_image_provider, Some("openai".to_string()));
        assert_eq!(config.default_tts_provider, Some("elevenlabs".to_string()));
    }

    // ========================================================================
    // GenerationRequest Tests
    // ========================================================================

    #[test]
    fn test_request_capability() {
        let img = GenerationRequest::Image(ImageGenerationParams::new("test"));
        assert_eq!(
            img.required_capability(),
            ProviderCapability::ImageGeneration
        );

        let speech = GenerationRequest::Speech(TTSParams::new("test"));
        assert_eq!(
            speech.required_capability(),
            ProviderCapability::TextToSpeech
        );

        let music = GenerationRequest::Music(MusicGenerationParams::new(30.0));
        assert_eq!(
            music.required_capability(),
            ProviderCapability::MusicGeneration
        );
    }

    // ========================================================================
    // GenerativeEngine Tests
    // ========================================================================

    #[tokio::test]
    async fn test_engine_new() {
        let engine = GenerativeEngine::new();
        let providers = engine.list_providers().await;

        assert!(!providers.is_empty());
        assert!(providers.contains(&"mock".to_string()));
    }

    #[tokio::test]
    async fn test_engine_register_provider() {
        let engine = GenerativeEngine::new();

        let custom = Arc::new(MockGenerativeProvider::new("custom"));
        engine.register_provider(custom).await;

        let providers = engine.list_providers().await;
        assert!(providers.contains(&"custom".to_string()));
    }

    #[tokio::test]
    async fn test_engine_providers_with_capability() {
        let engine = GenerativeEngine::new();

        let image_providers = engine
            .providers_with_capability(ProviderCapability::ImageGeneration)
            .await;
        assert!(!image_providers.is_empty());
    }

    #[tokio::test]
    async fn test_engine_generate_image() {
        let engine = GenerativeEngine::new();
        let params = ImageGenerationParams::new("A sunset");

        let result = engine.generate_image(params).await.unwrap();

        assert!(!result.id.is_empty());
        assert!(!result.image_data.is_empty());
    }

    #[tokio::test]
    async fn test_engine_generate_speech() {
        let engine = GenerativeEngine::new();
        let params = TTSParams::new("Hello world");

        let result = engine.generate_speech(params).await.unwrap();

        assert!(!result.id.is_empty());
        assert!(!result.audio_data.is_empty());
    }

    #[tokio::test]
    async fn test_engine_generate_with_provider() {
        let engine = GenerativeEngine::new();
        let params = ImageGenerationParams::new("A mountain");

        let result = engine
            .generate_with_provider("mock", GenerationRequest::Image(params))
            .await
            .unwrap();

        if let GenerationResult::Image(img) = result {
            assert!(!img.id.is_empty());
        } else {
            panic!("Expected image result");
        }
    }

    #[tokio::test]
    async fn test_engine_history() {
        let engine = GenerativeEngine::new();

        // Generate some content
        engine
            .generate_image(ImageGenerationParams::new("Test 1"))
            .await
            .unwrap();
        engine
            .generate_speech(TTSParams::new("Test 2"))
            .await
            .unwrap();

        let history = engine.get_history(10).await;
        assert_eq!(history.len(), 2);

        engine.clear_history().await;
        let history = engine.get_history(10).await;
        assert!(history.is_empty());
    }

    #[tokio::test]
    async fn test_engine_config() {
        let engine = GenerativeEngine::new();

        let config = engine.get_config().await;
        assert!(config.cache_enabled);

        let mut new_config = config;
        new_config.cache_enabled = false;
        engine.set_config(new_config).await;

        let updated = engine.get_config().await;
        assert!(!updated.cache_enabled);
    }

    #[tokio::test]
    async fn test_engine_validation_error() {
        let engine = GenerativeEngine::new();

        // Empty prompt should fail validation
        let params = ImageGenerationParams::new("  ");
        let result = engine.generate_image(params).await;

        assert!(result.is_err());
    }
}

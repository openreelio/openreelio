//! AI Provider Implementations
//!
//! Concrete implementations of the AIProvider trait for various AI services.

mod anthropic;
mod gemini;
mod local;
mod openai;

pub use anthropic::AnthropicProvider;
pub use gemini::GeminiProvider;
pub use local::LocalProvider;
pub use openai::OpenAIProvider;

use serde::{Deserialize, Serialize};
use specta::Type;

// =============================================================================
// Provider Configuration
// =============================================================================

/// Supported AI provider types
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    /// OpenAI GPT models (GPT-4, GPT-4o, etc.)
    OpenAI,
    /// Anthropic Claude models
    Anthropic,
    /// Google Gemini models
    Gemini,
    /// Local models via Ollama
    Local,
}

impl std::fmt::Display for ProviderType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderType::OpenAI => write!(f, "openai"),
            ProviderType::Anthropic => write!(f, "anthropic"),
            ProviderType::Gemini => write!(f, "gemini"),
            ProviderType::Local => write!(f, "local"),
        }
    }
}

impl std::str::FromStr for ProviderType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "openai" => Ok(ProviderType::OpenAI),
            "anthropic" => Ok(ProviderType::Anthropic),
            "gemini" => Ok(ProviderType::Gemini),
            "local" | "ollama" => Ok(ProviderType::Local),
            _ => Err(format!("Unknown provider type: {}", s)),
        }
    }
}

/// Provider status information
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    /// Provider type
    pub provider_type: ProviderType,
    /// Whether the provider is configured (has API key or endpoint)
    pub is_configured: bool,
    /// Whether the provider is available and working
    pub is_available: bool,
    /// Current model being used
    pub current_model: String,
    /// Available models for this provider
    pub available_models: Vec<String>,
    /// Error message if unavailable
    pub error_message: Option<String>,
}

/// Configuration for creating a provider
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// Provider type
    pub provider_type: ProviderType,
    /// API key (for cloud providers)
    pub api_key: Option<String>,
    /// Base URL (for custom endpoints or local models)
    pub base_url: Option<String>,
    /// Default model to use
    pub model: Option<String>,
    /// Request timeout in seconds
    pub timeout_secs: Option<u64>,
}

impl ProviderConfig {
    /// Creates a new OpenAI provider config
    pub fn openai(api_key: &str) -> Self {
        Self {
            provider_type: ProviderType::OpenAI,
            api_key: Some(api_key.to_string()),
            base_url: None,
            model: Some("gpt-5.2".to_string()),
            timeout_secs: Some(60),
        }
    }

    /// Creates a new Anthropic provider config
    pub fn anthropic(api_key: &str) -> Self {
        Self {
            provider_type: ProviderType::Anthropic,
            api_key: Some(api_key.to_string()),
            base_url: None,
            model: Some("claude-sonnet-4-5-20251015".to_string()),
            timeout_secs: Some(60),
        }
    }

    /// Creates a new Google Gemini provider config
    pub fn gemini(api_key: &str) -> Self {
        Self {
            provider_type: ProviderType::Gemini,
            api_key: Some(api_key.to_string()),
            base_url: None,
            model: Some("gemini-3-flash-preview".to_string()),
            timeout_secs: Some(120), // Longer timeout for large context
        }
    }

    /// Creates a new local (Ollama) provider config
    pub fn local(base_url: Option<&str>) -> Self {
        Self {
            provider_type: ProviderType::Local,
            api_key: None,
            base_url: base_url.map(|s| s.to_string()),
            model: Some("llama3.2".to_string()),
            timeout_secs: Some(120),
        }
    }

    /// Sets the model
    pub fn with_model(mut self, model: &str) -> Self {
        self.model = Some(model.to_string());
        self
    }

    /// Sets the base URL
    pub fn with_base_url(mut self, url: &str) -> Self {
        self.base_url = Some(url.to_string());
        self
    }
}

// =============================================================================
// Provider Factory
// =============================================================================

use super::provider::AIProvider;
use crate::core::CoreResult;

/// Creates an AI provider from configuration
pub fn create_provider(config: ProviderConfig) -> CoreResult<Box<dyn AIProvider>> {
    match config.provider_type {
        ProviderType::OpenAI => {
            let provider = OpenAIProvider::new(config)?;
            Ok(Box::new(provider))
        }
        ProviderType::Anthropic => {
            let provider = AnthropicProvider::new(config)?;
            Ok(Box::new(provider))
        }
        ProviderType::Gemini => {
            let provider = GeminiProvider::new(config)?;
            Ok(Box::new(provider))
        }
        ProviderType::Local => {
            let provider = LocalProvider::new(config)?;
            Ok(Box::new(provider))
        }
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_type_parsing() {
        assert_eq!(
            "openai".parse::<ProviderType>().unwrap(),
            ProviderType::OpenAI
        );
        assert_eq!(
            "anthropic".parse::<ProviderType>().unwrap(),
            ProviderType::Anthropic
        );
        assert_eq!(
            "local".parse::<ProviderType>().unwrap(),
            ProviderType::Local
        );
        assert_eq!(
            "ollama".parse::<ProviderType>().unwrap(),
            ProviderType::Local
        );
        assert_eq!(
            "gemini".parse::<ProviderType>().unwrap(),
            ProviderType::Gemini
        );
    }

    #[test]
    fn test_provider_type_display() {
        assert_eq!(ProviderType::OpenAI.to_string(), "openai");
        assert_eq!(ProviderType::Anthropic.to_string(), "anthropic");
        assert_eq!(ProviderType::Gemini.to_string(), "gemini");
        assert_eq!(ProviderType::Local.to_string(), "local");
    }

    #[test]
    fn test_provider_config_openai() {
        let config = ProviderConfig::openai("test-key").with_model("gpt-4.1");
        assert_eq!(config.provider_type, ProviderType::OpenAI);
        assert_eq!(config.api_key, Some("test-key".to_string()));
        assert_eq!(config.model, Some("gpt-4.1".to_string()));
    }

    #[test]
    fn test_provider_config_anthropic() {
        let config = ProviderConfig::anthropic("test-key");
        assert_eq!(config.provider_type, ProviderType::Anthropic);
        assert_eq!(config.api_key, Some("test-key".to_string()));
    }

    #[test]
    fn test_provider_config_local() {
        let config = ProviderConfig::local(Some("http://localhost:11434"));
        assert_eq!(config.provider_type, ProviderType::Local);
        assert!(config.api_key.is_none());
        assert_eq!(config.base_url, Some("http://localhost:11434".to_string()));
    }
}

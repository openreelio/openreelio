//! Anthropic Provider Implementation
//!
//! Implements the AIProvider trait for Anthropic's Claude models.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::ProviderConfig;
use crate::core::ai::provider::{AIProvider, CompletionRequest, CompletionResponse};
#[cfg(feature = "ai-providers")]
use crate::core::ai::provider::{FinishReason, TokenUsage};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Anthropic Provider
// =============================================================================

/// Anthropic API provider for Claude models
pub struct AnthropicProvider {
    /// API key
    api_key: String,
    /// Base URL for API requests
    #[allow(dead_code)]
    base_url: String,
    /// Default model
    #[allow(dead_code)]
    default_model: String,
    /// Request timeout in seconds
    #[allow(dead_code)]
    timeout_secs: u64,
    /// HTTP client
    #[cfg(feature = "ai-providers")]
    client: reqwest::Client,
}

impl AnthropicProvider {
    /// Default Anthropic API base URL
    pub const DEFAULT_BASE_URL: &'static str = "https://api.anthropic.com";

    /// API version header
    pub const API_VERSION: &'static str = "2023-06-01";

    /// Available Claude models (2026)
    /// Note: Claude 3.x models are deprecated/retired as of January 2026
    pub const AVAILABLE_MODELS: &'static [&'static str] = &[
        "claude-opus-4-5-20251115",
        "claude-sonnet-4-5-20251015",
        "claude-haiku-4-5-20251015",
        "claude-opus-4-1-20250805",
        "claude-sonnet-4-20250514",
    ];

    /// Creates a new Anthropic provider
    pub fn new(config: ProviderConfig) -> CoreResult<Self> {
        let api_key = config.api_key.ok_or_else(|| {
            CoreError::ValidationError("Anthropic API key is required".to_string())
        })?;

        if api_key.is_empty() {
            return Err(CoreError::ValidationError(
                "Anthropic API key cannot be empty".to_string(),
            ));
        }

        let base_url = config
            .base_url
            .unwrap_or_else(|| Self::DEFAULT_BASE_URL.to_string());

        let default_model = config
            .model
            .unwrap_or_else(|| "claude-sonnet-4-5-20251015".to_string());

        let timeout_secs = config.timeout_secs.unwrap_or(60);

        #[cfg(feature = "ai-providers")]
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .build()
            .map_err(|e| CoreError::Internal(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            api_key,
            base_url,
            default_model,
            timeout_secs,
            #[cfg(feature = "ai-providers")]
            client,
        })
    }

    /// Returns available models for this provider
    pub fn available_models() -> Vec<String> {
        Self::AVAILABLE_MODELS
            .iter()
            .map(|s| s.to_string())
            .collect()
    }
}

// =============================================================================
// Anthropic API Types
// =============================================================================

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
struct MessagesRequest {
    model: String,
    max_tokens: u32,
    messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
struct Message {
    role: String,
    content: String,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct MessagesResponse {
    content: Vec<ContentBlock>,
    model: String,
    stop_reason: Option<String>,
    usage: ApiUsage,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ApiUsage {
    input_tokens: u32,
    output_tokens: u32,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ApiError {
    error: ApiErrorDetail,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ApiErrorDetail {
    message: String,
    #[serde(rename = "type")]
    error_type: String,
}

// =============================================================================
// AIProvider Implementation
// =============================================================================

#[async_trait]
impl AIProvider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    #[cfg(feature = "ai-providers")]
    async fn complete(&self, request: CompletionRequest) -> CoreResult<CompletionResponse> {
        let model = request.model.unwrap_or_else(|| self.default_model.clone());

        // Build messages (Anthropic uses separate system parameter)
        let messages = vec![Message {
            role: "user".to_string(),
            content: request.prompt.clone(),
        }];

        // Set max_tokens (required for Anthropic)
        let max_tokens = request.max_tokens.unwrap_or(4096);

        // Build request
        let api_request = MessagesRequest {
            model: model.clone(),
            max_tokens,
            messages,
            system: request.system.clone(),
            temperature: request.temperature,
        };

        // Send request
        let url = format!("{}/v1/messages", self.base_url);
        let response = self
            .client
            .post(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", Self::API_VERSION)
            .header("Content-Type", "application/json")
            .json(&api_request)
            .send()
            .await
            .map_err(|e| CoreError::AIRequestFailed(format!("Request failed: {}", e)))?;

        // Handle response
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| CoreError::AIRequestFailed(format!("Failed to read response: {}", e)))?;

        if !status.is_success() {
            let error: ApiError = serde_json::from_str(&body).unwrap_or(ApiError {
                error: ApiErrorDetail {
                    message: body.clone(),
                    error_type: "unknown".to_string(),
                },
            });
            return Err(CoreError::AIRequestFailed(format!(
                "Anthropic API error ({}): {} - {}",
                status, error.error.error_type, error.error.message
            )));
        }

        let api_response: MessagesResponse = serde_json::from_str(&body)
            .map_err(|e| CoreError::AIRequestFailed(format!("Failed to parse response: {}", e)))?;

        // Extract text from content blocks
        let text = api_response
            .content
            .iter()
            .filter_map(|block| {
                if block.content_type == "text" {
                    block.text.clone()
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("");

        let finish_reason = match api_response.stop_reason.as_deref() {
            Some("end_turn") => FinishReason::Stop,
            Some("max_tokens") => FinishReason::Length,
            Some("stop_sequence") => FinishReason::Stop,
            Some("tool_use") => FinishReason::ToolCalls,
            _ => FinishReason::Stop,
        };

        let usage = TokenUsage {
            prompt_tokens: api_response.usage.input_tokens,
            completion_tokens: api_response.usage.output_tokens,
            total_tokens: api_response.usage.input_tokens + api_response.usage.output_tokens,
        };

        Ok(CompletionResponse {
            text,
            model: api_response.model,
            usage,
            finish_reason,
        })
    }

    #[cfg(not(feature = "ai-providers"))]
    async fn complete(&self, _request: CompletionRequest) -> CoreResult<CompletionResponse> {
        Err(CoreError::NotSupported(
            "AI providers feature not enabled. Build with --features ai-providers".to_string(),
        ))
    }

    async fn embed(&self, _texts: Vec<String>) -> CoreResult<Vec<Vec<f32>>> {
        // Anthropic doesn't have a native embedding API
        // Users should use a different provider for embeddings
        Err(CoreError::NotSupported(
            "Anthropic does not provide an embedding API. Use OpenAI or a local model for embeddings.".to_string(),
        ))
    }

    fn is_available(&self) -> bool {
        !self.api_key.is_empty()
    }

    #[cfg(feature = "ai-providers")]
    async fn health_check(&self) -> CoreResult<()> {
        // Anthropic provides a models endpoint. This is a cheap auth + connectivity check.
        let url = format!("{}/v1/models", self.base_url);
        let response = self
            .client
            .get(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", Self::API_VERSION)
            .send()
            .await
            .map_err(|e| CoreError::AIRequestFailed(format!("Health check failed: {}", e)))?;

        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<unreadable response body>".to_string());

        Err(CoreError::AIRequestFailed(format!(
            "Anthropic health check failed ({}): {}",
            status, body
        )))
    }

    #[cfg(not(feature = "ai-providers"))]
    async fn health_check(&self) -> CoreResult<()> {
        Err(CoreError::NotSupported(
            "AI providers feature not enabled. Build with --features ai-providers".to_string(),
        ))
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_anthropic_provider_creation() {
        let config = ProviderConfig::anthropic("test-api-key");
        let provider = AnthropicProvider::new(config).unwrap();

        assert_eq!(provider.name(), "anthropic");
        assert!(provider.is_available());
    }

    #[test]
    fn test_anthropic_provider_empty_key() {
        let config = ProviderConfig::anthropic("");
        let result = AnthropicProvider::new(config);

        assert!(result.is_err());
    }

    #[test]
    fn test_anthropic_provider_no_key() {
        let config = ProviderConfig {
            provider_type: super::super::ProviderType::Anthropic,
            api_key: None,
            base_url: None,
            model: None,
            timeout_secs: None,
        };
        let result = AnthropicProvider::new(config);

        assert!(result.is_err());
    }

    #[test]
    fn test_anthropic_custom_model() {
        let config = ProviderConfig::anthropic("test-key").with_model("claude-opus-4-5-20251115");
        let provider = AnthropicProvider::new(config).unwrap();

        assert_eq!(provider.default_model, "claude-opus-4-5-20251115");
    }

    #[test]
    fn test_available_models() {
        let models = AnthropicProvider::available_models();
        assert!(models.contains(&"claude-sonnet-4-5-20251015".to_string()));
        assert!(models.contains(&"claude-opus-4-5-20251115".to_string()));
    }

    #[tokio::test]
    async fn test_embed_not_supported() {
        let config = ProviderConfig::anthropic("test-key");
        let provider = AnthropicProvider::new(config).unwrap();

        let result = provider.embed(vec!["test".to_string()]).await;
        assert!(result.is_err());
    }
}

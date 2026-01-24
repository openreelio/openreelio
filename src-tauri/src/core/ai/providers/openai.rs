//! OpenAI Provider Implementation
//!
//! Implements the AIProvider trait for OpenAI's GPT models.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::ProviderConfig;
use crate::core::ai::provider::{AIProvider, CompletionRequest, CompletionResponse};
#[cfg(feature = "ai-providers")]
use crate::core::ai::provider::{FinishReason, TokenUsage};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// OpenAI Provider
// =============================================================================

/// OpenAI API provider for GPT models
pub struct OpenAIProvider {
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

impl OpenAIProvider {
    /// Default OpenAI API base URL
    pub const DEFAULT_BASE_URL: &'static str = "https://api.openai.com/v1";

    /// Available GPT models (2026)
    pub const AVAILABLE_MODELS: &'static [&'static str] = &[
        "gpt-5.2",
        "gpt-5.1",
        "gpt-5-mini",
        "gpt-5-nano",
        "gpt-4.1",
        "gpt-4.1-mini",
        "o3",
        "o3-mini",
        "o4-mini",
    ];

    /// Creates a new OpenAI provider
    pub fn new(config: ProviderConfig) -> CoreResult<Self> {
        let api_key = config
            .api_key
            .ok_or_else(|| CoreError::ValidationError("OpenAI API key is required".to_string()))?;

        if api_key.is_empty() {
            return Err(CoreError::ValidationError(
                "OpenAI API key cannot be empty".to_string(),
            ));
        }

        let base_url = config
            .base_url
            .unwrap_or_else(|| Self::DEFAULT_BASE_URL.to_string());

        let default_model = config.model.unwrap_or_else(|| "gpt-5.2".to_string());
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
// OpenAI API Types
// =============================================================================

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    format_type: String,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
    model: String,
    usage: Option<ApiUsage>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ChatChoice {
    message: ChatResponseMessage,
    finish_reason: Option<String>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ChatResponseMessage {
    content: Option<String>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ApiUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
struct EmbeddingRequest {
    model: String,
    input: Vec<String>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
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
    error_type: Option<String>,
}

// =============================================================================
// AIProvider Implementation
// =============================================================================

#[async_trait]
impl AIProvider for OpenAIProvider {
    fn name(&self) -> &str {
        "openai"
    }

    #[cfg(feature = "ai-providers")]
    async fn complete(&self, request: CompletionRequest) -> CoreResult<CompletionResponse> {
        let model = request.model.unwrap_or_else(|| self.default_model.clone());

        // Build messages
        let mut messages = Vec::new();
        if let Some(system) = &request.system {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: system.clone(),
            });
        }
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: request.prompt.clone(),
        });

        // Build request
        let api_request = ChatCompletionRequest {
            model: model.clone(),
            messages,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            response_format: if request.json_mode {
                Some(ResponseFormat {
                    format_type: "json_object".to_string(),
                })
            } else {
                None
            },
        };

        // Send request
        let url = format!("{}/chat/completions", self.base_url);
        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
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
                    error_type: None,
                },
            });
            let error_type = error.error.error_type.as_deref().unwrap_or("unknown");
            return Err(CoreError::AIRequestFailed(format!(
                "OpenAI API error ({}; type={}): {}",
                status, error_type, error.error.message
            )));
        }

        let api_response: ChatCompletionResponse = serde_json::from_str(&body)
            .map_err(|e| CoreError::AIRequestFailed(format!("Failed to parse response: {}", e)))?;

        let choice = api_response.choices.first().ok_or_else(|| {
            CoreError::AIRequestFailed("No completion choices returned".to_string())
        })?;

        let text = choice.message.content.clone().unwrap_or_default();

        let finish_reason = match choice.finish_reason.as_deref() {
            Some("stop") => FinishReason::Stop,
            Some("length") => FinishReason::Length,
            Some("content_filter") => FinishReason::ContentFilter,
            Some("tool_calls") | Some("function_call") => FinishReason::ToolCalls,
            _ => FinishReason::Stop,
        };

        let usage = api_response
            .usage
            .map(|u| TokenUsage {
                prompt_tokens: u.prompt_tokens,
                completion_tokens: u.completion_tokens,
                total_tokens: u.total_tokens,
            })
            .unwrap_or_default();

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

    #[cfg(feature = "ai-providers")]
    async fn embed(&self, texts: Vec<String>) -> CoreResult<Vec<Vec<f32>>> {
        let api_request = EmbeddingRequest {
            model: "text-embedding-3-small".to_string(),
            input: texts,
        };

        let url = format!("{}/embeddings", self.base_url);
        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&api_request)
            .send()
            .await
            .map_err(|e| CoreError::AIRequestFailed(format!("Embedding request failed: {}", e)))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| CoreError::AIRequestFailed(format!("Failed to read response: {}", e)))?;

        if !status.is_success() {
            return Err(CoreError::AIRequestFailed(format!(
                "OpenAI embedding API error ({}): {}",
                status, body
            )));
        }

        let api_response: EmbeddingResponse = serde_json::from_str(&body).map_err(|e| {
            CoreError::AIRequestFailed(format!("Failed to parse embedding response: {}", e))
        })?;

        Ok(api_response.data.into_iter().map(|d| d.embedding).collect())
    }

    #[cfg(not(feature = "ai-providers"))]
    async fn embed(&self, _texts: Vec<String>) -> CoreResult<Vec<Vec<f32>>> {
        Err(CoreError::NotSupported(
            "AI providers feature not enabled. Build with --features ai-providers".to_string(),
        ))
    }

    fn is_available(&self) -> bool {
        !self.api_key.is_empty()
    }

    #[cfg(feature = "ai-providers")]
    async fn health_check(&self) -> CoreResult<()> {
        let url = format!("{}/models", self.base_url);
        let response = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
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
            "OpenAI health check failed ({}): {}",
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
    fn test_openai_provider_creation() {
        let config = ProviderConfig::openai("test-api-key");
        let provider = OpenAIProvider::new(config).unwrap();

        assert_eq!(provider.name(), "openai");
        assert!(provider.is_available());
    }

    #[test]
    fn test_openai_provider_empty_key() {
        let config = ProviderConfig::openai("");
        let result = OpenAIProvider::new(config);

        assert!(result.is_err());
    }

    #[test]
    fn test_openai_provider_no_key() {
        let config = ProviderConfig {
            provider_type: super::super::ProviderType::OpenAI,
            api_key: None,
            base_url: None,
            model: None,
            timeout_secs: None,
        };
        let result = OpenAIProvider::new(config);

        assert!(result.is_err());
    }

    #[test]
    fn test_openai_custom_base_url() {
        let config =
            ProviderConfig::openai("test-key").with_base_url("https://custom.openai.com/v1");
        let provider = OpenAIProvider::new(config).unwrap();

        assert_eq!(provider.base_url, "https://custom.openai.com/v1");
    }

    #[test]
    fn test_openai_custom_model() {
        let config = ProviderConfig::openai("test-key").with_model("gpt-4-turbo");
        let provider = OpenAIProvider::new(config).unwrap();

        assert_eq!(provider.default_model, "gpt-4-turbo");
    }

    #[test]
    fn test_available_models() {
        let models = OpenAIProvider::available_models();
        assert!(models.contains(&"gpt-5.2".to_string()));
        assert!(models.contains(&"gpt-4.1".to_string()));
    }
}

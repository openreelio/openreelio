//! Local Provider Implementation
//!
//! Implements the AIProvider trait for local models via Ollama.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::ProviderConfig;
use crate::core::ai::provider::{AIProvider, CompletionRequest, CompletionResponse};
#[cfg(feature = "ai-providers")]
use crate::core::ai::provider::{FinishReason, TokenUsage};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Local Provider (Ollama)
// =============================================================================

/// Local AI provider using Ollama for running local models
pub struct LocalProvider {
    /// Base URL for Ollama API
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

impl LocalProvider {
    /// Default Ollama API base URL
    pub const DEFAULT_BASE_URL: &'static str = "http://localhost:11434";

    /// Common local models
    pub const COMMON_MODELS: &'static [&'static str] = &[
        "llama3.2",
        "llama3.1",
        "mistral",
        "mixtral",
        "codellama",
        "deepseek-coder",
        "qwen2.5",
        "phi3",
    ];

    /// Creates a new local (Ollama) provider
    pub fn new(config: ProviderConfig) -> CoreResult<Self> {
        let base_url = config
            .base_url
            .unwrap_or_else(|| Self::DEFAULT_BASE_URL.to_string());

        let default_model = config.model.unwrap_or_else(|| "llama3.2".to_string());
        let timeout_secs = config.timeout_secs.unwrap_or(120);

        #[cfg(feature = "ai-providers")]
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .build()
            .map_err(|e| CoreError::Internal(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            base_url,
            default_model,
            timeout_secs,
            #[cfg(feature = "ai-providers")]
            client,
        })
    }

    /// Returns common local models
    pub fn common_models() -> Vec<String> {
        Self::COMMON_MODELS.iter().map(|s| s.to_string()).collect()
    }

    /// Checks if Ollama is running
    #[cfg(feature = "ai-providers")]
    pub async fn check_health(&self) -> CoreResult<bool> {
        let url = format!("{}/api/tags", self.base_url);
        match self.client.get(&url).send().await {
            Ok(response) => Ok(response.status().is_success()),
            Err(_) => Ok(false),
        }
    }

    /// Lists available models from Ollama
    #[cfg(feature = "ai-providers")]
    pub async fn list_models(&self) -> CoreResult<Vec<String>> {
        let url = format!("{}/api/tags", self.base_url);
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| CoreError::AIRequestFailed(format!("Failed to list models: {}", e)))?;

        if !response.status().is_success() {
            return Ok(Vec::new());
        }

        let body = response
            .text()
            .await
            .map_err(|e| CoreError::AIRequestFailed(format!("Failed to read response: {}", e)))?;

        let tags: TagsResponse = serde_json::from_str(&body).map_err(|e| {
            CoreError::AIRequestFailed(format!("Failed to parse models list: {}", e))
        })?;

        Ok(tags.models.into_iter().map(|m| m.name).collect())
    }
}

// =============================================================================
// Ollama API Types
// =============================================================================

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<ChatOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
struct ChatOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_predict: Option<u32>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ChatResponse {
    message: ResponseMessage,
    model: String,
    done: bool,
    #[serde(default)]
    prompt_eval_count: Option<u32>,
    #[serde(default)]
    eval_count: Option<u32>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ResponseMessage {
    content: String,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
struct EmbeddingRequest {
    model: String,
    prompt: String,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct EmbeddingResponse {
    embedding: Vec<f32>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<ModelInfo>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct ModelInfo {
    name: String,
}

// =============================================================================
// AIProvider Implementation
// =============================================================================

#[async_trait]
impl AIProvider for LocalProvider {
    fn name(&self) -> &str {
        "local"
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

        // Build options
        let options = if request.temperature.is_some() || request.max_tokens.is_some() {
            Some(ChatOptions {
                temperature: request.temperature,
                num_predict: request.max_tokens,
            })
        } else {
            None
        };

        // Build request
        let api_request = ChatRequest {
            model: model.clone(),
            messages,
            stream: false,
            options,
            format: if request.json_mode {
                Some("json".to_string())
            } else {
                None
            },
        };

        // Send request
        let url = format!("{}/api/chat", self.base_url);
        let response = self
            .client
            .post(&url)
            .json(&api_request)
            .send()
            .await
            .map_err(|e| {
                CoreError::AIRequestFailed(format!(
                    "Failed to connect to Ollama at {}: {}",
                    self.base_url, e
                ))
            })?;

        // Handle response
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| CoreError::AIRequestFailed(format!("Failed to read response: {}", e)))?;

        if !status.is_success() {
            return Err(CoreError::AIRequestFailed(format!(
                "Ollama API error ({}): {}",
                status, body
            )));
        }

        let api_response: ChatResponse = serde_json::from_str(&body)
            .map_err(|e| CoreError::AIRequestFailed(format!("Failed to parse response: {}", e)))?;

        let usage = TokenUsage {
            prompt_tokens: api_response.prompt_eval_count.unwrap_or(0),
            completion_tokens: api_response.eval_count.unwrap_or(0),
            total_tokens: api_response.prompt_eval_count.unwrap_or(0)
                + api_response.eval_count.unwrap_or(0),
        };

        Ok(CompletionResponse {
            text: api_response.message.content,
            model: api_response.model,
            usage,
            finish_reason: if api_response.done {
                FinishReason::Stop
            } else {
                FinishReason::Length
            },
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
        let mut embeddings = Vec::with_capacity(texts.len());

        // Ollama processes one embedding at a time
        for text in texts {
            let api_request = EmbeddingRequest {
                model: "nomic-embed-text".to_string(),
                prompt: text,
            };

            let url = format!("{}/api/embeddings", self.base_url);
            let response = self
                .client
                .post(&url)
                .json(&api_request)
                .send()
                .await
                .map_err(|e| {
                    CoreError::AIRequestFailed(format!("Embedding request failed: {}", e))
                })?;

            if !response.status().is_success() {
                return Err(CoreError::AIRequestFailed(format!(
                    "Ollama embedding error: {}",
                    response.status()
                )));
            }

            let body = response.text().await.map_err(|e| {
                CoreError::AIRequestFailed(format!("Failed to read embedding response: {}", e))
            })?;

            let api_response: EmbeddingResponse = serde_json::from_str(&body).map_err(|e| {
                CoreError::AIRequestFailed(format!("Failed to parse embedding response: {}", e))
            })?;

            embeddings.push(api_response.embedding);
        }

        Ok(embeddings)
    }

    #[cfg(not(feature = "ai-providers"))]
    async fn embed(&self, _texts: Vec<String>) -> CoreResult<Vec<Vec<f32>>> {
        Err(CoreError::NotSupported(
            "AI providers feature not enabled. Build with --features ai-providers".to_string(),
        ))
    }

    fn is_available(&self) -> bool {
        // Local provider is always considered available if configured
        // Actual availability is checked via check_health()
        true
    }

    #[cfg(feature = "ai-providers")]
    async fn health_check(&self) -> CoreResult<()> {
        let ok = self.check_health().await?;
        if ok {
            Ok(())
        } else {
            Err(CoreError::AIRequestFailed(format!(
                "Ollama is not reachable at {}",
                self.base_url
            )))
        }
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
    fn test_local_provider_creation() {
        let config = ProviderConfig::local(None);
        let provider = LocalProvider::new(config).unwrap();

        assert_eq!(provider.name(), "local");
        assert!(provider.is_available());
        assert_eq!(provider.base_url, LocalProvider::DEFAULT_BASE_URL);
    }

    #[test]
    fn test_local_provider_custom_url() {
        let config = ProviderConfig::local(Some("http://192.168.1.100:11434"));
        let provider = LocalProvider::new(config).unwrap();

        assert_eq!(provider.base_url, "http://192.168.1.100:11434");
    }

    #[test]
    fn test_local_provider_custom_model() {
        let config = ProviderConfig::local(None).with_model("mistral");
        let provider = LocalProvider::new(config).unwrap();

        assert_eq!(provider.default_model, "mistral");
    }

    #[test]
    fn test_common_models() {
        let models = LocalProvider::common_models();
        assert!(models.contains(&"llama3.2".to_string()));
        assert!(models.contains(&"mistral".to_string()));
    }
}

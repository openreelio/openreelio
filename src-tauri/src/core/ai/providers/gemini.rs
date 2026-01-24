//! Google Gemini Provider Implementation
//!
//! Implements the AIProvider trait for Google's Gemini models.
//! Features 2M token context window and native video understanding.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::ProviderConfig;
use crate::core::ai::provider::{AIProvider, CompletionRequest, CompletionResponse};
#[cfg(feature = "ai-providers")]
use crate::core::ai::provider::{FinishReason, TokenUsage};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Gemini Provider
// =============================================================================

/// Google Gemini API provider
pub struct GeminiProvider {
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

impl GeminiProvider {
    /// Default Gemini API base URL
    pub const DEFAULT_BASE_URL: &'static str = "https://generativelanguage.googleapis.com/v1beta";

    /// Available Gemini models (2026)
    /// Note: Gemini 1.x and 2.0 models are deprecated/retired as of March 2026
    pub const AVAILABLE_MODELS: &'static [&'static str] = &[
        "gemini-3-pro-preview",
        "gemini-3-flash-preview",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
    ];

    /// Creates a new Gemini provider
    pub fn new(config: ProviderConfig) -> CoreResult<Self> {
        let api_key = config
            .api_key
            .ok_or_else(|| CoreError::ValidationError("Gemini API key is required".to_string()))?;

        if api_key.is_empty() {
            return Err(CoreError::ValidationError(
                "Gemini API key cannot be empty".to_string(),
            ));
        }

        let base_url = config
            .base_url
            .unwrap_or_else(|| Self::DEFAULT_BASE_URL.to_string());

        let default_model = config
            .model
            .unwrap_or_else(|| "gemini-3-flash-preview".to_string());
        let timeout_secs = config.timeout_secs.unwrap_or(120); // Longer timeout for large context

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
// Gemini API Types
// =============================================================================

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateContentRequest {
    contents: Vec<Content>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_instruction: Option<Content>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation_config: Option<GenerationConfig>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize, Deserialize)]
struct Content {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    parts: Vec<Part>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize, Deserialize)]
struct Part {
    text: String,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_mime_type: Option<String>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateContentResponse {
    candidates: Option<Vec<Candidate>>,
    usage_metadata: Option<UsageMetadata>,
    #[serde(default)]
    prompt_feedback: Option<PromptFeedback>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    content: Option<Content>,
    finish_reason: Option<String>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageMetadata {
    prompt_token_count: Option<u32>,
    candidates_token_count: Option<u32>,
    total_token_count: Option<u32>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptFeedback {
    block_reason: Option<String>,
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
    #[allow(dead_code)]
    #[serde(default)]
    code: Option<i32>,
    #[serde(default)]
    status: Option<String>,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbedContentRequest {
    model: String,
    content: Content,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct EmbedContentResponse {
    embedding: EmbeddingValues,
}

#[cfg_attr(not(feature = "ai-providers"), allow(dead_code))]
#[derive(Deserialize)]
struct EmbeddingValues {
    values: Vec<f32>,
}

// =============================================================================
// AIProvider Implementation
// =============================================================================

#[async_trait]
impl AIProvider for GeminiProvider {
    fn name(&self) -> &str {
        "gemini"
    }

    #[cfg(feature = "ai-providers")]
    async fn complete(&self, request: CompletionRequest) -> CoreResult<CompletionResponse> {
        let model = request.model.unwrap_or_else(|| self.default_model.clone());

        // Build contents
        let contents = vec![Content {
            role: Some("user".to_string()),
            parts: vec![Part {
                text: request.prompt.clone(),
            }],
        }];

        // Build system instruction (if provided)
        let system_instruction = request.system.as_ref().map(|system| Content {
            role: None, // System instruction doesn't need a role
            parts: vec![Part {
                text: system.clone(),
            }],
        });

        // Build generation config
        let generation_config = Some(GenerationConfig {
            temperature: request.temperature,
            max_output_tokens: request.max_tokens,
            response_mime_type: if request.json_mode {
                Some("application/json".to_string())
            } else {
                None
            },
        });

        let api_request = GenerateContentRequest {
            contents,
            system_instruction,
            generation_config,
        };

        // Build URL with API key
        let url = format!(
            "{}/models/{}:generateContent?key={}",
            self.base_url, model, self.api_key
        );

        // Send request
        let response = self
            .client
            .post(&url)
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
                    code: None,
                    status: None,
                },
            });
            let status_str = error.error.status.as_deref().unwrap_or("unknown");
            return Err(CoreError::AIRequestFailed(format!(
                "Gemini API error ({}; status={}): {}",
                status, status_str, error.error.message
            )));
        }

        let api_response: GenerateContentResponse = serde_json::from_str(&body)
            .map_err(|e| CoreError::AIRequestFailed(format!("Failed to parse response: {}", e)))?;

        // Check for blocked content
        if let Some(feedback) = &api_response.prompt_feedback {
            if let Some(reason) = &feedback.block_reason {
                return Err(CoreError::AIRequestFailed(format!(
                    "Content blocked by Gemini safety filters: {}",
                    reason
                )));
            }
        }

        let candidates = api_response.candidates.ok_or_else(|| {
            CoreError::AIRequestFailed("No candidates returned from Gemini".to_string())
        })?;

        let candidate = candidates.first().ok_or_else(|| {
            CoreError::AIRequestFailed("Empty candidates array from Gemini".to_string())
        })?;

        let text = candidate
            .content
            .as_ref()
            .and_then(|c| c.parts.first())
            .map(|p| p.text.clone())
            .unwrap_or_default();

        let finish_reason = match candidate.finish_reason.as_deref() {
            Some("STOP") => FinishReason::Stop,
            Some("MAX_TOKENS") => FinishReason::Length,
            Some("SAFETY") | Some("RECITATION") | Some("OTHER") => FinishReason::ContentFilter,
            _ => FinishReason::Stop,
        };

        let usage = api_response
            .usage_metadata
            .map(|u| TokenUsage {
                prompt_tokens: u.prompt_token_count.unwrap_or(0),
                completion_tokens: u.candidates_token_count.unwrap_or(0),
                total_tokens: u.total_token_count.unwrap_or(0),
            })
            .unwrap_or_default();

        Ok(CompletionResponse {
            text,
            model,
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
        // Gemini uses text-embedding-004 model for embeddings
        let mut embeddings = Vec::with_capacity(texts.len());

        for text in texts {
            let content = Content {
                role: None,
                parts: vec![Part { text }],
            };

            let api_request = EmbedContentRequest {
                model: "models/text-embedding-004".to_string(),
                content,
            };

            let url = format!(
                "{}/models/text-embedding-004:embedContent?key={}",
                self.base_url, self.api_key
            );

            let response = self
                .client
                .post(&url)
                .header("Content-Type", "application/json")
                .json(&api_request)
                .send()
                .await
                .map_err(|e| {
                    CoreError::AIRequestFailed(format!("Embedding request failed: {}", e))
                })?;

            let status = response.status();
            let body = response.text().await.map_err(|e| {
                CoreError::AIRequestFailed(format!("Failed to read response: {}", e))
            })?;

            if !status.is_success() {
                return Err(CoreError::AIRequestFailed(format!(
                    "Gemini embedding API error ({}): {}",
                    status, body
                )));
            }

            let api_response: EmbedContentResponse = serde_json::from_str(&body).map_err(|e| {
                CoreError::AIRequestFailed(format!("Failed to parse embedding response: {}", e))
            })?;

            embeddings.push(api_response.embedding.values);
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
        !self.api_key.is_empty()
    }

    #[cfg(feature = "ai-providers")]
    async fn health_check(&self) -> CoreResult<()> {
        // List models to check API key validity
        let url = format!("{}/models?key={}", self.base_url, self.api_key);

        let response = self
            .client
            .get(&url)
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
            "Gemini health check failed ({}): {}",
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
    fn test_gemini_provider_creation() {
        let config = ProviderConfig::gemini("test-api-key");
        let provider = GeminiProvider::new(config).unwrap();

        assert_eq!(provider.name(), "gemini");
        assert!(provider.is_available());
    }

    #[test]
    fn test_gemini_provider_empty_key() {
        let config = ProviderConfig::gemini("");
        let result = GeminiProvider::new(config);

        assert!(result.is_err());
    }

    #[test]
    fn test_gemini_provider_no_key() {
        let config = ProviderConfig {
            provider_type: super::super::ProviderType::Gemini,
            api_key: None,
            base_url: None,
            model: None,
            timeout_secs: None,
        };
        let result = GeminiProvider::new(config);

        assert!(result.is_err());
    }

    #[test]
    fn test_gemini_custom_base_url() {
        let config =
            ProviderConfig::gemini("test-key").with_base_url("https://custom.googleapis.com/v1");
        let provider = GeminiProvider::new(config).unwrap();

        assert_eq!(provider.base_url, "https://custom.googleapis.com/v1");
    }

    #[test]
    fn test_gemini_custom_model() {
        let config = ProviderConfig::gemini("test-key").with_model("gemini-2.5-pro");
        let provider = GeminiProvider::new(config).unwrap();

        assert_eq!(provider.default_model, "gemini-2.5-pro");
    }

    #[test]
    fn test_available_models() {
        let models = GeminiProvider::available_models();
        assert!(models.contains(&"gemini-3-pro-preview".to_string()));
        assert!(models.contains(&"gemini-3-flash-preview".to_string()));
        assert!(models.contains(&"gemini-2.5-flash".to_string()));
    }

    #[test]
    fn test_gemini_default_timeout() {
        let config = ProviderConfig::gemini("test-key");
        let provider = GeminiProvider::new(config).unwrap();

        // Gemini uses longer timeout (120s) for large context
        assert_eq!(provider.timeout_secs, 120);
    }
}

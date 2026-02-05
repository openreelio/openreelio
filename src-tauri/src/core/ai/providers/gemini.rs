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

    fn build_generate_content_request(
        &self,
        request: &CompletionRequest,
    ) -> CoreResult<GenerateContentRequest> {
        let mut system_parts: Vec<String> = Vec::new();
        if let Some(system) = &request.system {
            if !system.trim().is_empty() {
                system_parts.push(system.clone());
            }
        }

        let contents = if let Some(conversation_messages) = &request.messages {
            if conversation_messages.is_empty() {
                return Err(CoreError::ValidationError(
                    "Conversation request must include at least one message.".to_string(),
                ));
            }

            let mut contents: Vec<Content> = Vec::new();

            for msg in conversation_messages {
                let role = msg.role.to_ascii_lowercase();
                if role == "system" {
                    if !msg.content.trim().is_empty() {
                        system_parts.push(msg.content.clone());
                    }
                    continue;
                }

                let gemini_role = match role.as_str() {
                    "assistant" | "model" => "model",
                    "user" => "user",
                    _ => {
                        tracing::warn!(
                            "Unknown conversation role for Gemini provider: {} (defaulting to user)",
                            msg.role
                        );
                        "user"
                    }
                };

                contents.push(Content {
                    role: Some(gemini_role.to_string()),
                    parts: vec![Part {
                        text: msg.content.clone(),
                    }],
                });
            }

            if contents.is_empty() {
                return Err(CoreError::ValidationError(
                    "Conversation request must include at least one non-system message."
                        .to_string(),
                ));
            }

            contents
        } else {
            vec![Content {
                role: Some("user".to_string()),
                parts: vec![Part {
                    text: request.prompt.clone(),
                }],
            }]
        };

        let system_instruction = if system_parts.is_empty() {
            None
        } else {
            Some(Content {
                role: None, // System instruction doesn't need a role
                parts: vec![Part {
                    text: system_parts.join("\n\n"),
                }],
            })
        };

        let generation_config = Some(GenerationConfig {
            temperature: request.temperature,
            max_output_tokens: request.max_tokens,
            response_mime_type: if request.json_mode {
                Some("application/json".to_string())
            } else {
                None
            },
        });

        Ok(GenerateContentRequest {
            contents,
            system_instruction,
            generation_config,
        })
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
        let model = request
            .model
            .as_deref()
            .unwrap_or(self.default_model.as_str())
            .to_string();

        let api_request = self.build_generate_content_request(&request)?;

        // Build URL (API key is passed via header to avoid leaking it in logs).
        let url = format!("{}/models/{}:generateContent", self.base_url, model);

        // Send request
        let response = self
            .client
            .post(&url)
            .header("x-goog-api-key", &self.api_key)
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

            let url = format!("{}/models/text-embedding-004:embedContent", self.base_url);

            let response = self
                .client
                .post(&url)
                .header("x-goog-api-key", &self.api_key)
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
        let url = format!("{}/models", self.base_url);

        let response = self
            .client
            .get(&url)
            .header("x-goog-api-key", &self.api_key)
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
    use crate::core::ai::provider::ConversationMessage;

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

    #[test]
    fn test_build_generate_content_request_single_turn() {
        let config = ProviderConfig::gemini("test-key");
        let provider = GeminiProvider::new(config).unwrap();

        let request = CompletionRequest::new("Hello")
            .with_system("You are a helpful assistant.")
            .with_max_tokens(123)
            .with_temperature(0.5)
            .with_json_mode();

        let api_request = provider.build_generate_content_request(&request).unwrap();

        assert_eq!(api_request.contents.len(), 1);
        assert_eq!(api_request.contents[0].role, Some("user".to_string()));
        assert_eq!(api_request.contents[0].parts.len(), 1);
        assert_eq!(api_request.contents[0].parts[0].text, "Hello");

        let system_instruction = api_request.system_instruction.unwrap();
        assert_eq!(system_instruction.parts.len(), 1);
        assert_eq!(
            system_instruction.parts[0].text,
            "You are a helpful assistant."
        );

        let gen = api_request.generation_config.unwrap();
        assert_eq!(gen.max_output_tokens, Some(123));
        assert_eq!(gen.temperature, Some(0.5));
        assert_eq!(gen.response_mime_type, Some("application/json".to_string()));
    }

    #[test]
    fn test_build_generate_content_request_conversation_mode_uses_messages() {
        let config = ProviderConfig::gemini("test-key");
        let provider = GeminiProvider::new(config).unwrap();

        let request = CompletionRequest::with_conversation(vec![
            ConversationMessage::user("Hi"),
            ConversationMessage::assistant("Hello!"),
            ConversationMessage::user("Split the selected clip at 5 seconds."),
        ])
        .with_system("Return JSON only.")
        .with_json_mode();

        let api_request = provider.build_generate_content_request(&request).unwrap();

        assert_eq!(api_request.contents.len(), 3);
        assert_eq!(api_request.contents[0].role, Some("user".to_string()));
        assert_eq!(api_request.contents[0].parts[0].text, "Hi");
        assert_eq!(api_request.contents[1].role, Some("model".to_string()));
        assert_eq!(api_request.contents[1].parts[0].text, "Hello!");
        assert_eq!(api_request.contents[2].role, Some("user".to_string()));
        assert_eq!(
            api_request.contents[2].parts[0].text,
            "Split the selected clip at 5 seconds."
        );

        let system_instruction = api_request.system_instruction.unwrap();
        assert_eq!(system_instruction.parts.len(), 1);
        assert_eq!(system_instruction.parts[0].text, "Return JSON only.");
    }

    #[test]
    fn test_build_generate_content_request_merges_system_messages() {
        let config = ProviderConfig::gemini("test-key");
        let provider = GeminiProvider::new(config).unwrap();

        let request = CompletionRequest::with_conversation(vec![
            ConversationMessage::system("Extra system instruction."),
            ConversationMessage::user("Hello"),
        ])
        .with_system("Base system instruction.");

        let api_request = provider.build_generate_content_request(&request).unwrap();

        assert_eq!(api_request.contents.len(), 1);
        assert_eq!(api_request.contents[0].role, Some("user".to_string()));
        assert_eq!(api_request.contents[0].parts[0].text, "Hello");

        let system_instruction = api_request.system_instruction.unwrap();
        assert_eq!(system_instruction.parts.len(), 1);
        assert_eq!(
            system_instruction.parts[0].text,
            "Base system instruction.\n\nExtra system instruction."
        );
    }
}

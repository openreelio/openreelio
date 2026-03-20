//! OpenAI Codex provider implementation.
//!
//! Uses the same Codex OAuth transport family as OpenClaw via
//! `@mariozechner/pi-ai`'s `openai-codex-responses` runtime instead of
//! forcing Codex OAuth through the standard OpenAI `/v1` API surface.

use async_trait::async_trait;
use serde::Serialize;

use super::ProviderConfig;
use crate::core::ai::provider::{AIProvider, CompletionRequest, CompletionResponse};
use crate::core::ai::provider::{FinishReason, TokenUsage};
use crate::core::credentials::{
    run_codex_helper_json, run_codex_helper_json_with_input, CodexHelperCompletion,
    CodexHelperModels, StoredCodexOauthCredential,
};
use crate::core::{CoreError, CoreResult};

pub struct OpenAICodexProvider {
    oauth: StoredCodexOauthCredential,
    default_model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexCompletionPayload {
    oauth: StoredCodexOauthCredential,
    request: CodexCompletionHelperRequest,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexCompletionHelperRequest {
    system: Option<String>,
    prompt: String,
    messages: Option<Vec<CodexConversationMessage>>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    model: Option<String>,
    json_mode: bool,
}

#[derive(Serialize)]
struct CodexConversationMessage {
    role: String,
    content: String,
}

impl OpenAICodexProvider {
    pub const DEFAULT_BASE_URL: &'static str = "https://chatgpt.com/backend-api";

    pub const AVAILABLE_MODELS: &'static [&'static str] = &[
        "gpt-5.4",
        "gpt-5.3-codex",
        "gpt-5.3-codex-spark",
        "gpt-5.2",
        "gpt-5.2-codex",
        "gpt-5.1-codex",
        "gpt-5.1-codex-mini",
        "gpt-5.1-codex-max",
    ];

    pub fn new(config: ProviderConfig) -> CoreResult<Self> {
        let oauth_json = config.oauth_credential.ok_or_else(|| {
            CoreError::ValidationError("Codex OAuth credential is required".to_string())
        })?;

        let oauth = serde_json::from_str::<StoredCodexOauthCredential>(&oauth_json).map_err(|e| {
            CoreError::ValidationError(format!(
                "Stored Codex OAuth credential could not be parsed: {}",
                e
            ))
        })?;

        if oauth.access.trim().is_empty() || oauth.refresh.trim().is_empty() {
            return Err(CoreError::ValidationError(
                "Stored Codex OAuth credential is missing required token fields".to_string(),
            ));
        }

        Ok(Self {
            oauth,
            default_model: config.model.unwrap_or_else(|| "gpt-5.4".to_string()),
        })
    }

    pub fn available_models() -> Vec<String> {
        Self::AVAILABLE_MODELS
            .iter()
            .map(|model| (*model).to_string())
            .collect()
    }

    pub fn supports_model(model: &str) -> bool {
        let trimmed = model.trim().to_ascii_lowercase();
        Self::AVAILABLE_MODELS
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(&trimmed))
    }

    pub async fn fetch_available_models(&self) -> CoreResult<Vec<String>> {
        let result = tokio::task::spawn_blocking(|| run_codex_helper_json::<CodexHelperModels>("list-models"))
            .await
            .map_err(|e| CoreError::Internal(format!("Failed to join Codex models task: {}", e)))?
            .map_err(|e| CoreError::AIRequestFailed(format!("Failed to list Codex models: {}", e)))?;

        if !result.ok {
            return Err(CoreError::AIRequestFailed(
                result
                    .message
                    .unwrap_or_else(|| "Codex helper failed to list models".to_string()),
            ));
        }

        let mut models = result.models.unwrap_or_default();
        if models.is_empty() {
            models = Self::available_models();
        }
        models.sort();
        models.dedup();
        Ok(models)
    }

    async fn complete_via_helper(
        &self,
        request: CompletionRequest,
    ) -> CoreResult<(CodexHelperCompletion, Option<String>)> {
        let oauth = self.oauth.clone();
        let helper_request = CodexCompletionHelperRequest {
            system: request.system.clone(),
            prompt: request.prompt.clone(),
            messages: request.messages.as_ref().map(|messages| {
                messages
                    .iter()
                    .filter(|message| message.role != "system")
                    .map(|message| CodexConversationMessage {
                        role: message.role.clone(),
                        content: message.content.clone(),
                    })
                    .collect()
            }),
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            model: request.model.clone().or_else(|| Some(self.default_model.clone())),
            json_mode: request.json_mode,
        };

        let payload = CodexCompletionPayload {
            oauth,
            request: helper_request,
        };

        let result = tokio::task::spawn_blocking(move || {
            run_codex_helper_json_with_input::<CodexHelperCompletion, _>("complete-oauth-stdin", &payload)
        })
        .await
        .map_err(|e| CoreError::Internal(format!("Failed to join Codex completion task: {}", e)))?
        .map_err(|e| CoreError::AIRequestFailed(format!("Codex helper completion failed: {}", e)))?;

        let refreshed_oauth = result
            .new_credentials
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| CoreError::Internal(format!("Failed to serialize refreshed Codex OAuth: {}", e)))?;

        Ok((result, refreshed_oauth))
    }
}

impl std::fmt::Debug for OpenAICodexProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAICodexProvider")
            .field("oauth", &"***REDACTED***")
            .field("default_model", &self.default_model)
            .finish()
    }
}

#[async_trait]
impl AIProvider for OpenAICodexProvider {
    fn name(&self) -> &str {
        "openai-codex"
    }

    async fn complete(&self, request: CompletionRequest) -> CoreResult<CompletionResponse> {
        let requested_model = request
            .model
            .clone()
            .unwrap_or_else(|| self.default_model.clone());
        let (result, _refreshed_oauth) = self.complete_via_helper(request).await?;

        if !result.ok {
            return Err(CoreError::AIRequestFailed(
                result
                    .message
                    .or(result.error_message)
                    .unwrap_or_else(|| "OpenAI Codex request failed".to_string()),
            ));
        }

        let finish_reason = match result.stop_reason.as_deref() {
            Some("length") => FinishReason::Length,
            Some("toolUse") => FinishReason::ToolCalls,
            Some("error") => FinishReason::ContentFilter,
            _ => FinishReason::Stop,
        };

        let usage = result
            .usage
            .map(|usage| {
                let _ = usage.cost.input
                    + usage.cost.output
                    + usage.cost.cache_read
                    + usage.cost.cache_write
                    + usage.cost.total;
                let _ = usage.cache_read + usage.cache_write;
                TokenUsage {
                    prompt_tokens: usage.input,
                    completion_tokens: usage.output,
                    total_tokens: usage.total_tokens,
                }
            })
            .unwrap_or_default();

        Ok(CompletionResponse {
            text: result.text.unwrap_or_default(),
            model: result.model.unwrap_or(requested_model),
            usage,
            finish_reason,
        })
    }

    async fn embed(&self, _texts: Vec<String>) -> CoreResult<Vec<Vec<f32>>> {
        Err(CoreError::NotSupported(
            "Embeddings are not supported over OpenAI Codex OAuth".to_string(),
        ))
    }

    async fn health_check(&self) -> CoreResult<()> {
        let request = CompletionRequest::new("Reply with exactly OK.")
            .with_model(&self.default_model)
            .with_max_tokens(8)
            .with_temperature(0.0);
        let (result, _) = self.complete_via_helper(request).await?;

        if !result.ok {
            return Err(CoreError::AIRequestFailed(
                result
                    .message
                    .or(result.error_message)
                    .unwrap_or_else(|| "OpenAI Codex health check failed".to_string()),
            ));
        }

        Ok(())
    }

    fn is_available(&self) -> bool {
        !self.oauth.access.trim().is_empty() && !self.oauth.refresh.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_oauth_json() -> String {
        serde_json::json!({
            "type": "oauth",
            "provider": "openai-codex",
            "access": "access-token",
            "refresh": "refresh-token",
            "expires": 1234567890_i64
        })
        .to_string()
    }

    #[test]
    fn test_openai_codex_provider_creation() {
        let provider = OpenAICodexProvider::new(ProviderConfig::openai_codex(&sample_oauth_json()))
            .unwrap();
        assert_eq!(provider.name(), "openai-codex");
        assert!(provider.is_available());
    }

    #[test]
    fn test_openai_codex_supports_expected_models() {
        assert!(OpenAICodexProvider::supports_model("gpt-5.4"));
        assert!(OpenAICodexProvider::supports_model("gpt-5.3-codex"));
        assert!(!OpenAICodexProvider::supports_model("o3"));
    }
}

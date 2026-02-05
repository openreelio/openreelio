//! AI Provider Module
//!
//! Defines the trait and types for AI providers.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::core::{CoreError, CoreResult};

// =============================================================================
// AI Provider Trait
// =============================================================================

/// Trait for AI providers (OpenAI, Anthropic, local models, etc.)
#[async_trait]
pub trait AIProvider: Send + Sync {
    /// Returns the provider name
    fn name(&self) -> &str;

    /// Generates a completion from a prompt
    async fn complete(&self, request: CompletionRequest) -> CoreResult<CompletionResponse>;

    /// Generates embeddings for text
    async fn embed(&self, texts: Vec<String>) -> CoreResult<Vec<Vec<f32>>>;

    /// Performs a lightweight connectivity/auth check.
    ///
    /// This should be cheap (no expensive completions) and should not leak
    /// secrets in error messages.
    async fn health_check(&self) -> CoreResult<()> {
        Ok(())
    }

    /// Checks if the provider is available
    fn is_available(&self) -> bool;
}

// =============================================================================
// Conversation Message
// =============================================================================

/// A single message in a conversation
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    /// Role: user, assistant, or system
    pub role: String,
    /// Message content
    pub content: String,
}

impl ConversationMessage {
    pub fn user(content: &str) -> Self {
        Self {
            role: "user".to_string(),
            content: content.to_string(),
        }
    }

    pub fn assistant(content: &str) -> Self {
        Self {
            role: "assistant".to_string(),
            content: content.to_string(),
        }
    }

    pub fn system(content: &str) -> Self {
        Self {
            role: "system".to_string(),
            content: content.to_string(),
        }
    }
}

// =============================================================================
// Completion Request
// =============================================================================

/// Request for text completion
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    /// System prompt/instructions
    pub system: Option<String>,
    /// User prompt (for single-turn mode)
    pub prompt: String,
    /// Conversation history (for multi-turn mode)
    /// If provided, this takes precedence over `prompt`
    pub messages: Option<Vec<ConversationMessage>>,
    /// Maximum tokens to generate
    pub max_tokens: Option<u32>,
    /// Temperature (0.0 - 2.0)
    pub temperature: Option<f32>,
    /// Model to use (provider-specific)
    pub model: Option<String>,
    /// Whether to return JSON
    pub json_mode: bool,
}

impl CompletionRequest {
    /// Creates a new completion request (single-turn mode)
    pub fn new(prompt: &str) -> Self {
        Self {
            system: None,
            prompt: prompt.to_string(),
            messages: None,
            max_tokens: None,
            temperature: None,
            model: None,
            json_mode: false,
        }
    }

    /// Creates a new completion request with conversation history (multi-turn mode)
    pub fn with_conversation(messages: Vec<ConversationMessage>) -> Self {
        Self {
            system: None,
            prompt: String::new(),
            messages: Some(messages),
            max_tokens: None,
            temperature: None,
            model: None,
            json_mode: false,
        }
    }

    /// Sets the system prompt
    pub fn with_system(mut self, system: &str) -> Self {
        self.system = Some(system.to_string());
        self
    }

    /// Sets conversation messages (enables multi-turn mode)
    pub fn with_messages(mut self, messages: Vec<ConversationMessage>) -> Self {
        self.messages = Some(messages);
        self
    }

    /// Sets the maximum tokens
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }

    /// Sets the temperature
    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self
    }

    /// Sets the model
    pub fn with_model(mut self, model: &str) -> Self {
        self.model = Some(model.to_string());
        self
    }

    /// Enables JSON mode
    pub fn with_json_mode(mut self) -> Self {
        self.json_mode = true;
        self
    }

    /// Returns whether this request is in conversation mode
    pub fn is_conversation_mode(&self) -> bool {
        self.messages.is_some() && !self.messages.as_ref().unwrap().is_empty()
    }
}

// =============================================================================
// Completion Response
// =============================================================================

/// Response from text completion
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResponse {
    /// Generated text
    pub text: String,
    /// Model used
    pub model: String,
    /// Token usage
    pub usage: TokenUsage,
    /// Finish reason
    pub finish_reason: FinishReason,
}

impl CompletionResponse {
    /// Creates a new completion response
    pub fn new(text: &str, model: &str) -> Self {
        Self {
            text: text.to_string(),
            model: model.to_string(),
            usage: TokenUsage::default(),
            finish_reason: FinishReason::Stop,
        }
    }
}

// =============================================================================
// AI Response (Unified Agent)
// =============================================================================

/// Intent type detected by AI
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AIIntentType {
    /// General conversation
    #[default]
    Chat,
    /// Edit request
    Edit,
    /// Information query
    Query,
    /// Needs clarification
    Clarify,
}

/// AI's understanding of user intent
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIIntent {
    /// Type of intent
    #[serde(rename = "type")]
    pub intent_type: AIIntentType,
    /// Confidence score (0.0 - 1.0)
    pub confidence: f32,
}

/// Edit command for timeline operations
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditAction {
    /// Command type (e.g., "SplitClip", "MoveClip")
    pub command_type: String,
    /// Command parameters
    pub params: serde_json::Value,
    /// Human-readable description
    pub description: Option<String>,
}

/// Risk assessment for edit actions
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskAssessment {
    /// Copyright risk level
    pub copyright: String,
    /// NSFW risk level
    pub nsfw: String,
}

/// Unified AI response supporting conversation and editing
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIResponse {
    /// Conversational response text - always present
    pub message: String,
    /// Edit actions to execute - only when user requests edits
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<EditAction>>,
    /// Whether user confirmation is needed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_confirmation: Option<bool>,
    /// AI's understanding of the intent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<AIIntent>,
    /// Risk assessment if actions are present
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<RiskAssessment>,
    /// Clarifying questions if AI needs more info
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clarifying_questions: Option<Vec<String>>,
}

impl AIResponse {
    /// Creates a simple chat response
    pub fn chat(message: &str) -> Self {
        Self {
            message: message.to_string(),
            actions: None,
            needs_confirmation: None,
            intent: Some(AIIntent {
                intent_type: AIIntentType::Chat,
                confidence: 1.0,
            }),
            risk: None,
            clarifying_questions: None,
        }
    }

    /// Creates an edit response with actions
    pub fn edit(message: &str, actions: Vec<EditAction>) -> Self {
        Self {
            message: message.to_string(),
            actions: Some(actions),
            needs_confirmation: Some(true),
            intent: Some(AIIntent {
                intent_type: AIIntentType::Edit,
                confidence: 1.0,
            }),
            risk: Some(RiskAssessment::default()),
            clarifying_questions: None,
        }
    }

    /// Creates a clarification request
    pub fn clarify(message: &str, questions: Vec<String>) -> Self {
        Self {
            message: message.to_string(),
            actions: None,
            needs_confirmation: None,
            intent: Some(AIIntent {
                intent_type: AIIntentType::Clarify,
                confidence: 1.0,
            }),
            risk: None,
            clarifying_questions: Some(questions),
        }
    }
}

// =============================================================================
// Token Usage
// =============================================================================

/// Token usage statistics
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// Prompt tokens
    pub prompt_tokens: u32,
    /// Completion tokens
    pub completion_tokens: u32,
    /// Total tokens
    pub total_tokens: u32,
}

impl TokenUsage {
    /// Creates a new token usage record
    pub fn new(prompt: u32, completion: u32) -> Self {
        Self {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
        }
    }
}

// =============================================================================
// Finish Reason
// =============================================================================

/// Reason for completion finish
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    /// Normal stop
    #[default]
    Stop,
    /// Reached max tokens
    Length,
    /// Content filter triggered
    ContentFilter,
    /// Function/tool call
    ToolCalls,
}

// =============================================================================
// Mock Provider (for testing)
// =============================================================================

/// Mock AI provider for testing
pub struct MockAIProvider {
    name: String,
    response: String,
    available: bool,
}

impl MockAIProvider {
    /// Creates a new mock provider
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            response: "Mock response".to_string(),
            available: true,
        }
    }

    /// Sets the mock response
    pub fn with_response(mut self, response: &str) -> Self {
        self.response = response.to_string();
        self
    }

    /// Sets availability
    pub fn with_available(mut self, available: bool) -> Self {
        self.available = available;
        self
    }
}

#[async_trait]
impl AIProvider for MockAIProvider {
    fn name(&self) -> &str {
        &self.name
    }

    async fn complete(&self, _request: CompletionRequest) -> CoreResult<CompletionResponse> {
        if !self.available {
            return Err(CoreError::Internal("Provider not available".to_string()));
        }

        Ok(CompletionResponse {
            text: self.response.clone(),
            model: "mock-model".to_string(),
            usage: TokenUsage::new(10, 20),
            finish_reason: FinishReason::Stop,
        })
    }

    async fn embed(&self, texts: Vec<String>) -> CoreResult<Vec<Vec<f32>>> {
        if !self.available {
            return Err(CoreError::Internal("Provider not available".to_string()));
        }

        // Return dummy embeddings
        Ok(texts.iter().map(|_| vec![0.0; 384]).collect())
    }

    async fn health_check(&self) -> CoreResult<()> {
        if !self.available {
            return Err(CoreError::Internal("Provider not available".to_string()));
        }
        Ok(())
    }

    fn is_available(&self) -> bool {
        self.available
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_completion_request_builder() {
        let request = CompletionRequest::new("Hello")
            .with_system("You are a helpful assistant")
            .with_max_tokens(100)
            .with_temperature(0.7)
            .with_model("gpt-4")
            .with_json_mode();

        assert_eq!(request.prompt, "Hello");
        assert_eq!(
            request.system,
            Some("You are a helpful assistant".to_string())
        );
        assert_eq!(request.max_tokens, Some(100));
        assert_eq!(request.temperature, Some(0.7));
        assert_eq!(request.model, Some("gpt-4".to_string()));
        assert!(request.json_mode);
    }

    #[test]
    fn test_completion_response() {
        let response = CompletionResponse::new("Hello world", "gpt-4");

        assert_eq!(response.text, "Hello world");
        assert_eq!(response.model, "gpt-4");
        assert_eq!(response.finish_reason, FinishReason::Stop);
    }

    #[test]
    fn test_token_usage() {
        let usage = TokenUsage::new(100, 50);

        assert_eq!(usage.prompt_tokens, 100);
        assert_eq!(usage.completion_tokens, 50);
        assert_eq!(usage.total_tokens, 150);
    }

    #[tokio::test]
    async fn test_mock_provider() {
        let provider = MockAIProvider::new("test").with_response("Test response");

        assert_eq!(provider.name(), "test");
        assert!(provider.is_available());

        let request = CompletionRequest::new("Hello");
        let response = provider.complete(request).await.unwrap();

        assert_eq!(response.text, "Test response");
    }

    #[tokio::test]
    async fn test_mock_provider_unavailable() {
        let provider = MockAIProvider::new("test").with_available(false);

        assert!(!provider.is_available());

        let request = CompletionRequest::new("Hello");
        let result = provider.complete(request).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_mock_provider_embed() {
        let provider = MockAIProvider::new("test");

        let texts = vec!["Hello".to_string(), "World".to_string()];
        let embeddings = provider.embed(texts).await.unwrap();

        assert_eq!(embeddings.len(), 2);
        assert_eq!(embeddings[0].len(), 384);
    }
}

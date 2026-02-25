//! AI Module
//!
//! Provides AI integration for video editing assistance.

pub mod conversation;
#[cfg(not(test))]
pub mod conversation_commands;
pub mod cost_tracker;
pub mod edit_script;
pub mod executor;
pub mod gateway;
pub mod knowledge;
#[cfg(not(test))]
pub mod knowledge_commands;
pub mod proposal;
pub mod provider;
pub mod providers;
pub mod streaming;

// =============================================================================
// Shared Helpers
// =============================================================================

/// Resolves the application data directory from the Tauri app handle.
///
/// Shared by `conversation_commands` and `knowledge_commands` to avoid
/// duplicating the same helper in each module.
#[cfg(not(test))]
pub(crate) fn get_app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))
}

pub use conversation::{ConversationDb, MessageRow, MessageWithParts, PartRow, SessionRow};
pub use cost_tracker::{CostError, CostTracker, ModelPricing, UsageSummary};
pub use edit_script::{EditCommand, EditScript, Requirement, RiskAssessment};
pub use executor::{
    CommandResult, EditScriptExecutor, ExecutionContext, ExecutionResult, ValidationError,
    ValidationResult as ScriptValidationResult, ValidationWarning,
};
pub use gateway::{
    AIGateway, AIGatewayConfig, EditContext, KeyMoment, ProviderRuntimeStatus, ValidationResult,
};
pub use knowledge::{KnowledgeDb, KnowledgeRow};
pub use proposal::{Proposal, ProposalManager, ProposalStatus};
pub use provider::{
    AIIntent, AIIntentType, AIProvider, AIResponse, CompletionRequest, CompletionResponse,
    ConversationMessage, EditAction, FinishReason, RiskAssessment as ProviderRiskAssessment,
    TokenUsage,
};
pub use providers::{
    create_provider, AnthropicProvider, GeminiProvider, LocalProvider, OpenAIProvider,
    ProviderConfig, ProviderStatus, ProviderType,
};
pub use streaming::{
    clear_streaming_provider_config, set_streaming_provider_config, StreamEvent, StreamMessage,
    StreamOptionsDto, StreamToolDefinition, StreamingProviderConfig,
};

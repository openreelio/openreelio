//! AI Module
//!
//! Provides AI integration for video editing assistance.

pub mod cost_tracker;
pub mod edit_script;
pub mod executor;
pub mod gateway;
pub mod proposal;
pub mod provider;
pub mod providers;

pub use cost_tracker::{CostError, CostTracker, ModelPricing, UsageSummary};
pub use edit_script::{EditCommand, EditScript, Requirement, RiskAssessment};
pub use executor::{
    CommandResult, EditScriptExecutor, ExecutionContext, ExecutionResult, ValidationError,
    ValidationResult as ScriptValidationResult, ValidationWarning,
};
pub use gateway::{
    AIGateway, AIGatewayConfig, EditContext, KeyMoment, ProviderRuntimeStatus, ValidationResult,
};
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

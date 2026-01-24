//! AI Module
//!
//! Provides AI integration for video editing assistance.

pub mod edit_script;
pub mod executor;
pub mod gateway;
pub mod proposal;
pub mod provider;
pub mod providers;

pub use edit_script::{EditCommand, EditScript, Requirement, RiskAssessment};
pub use executor::{
    CommandResult, EditScriptExecutor, ExecutionContext, ExecutionResult, ValidationError,
    ValidationResult as ScriptValidationResult, ValidationWarning,
};
pub use gateway::{
    AIGateway, AIGatewayConfig, EditContext, KeyMoment, ProviderRuntimeStatus, ValidationResult,
};
pub use proposal::{Proposal, ProposalManager, ProposalStatus};
pub use provider::{AIProvider, CompletionRequest, CompletionResponse, FinishReason, TokenUsage};
pub use providers::{
    create_provider, AnthropicProvider, GeminiProvider, LocalProvider, OpenAIProvider,
    ProviderConfig, ProviderStatus, ProviderType,
};

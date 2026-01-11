//! AI Module
//!
//! Provides AI integration for video editing assistance.

pub mod edit_script;
pub mod gateway;
pub mod proposal;
pub mod provider;

pub use edit_script::{EditCommand, EditScript, Requirement};
pub use gateway::{AIGateway, EditContext, ValidationResult};
pub use proposal::{Proposal, ProposalManager, ProposalStatus};
pub use provider::{AIProvider, CompletionRequest, CompletionResponse};

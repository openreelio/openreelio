//! Generative Provider Implementations
//!
//! Concrete provider adapters for different AI generation services.

#[cfg(feature = "ai-providers")]
pub mod seedance;

#[cfg(feature = "ai-providers")]
pub use seedance::SeedanceProvider;

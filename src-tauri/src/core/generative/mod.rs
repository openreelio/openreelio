//! Generative AI Integration
//!
//! AI-powered content generation for video editing.
//! Supports image generation, TTS, and music generation.

pub mod engine;
pub mod image;
pub mod audio;
pub mod providers;

// Re-export main types
pub use engine::{GenerativeEngine, GenerativeEngineConfig, GenerationRequest, GenerationResult};
pub use image::{ImageGenerationParams, ImageGenerationResult, ImageStyle};
pub use audio::{TTSParams, TTSResult, MusicGenerationParams, MusicGenerationResult, Voice};
pub use providers::{GenerativeProvider, GenerativeProviderConfig, ProviderCapability};

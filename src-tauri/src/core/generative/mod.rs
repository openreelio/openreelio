//! Generative AI Integration
//!
//! AI-powered content generation for video editing.
//! Supports image generation, TTS, and music generation.

pub mod audio;
pub mod engine;
pub mod image;
pub mod providers;

// Re-export main types
pub use audio::{MusicGenerationParams, MusicGenerationResult, TTSParams, TTSResult, Voice};
pub use engine::{GenerationRequest, GenerationResult, GenerativeEngine, GenerativeEngineConfig};
pub use image::{ImageGenerationParams, ImageGenerationResult, ImageStyle};
pub use providers::{GenerativeProvider, GenerativeProviderConfig, ProviderCapability};

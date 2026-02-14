//! Generative AI Integration
//!
//! AI-powered content generation for video editing.
//! Supports image generation, TTS, music generation, and video generation.

pub mod audio;
pub mod engine;
pub mod image;
pub mod provider_impls;
pub mod providers;
pub mod video;
pub mod video_input_validation;

// Re-export main types
pub use audio::{MusicGenerationParams, MusicGenerationResult, TTSParams, TTSResult, Voice};
pub use engine::{GenerationRequest, GenerationResult, GenerativeEngine, GenerativeEngineConfig};
pub use image::{ImageGenerationParams, ImageGenerationResult, ImageStyle};
pub use provider_impls::SeedanceProvider;
pub use providers::{GenerativeProvider, GenerativeProviderConfig, ProviderCapability};
pub use video::{
    VideoCostEstimate, VideoGenMode, VideoGenerationParams, VideoGenerationResult,
    VideoGenerationStatus, VideoJobHandle, VideoQuality, VideoResolution,
};

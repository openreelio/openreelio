//! Asset Annotation System
//!
//! Provider-agnostic video analysis and annotation storage.
//!
//! ## Architecture (ADR-036)
//!
//! - **Default**: FFmpeg scenedetect only (free, ~90% accuracy)
//! - **Optional**: Google Cloud APIs (user-provided key, ~95% accuracy)
//! - **Future**: Local ML plugin (whisper, etc. - v0.4.0+)
//!
//! All annotations are stored per-asset in unified format:
//! `{project}/.openreelio/annotations/{asset_id}.json`

pub mod models;
pub mod orchestrator;
pub mod provider;
pub mod providers;
pub mod store;

pub use models::*;
pub use orchestrator::AnalysisOrchestrator;
pub use provider::{
    AnalysisProviderTrait, AnalysisRequest, AnalysisResponse, FaceDetectionConfig,
    ObjectDetectionConfig, ProviderCapabilities, ShotDetectionConfig, TextDetectionConfig,
    TranscriptConfig,
};
pub use providers::{GoogleCloudProvider, LocalAnalysisProvider};
pub use store::AnnotationStore;

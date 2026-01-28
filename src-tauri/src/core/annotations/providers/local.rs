//! Local Analysis Provider
//!
//! FFmpeg-based video analysis provider.
//!
//! **CRITICAL**: This provider uses FFmpeg ONLY.
//! - No whisper (too heavy for default installation)
//! - No ML models (keep installation ~50MB)
//!
//! Supported analysis types:
//! - Shots: FFmpeg scenedetect (~90% accuracy)
//!
//! For transcript, objects, faces, text: use Cloud provider or future plugins.

use async_trait::async_trait;
use std::path::PathBuf;

use crate::core::annotations::{
    AnalysisProvider as ProviderType, AnalysisProviderTrait, AnalysisRequest, AnalysisResponse,
    AnalysisResult, AnalysisType, CostEstimate, ProviderCapabilities, ShotResult,
};
use crate::core::indexing::shots::{ShotDetector, ShotDetectorConfig};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Local Analysis Provider
// =============================================================================

/// FFmpeg-based local analysis provider
///
/// This provider is free and works offline, but only supports shot detection.
/// It wraps the existing `ShotDetector` from the indexing module.
pub struct LocalAnalysisProvider {
    /// FFmpeg binary path (optional, uses PATH if not set)
    ffmpeg_path: Option<PathBuf>,
    /// FFprobe binary path (optional, uses PATH if not set)
    ffprobe_path: Option<PathBuf>,
}

impl LocalAnalysisProvider {
    /// Creates a new local analysis provider
    pub fn new() -> Self {
        Self {
            ffmpeg_path: None,
            ffprobe_path: None,
        }
    }

    /// Creates a provider with custom FFmpeg paths
    pub fn with_paths(ffmpeg_path: Option<PathBuf>, ffprobe_path: Option<PathBuf>) -> Self {
        Self {
            ffmpeg_path,
            ffprobe_path,
        }
    }

    /// Performs shot detection using FFmpeg
    async fn detect_shots(
        &self,
        request: &AnalysisRequest,
    ) -> CoreResult<AnalysisResult<ShotResult>> {
        let config = request.shot_config.as_ref();

        let detector_config = ShotDetectorConfig {
            threshold: config.map(|c| c.threshold).unwrap_or(0.3),
            min_shot_duration: config.map(|c| c.min_duration_sec).unwrap_or(0.5),
            generate_keyframes: config.map(|c| c.generate_keyframes).unwrap_or(false),
            keyframe_dir: None,
            ffmpeg_path: self.ffmpeg_path.clone(),
            ffprobe_path: self.ffprobe_path.clone(),
            ..Default::default()
        };

        let detector = ShotDetector::with_config(detector_config.clone());

        // Detect shots
        let shots = detector
            .detect(&request.asset_path, &request.asset_id)
            .await?;

        // Convert to ShotResult format
        let results: Vec<ShotResult> = shots
            .into_iter()
            .map(|shot| {
                ShotResult::new(
                    shot.start_sec,
                    shot.end_sec,
                    shot.quality_score.unwrap_or(0.9),
                )
            })
            .collect();

        // Build config for result metadata
        let config_json = serde_json::json!({
            "threshold": detector_config.threshold,
            "minDurationSec": detector_config.min_shot_duration,
            "generateKeyframes": detector_config.generate_keyframes,
        });

        Ok(AnalysisResult::new(ProviderType::Ffmpeg, results).with_config(config_json))
    }
}

impl Default for LocalAnalysisProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AnalysisProviderTrait for LocalAnalysisProvider {
    fn provider_type(&self) -> ProviderType {
        ProviderType::Ffmpeg
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            provider: ProviderType::Ffmpeg,
            supported_types: vec![AnalysisType::Shots],
            requires_network: false,
            has_cost: false,
            description: "FFmpeg-based local shot detection (free, offline)".to_string(),
        }
    }

    fn is_available(&self) -> bool {
        ShotDetector::is_ffmpeg_available()
    }

    fn estimate_cost(
        &self,
        _duration_sec: f64,
        _analysis_types: &[AnalysisType],
    ) -> Option<CostEstimate> {
        // Local provider is free
        None
    }

    async fn analyze(&self, request: AnalysisRequest) -> CoreResult<AnalysisResponse> {
        // Validate file exists
        super::super::provider::validate_asset_path(&request.asset_path)?;

        let mut response = AnalysisResponse::new();

        // Check which requested types we support
        for analysis_type in &request.analysis_types {
            match analysis_type {
                AnalysisType::Shots => {
                    response.shots = Some(self.detect_shots(&request).await?);
                }
                AnalysisType::Transcript => {
                    // Not supported by local provider
                    tracing::warn!(
                        "Transcript analysis requested but not supported by local provider. Use Cloud provider or whisper plugin."
                    );
                }
                AnalysisType::Objects => {
                    tracing::warn!(
                        "Object detection requested but not supported by local provider. Use Cloud provider."
                    );
                }
                AnalysisType::Faces => {
                    tracing::warn!(
                        "Face detection requested but not supported by local provider. Use Cloud provider."
                    );
                }
                AnalysisType::TextOcr => {
                    tracing::warn!(
                        "Text detection requested but not supported by local provider. Use Cloud provider."
                    );
                }
            }
        }

        Ok(response)
    }

    async fn health_check(&self) -> CoreResult<()> {
        if self.is_available() {
            Ok(())
        } else {
            Err(CoreError::NotSupported(
                "FFmpeg not found in PATH".to_string(),
            ))
        }
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // Provider Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_local_provider_creation() {
        let provider = LocalAnalysisProvider::new();
        assert_eq!(provider.provider_type(), ProviderType::Ffmpeg);
    }

    #[test]
    fn test_local_provider_capabilities() {
        let provider = LocalAnalysisProvider::new();
        let caps = provider.capabilities();

        assert_eq!(caps.provider, ProviderType::Ffmpeg);
        assert_eq!(caps.supported_types, vec![AnalysisType::Shots]);
        assert!(!caps.requires_network);
        assert!(!caps.has_cost);
    }

    #[test]
    fn test_local_provider_no_cost() {
        let provider = LocalAnalysisProvider::new();
        let cost = provider.estimate_cost(3600.0, &[AnalysisType::Shots]);
        assert!(cost.is_none());
    }

    #[test]
    fn test_local_provider_with_paths() {
        let provider = LocalAnalysisProvider::with_paths(
            Some(PathBuf::from("/usr/bin/ffmpeg")),
            Some(PathBuf::from("/usr/bin/ffprobe")),
        );
        assert_eq!(provider.ffmpeg_path, Some(PathBuf::from("/usr/bin/ffmpeg")));
        assert_eq!(
            provider.ffprobe_path,
            Some(PathBuf::from("/usr/bin/ffprobe"))
        );
    }

    #[test]
    fn test_local_provider_default() {
        let provider = LocalAnalysisProvider::default();
        assert!(provider.ffmpeg_path.is_none());
        assert!(provider.ffprobe_path.is_none());
    }

    #[tokio::test]
    async fn test_analyze_file_not_found() {
        let provider = LocalAnalysisProvider::new();
        let request = AnalysisRequest::new(
            "asset_001",
            "/nonexistent/video.mp4",
            60.0,
            vec![AnalysisType::Shots],
        );

        let result = provider.analyze(request).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_health_check() {
        let provider = LocalAnalysisProvider::new();
        let result = provider.health_check().await;

        // Result depends on whether FFmpeg is installed
        // Just verify it doesn't panic
        let _ = result;
    }
}

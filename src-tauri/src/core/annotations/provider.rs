//! Analysis Provider Trait
//!
//! Defines the interface for video analysis providers.
//! Implementations include local (FFmpeg) and cloud (Google Cloud) providers.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

use crate::core::CoreResult;

use super::{
    AnalysisProvider as ProviderType, AnalysisResult, AnalysisType, CostBreakdownItem,
    CostEstimate, FaceDetection, ObjectDetection, ShotResult, TextDetection, TranscriptSegment,
};

// =============================================================================
// Provider Capabilities
// =============================================================================

/// Capabilities of an analysis provider
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    /// Provider identifier
    pub provider: ProviderType,
    /// Supported analysis types
    pub supported_types: Vec<AnalysisType>,
    /// Whether the provider requires network access
    pub requires_network: bool,
    /// Whether the provider has associated costs
    pub has_cost: bool,
    /// Human-readable description
    pub description: String,
}

// =============================================================================
// Analysis Request
// =============================================================================

/// Configuration for shot detection
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShotDetectionConfig {
    /// Scene change threshold (0.0 - 1.0)
    /// Lower = more sensitive (more shots detected)
    #[serde(default = "default_shot_threshold")]
    pub threshold: f64,
    /// Minimum shot duration in seconds
    #[serde(default = "default_min_shot_duration")]
    pub min_duration_sec: f64,
    /// Generate keyframe thumbnails
    #[serde(default)]
    pub generate_keyframes: bool,
}

fn default_shot_threshold() -> f64 {
    0.3
}

fn default_min_shot_duration() -> f64 {
    0.5
}

/// Configuration for transcription
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptConfig {
    /// Language hint (e.g., "en", "ko", "auto")
    #[serde(default = "default_language")]
    pub language: String,
    /// Enable speaker diarization
    #[serde(default)]
    pub enable_diarization: bool,
    /// Maximum speaker count (for diarization)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_speakers: Option<u8>,
}

fn default_language() -> String {
    "auto".to_string()
}

/// Configuration for object detection
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetectionConfig {
    /// Sample rate in frames per second
    #[serde(default = "default_sample_rate")]
    pub sample_rate_fps: f64,
    /// Confidence threshold (0.0 - 1.0)
    #[serde(default = "default_confidence_threshold")]
    pub confidence_threshold: f64,
    /// Include bounding boxes in results
    #[serde(default = "default_true")]
    pub include_bounding_boxes: bool,
}

fn default_sample_rate() -> f64 {
    1.0
}

fn default_confidence_threshold() -> f64 {
    0.5
}

fn default_true() -> bool {
    true
}

/// Configuration for face detection
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FaceDetectionConfig {
    /// Sample rate in frames per second
    #[serde(default = "default_sample_rate")]
    pub sample_rate_fps: f64,
    /// Include emotion detection
    #[serde(default)]
    pub detect_emotions: bool,
    /// Enable face tracking across frames
    #[serde(default)]
    pub enable_tracking: bool,
}

/// Configuration for text detection (OCR)
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextDetectionConfig {
    /// Sample rate in frames per second
    #[serde(default = "default_sample_rate")]
    pub sample_rate_fps: f64,
    /// Language hints for OCR
    #[serde(default)]
    pub language_hints: Vec<String>,
}

/// Request for analysis
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRequest {
    /// Asset ID
    pub asset_id: String,
    /// Asset file path
    pub asset_path: String,
    /// Asset duration in seconds
    pub duration_sec: f64,
    /// Analysis types to perform
    pub analysis_types: Vec<AnalysisType>,
    /// Shot detection config
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_config: Option<ShotDetectionConfig>,
    /// Transcript config
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_config: Option<TranscriptConfig>,
    /// Object detection config
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_config: Option<ObjectDetectionConfig>,
    /// Face detection config
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_config: Option<FaceDetectionConfig>,
    /// Text detection config
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_config: Option<TextDetectionConfig>,
}

impl AnalysisRequest {
    /// Creates a new analysis request
    pub fn new(
        asset_id: &str,
        asset_path: &str,
        duration_sec: f64,
        analysis_types: Vec<AnalysisType>,
    ) -> Self {
        Self {
            asset_id: asset_id.to_string(),
            asset_path: asset_path.to_string(),
            duration_sec,
            analysis_types,
            shot_config: None,
            transcript_config: None,
            object_config: None,
            face_config: None,
            text_config: None,
        }
    }

    /// Sets shot detection config
    pub fn with_shot_config(mut self, config: ShotDetectionConfig) -> Self {
        self.shot_config = Some(config);
        self
    }

    /// Sets transcript config
    pub fn with_transcript_config(mut self, config: TranscriptConfig) -> Self {
        self.transcript_config = Some(config);
        self
    }

    /// Sets object detection config
    pub fn with_object_config(mut self, config: ObjectDetectionConfig) -> Self {
        self.object_config = Some(config);
        self
    }

    /// Sets face detection config
    pub fn with_face_config(mut self, config: FaceDetectionConfig) -> Self {
        self.face_config = Some(config);
        self
    }

    /// Sets text detection config
    pub fn with_text_config(mut self, config: TextDetectionConfig) -> Self {
        self.text_config = Some(config);
        self
    }
}

// =============================================================================
// Analysis Response
// =============================================================================

/// Response from analysis
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResponse {
    /// Shot detection results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shots: Option<AnalysisResult<ShotResult>>,
    /// Transcription results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript: Option<AnalysisResult<TranscriptSegment>>,
    /// Object detection results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objects: Option<AnalysisResult<ObjectDetection>>,
    /// Face detection results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub faces: Option<AnalysisResult<FaceDetection>>,
    /// Text detection results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_ocr: Option<AnalysisResult<TextDetection>>,
    /// Total cost in cents (for cloud providers)
    pub total_cost_cents: u32,
}

impl AnalysisResponse {
    /// Creates a new empty response
    pub fn new() -> Self {
        Self::default()
    }

    /// Checks if any results are present
    pub fn has_results(&self) -> bool {
        self.shots.is_some()
            || self.transcript.is_some()
            || self.objects.is_some()
            || self.faces.is_some()
            || self.text_ocr.is_some()
    }
}

// =============================================================================
// Analysis Provider Trait
// =============================================================================

/// Trait for video analysis providers
///
/// Implementations:
/// - `LocalAnalysisProvider`: FFmpeg-based shot detection (free)
/// - `GoogleCloudProvider`: Google Cloud Video Intelligence + Vision API (paid)
#[async_trait]
pub trait AnalysisProviderTrait: Send + Sync {
    /// Returns the provider type identifier
    fn provider_type(&self) -> ProviderType;

    /// Returns provider capabilities
    fn capabilities(&self) -> ProviderCapabilities;

    /// Checks if the provider is available (e.g., API key configured)
    fn is_available(&self) -> bool;

    /// Estimates the cost for analyzing an asset
    ///
    /// Returns `None` for free providers.
    fn estimate_cost(
        &self,
        duration_sec: f64,
        analysis_types: &[AnalysisType],
    ) -> Option<CostEstimate>;

    /// Performs analysis on an asset
    async fn analyze(&self, request: AnalysisRequest) -> CoreResult<AnalysisResponse>;

    /// Performs health check to verify provider is working
    async fn health_check(&self) -> CoreResult<()>;
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Creates a cost estimate with breakdown
pub fn create_cost_estimate(
    provider: ProviderType,
    duration_sec: f64,
    analysis_types: &[AnalysisType],
    rates: &[(AnalysisType, u32, &str)], // (type, cents_per_minute, rate_description)
) -> CostEstimate {
    let duration_min = (duration_sec / 60.0).ceil() as u32;

    let mut breakdown = Vec::new();
    let mut total_cost = 0u32;

    for analysis_type in analysis_types {
        if let Some((_, rate_cents, rate_desc)) = rates.iter().find(|(t, _, _)| t == analysis_type)
        {
            let cost = duration_min * rate_cents;
            total_cost += cost;
            breakdown.push(CostBreakdownItem {
                analysis_type: analysis_type.clone(),
                cost_cents: cost,
                rate_description: rate_desc.to_string(),
            });
        }
    }

    CostEstimate {
        provider,
        analysis_types: analysis_types.to_vec(),
        estimated_cost_cents: total_cost,
        asset_duration_sec: duration_sec,
        breakdown,
    }
}

/// Validates that the file exists and is readable
pub fn validate_asset_path(path: &str) -> CoreResult<()> {
    let path = Path::new(path);
    if !path.exists() {
        return Err(crate::core::CoreError::FileNotFound(
            path.to_string_lossy().to_string(),
        ));
    }
    if !path.is_file() {
        return Err(crate::core::CoreError::ValidationError(format!(
            "Path is not a file: {}",
            path.display()
        )));
    }
    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // ProviderCapabilities Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_provider_capabilities_serialization() {
        let caps = ProviderCapabilities {
            provider: ProviderType::Ffmpeg,
            supported_types: vec![AnalysisType::Shots],
            requires_network: false,
            has_cost: false,
            description: "FFmpeg-based local shot detection".to_string(),
        };

        let json = serde_json::to_string(&caps).unwrap();
        assert!(json.contains("\"provider\":\"ffmpeg\""));
        assert!(json.contains("\"requiresNetwork\":false"));

        let parsed: ProviderCapabilities = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.provider, ProviderType::Ffmpeg);
    }

    // -------------------------------------------------------------------------
    // Config Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_shot_detection_config_defaults() {
        let config = ShotDetectionConfig::default();
        assert_eq!(config.threshold, 0.0); // Default::default for f64
        assert_eq!(config.min_duration_sec, 0.0);
        assert!(!config.generate_keyframes);
    }

    #[test]
    fn test_shot_detection_config_serialization() {
        let config = ShotDetectionConfig {
            threshold: 0.4,
            min_duration_sec: 1.0,
            generate_keyframes: true,
        };

        let json = serde_json::to_string(&config).unwrap();
        let parsed: ShotDetectionConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.threshold, 0.4);
        assert_eq!(parsed.min_duration_sec, 1.0);
        assert!(parsed.generate_keyframes);
    }

    #[test]
    fn test_transcript_config_defaults() {
        let config = TranscriptConfig::default();
        assert_eq!(config.language, "");
        assert!(!config.enable_diarization);
        assert!(config.max_speakers.is_none());
    }

    #[test]
    fn test_object_detection_config_defaults() {
        let config = ObjectDetectionConfig::default();
        assert_eq!(config.sample_rate_fps, 0.0);
        assert_eq!(config.confidence_threshold, 0.0);
        assert!(!config.include_bounding_boxes);
    }

    // -------------------------------------------------------------------------
    // AnalysisRequest Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_analysis_request_creation() {
        let request = AnalysisRequest::new(
            "asset_001",
            "/path/to/video.mp4",
            120.0,
            vec![AnalysisType::Shots, AnalysisType::Transcript],
        );

        assert_eq!(request.asset_id, "asset_001");
        assert_eq!(request.duration_sec, 120.0);
        assert_eq!(request.analysis_types.len(), 2);
        assert!(request.shot_config.is_none());
    }

    #[test]
    fn test_analysis_request_builder() {
        let request = AnalysisRequest::new(
            "asset_001",
            "/path/to/video.mp4",
            120.0,
            vec![AnalysisType::Shots],
        )
        .with_shot_config(ShotDetectionConfig {
            threshold: 0.5,
            min_duration_sec: 2.0,
            generate_keyframes: true,
        });

        assert!(request.shot_config.is_some());
        assert_eq!(request.shot_config.unwrap().threshold, 0.5);
    }

    #[test]
    fn test_analysis_request_serialization() {
        let request = AnalysisRequest::new(
            "asset_001",
            "/path/to/video.mp4",
            60.0,
            vec![AnalysisType::Shots],
        );

        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("\"assetId\":\"asset_001\""));
        assert!(json.contains("\"durationSec\":60.0"));

        let parsed: AnalysisRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.asset_id, "asset_001");
    }

    // -------------------------------------------------------------------------
    // AnalysisResponse Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_analysis_response_empty() {
        let response = AnalysisResponse::new();
        assert!(!response.has_results());
        assert_eq!(response.total_cost_cents, 0);
    }

    #[test]
    fn test_analysis_response_has_results() {
        let mut response = AnalysisResponse::new();
        assert!(!response.has_results());

        response.shots = Some(AnalysisResult::new(ProviderType::Ffmpeg, vec![]));
        assert!(response.has_results());
    }

    // -------------------------------------------------------------------------
    // Cost Estimate Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_create_cost_estimate() {
        let rates = [
            (AnalysisType::Shots, 5, "$0.05/min"),
            (AnalysisType::Objects, 10, "$0.10/min"),
            (AnalysisType::Faces, 10, "$0.10/min"),
        ];

        let estimate = create_cost_estimate(
            ProviderType::GoogleCloud,
            120.0, // 2 minutes
            &[AnalysisType::Shots, AnalysisType::Objects],
            &rates,
        );

        assert_eq!(estimate.provider, ProviderType::GoogleCloud);
        assert_eq!(estimate.estimated_cost_cents, 30); // (5 + 10) * 2 = 30
        assert_eq!(estimate.breakdown.len(), 2);
        assert_eq!(estimate.asset_duration_sec, 120.0);
    }

    #[test]
    fn test_create_cost_estimate_partial_minutes() {
        let rates = [(AnalysisType::Shots, 5, "$0.05/min")];

        // 90 seconds = 1.5 minutes, rounded up to 2 minutes
        let estimate = create_cost_estimate(
            ProviderType::GoogleCloud,
            90.0,
            &[AnalysisType::Shots],
            &rates,
        );

        assert_eq!(estimate.estimated_cost_cents, 10); // 5 * 2 = 10
    }

    #[test]
    fn test_create_cost_estimate_no_matching_types() {
        let rates = [(AnalysisType::Shots, 5, "$0.05/min")];

        let estimate = create_cost_estimate(
            ProviderType::GoogleCloud,
            60.0,
            &[AnalysisType::Transcript], // Not in rates
            &rates,
        );

        assert_eq!(estimate.estimated_cost_cents, 0);
        assert!(estimate.breakdown.is_empty());
    }

    // -------------------------------------------------------------------------
    // Validation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_validate_asset_path_not_found() {
        let result = validate_asset_path("/nonexistent/file.mp4");
        assert!(result.is_err());
    }
}

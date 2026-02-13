//! Video Generation Types
//!
//! Data models for AI-powered video generation (e.g., Seedance 2.0).
//! Supports text-to-video, image-to-video, and multimodal generation modes.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// =============================================================================
// Enums
// =============================================================================

/// Video generation mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoGenMode {
    /// Generate video from text prompt
    TextToVideo,
    /// Generate video from reference image(s) + prompt
    ImageToVideo,
    /// Multimodal: combine text, image, video, and audio references
    Multimodal,
}

impl std::fmt::Display for VideoGenMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VideoGenMode::TextToVideo => write!(f, "Text to Video"),
            VideoGenMode::ImageToVideo => write!(f, "Image to Video"),
            VideoGenMode::Multimodal => write!(f, "Multimodal"),
        }
    }
}

/// Video quality tier (maps to pricing)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoQuality {
    /// Basic quality — fastest, cheapest ($0.10/min)
    Basic,
    /// Professional quality — balanced ($0.30/min)
    Pro,
    /// Cinema quality — highest fidelity ($0.80/min)
    Cinema,
}

impl VideoQuality {
    /// Cost per minute in cents
    pub fn cents_per_minute(&self) -> u32 {
        match self {
            VideoQuality::Basic => 10,
            VideoQuality::Pro => 30,
            VideoQuality::Cinema => 80,
        }
    }
}

impl std::fmt::Display for VideoQuality {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VideoQuality::Basic => write!(f, "Basic"),
            VideoQuality::Pro => write!(f, "Pro"),
            VideoQuality::Cinema => write!(f, "Cinema"),
        }
    }
}

// =============================================================================
// Resolution
// =============================================================================

/// Video resolution
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoResolution {
    pub width: u32,
    pub height: u32,
}

impl VideoResolution {
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// 1080p landscape
    pub fn fhd() -> Self {
        Self {
            width: 1920,
            height: 1080,
        }
    }

    /// 2K landscape
    pub fn two_k() -> Self {
        Self {
            width: 2560,
            height: 1440,
        }
    }

    /// 1080p portrait (for shorts/reels)
    pub fn portrait() -> Self {
        Self {
            width: 1080,
            height: 1920,
        }
    }

    /// 1080x1080 square
    pub fn square() -> Self {
        Self {
            width: 1080,
            height: 1080,
        }
    }
}

// =============================================================================
// Generation Parameters
// =============================================================================

/// Parameters for video generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoGenerationParams {
    /// Text prompt describing the desired video
    pub prompt: String,
    /// Generation mode
    pub mode: VideoGenMode,
    /// Quality tier
    pub quality: VideoQuality,
    /// Desired duration in seconds (5-120)
    pub duration_sec: f64,
    /// Negative prompt (things to avoid)
    pub negative_prompt: Option<String>,
    /// Reference image paths (max 9)
    pub reference_images: Vec<PathBuf>,
    /// Reference video paths (max 3)
    pub reference_videos: Vec<PathBuf>,
    /// Reference audio paths (max 3)
    pub reference_audio: Vec<PathBuf>,
    /// Aspect ratio (e.g., "16:9", "9:16", "1:1")
    pub aspect_ratio: String,
    /// Random seed for reproducibility
    pub seed: Option<u64>,
    /// Lip sync language code (e.g., "en", "ko")
    pub lip_sync_language: Option<String>,
}

impl VideoGenerationParams {
    /// Create new text-to-video params with defaults
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            mode: VideoGenMode::TextToVideo,
            quality: VideoQuality::Pro,
            duration_sec: 10.0,
            negative_prompt: None,
            reference_images: Vec::new(),
            reference_videos: Vec::new(),
            reference_audio: Vec::new(),
            aspect_ratio: "16:9".to_string(),
            seed: None,
            lip_sync_language: None,
        }
    }

    /// Set generation mode
    pub fn with_mode(mut self, mode: VideoGenMode) -> Self {
        self.mode = mode;
        self
    }

    /// Set quality tier
    pub fn with_quality(mut self, quality: VideoQuality) -> Self {
        self.quality = quality;
        self
    }

    /// Set duration in seconds
    pub fn with_duration(mut self, duration_sec: f64) -> Self {
        self.duration_sec = duration_sec.clamp(5.0, 120.0);
        self
    }

    /// Set negative prompt
    pub fn with_negative_prompt(mut self, negative: impl Into<String>) -> Self {
        self.negative_prompt = Some(negative.into());
        self
    }

    /// Set aspect ratio
    pub fn with_aspect_ratio(mut self, ratio: impl Into<String>) -> Self {
        self.aspect_ratio = ratio.into();
        self
    }

    /// Set random seed
    pub fn with_seed(mut self, seed: u64) -> Self {
        self.seed = Some(seed);
        self
    }

    /// Add a reference image
    pub fn with_reference_image(mut self, path: PathBuf) -> Self {
        self.reference_images.push(path);
        self
    }

    /// Add a reference video
    pub fn with_reference_video(mut self, path: PathBuf) -> Self {
        self.reference_videos.push(path);
        self
    }

    /// Validate parameters
    pub fn validate(&self) -> Result<(), String> {
        // Prompt validation
        let trimmed = self.prompt.trim();
        if trimmed.is_empty() {
            return Err("Prompt cannot be empty".to_string());
        }
        if trimmed.len() > 4096 {
            return Err("Prompt too long (max 4096 characters)".to_string());
        }

        // Duration validation
        if self.duration_sec < 5.0 {
            return Err(format!(
                "Duration too short: {:.1}s (minimum 5s)",
                self.duration_sec
            ));
        }
        if self.duration_sec > 120.0 {
            return Err(format!(
                "Duration too long: {:.1}s (maximum 120s)",
                self.duration_sec
            ));
        }

        // Reference file limits
        if self.reference_images.len() > 9 {
            return Err(format!(
                "Too many reference images: {} (max 9)",
                self.reference_images.len()
            ));
        }
        if self.reference_videos.len() > 3 {
            return Err(format!(
                "Too many reference videos: {} (max 3)",
                self.reference_videos.len()
            ));
        }
        if self.reference_audio.len() > 3 {
            return Err(format!(
                "Too many reference audio files: {} (max 3)",
                self.reference_audio.len()
            ));
        }

        // Aspect ratio validation
        let valid_ratios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
        if !valid_ratios.contains(&self.aspect_ratio.as_str()) {
            return Err(format!(
                "Invalid aspect ratio '{}'. Valid: {}",
                self.aspect_ratio,
                valid_ratios.join(", ")
            ));
        }

        // Mode-specific validation
        match self.mode {
            VideoGenMode::ImageToVideo => {
                if self.reference_images.is_empty() {
                    return Err(
                        "Image-to-video mode requires at least one reference image".to_string()
                    );
                }
            }
            VideoGenMode::TextToVideo => {
                // Text-to-video is valid with just a prompt
            }
            VideoGenMode::Multimodal => {
                // Multimodal accepts any combination
            }
        }

        Ok(())
    }
}

// =============================================================================
// Job Handle & Status
// =============================================================================

/// Handle for tracking a submitted video generation job
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoJobHandle {
    /// Provider identifier (e.g., "seedance")
    pub provider: String,
    /// Provider-assigned job ID
    pub job_id: String,
    /// Unix timestamp when submitted
    pub submitted_at: i64,
}

/// Status of a video generation job
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum VideoGenerationStatus {
    /// Job is queued but not yet started
    Queued,
    /// Job is actively being processed
    Processing {
        progress: Option<f64>,
        message: Option<String>,
    },
    /// Job completed successfully
    Completed {
        download_url: String,
        duration_sec: f64,
        has_audio: bool,
    },
    /// Job failed
    Failed { error: String, code: Option<String> },
    /// Job was cancelled
    Cancelled,
}

impl VideoGenerationStatus {
    /// Whether the job is in a terminal state
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            VideoGenerationStatus::Completed { .. }
                | VideoGenerationStatus::Failed { .. }
                | VideoGenerationStatus::Cancelled
        )
    }
}

// =============================================================================
// Generation Result
// =============================================================================

/// Result of a completed video generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoGenerationResult {
    /// Unique result ID
    pub id: String,
    /// Path to the downloaded output file
    pub output_path: PathBuf,
    /// Duration of the generated video in seconds
    pub duration_sec: f64,
    /// Video resolution
    pub resolution: VideoResolution,
    /// Whether the video includes synchronized audio
    pub has_audio: bool,
    /// Cost in cents
    pub cost_cents: u32,
    /// Wall-clock generation time in milliseconds
    pub generation_time_ms: u64,
}

// =============================================================================
// Cost Estimate
// =============================================================================

/// Cost estimate for a video generation request
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct VideoCostEstimate {
    /// Estimated cost in cents
    pub cents: u32,
    /// Quality tier used for estimation
    pub quality: VideoQuality,
    /// Duration used for estimation
    pub duration_sec: f64,
}

impl VideoCostEstimate {
    /// Calculate a cost estimate from quality and duration
    pub fn calculate(quality: VideoQuality, duration_sec: f64) -> Self {
        let minutes = duration_sec / 60.0;
        let cents = (minutes * quality.cents_per_minute() as f64).ceil() as u32;
        Self {
            cents,
            quality,
            duration_sec,
        }
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // VideoGenMode Tests
    // =========================================================================

    #[test]
    fn test_mode_display() {
        assert_eq!(VideoGenMode::TextToVideo.to_string(), "Text to Video");
        assert_eq!(VideoGenMode::ImageToVideo.to_string(), "Image to Video");
        assert_eq!(VideoGenMode::Multimodal.to_string(), "Multimodal");
    }

    #[test]
    fn test_mode_serialization() {
        assert_eq!(
            serde_json::to_string(&VideoGenMode::TextToVideo).unwrap(),
            "\"text_to_video\""
        );
        assert_eq!(
            serde_json::from_str::<VideoGenMode>("\"image_to_video\"").unwrap(),
            VideoGenMode::ImageToVideo
        );
    }

    // =========================================================================
    // VideoQuality Tests
    // =========================================================================

    #[test]
    fn test_quality_pricing() {
        assert_eq!(VideoQuality::Basic.cents_per_minute(), 10);
        assert_eq!(VideoQuality::Pro.cents_per_minute(), 30);
        assert_eq!(VideoQuality::Cinema.cents_per_minute(), 80);
    }

    #[test]
    fn test_quality_serialization() {
        assert_eq!(
            serde_json::to_string(&VideoQuality::Pro).unwrap(),
            "\"pro\""
        );
        assert_eq!(
            serde_json::from_str::<VideoQuality>("\"cinema\"").unwrap(),
            VideoQuality::Cinema
        );
    }

    // =========================================================================
    // VideoResolution Tests
    // =========================================================================

    #[test]
    fn test_resolution_presets() {
        let fhd = VideoResolution::fhd();
        assert_eq!(fhd.width, 1920);
        assert_eq!(fhd.height, 1080);

        let portrait = VideoResolution::portrait();
        assert_eq!(portrait.width, 1080);
        assert_eq!(portrait.height, 1920);

        let square = VideoResolution::square();
        assert_eq!(square.width, 1080);
        assert_eq!(square.height, 1080);
    }

    // =========================================================================
    // VideoGenerationParams Tests
    // =========================================================================

    #[test]
    fn test_params_new_defaults() {
        let params = VideoGenerationParams::new("A sunset timelapse");
        assert_eq!(params.prompt, "A sunset timelapse");
        assert_eq!(params.mode, VideoGenMode::TextToVideo);
        assert_eq!(params.quality, VideoQuality::Pro);
        assert_eq!(params.duration_sec, 10.0);
        assert_eq!(params.aspect_ratio, "16:9");
        assert!(params.reference_images.is_empty());
    }

    #[test]
    fn test_params_builder() {
        let params = VideoGenerationParams::new("Ocean waves")
            .with_mode(VideoGenMode::ImageToVideo)
            .with_quality(VideoQuality::Cinema)
            .with_duration(30.0)
            .with_aspect_ratio("9:16")
            .with_seed(42)
            .with_reference_image(PathBuf::from("/tmp/ref.jpg"));

        assert_eq!(params.mode, VideoGenMode::ImageToVideo);
        assert_eq!(params.quality, VideoQuality::Cinema);
        assert_eq!(params.duration_sec, 30.0);
        assert_eq!(params.aspect_ratio, "9:16");
        assert_eq!(params.seed, Some(42));
        assert_eq!(params.reference_images.len(), 1);
    }

    #[test]
    fn test_params_duration_clamping() {
        let short = VideoGenerationParams::new("Test").with_duration(1.0);
        assert_eq!(short.duration_sec, 5.0);

        let long = VideoGenerationParams::new("Test").with_duration(999.0);
        assert_eq!(long.duration_sec, 120.0);
    }

    #[test]
    fn test_params_validate_success() {
        let params = VideoGenerationParams::new("A beautiful sunset over the ocean");
        assert!(params.validate().is_ok());
    }

    #[test]
    fn test_params_validate_empty_prompt() {
        let params = VideoGenerationParams::new("   ");
        assert_eq!(params.validate().unwrap_err(), "Prompt cannot be empty");
    }

    #[test]
    fn test_params_validate_prompt_too_long() {
        let params = VideoGenerationParams::new("x".repeat(4097));
        assert!(params.validate().unwrap_err().contains("too long"));
    }

    #[test]
    fn test_params_validate_duration_bounds() {
        let mut params = VideoGenerationParams::new("Test");
        params.duration_sec = 3.0;
        assert!(params.validate().unwrap_err().contains("too short"));

        params.duration_sec = 200.0;
        assert!(params.validate().unwrap_err().contains("too long"));
    }

    #[test]
    fn test_params_validate_reference_limits() {
        let mut params = VideoGenerationParams::new("Test");
        params.reference_images = vec![PathBuf::from("x"); 10];
        assert!(params
            .validate()
            .unwrap_err()
            .contains("Too many reference images"));

        let mut params = VideoGenerationParams::new("Test");
        params.reference_videos = vec![PathBuf::from("x"); 4];
        assert!(params
            .validate()
            .unwrap_err()
            .contains("Too many reference videos"));

        let mut params = VideoGenerationParams::new("Test");
        params.reference_audio = vec![PathBuf::from("x"); 4];
        assert!(params
            .validate()
            .unwrap_err()
            .contains("Too many reference audio"));
    }

    #[test]
    fn test_params_validate_invalid_aspect_ratio() {
        let params = VideoGenerationParams::new("Test").with_aspect_ratio("5:3");
        assert!(params
            .validate()
            .unwrap_err()
            .contains("Invalid aspect ratio"));
    }

    #[test]
    fn test_params_validate_i2v_requires_image() {
        let params = VideoGenerationParams::new("Test").with_mode(VideoGenMode::ImageToVideo);
        assert!(params
            .validate()
            .unwrap_err()
            .contains("requires at least one reference image"));
    }

    #[test]
    fn test_params_validate_i2v_with_image_ok() {
        let params = VideoGenerationParams::new("Test")
            .with_mode(VideoGenMode::ImageToVideo)
            .with_reference_image(PathBuf::from("/tmp/img.png"));
        assert!(params.validate().is_ok());
    }

    // =========================================================================
    // VideoGenerationStatus Tests
    // =========================================================================

    #[test]
    fn test_status_is_terminal() {
        assert!(!VideoGenerationStatus::Queued.is_terminal());
        assert!(!VideoGenerationStatus::Processing {
            progress: Some(0.5),
            message: None
        }
        .is_terminal());
        assert!(VideoGenerationStatus::Completed {
            download_url: "https://example.com/v.mp4".to_string(),
            duration_sec: 10.0,
            has_audio: true,
        }
        .is_terminal());
        assert!(VideoGenerationStatus::Failed {
            error: "timeout".to_string(),
            code: None,
        }
        .is_terminal());
        assert!(VideoGenerationStatus::Cancelled.is_terminal());
    }

    #[test]
    fn test_status_serialization() {
        let status = VideoGenerationStatus::Processing {
            progress: Some(0.75),
            message: Some("Rendering frames".to_string()),
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"status\":\"processing\""));
        assert!(json.contains("0.75"));

        let deserialized: VideoGenerationStatus = serde_json::from_str(&json).unwrap();
        match deserialized {
            VideoGenerationStatus::Processing { progress, message } => {
                assert_eq!(progress, Some(0.75));
                assert_eq!(message, Some("Rendering frames".to_string()));
            }
            _ => panic!("Expected Processing status"),
        }
    }

    // =========================================================================
    // VideoCostEstimate Tests
    // =========================================================================

    #[test]
    fn test_cost_estimate_basic() {
        let estimate = VideoCostEstimate::calculate(VideoQuality::Basic, 60.0);
        assert_eq!(estimate.cents, 10); // 1 min * 10 cents/min
    }

    #[test]
    fn test_cost_estimate_pro() {
        let estimate = VideoCostEstimate::calculate(VideoQuality::Pro, 30.0);
        assert_eq!(estimate.cents, 15); // 0.5 min * 30 cents/min = 15
    }

    #[test]
    fn test_cost_estimate_cinema() {
        let estimate = VideoCostEstimate::calculate(VideoQuality::Cinema, 10.0);
        // 10s / 60 * 80 cents/min = 13.33 -> ceil = 14
        assert_eq!(estimate.cents, 14);
    }

    #[test]
    fn test_cost_estimate_short_duration() {
        let estimate = VideoCostEstimate::calculate(VideoQuality::Basic, 5.0);
        // 5s / 60 * 10 cents/min = 0.83 -> ceil = 1
        assert_eq!(estimate.cents, 1);
    }

    // =========================================================================
    // VideoJobHandle Tests
    // =========================================================================

    #[test]
    fn test_job_handle_serialization() {
        let handle = VideoJobHandle {
            provider: "seedance".to_string(),
            job_id: "job-123".to_string(),
            submitted_at: 1700000000,
        };
        let json = serde_json::to_string(&handle).unwrap();
        let deserialized: VideoJobHandle = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.provider, "seedance");
        assert_eq!(deserialized.job_id, "job-123");
    }

    // =========================================================================
    // VideoGenerationResult Tests
    // =========================================================================

    #[test]
    fn test_result_serialization() {
        let result = VideoGenerationResult {
            id: "res-1".to_string(),
            output_path: PathBuf::from("/tmp/output.mp4"),
            duration_sec: 10.0,
            resolution: VideoResolution::fhd(),
            has_audio: true,
            cost_cents: 15,
            generation_time_ms: 60000,
        };
        let json = serde_json::to_string(&result).unwrap();
        let deserialized: VideoGenerationResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "res-1");
        assert_eq!(deserialized.resolution.width, 1920);
        assert!(deserialized.has_audio);
    }
}

//! Seedance 2.0 Video Generation Provider
//!
//! Adapter for ByteDance/BytePlus Seedance 2.0 AI video generation API.
//! Uses OpenAI-compatible REST endpoints for submit/poll/cancel/download.
//!
//! Features:
//! - Text-to-video, image-to-video, and multimodal generation
//! - Native 2K resolution with synchronized audio
//! - Async submit + poll pattern (~60s generation time)
//! - Exponential backoff retry for transient errors

use async_trait::async_trait;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tracing::{debug, info, warn};

use crate::core::generative::providers::{
    CostTier, GenerativeProvider, ModelInfo, ProviderCapability,
};
use crate::core::generative::video::{
    VideoCostEstimate, VideoGenMode, VideoGenerationParams, VideoGenerationStatus, VideoJobHandle,
    VideoQuality,
};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Constants
// =============================================================================

/// Default base URL for the Seedance API (BytePlus ModelArk)
const DEFAULT_BASE_URL: &str = "https://ark.byteplus.com/api/v3";

/// Default model ID
const DEFAULT_MODEL_ID: &str = "seedance-2.0";

/// Maximum retry attempts for transient errors
const MAX_RETRIES: u32 = 3;

/// Base delay for exponential backoff (milliseconds)
const BASE_RETRY_DELAY_MS: u64 = 1000;

/// Maximum allowed download size (500 MB) to prevent unbounded memory/disk usage.
const MAX_DOWNLOAD_BYTES: u64 = 500 * 1024 * 1024;

/// Maximum length for job-id-derived output filenames.
const MAX_JOB_ID_FILENAME_LEN: usize = 64;

// =============================================================================
// API Request/Response Types
// =============================================================================

#[derive(Debug, Serialize)]
struct SubmitVideoRequest {
    model: String,
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    negative_prompt: Option<String>,
    mode: String,
    quality: String,
    duration_sec: f64,
    aspect_ratio: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lip_sync_language: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    reference_images: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    reference_videos: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    reference_audio: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SubmitVideoResponse {
    id: String,
}

#[derive(Debug, Deserialize)]
struct PollVideoResponse {
    status: String,
    #[serde(default)]
    progress: Option<f64>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    duration_sec: Option<f64>,
    #[serde(default)]
    has_audio: Option<bool>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiErrorResponse {
    #[serde(default)]
    error: Option<ApiErrorDetail>,
}

#[derive(Debug, Deserialize)]
struct ApiErrorDetail {
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

// =============================================================================
// SeedanceProvider
// =============================================================================

/// Seedance 2.0 video generation provider
pub struct SeedanceProvider {
    /// HTTP client with configured timeout
    client: reqwest::Client,
    /// API key for authentication
    api_key: String,
    /// Base URL for the API
    base_url: String,
    /// Model ID to use
    model_id: String,
}

impl std::fmt::Debug for SeedanceProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SeedanceProvider")
            .field("base_url", &self.base_url)
            .field("model_id", &self.model_id)
            .finish_non_exhaustive()
    }
}

impl SeedanceProvider {
    /// Create a new Seedance provider
    pub fn new(api_key: impl Into<String>) -> CoreResult<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|e| CoreError::Internal(format!("Failed to create HTTP client: {}", e)))?;

        Ok(Self {
            client,
            api_key: api_key.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
            model_id: DEFAULT_MODEL_ID.to_string(),
        })
    }

    /// Set custom base URL
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    /// Set custom model ID
    pub fn with_model_id(mut self, model: impl Into<String>) -> Self {
        self.model_id = model.into();
        self
    }

    /// Build the submit URL
    fn submit_url(&self) -> String {
        format!("{}/video/generations", self.base_url)
    }

    /// Build the poll URL
    fn poll_url(&self, job_id: &str) -> String {
        format!("{}/video/generations/{}", self.base_url, job_id)
    }

    /// Build the cancel URL
    fn cancel_url(&self, job_id: &str) -> String {
        format!("{}/video/generations/{}", self.base_url, job_id)
    }

    /// Convert mode enum to API string
    fn mode_to_str(mode: VideoGenMode) -> &'static str {
        match mode {
            VideoGenMode::TextToVideo => "text_to_video",
            VideoGenMode::ImageToVideo => "image_to_video",
            VideoGenMode::Multimodal => "multimodal",
        }
    }

    /// Convert quality enum to API string
    fn quality_to_str(quality: VideoQuality) -> &'static str {
        match quality {
            VideoQuality::Basic => "basic",
            VideoQuality::Pro => "pro",
            VideoQuality::Cinema => "cinema",
        }
    }

    /// Sanitize a provider job ID for use as a filesystem filename segment.
    fn sanitize_job_id_for_filename(job_id: &str) -> String {
        let sanitized: String = job_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .take(MAX_JOB_ID_FILENAME_LEN)
            .collect();

        if sanitized.is_empty() {
            "generated_video".to_string()
        } else {
            sanitized
        }
    }

    /// Validate that the download URL is a safe HTTP(S) URL.
    fn validate_download_url(url: &str) -> CoreResult<reqwest::Url> {
        let parsed = reqwest::Url::parse(url).map_err(|e| {
            CoreError::ValidationError(format!("Invalid download URL '{}': {}", url, e))
        })?;

        match parsed.scheme() {
            "http" | "https" => Ok(parsed),
            scheme => Err(CoreError::ValidationError(format!(
                "Unsupported download URL scheme '{}'. Only http/https are allowed.",
                scheme
            ))),
        }
    }

    /// Returns true when an error is likely transient and should be retried.
    fn is_retryable_error(error: &CoreError) -> bool {
        let message = match error {
            CoreError::Internal(msg) | CoreError::AIRequestFailed(msg) => msg,
            _ => return false,
        };

        let lowered = message.to_ascii_lowercase();
        lowered.contains("429")
            || lowered.contains("502")
            || lowered.contains("503")
            || lowered.contains("504")
            || lowered.contains("timeout")
            || lowered.contains("temporarily unavailable")
    }

    /// Execute an HTTP request with retries and exponential backoff
    async fn execute_with_retry<F, Fut, T>(&self, operation: &str, f: F) -> CoreResult<T>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = CoreResult<T>>,
    {
        let mut last_error = None;

        for attempt in 0..MAX_RETRIES {
            match f().await {
                Ok(result) => return Ok(result),
                Err(e) => {
                    let is_retryable = Self::is_retryable_error(&e);

                    if !is_retryable || attempt == MAX_RETRIES - 1 {
                        return Err(e);
                    }

                    let delay = BASE_RETRY_DELAY_MS * 2u64.pow(attempt);
                    warn!(
                        "Seedance {} attempt {} failed, retrying in {}ms: {}",
                        operation,
                        attempt + 1,
                        delay,
                        e
                    );
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            CoreError::Internal(format!(
                "Seedance {} failed after {} retries",
                operation, MAX_RETRIES
            ))
        }))
    }

    /// Parse an error response body
    fn parse_api_error(status: StatusCode, body: &str) -> CoreError {
        if let Ok(err_resp) = serde_json::from_str::<ApiErrorResponse>(body) {
            if let Some(detail) = err_resp.error {
                return CoreError::AIRequestFailed(format!(
                    "Seedance API error ({}): {} (code: {})",
                    status,
                    detail.message.unwrap_or_default(),
                    detail.code.unwrap_or_default(),
                ));
            }
        }

        let truncated: String = body.chars().take(500).collect();
        CoreError::AIRequestFailed(format!("Seedance API error ({}): {}", status, truncated))
    }
}

#[async_trait]
impl GenerativeProvider for SeedanceProvider {
    fn name(&self) -> &str {
        "seedance"
    }

    fn capabilities(&self) -> Vec<ProviderCapability> {
        vec![ProviderCapability::VideoGeneration]
    }

    fn is_available(&self) -> bool {
        !self.api_key.is_empty()
    }

    async fn submit_video(&self, params: &VideoGenerationParams) -> CoreResult<VideoJobHandle> {
        params.validate().map_err(CoreError::ValidationError)?;

        let request_body = SubmitVideoRequest {
            model: self.model_id.clone(),
            prompt: params.prompt.clone(),
            negative_prompt: params.negative_prompt.clone(),
            mode: Self::mode_to_str(params.mode).to_string(),
            quality: Self::quality_to_str(params.quality).to_string(),
            duration_sec: params.duration_sec,
            aspect_ratio: params.aspect_ratio.clone(),
            seed: params.seed,
            lip_sync_language: params.lip_sync_language.clone(),
            reference_images: params
                .reference_images
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            reference_videos: params
                .reference_videos
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            reference_audio: params
                .reference_audio
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
        };

        let url = self.submit_url();
        let api_key = self.api_key.clone();

        let response = self
            .execute_with_retry("submit", || {
                let client = self.client.clone();
                let url = url.clone();
                let body = serde_json::to_string(&request_body)
                    .map_err(|e| CoreError::Internal(format!("Serialization failed: {}", e)));
                let key = api_key.clone();

                async move {
                    let body = body?;
                    let resp = client
                        .post(&url)
                        .header("Authorization", format!("Bearer {}", key))
                        .header("Content-Type", "application/json")
                        .body(body)
                        .send()
                        .await
                        .map_err(|e| CoreError::Internal(format!("Network error: {}", e)))?;

                    let status = resp.status();
                    let body = resp.text().await.map_err(|e| {
                        CoreError::Internal(format!("Failed to read response: {}", e))
                    })?;

                    if !status.is_success() {
                        return Err(Self::parse_api_error(status, &body));
                    }

                    let parsed: SubmitVideoResponse = serde_json::from_str(&body).map_err(|e| {
                        CoreError::Internal(format!("Failed to parse response: {}", e))
                    })?;

                    Ok(parsed)
                }
            })
            .await?;

        info!(
            "Seedance video generation submitted: job_id={}",
            response.id
        );

        Ok(VideoJobHandle {
            provider: self.name().to_string(),
            job_id: response.id,
            submitted_at: chrono::Utc::now().timestamp(),
        })
    }

    async fn poll_video(&self, handle: &VideoJobHandle) -> CoreResult<VideoGenerationStatus> {
        let url = self.poll_url(&handle.job_id);
        let api_key = self.api_key.clone();

        let response = self
            .execute_with_retry("poll", || {
                let client = self.client.clone();
                let url = url.clone();
                let key = api_key.clone();

                async move {
                    let resp = client
                        .get(&url)
                        .header("Authorization", format!("Bearer {}", key))
                        .send()
                        .await
                        .map_err(|e| CoreError::Internal(format!("Network error: {}", e)))?;

                    let status = resp.status();
                    let body = resp.text().await.map_err(|e| {
                        CoreError::Internal(format!("Failed to read response: {}", e))
                    })?;

                    if !status.is_success() {
                        return Err(Self::parse_api_error(status, &body));
                    }

                    let parsed: PollVideoResponse = serde_json::from_str(&body).map_err(|e| {
                        CoreError::Internal(format!("Failed to parse poll response: {}", e))
                    })?;

                    Ok(parsed)
                }
            })
            .await?;

        debug!(
            "Seedance poll for job {}: status={}",
            handle.job_id, response.status
        );

        match response.status.as_str() {
            "queued" | "pending" => Ok(VideoGenerationStatus::Queued),
            "processing" | "running" => Ok(VideoGenerationStatus::Processing {
                progress: response.progress,
                message: response.message,
            }),
            "completed" | "succeeded" => {
                let download_url = response.download_url.ok_or_else(|| {
                    CoreError::Internal("Completed status missing download_url".to_string())
                })?;
                Ok(VideoGenerationStatus::Completed {
                    download_url,
                    duration_sec: response.duration_sec.unwrap_or(0.0),
                    has_audio: response.has_audio.unwrap_or(false),
                })
            }
            "failed" | "error" => Ok(VideoGenerationStatus::Failed {
                error: response
                    .error
                    .unwrap_or_else(|| "Unknown error".to_string()),
                code: response.error_code,
            }),
            "cancelled" | "canceled" => Ok(VideoGenerationStatus::Cancelled),
            other => {
                warn!("Unknown Seedance job status: {}", other);
                Ok(VideoGenerationStatus::Processing {
                    progress: response.progress,
                    message: Some(format!("Unknown status: {}", other)),
                })
            }
        }
    }

    async fn cancel_video(&self, handle: &VideoJobHandle) -> CoreResult<()> {
        let url = self.cancel_url(&handle.job_id);
        let api_key = self.api_key.clone();

        self.execute_with_retry("cancel", || {
            let client = self.client.clone();
            let url = url.clone();
            let key = api_key.clone();

            async move {
                let resp = client
                    .delete(&url)
                    .header("Authorization", format!("Bearer {}", key))
                    .send()
                    .await
                    .map_err(|e| CoreError::Internal(format!("Network error: {}", e)))?;

                let status = resp.status();
                if !status.is_success() {
                    let body = resp.text().await.unwrap_or_default();
                    return Err(Self::parse_api_error(status, &body));
                }

                Ok(())
            }
        })
        .await?;

        info!(
            "Seedance video generation cancelled: job_id={}",
            handle.job_id
        );
        Ok(())
    }

    async fn download_video(&self, handle: &VideoJobHandle, dir: &Path) -> CoreResult<PathBuf> {
        // First poll to get the download URL
        let status = self.poll_video(handle).await?;

        let download_url = match status {
            VideoGenerationStatus::Completed { download_url, .. } => download_url,
            _ => {
                return Err(CoreError::ValidationError(
                    "Video generation not yet completed".to_string(),
                ))
            }
        };

        let validated_url = Self::validate_download_url(&download_url)?;

        // Create output directory
        let gen_dir = dir.join("generated-media");
        tokio::fs::create_dir_all(&gen_dir)
            .await
            .map_err(|e| CoreError::Internal(format!("Failed to create output dir: {}", e)))?;

        let filename = format!("{}.mp4", Self::sanitize_job_id_for_filename(&handle.job_id));
        let output_path = gen_dir.join(&filename);

        // Download the file as a stream to avoid holding large blobs in memory.
        let mut resp = self
            .client
            .get(validated_url)
            .send()
            .await
            .map_err(|e| CoreError::Internal(format!("Download failed: {}", e)))?;

        if !resp.status().is_success() {
            return Err(CoreError::Internal(format!(
                "Download failed with status: {}",
                resp.status()
            )));
        }

        if let Some(content_len) = resp.content_length() {
            if content_len > MAX_DOWNLOAD_BYTES {
                return Err(CoreError::ValidationError(format!(
                    "Downloaded video is too large ({} bytes > {} bytes limit)",
                    content_len, MAX_DOWNLOAD_BYTES
                )));
            }
        }

        let mut file = tokio::fs::File::create(&output_path)
            .await
            .map_err(|e| CoreError::Internal(format!("Failed to create video file: {}", e)))?;

        let mut total_bytes: u64 = 0;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| CoreError::Internal(format!("Failed to read chunk: {}", e)))?
        {
            total_bytes = total_bytes.saturating_add(chunk.len() as u64);
            if total_bytes > MAX_DOWNLOAD_BYTES {
                let _ = tokio::fs::remove_file(&output_path).await;
                return Err(CoreError::ValidationError(format!(
                    "Downloaded video exceeded max size limit ({} bytes)",
                    MAX_DOWNLOAD_BYTES
                )));
            }

            file.write_all(&chunk)
                .await
                .map_err(|e| CoreError::Internal(format!("Failed to write video file: {}", e)))?;
        }

        file.flush()
            .await
            .map_err(|e| CoreError::Internal(format!("Failed to flush video file: {}", e)))?;

        info!(
            "Downloaded generated video to {} ({} bytes)",
            output_path.display(),
            total_bytes
        );

        Ok(output_path)
    }

    fn estimate_video_cost(&self, params: &VideoGenerationParams) -> CoreResult<VideoCostEstimate> {
        Ok(VideoCostEstimate::calculate(
            params.quality,
            params.duration_sec,
        ))
    }

    async fn list_models(&self, capability: ProviderCapability) -> CoreResult<Vec<ModelInfo>> {
        if capability != ProviderCapability::VideoGeneration {
            return Ok(vec![]);
        }

        Ok(vec![ModelInfo::new(
            "seedance-2.0",
            "Seedance 2.0",
            capability,
        )
        .with_description("4.5B parameter Dual-Branch DiT, native 2K + audio")
        .with_cost_tier(CostTier::High)
        .as_default()])
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_name_and_capabilities() {
        let provider = SeedanceProvider::new("test-key").unwrap();
        assert_eq!(provider.name(), "seedance");
        assert!(provider.supports(ProviderCapability::VideoGeneration));
        assert!(!provider.supports(ProviderCapability::ImageGeneration));
    }

    #[test]
    fn test_provider_availability() {
        let available = SeedanceProvider::new("test-key").unwrap();
        assert!(available.is_available());

        let unavailable = SeedanceProvider::new("").unwrap();
        assert!(!unavailable.is_available());
    }

    #[test]
    fn test_url_building() {
        let provider = SeedanceProvider::new("key").unwrap();
        assert_eq!(
            provider.submit_url(),
            "https://ark.byteplus.com/api/v3/video/generations"
        );
        assert_eq!(
            provider.poll_url("job-123"),
            "https://ark.byteplus.com/api/v3/video/generations/job-123"
        );
    }

    #[test]
    fn test_custom_base_url() {
        let provider = SeedanceProvider::new("key")
            .unwrap()
            .with_base_url("https://custom.api.com/v1");
        assert_eq!(
            provider.submit_url(),
            "https://custom.api.com/v1/video/generations"
        );
    }

    #[test]
    fn test_mode_to_str() {
        assert_eq!(
            SeedanceProvider::mode_to_str(VideoGenMode::TextToVideo),
            "text_to_video"
        );
        assert_eq!(
            SeedanceProvider::mode_to_str(VideoGenMode::ImageToVideo),
            "image_to_video"
        );
        assert_eq!(
            SeedanceProvider::mode_to_str(VideoGenMode::Multimodal),
            "multimodal"
        );
    }

    #[test]
    fn test_estimate_video_cost() {
        let provider = SeedanceProvider::new("key").unwrap();
        let params = VideoGenerationParams::new("Test").with_duration(60.0);
        let estimate = provider.estimate_video_cost(&params).unwrap();
        assert_eq!(estimate.cents, 30); // 1 min * 30 cents/min (Pro default)
    }

    #[test]
    fn test_sanitize_job_id_for_filename() {
        let sanitized = SeedanceProvider::sanitize_job_id_for_filename("../../job:abc?*");
        assert_eq!(sanitized, "______job_abc__");

        let empty = SeedanceProvider::sanitize_job_id_for_filename("!!!");
        assert_eq!(empty, "___");
    }

    #[test]
    fn test_validate_download_url() {
        assert!(SeedanceProvider::validate_download_url("https://example.com/video.mp4").is_ok());
        assert!(SeedanceProvider::validate_download_url("http://example.com/video.mp4").is_ok());
        assert!(SeedanceProvider::validate_download_url("file:///tmp/video.mp4").is_err());
    }

    #[test]
    fn test_is_retryable_error_for_ai_request_failed() {
        let err = CoreError::AIRequestFailed("Seedance API error (429): rate limit".to_string());
        assert!(SeedanceProvider::is_retryable_error(&err));

        let err = CoreError::AIRequestFailed("validation failed".to_string());
        assert!(!SeedanceProvider::is_retryable_error(&err));
    }

    #[tokio::test]
    async fn test_list_models() {
        let provider = SeedanceProvider::new("key").unwrap();
        let models = provider
            .list_models(ProviderCapability::VideoGeneration)
            .await
            .unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "seedance-2.0");
        assert!(models[0].is_default);

        let no_models = provider
            .list_models(ProviderCapability::ImageGeneration)
            .await
            .unwrap();
        assert!(no_models.is_empty());
    }

    #[test]
    fn test_parse_api_error_structured() {
        let body = r#"{"error":{"message":"Rate limit exceeded","code":"rate_limit"}}"#;
        let err = SeedanceProvider::parse_api_error(StatusCode::TOO_MANY_REQUESTS, body);
        match err {
            CoreError::AIRequestFailed(msg) => {
                assert!(msg.contains("Rate limit exceeded"));
                assert!(msg.contains("rate_limit"));
            }
            _ => panic!("Expected AIRequestFailed"),
        }
    }

    #[test]
    fn test_parse_api_error_unstructured() {
        let body = "Internal Server Error";
        let err = SeedanceProvider::parse_api_error(StatusCode::INTERNAL_SERVER_ERROR, body);
        match err {
            CoreError::AIRequestFailed(msg) => {
                assert!(msg.contains("Internal Server Error"));
            }
            _ => panic!("Expected AIRequestFailed"),
        }
    }

    #[test]
    fn test_submit_request_serialization() {
        let req = SubmitVideoRequest {
            model: "seedance-2.0".to_string(),
            prompt: "A sunset".to_string(),
            negative_prompt: Some("blurry".to_string()),
            mode: "text_to_video".to_string(),
            quality: "pro".to_string(),
            duration_sec: 10.0,
            aspect_ratio: "16:9".to_string(),
            seed: Some(42),
            lip_sync_language: None,
            reference_images: vec![],
            reference_videos: vec![],
            reference_audio: vec![],
        };

        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"model\":\"seedance-2.0\""));
        assert!(json.contains("\"prompt\":\"A sunset\""));
        assert!(json.contains("\"seed\":42"));
        // Empty arrays should be skipped
        assert!(!json.contains("reference_images"));
    }

    #[test]
    fn test_poll_response_deserialization() {
        let json = r#"{"status":"processing","progress":0.5,"message":"Rendering frames"}"#;
        let resp: PollVideoResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.status, "processing");
        assert_eq!(resp.progress, Some(0.5));
        assert_eq!(resp.message, Some("Rendering frames".to_string()));

        let completed = r#"{"status":"completed","download_url":"https://ex.com/v.mp4","duration_sec":10.5,"has_audio":true}"#;
        let resp: PollVideoResponse = serde_json::from_str(completed).unwrap();
        assert_eq!(resp.status, "completed");
        assert_eq!(resp.download_url, Some("https://ex.com/v.mp4".to_string()));
        assert_eq!(resp.has_audio, Some(true));
    }
}

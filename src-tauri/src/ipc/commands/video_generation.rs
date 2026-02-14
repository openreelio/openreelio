//! Video Generation IPC Commands
//!
//! Tauri commands for AI video generation via Seedance 2.0 and other providers.
//!
//! ## Commands
//!
//! - `submit_video_generation`: Submit a video generation job
//! - `poll_generation_job`: Poll the status of a generation job
//! - `cancel_generation_job`: Cancel a running generation job
//! - `estimate_generation_cost`: Estimate cost for a generation request
//! - `download_generated_video`: Download a completed video to project dir
//! - `configure_seedance_provider`: Configure the Seedance API key

use std::sync::OnceLock;

use tauri::Manager;
use tokio::sync::Mutex as AsyncMutex;

use crate::core::credentials::{CredentialType, CredentialVault};
use crate::core::generative::provider_impls::SeedanceProvider;
use crate::core::generative::providers::GenerativeProvider;
use crate::core::generative::video::{
    VideoCostEstimate, VideoGenerationParams, VideoGenerationStatus, VideoJobHandle,
};
use crate::core::generative::video_input_validation::{
    normalize_enum_input, parse_mode, parse_quality, quality_to_wire_value, validate_base_url,
};
use crate::core::settings::SettingsManager;
use crate::AppState;

// =============================================================================
// Helper Functions
// =============================================================================

/// Gets the application data directory path.
fn get_app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))
}

fn video_cost_write_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

/// Retrieves the Seedance API key from the credential vault.
async fn get_seedance_api_key(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let app_data_dir = get_app_data_dir(app)?;
    let vault_path = app_data_dir.join("credentials.vault");

    if vault_path.exists() {
        match CredentialVault::new(vault_path) {
            Ok(vault) => {
                if vault.exists(CredentialType::SeedanceApiKey).await {
                    if let Ok(key) = vault.retrieve(CredentialType::SeedanceApiKey).await {
                        let trimmed = key.trim();
                        if !trimmed.is_empty() {
                            return Ok(Some(trimmed.to_string()));
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Failed to open credential vault: {}", e);
            }
        }
    }

    // Legacy fallback: read from settings if vault key is not configured.
    // Vault remains the preferred secure storage location.
    let settings = SettingsManager::new(app_data_dir).load();
    let fallback = settings
        .ai
        .seedance_api_key
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);
    if fallback.is_some() {
        tracing::warn!("Using legacy settings-based Seedance API key fallback");
    }

    Ok(fallback)
}

/// Enforces server-side video generation cost limits from settings.
fn enforce_video_budget_limits(app: &tauri::AppHandle, estimated_cents: u32) -> Result<(), String> {
    let settings = SettingsManager::new(get_app_data_dir(app)?).load();
    let ai = settings.ai;

    // Per-request limit. 0 means unlimited.
    if ai.video_gen_per_request_limit_cents > 0
        && estimated_cents > ai.video_gen_per_request_limit_cents
    {
        return Err(format!(
            "Estimated cost ${:.2} exceeds per-request limit ${:.2}. Lower duration/quality or increase the limit in Settings > AI > Video Generation.",
            estimated_cents as f64 / 100.0,
            ai.video_gen_per_request_limit_cents as f64 / 100.0
        ));
    }

    // Monthly video budget. Shared usage bucket until dedicated video usage accounting is added.
    if let Some(monthly_budget) = ai.video_gen_budget_cents {
        let projected = ai.current_month_usage_cents.saturating_add(estimated_cents);
        if projected > monthly_budget {
            return Err(format!(
                "Estimated cost ${:.2} exceeds remaining monthly video budget (${:.2} remaining).",
                estimated_cents as f64 / 100.0,
                monthly_budget.saturating_sub(ai.current_month_usage_cents) as f64 / 100.0
            ));
        }
    }

    Ok(())
}

/// Records video generation cost to the shared monthly usage bucket.
///
/// Uses a process-wide async mutex to avoid read-modify-write races between
/// concurrent submissions.
async fn record_video_cost(app: &tauri::AppHandle, cost_cents: u32) {
    let _guard = video_cost_write_lock().lock().await;

    let data_dir = match get_app_data_dir(app) {
        Ok(dir) => dir,
        Err(e) => {
            tracing::warn!("Failed to get app data dir for cost recording: {}", e);
            return;
        }
    };
    let manager = SettingsManager::new(data_dir);
    let mut settings = manager.load();
    settings.ai.current_month_usage_cents = settings
        .ai
        .current_month_usage_cents
        .saturating_add(cost_cents);
    if let Err(e) = manager.save(&settings) {
        tracing::warn!("Failed to record video cost: {}", e);
    }
}

/// Create a SeedanceProvider from vault credentials.
async fn create_seedance_provider(app: &tauri::AppHandle) -> Result<SeedanceProvider, String> {
    let api_key = get_seedance_api_key(app).await?.ok_or_else(|| {
        "Seedance API key not configured. Set it in Settings > AI > Video Generation.".to_string()
    })?;

    SeedanceProvider::new(api_key).map_err(|e| format!("Failed to create Seedance provider: {}", e))
}

// =============================================================================
// Request/Response DTOs
// =============================================================================

/// Request for submit_video_generation
#[derive(Clone, Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitVideoGenerationRequest {
    pub prompt: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_quality")]
    pub quality: String,
    #[serde(default = "default_duration")]
    pub duration_sec: f64,
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub reference_images: Vec<String>,
    #[serde(default)]
    pub reference_videos: Vec<String>,
    #[serde(default)]
    pub reference_audio: Vec<String>,
    #[serde(default = "default_aspect_ratio")]
    pub aspect_ratio: String,
    pub seed: Option<u64>,
    pub lip_sync_language: Option<String>,
}

fn default_mode() -> String {
    "text_to_video".to_string()
}
fn default_quality() -> String {
    "pro".to_string()
}
fn default_duration() -> f64 {
    10.0
}
fn default_aspect_ratio() -> String {
    "16:9".to_string()
}

/// Response for submit_video_generation
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmitVideoGenerationResponse {
    pub job_id: String,
    pub provider_job_id: String,
    pub estimated_cost_cents: u32,
}

/// Response for poll_generation_job
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PollGenerationJobResponse {
    pub status: String,
    pub progress: Option<f64>,
    pub message: Option<String>,
    pub download_url: Option<String>,
    pub duration_sec: Option<f64>,
    pub has_audio: Option<bool>,
    pub error: Option<String>,
}

/// Response for estimate_generation_cost
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EstimateGenerationCostResponse {
    pub estimated_cents: u32,
    pub quality: String,
    pub duration_sec: f64,
}

/// Response for download_generated_video
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadGeneratedVideoResponse {
    pub output_path: String,
}

/// Response for configure_seedance_provider
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureSeedanceProviderResponse {
    pub is_available: bool,
}

// =============================================================================
// IPC Commands
// =============================================================================

/// Submit a video generation job.
///
/// Returns the job handle and estimated cost. Does not block until completion.
#[tauri::command]
#[specta::specta]
pub async fn submit_video_generation(
    app: tauri::AppHandle,
    request: SubmitVideoGenerationRequest,
) -> Result<SubmitVideoGenerationResponse, String> {
    let provider = create_seedance_provider(&app).await?;

    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("Prompt cannot be empty".to_string());
    }

    let normalized_mode = normalize_enum_input(&request.mode);
    let normalized_quality = normalize_enum_input(&request.quality);
    let mode = parse_mode(&normalized_mode)?;
    let quality = parse_quality(&normalized_quality)?;

    let aspect_ratio = if request.aspect_ratio.trim().is_empty() {
        default_aspect_ratio()
    } else {
        request.aspect_ratio.trim().to_string()
    };

    let params = VideoGenerationParams::new(prompt)
        .with_mode(mode)
        .with_quality(quality)
        .with_duration(request.duration_sec)
        .with_aspect_ratio(&aspect_ratio);

    // Apply optional fields
    let params = if let Some(neg) = request
        .negative_prompt
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        params.with_negative_prompt(neg)
    } else {
        params
    };

    let mut params = if let Some(seed) = request.seed {
        params.with_seed(seed)
    } else {
        params
    };

    params.lip_sync_language = request
        .lip_sync_language
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned);

    // Add reference files
    for path in &request.reference_images {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            params
                .reference_images
                .push(std::path::PathBuf::from(trimmed));
        }
    }
    for path in &request.reference_videos {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            params
                .reference_videos
                .push(std::path::PathBuf::from(trimmed));
        }
    }
    for path in &request.reference_audio {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            params
                .reference_audio
                .push(std::path::PathBuf::from(trimmed));
        }
    }

    // Validate params before cost estimation and submission
    params
        .validate()
        .map_err(|e| format!("Invalid video generation parameters: {}", e))?;

    // Estimate cost
    let estimate = provider
        .estimate_video_cost(&params)
        .map_err(|e| format!("Cost estimation failed: {}", e))?;

    enforce_video_budget_limits(&app, estimate.cents)?;

    // Submit the job
    let handle = provider
        .submit_video(&params)
        .await
        .map_err(|e| format!("Video generation submission failed: {}", e))?;

    // Record estimated cost to monthly usage so subsequent budget checks see the updated total
    record_video_cost(&app, estimate.cents).await;

    Ok(SubmitVideoGenerationResponse {
        job_id: ulid::Ulid::new().to_string(),
        provider_job_id: handle.job_id,
        estimated_cost_cents: estimate.cents,
    })
}

/// Poll the status of a video generation job.
#[tauri::command]
#[specta::specta]
pub async fn poll_generation_job(
    app: tauri::AppHandle,
    provider_job_id: String,
) -> Result<PollGenerationJobResponse, String> {
    let provider = create_seedance_provider(&app).await?;

    let handle = VideoJobHandle {
        provider: "seedance".to_string(),
        job_id: provider_job_id,
        submitted_at: chrono::Utc::now().timestamp(),
    };

    let status = provider
        .poll_video(&handle)
        .await
        .map_err(|e| format!("Poll failed: {}", e))?;

    match status {
        VideoGenerationStatus::Queued => Ok(PollGenerationJobResponse {
            status: "queued".to_string(),
            progress: None,
            message: None,
            download_url: None,
            duration_sec: None,
            has_audio: None,
            error: None,
        }),
        VideoGenerationStatus::Processing { progress, message } => Ok(PollGenerationJobResponse {
            status: "processing".to_string(),
            progress,
            message,
            download_url: None,
            duration_sec: None,
            has_audio: None,
            error: None,
        }),
        VideoGenerationStatus::Completed {
            download_url,
            duration_sec,
            has_audio,
        } => Ok(PollGenerationJobResponse {
            status: "completed".to_string(),
            progress: Some(100.0),
            message: None,
            download_url: Some(download_url),
            duration_sec: Some(duration_sec),
            has_audio: Some(has_audio),
            error: None,
        }),
        VideoGenerationStatus::Failed { error, code } => Ok(PollGenerationJobResponse {
            status: "failed".to_string(),
            progress: None,
            message: code,
            download_url: None,
            duration_sec: None,
            has_audio: None,
            error: Some(error),
        }),
        VideoGenerationStatus::Cancelled => Ok(PollGenerationJobResponse {
            status: "cancelled".to_string(),
            progress: None,
            message: None,
            download_url: None,
            duration_sec: None,
            has_audio: None,
            error: None,
        }),
    }
}

/// Cancel a running video generation job.
#[tauri::command]
#[specta::specta]
pub async fn cancel_generation_job(
    app: tauri::AppHandle,
    provider_job_id: String,
) -> Result<bool, String> {
    let provider = create_seedance_provider(&app).await?;

    let handle = VideoJobHandle {
        provider: "seedance".to_string(),
        job_id: provider_job_id,
        submitted_at: chrono::Utc::now().timestamp(),
    };

    provider
        .cancel_video(&handle)
        .await
        .map_err(|e| format!("Cancel failed: {}", e))?;

    Ok(true)
}

/// Estimate the cost of a video generation request.
#[tauri::command]
#[specta::specta]
pub async fn estimate_generation_cost(
    quality: String,
    duration_sec: f64,
) -> Result<EstimateGenerationCostResponse, String> {
    let normalized_quality = normalize_enum_input(&quality);
    let quality_enum = parse_quality(&normalized_quality)?;
    // Clamp to match submit_video_generation behavior (5-120s via with_duration)
    let duration_sec = duration_sec.clamp(5.0, 120.0);
    let estimate = VideoCostEstimate::calculate(quality_enum, duration_sec);

    Ok(EstimateGenerationCostResponse {
        estimated_cents: estimate.cents,
        quality: quality_to_wire_value(quality_enum).to_string(),
        duration_sec: estimate.duration_sec,
    })
}

/// Download a completed generated video to the project directory.
#[tauri::command]
#[specta::specta]
pub async fn download_generated_video(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    provider_job_id: String,
) -> Result<DownloadGeneratedVideoResponse, String> {
    let provider = create_seedance_provider(&app).await?;

    let handle = VideoJobHandle {
        provider: "seedance".to_string(),
        job_id: provider_job_id,
        submitted_at: chrono::Utc::now().timestamp(),
    };

    // Get the project directory
    let project_dir = {
        let project_guard = state.project.lock().await;
        let project = project_guard
            .as_ref()
            .ok_or_else(|| "No project open".to_string())?;
        project.path.clone()
    };

    let output_path = provider
        .download_video(&handle, &project_dir)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    // Allow asset protocol access for the downloaded file
    state.allow_asset_protocol_file(&output_path);

    Ok(DownloadGeneratedVideoResponse {
        output_path: output_path.to_string_lossy().to_string(),
    })
}

/// Configure the Seedance provider by storing the API key.
#[tauri::command]
#[specta::specta]
pub async fn configure_seedance_provider(
    app: tauri::AppHandle,
    api_key: String,
    base_url: Option<String>,
) -> Result<ConfigureSeedanceProviderResponse, String> {
    let api_key = api_key.trim().to_string();
    let app_data_dir = get_app_data_dir(&app)?;
    let vault_path = app_data_dir.join("credentials.vault");

    let vault = CredentialVault::new(vault_path)
        .map_err(|e| format!("Failed to open credential vault: {}", e))?;

    if api_key.is_empty() {
        // Delete the credential if empty
        vault
            .delete(CredentialType::SeedanceApiKey)
            .await
            .map_err(|e| format!("Failed to remove API key: {}", e))?;
        return Ok(ConfigureSeedanceProviderResponse {
            is_available: false,
        });
    }

    vault
        .store(CredentialType::SeedanceApiKey, &api_key)
        .await
        .map_err(|e| format!("Failed to store API key: {}", e))?;

    // Verify the provider can be created
    let mut provider =
        SeedanceProvider::new(&api_key).map_err(|e| format!("Failed to create provider: {}", e))?;

    if let Some(url) = base_url {
        let validated = validate_base_url(&url)?;
        provider = provider.with_base_url(validated);
    }

    Ok(ConfigureSeedanceProviderResponse {
        is_available: provider.is_available(),
    })
}

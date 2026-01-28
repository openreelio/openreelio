//! Annotation IPC Commands
//!
//! Tauri commands for asset annotation and video analysis.
//!
//! ## Commands
//!
//! - `get_annotation`: Get annotation for an asset
//! - `analyze_asset`: Perform analysis on an asset
//! - `estimate_analysis_cost`: Estimate cost for cloud analysis
//! - `delete_annotation`: Delete annotation for an asset
//! - `list_annotations`: List all annotated assets
//! - `get_analysis_status`: Get analysis status for an asset
//! - `get_available_providers`: Get available analysis providers
//! - `configure_cloud_provider`: Configure Google Cloud API key

use tauri::{Manager, State};

use crate::core::annotations::{
    AnalysisOrchestrator, AnalysisProvider, AnalysisRequest, AnalysisResponse, AnalysisStatus,
    AnalysisType, AssetAnnotation, CostEstimate, ProviderCapabilities, ShotDetectionConfig,
};
use crate::core::credentials::{CredentialType, CredentialVault};
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

/// Retrieves the Google API key from the credential vault.
/// Falls back to settings for backwards compatibility.
async fn get_google_api_key(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let app_data_dir = get_app_data_dir(app)?;
    let vault_path = app_data_dir.join("credentials.vault");

    // Try to get from credential vault first (preferred secure storage)
    if vault_path.exists() {
        match CredentialVault::new(vault_path) {
            Ok(vault) => {
                if vault.exists(CredentialType::GoogleApiKey).await {
                    match vault.retrieve(CredentialType::GoogleApiKey).await {
                        Ok(key) if !key.is_empty() => return Ok(Some(key)),
                        _ => {}
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Failed to open credential vault: {}", e);
            }
        }
    }

    // Fall back to settings for backwards compatibility
    let settings_manager = SettingsManager::new(app_data_dir);
    let settings = settings_manager.load();

    if let Some(ref api_key) = settings.ai.google_api_key {
        if !api_key.is_empty() {
            return Ok(Some(api_key.clone()));
        }
    }

    Ok(None)
}

// =============================================================================
// Response DTOs
// =============================================================================

/// Response for get_annotation command
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GetAnnotationResponse {
    /// Annotation data (null if not found)
    pub annotation: Option<AssetAnnotation>,
    /// Analysis status
    pub status: AnalysisStatus,
}

/// Response for analyze_asset command
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeAssetResponse {
    /// Updated annotation
    pub annotation: AssetAnnotation,
    /// Analysis response with results
    pub response: AnalysisResponse,
}

/// Request for analyze_asset command
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeAssetRequest {
    /// Asset ID to analyze
    pub asset_id: String,
    /// Provider to use
    pub provider: AnalysisProvider,
    /// Analysis types to perform
    pub analysis_types: Vec<AnalysisType>,
    /// Shot detection config (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot_config: Option<ShotDetectionConfig>,
}

// =============================================================================
// Commands
// =============================================================================

/// Gets annotation for an asset
///
/// Returns the annotation data if it exists, along with the analysis status.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn get_annotation(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<GetAnnotationResponse, String> {
    // Get project and asset
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project is currently open".to_string())?;

    let asset = project
        .state
        .assets
        .get(&asset_id)
        .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

    // Create orchestrator for this project
    let orchestrator = AnalysisOrchestrator::new(&project.path);

    // Get annotation and status
    let annotation = orchestrator
        .get_annotation(&asset_id)
        .map_err(|e| format!("Failed to get annotation: {}", e))?;

    let status = orchestrator
        .get_status(&asset_id, &asset.hash)
        .map_err(|e| format!("Failed to get status: {}", e))?;

    Ok(GetAnnotationResponse { annotation, status })
}

/// Analyzes an asset using the specified provider
///
/// Performs analysis and stores results in the annotation store.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app))]
pub async fn analyze_asset(
    request: AnalyzeAssetRequest,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AnalyzeAssetResponse, String> {
    // Get project and asset
    let (project_path, asset_path, asset_hash, duration_sec) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;

        let asset = project
            .state
            .assets
            .get(&request.asset_id)
            .ok_or_else(|| format!("Asset not found: {}", request.asset_id))?;

        let duration = asset
            .duration_sec
            .ok_or_else(|| "Asset has no duration (not a video/audio file?)".to_string())?;

        (
            project.path.clone(),
            asset.uri.clone(),
            asset.hash.clone(),
            duration,
        )
    };

    // Create orchestrator
    let mut orchestrator = AnalysisOrchestrator::new(&project_path);

    // Configure cloud provider if needed
    if matches!(request.provider, AnalysisProvider::GoogleCloud) {
        match get_google_api_key(&app).await? {
            Some(api_key) => {
                orchestrator
                    .configure_cloud_provider(&api_key)
                    .map_err(|e| format!("Failed to configure cloud provider: {}", e))?;
            }
            None => {
                return Err(
                    "Google Cloud API key not configured. Add it in Settings > AI.".to_string(),
                );
            }
        }
    }

    // Build analysis request
    let mut analysis_request = AnalysisRequest::new(
        &request.asset_id,
        &asset_path,
        duration_sec,
        request.analysis_types,
    );

    if let Some(shot_config) = request.shot_config {
        analysis_request = analysis_request.with_shot_config(shot_config);
    }

    // Perform analysis
    let response = orchestrator
        .analyze(request.provider.clone(), analysis_request.clone())
        .await
        .map_err(|e| format!("Analysis failed: {}", e))?;

    // Store results
    let annotation = orchestrator
        .analyze_and_store(request.provider, analysis_request, &asset_hash)
        .await
        .map_err(|e| format!("Failed to store annotation: {}", e))?;

    Ok(AnalyzeAssetResponse {
        annotation,
        response,
    })
}

/// Estimates cost for analysis
///
/// Returns cost estimate for cloud providers, None for local providers.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app))]
pub async fn estimate_analysis_cost(
    asset_id: String,
    provider: AnalysisProvider,
    analysis_types: Vec<AnalysisType>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Option<CostEstimate>, String> {
    // Get asset duration
    let (project_path, duration_sec) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;

        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        let duration = asset
            .duration_sec
            .ok_or_else(|| "Asset has no duration".to_string())?;

        (project.path.clone(), duration)
    };

    // Create orchestrator and estimate cost
    let mut orchestrator = AnalysisOrchestrator::new(&project_path);

    // Configure cloud provider for accurate estimation
    if matches!(provider, AnalysisProvider::GoogleCloud) {
        if let Some(api_key) = get_google_api_key(&app).await? {
            let _ = orchestrator.configure_cloud_provider(&api_key);
        }
    }

    let estimate = orchestrator.estimate_cost(provider, duration_sec, &analysis_types);

    Ok(estimate)
}

/// Deletes annotation for an asset
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn delete_annotation(asset_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project is currently open".to_string())?;

    let orchestrator = AnalysisOrchestrator::new(&project.path);
    orchestrator
        .delete_annotation(&asset_id)
        .map_err(|e| format!("Failed to delete annotation: {}", e))?;

    Ok(())
}

/// Lists all annotated asset IDs
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn list_annotations(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project is currently open".to_string())?;

    let orchestrator = AnalysisOrchestrator::new(&project.path);
    let annotations = orchestrator
        .list_annotated()
        .map_err(|e| format!("Failed to list annotations: {}", e))?;

    Ok(annotations)
}

/// Gets analysis status for an asset
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn get_analysis_status(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<AnalysisStatus, String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project is currently open".to_string())?;

    let asset = project
        .state
        .assets
        .get(&asset_id)
        .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

    let orchestrator = AnalysisOrchestrator::new(&project.path);
    let status = orchestrator
        .get_status(&asset_id, &asset.hash)
        .map_err(|e| format!("Failed to get status: {}", e))?;

    Ok(status)
}

/// Gets available analysis providers
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app))]
pub async fn get_available_providers(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<ProviderCapabilities>, String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project is currently open".to_string())?;

    let mut orchestrator = AnalysisOrchestrator::new(&project.path);

    // Check if cloud provider is configured
    if let Some(api_key) = get_google_api_key(&app).await? {
        let _ = orchestrator.configure_cloud_provider(&api_key);
    }

    Ok(orchestrator.available_providers())
}

/// Configures Google Cloud API key
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app, api_key))]
pub async fn configure_cloud_provider(
    api_key: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Validate API key format (basic check)
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API key cannot be empty".to_string());
    }

    let app_data_dir = get_app_data_dir(&app)?;

    // Store in credential vault (secure storage)
    let vault_path = app_data_dir.join("credentials.vault");
    let vault = CredentialVault::new(vault_path)
        .map_err(|e| format!("Failed to initialize credential vault: {}", e))?;

    vault
        .store(CredentialType::GoogleApiKey, trimmed)
        .await
        .map_err(|e| format!("Failed to store API key securely: {}", e))?;

    // Also save to settings for backwards compatibility
    let settings_manager = SettingsManager::new(app_data_dir);
    let mut settings = settings_manager.load();
    settings.ai.google_api_key = Some(trimmed.to_string());

    settings_manager
        .save(&settings)
        .map_err(|e| format!("Failed to save settings: {}", e))?;

    // Verify the key works (optional health check)
    let guard = state.project.lock().await;
    if let Some(project) = guard.as_ref() {
        let mut orchestrator = AnalysisOrchestrator::new(&project.path);
        orchestrator
            .configure_cloud_provider(trimmed)
            .map_err(|e| format!("Invalid API key: {}", e))?;
    }

    tracing::info!("Google Cloud API key configured successfully");
    Ok(())
}

/// Removes Google Cloud API key configuration
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app))]
pub async fn remove_cloud_provider(app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;

    // Remove from credential vault
    let vault_path = app_data_dir.join("credentials.vault");
    if vault_path.exists() {
        if let Ok(vault) = CredentialVault::new(vault_path) {
            let _ = vault.delete(CredentialType::GoogleApiKey).await;
        }
    }

    // Also remove from settings
    let settings_manager = SettingsManager::new(app_data_dir.clone());
    let mut settings = settings_manager.load();
    settings.ai.google_api_key = None;

    settings_manager
        .save(&settings)
        .map_err(|e| format!("Failed to save settings: {}", e))?;

    tracing::info!("Google Cloud API key removed");
    Ok(())
}

//! System commands, settings, credentials, and updates
//!
//! Tauri IPC commands for app lifecycle, playhead synchronization,
//! application settings, credential management, and auto-updates.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Manager, State};

use crate::core::settings::{AppSettings, SettingsManager};
use crate::AppState;

// =============================================================================
// App Lifecycle DTOs
// =============================================================================

/// Best-effort cleanup result returned to the frontend on app close.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppCleanupResult {
    pub project_saved: bool,
    pub workers_shutdown: bool,
    pub error: Option<String>,
}

/// Input payload for runtime playhead synchronization.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetPlayheadPositionPayload {
    /// Current playhead position in seconds.
    pub position_sec: f64,
    /// Active sequence ID (if available).
    pub sequence_id: Option<String>,
    /// Source label for diagnostics (e.g. "timeline-scrub", "seek-bar").
    pub source: Option<String>,
    /// Whether playback is currently active.
    pub is_playing: Option<bool>,
    /// Timeline duration in seconds (if known).
    pub duration_sec: Option<f64>,
}

/// Runtime playback sync DTO returned by backend sync commands.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayheadSyncStateDto {
    /// Current playhead position in seconds.
    pub position_sec: f64,
    /// Active sequence ID (if available).
    pub sequence_id: Option<String>,
    /// Last update source label.
    pub source: Option<String>,
    /// Whether playback is currently active.
    pub is_playing: bool,
    /// Timeline duration in seconds (if known).
    pub duration_sec: Option<f64>,
    /// RFC3339 timestamp of last backend update.
    pub updated_at: String,
}

impl PlayheadSyncStateDto {
    fn from_runtime(state: &crate::PlaybackSyncState) -> Self {
        Self {
            position_sec: state.position_sec,
            sequence_id: state.sequence_id.clone(),
            source: state.last_source.clone(),
            is_playing: state.is_playing,
            duration_sec: state.duration_sec,
            updated_at: state.updated_at.clone(),
        }
    }
}

// =============================================================================
// Settings DTOs
// =============================================================================

/// DTO for app settings (mirrors Rust AppSettings)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsDto {
    pub version: u32,
    pub general: GeneralSettingsDto,
    pub editor: EditorSettingsDto,
    pub playback: PlaybackSettingsDto,
    pub export: ExportSettingsDto,
    pub appearance: AppearanceSettingsDto,
    pub shortcuts: ShortcutSettingsDto,
    pub auto_save: AutoSaveSettingsDto,
    pub performance: PerformanceSettingsDto,
    pub ai: AISettingsDto,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettingsDto {
    pub language: String,
    pub show_welcome_on_startup: bool,
    pub has_completed_setup: bool,
    pub recent_projects_limit: u32,
    pub check_updates_on_startup: bool,
    pub default_project_location: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettingsDto {
    pub default_timeline_zoom: f64,
    pub snap_to_grid: bool,
    pub snap_tolerance: u32,
    pub show_clip_thumbnails: bool,
    pub show_audio_waveforms: bool,
    pub ripple_edit_default: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSettingsDto {
    pub default_volume: f64,
    pub loop_playback: bool,
    pub preview_quality: String,
    pub audio_scrubbing: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettingsDto {
    pub default_format: String,
    pub default_video_codec: String,
    pub default_audio_codec: String,
    pub default_export_location: Option<String>,
    pub open_folder_after_export: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettingsDto {
    pub theme: String,
    pub accent_color: String,
    pub ui_scale: f64,
    pub show_status_bar: bool,
    pub compact_mode: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettingsDto {
    pub custom_shortcuts: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveSettingsDto {
    pub enabled: bool,
    pub interval_seconds: u32,
    pub backup_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSettingsDto {
    pub hardware_acceleration: bool,
    pub proxy_generation: bool,
    pub proxy_resolution: String,
    pub max_concurrent_jobs: u32,
    pub memory_limit_mb: u32,
    pub cache_size_mb: u32,
}

/// AI provider type for settings DTO
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProviderTypeDto {
    Openai,
    Anthropic,
    Gemini,
    Local,
}

/// Proposal review mode for settings DTO
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ProposalReviewModeDto {
    Always,
    Smart,
    AutoApply,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AISettingsDto {
    // Provider Configuration
    pub primary_provider: ProviderTypeDto,
    pub primary_model: String,
    pub vision_provider: Option<ProviderTypeDto>,
    pub vision_model: Option<String>,

    // API Keys
    pub openai_api_key: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub google_api_key: Option<String>,
    pub ollama_url: Option<String>,

    // Generation Parameters
    pub temperature: f32,
    pub max_tokens: u32,
    pub frame_extraction_rate: f32,

    // Cost Controls
    pub monthly_budget_cents: Option<u32>,
    pub per_request_limit_cents: u32,
    pub current_month_usage_cents: u32,
    pub current_usage_month: Option<u32>,

    // Behavior
    pub auto_analyze_on_import: bool,
    pub auto_caption_on_import: bool,
    pub proposal_review_mode: ProposalReviewModeDto,
    pub cache_duration_hours: u32,

    // Privacy
    pub local_only_mode: bool,

    // Video Generation
    #[serde(default)]
    pub seedance_api_key: Option<String>,
    #[serde(default)]
    pub video_gen_provider: Option<String>,
    #[serde(default = "default_video_gen_default_quality_dto")]
    pub video_gen_default_quality: String,
    #[serde(default)]
    pub video_gen_budget_cents: Option<u32>,
    #[serde(default = "default_video_gen_per_request_limit_dto")]
    pub video_gen_per_request_limit_cents: u32,
}

fn default_video_gen_default_quality_dto() -> String {
    "pro".to_string()
}

fn default_video_gen_per_request_limit_dto() -> u32 {
    100
}

impl From<AppSettings> for AppSettingsDto {
    fn from(s: AppSettings) -> Self {
        Self {
            version: s.version,
            general: GeneralSettingsDto {
                language: s.general.language,
                show_welcome_on_startup: s.general.show_welcome_on_startup,
                has_completed_setup: s.general.has_completed_setup,
                recent_projects_limit: s.general.recent_projects_limit,
                check_updates_on_startup: s.general.check_updates_on_startup,
                default_project_location: s.general.default_project_location,
            },
            editor: EditorSettingsDto {
                default_timeline_zoom: s.editor.default_timeline_zoom,
                snap_to_grid: s.editor.snap_to_grid,
                snap_tolerance: s.editor.snap_tolerance,
                show_clip_thumbnails: s.editor.show_clip_thumbnails,
                show_audio_waveforms: s.editor.show_audio_waveforms,
                ripple_edit_default: s.editor.ripple_edit_default,
            },
            playback: PlaybackSettingsDto {
                default_volume: s.playback.default_volume,
                loop_playback: s.playback.loop_playback,
                preview_quality: s.playback.preview_quality,
                audio_scrubbing: s.playback.audio_scrubbing,
            },
            export: ExportSettingsDto {
                default_format: s.export.default_format,
                default_video_codec: s.export.default_video_codec,
                default_audio_codec: s.export.default_audio_codec,
                default_export_location: s.export.default_export_location,
                open_folder_after_export: s.export.open_folder_after_export,
            },
            appearance: AppearanceSettingsDto {
                theme: s.appearance.theme,
                accent_color: s.appearance.accent_color,
                ui_scale: s.appearance.ui_scale,
                show_status_bar: s.appearance.show_status_bar,
                compact_mode: s.appearance.compact_mode,
            },
            shortcuts: ShortcutSettingsDto {
                custom_shortcuts: s.shortcuts.custom_shortcuts,
            },
            auto_save: AutoSaveSettingsDto {
                enabled: s.auto_save.enabled,
                interval_seconds: s.auto_save.interval_seconds,
                backup_count: s.auto_save.backup_count,
            },
            performance: PerformanceSettingsDto {
                hardware_acceleration: s.performance.hardware_acceleration,
                proxy_generation: s.performance.proxy_generation,
                proxy_resolution: s.performance.proxy_resolution,
                max_concurrent_jobs: s.performance.max_concurrent_jobs,
                memory_limit_mb: s.performance.memory_limit_mb,
                cache_size_mb: s.performance.cache_size_mb,
            },
            ai: AISettingsDto {
                primary_provider: match s.ai.primary_provider {
                    crate::core::settings::ProviderType::OpenAI => ProviderTypeDto::Openai,
                    crate::core::settings::ProviderType::Anthropic => ProviderTypeDto::Anthropic,
                    crate::core::settings::ProviderType::Gemini => ProviderTypeDto::Gemini,
                    crate::core::settings::ProviderType::Local => ProviderTypeDto::Local,
                },
                primary_model: s.ai.primary_model,
                vision_provider: s.ai.vision_provider.map(|p| match p {
                    crate::core::settings::ProviderType::OpenAI => ProviderTypeDto::Openai,
                    crate::core::settings::ProviderType::Anthropic => ProviderTypeDto::Anthropic,
                    crate::core::settings::ProviderType::Gemini => ProviderTypeDto::Gemini,
                    crate::core::settings::ProviderType::Local => ProviderTypeDto::Local,
                }),
                vision_model: s.ai.vision_model,
                openai_api_key: s.ai.openai_api_key,
                anthropic_api_key: s.ai.anthropic_api_key,
                google_api_key: s.ai.google_api_key,
                ollama_url: s.ai.ollama_url,
                temperature: s.ai.temperature,
                max_tokens: s.ai.max_tokens,
                frame_extraction_rate: s.ai.frame_extraction_rate,
                monthly_budget_cents: s.ai.monthly_budget_cents,
                per_request_limit_cents: s.ai.per_request_limit_cents,
                current_month_usage_cents: s.ai.current_month_usage_cents,
                current_usage_month: s.ai.current_usage_month,
                auto_analyze_on_import: s.ai.auto_analyze_on_import,
                auto_caption_on_import: s.ai.auto_caption_on_import,
                proposal_review_mode: match s.ai.proposal_review_mode {
                    crate::core::settings::ProposalReviewMode::Always => {
                        ProposalReviewModeDto::Always
                    }
                    crate::core::settings::ProposalReviewMode::Smart => {
                        ProposalReviewModeDto::Smart
                    }
                    crate::core::settings::ProposalReviewMode::AutoApply => {
                        ProposalReviewModeDto::AutoApply
                    }
                },
                cache_duration_hours: s.ai.cache_duration_hours,
                local_only_mode: s.ai.local_only_mode,
                seedance_api_key: s.ai.seedance_api_key,
                video_gen_provider: s.ai.video_gen_provider,
                video_gen_default_quality: s.ai.video_gen_default_quality,
                video_gen_budget_cents: s.ai.video_gen_budget_cents,
                video_gen_per_request_limit_cents: s.ai.video_gen_per_request_limit_cents,
            },
        }
    }
}

impl From<AppSettingsDto> for AppSettings {
    fn from(dto: AppSettingsDto) -> Self {
        use crate::core::settings::*;
        Self {
            version: dto.version,
            general: GeneralSettings {
                language: dto.general.language,
                show_welcome_on_startup: dto.general.show_welcome_on_startup,
                has_completed_setup: dto.general.has_completed_setup,
                recent_projects_limit: dto.general.recent_projects_limit,
                check_updates_on_startup: dto.general.check_updates_on_startup,
                default_project_location: dto.general.default_project_location,
            },
            editor: EditorSettings {
                default_timeline_zoom: dto.editor.default_timeline_zoom,
                snap_to_grid: dto.editor.snap_to_grid,
                snap_tolerance: dto.editor.snap_tolerance,
                show_clip_thumbnails: dto.editor.show_clip_thumbnails,
                show_audio_waveforms: dto.editor.show_audio_waveforms,
                ripple_edit_default: dto.editor.ripple_edit_default,
            },
            playback: PlaybackSettings {
                default_volume: dto.playback.default_volume,
                loop_playback: dto.playback.loop_playback,
                preview_quality: dto.playback.preview_quality,
                audio_scrubbing: dto.playback.audio_scrubbing,
            },
            export: ExportSettings {
                default_format: dto.export.default_format,
                default_video_codec: dto.export.default_video_codec,
                default_audio_codec: dto.export.default_audio_codec,
                default_export_location: dto.export.default_export_location,
                open_folder_after_export: dto.export.open_folder_after_export,
            },
            appearance: AppearanceSettings {
                theme: dto.appearance.theme,
                accent_color: dto.appearance.accent_color,
                ui_scale: dto.appearance.ui_scale,
                show_status_bar: dto.appearance.show_status_bar,
                compact_mode: dto.appearance.compact_mode,
            },
            shortcuts: ShortcutSettings {
                custom_shortcuts: dto.shortcuts.custom_shortcuts,
            },
            auto_save: AutoSaveSettings {
                enabled: dto.auto_save.enabled,
                interval_seconds: dto.auto_save.interval_seconds,
                backup_count: dto.auto_save.backup_count,
            },
            performance: PerformanceSettings {
                hardware_acceleration: dto.performance.hardware_acceleration,
                proxy_generation: dto.performance.proxy_generation,
                proxy_resolution: dto.performance.proxy_resolution,
                max_concurrent_jobs: dto.performance.max_concurrent_jobs,
                memory_limit_mb: dto.performance.memory_limit_mb,
                cache_size_mb: dto.performance.cache_size_mb,
            },
            ai: AISettings {
                primary_provider: match dto.ai.primary_provider {
                    ProviderTypeDto::Openai => ProviderType::OpenAI,
                    ProviderTypeDto::Anthropic => ProviderType::Anthropic,
                    ProviderTypeDto::Gemini => ProviderType::Gemini,
                    ProviderTypeDto::Local => ProviderType::Local,
                },
                primary_model: dto.ai.primary_model,
                vision_provider: dto.ai.vision_provider.map(|p| match p {
                    ProviderTypeDto::Openai => ProviderType::OpenAI,
                    ProviderTypeDto::Anthropic => ProviderType::Anthropic,
                    ProviderTypeDto::Gemini => ProviderType::Gemini,
                    ProviderTypeDto::Local => ProviderType::Local,
                }),
                vision_model: dto.ai.vision_model,
                openai_api_key: dto.ai.openai_api_key,
                anthropic_api_key: dto.ai.anthropic_api_key,
                google_api_key: dto.ai.google_api_key,
                ollama_url: dto.ai.ollama_url,
                temperature: dto.ai.temperature,
                max_tokens: dto.ai.max_tokens,
                frame_extraction_rate: dto.ai.frame_extraction_rate,
                monthly_budget_cents: dto.ai.monthly_budget_cents,
                per_request_limit_cents: dto.ai.per_request_limit_cents,
                current_month_usage_cents: dto.ai.current_month_usage_cents,
                current_usage_month: dto.ai.current_usage_month,
                auto_analyze_on_import: dto.ai.auto_analyze_on_import,
                auto_caption_on_import: dto.ai.auto_caption_on_import,
                proposal_review_mode: match dto.ai.proposal_review_mode {
                    ProposalReviewModeDto::Always => ProposalReviewMode::Always,
                    ProposalReviewModeDto::Smart => ProposalReviewMode::Smart,
                    ProposalReviewModeDto::AutoApply => ProposalReviewMode::AutoApply,
                },
                cache_duration_hours: dto.ai.cache_duration_hours,
                local_only_mode: dto.ai.local_only_mode,
                seedance_api_key: dto.ai.seedance_api_key,
                video_gen_provider: dto.ai.video_gen_provider,
                video_gen_default_quality: dto.ai.video_gen_default_quality,
                video_gen_budget_cents: dto.ai.video_gen_budget_cents,
                video_gen_per_request_limit_cents: dto.ai.video_gen_per_request_limit_cents,
            },
        }
    }
}

// =============================================================================
// Credential DTOs
// =============================================================================

/// Status of credentials for each provider
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatusDto {
    pub openai: bool,
    pub anthropic: bool,
    pub google: bool,
    pub seedance: bool,
}

// =============================================================================
// Update DTOs
// =============================================================================

use crate::core::update::{UpdateCheckResult, UpdateStatus};

/// DTO for update status
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusDto {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_notes: Option<String>,
    pub download_url: Option<String>,
    pub release_date: Option<String>,
}

impl From<UpdateStatus> for UpdateStatusDto {
    fn from(s: UpdateStatus) -> Self {
        Self {
            update_available: s.update_available,
            current_version: s.current_version,
            latest_version: s.latest_version,
            release_notes: s.release_notes,
            download_url: s.download_url,
            release_date: s.release_date,
        }
    }
}

/// DTO for update check result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResultDto {
    pub status: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub message: Option<String>,
}

impl From<UpdateCheckResult> for UpdateCheckResultDto {
    fn from(r: UpdateCheckResult) -> Self {
        match r {
            UpdateCheckResult::Available {
                version,
                notes,
                date,
            } => Self {
                status: "available".to_string(),
                version: Some(version),
                notes,
                date,
                message: None,
            },
            UpdateCheckResult::UpToDate { version } => Self {
                status: "upToDate".to_string(),
                version: Some(version),
                notes: None,
                date: None,
                message: None,
            },
            UpdateCheckResult::Error { message } => Self {
                status: "error".to_string(),
                version: None,
                notes: None,
                date: None,
                message: Some(message),
            },
        }
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

fn validate_non_negative_f64(field_name: &str, value: f64) -> Result<f64, String> {
    if !value.is_finite() {
        return Err(format!("{field_name} must be a finite number"));
    }
    if value < 0.0 {
        return Err(format!("{field_name} must be non-negative"));
    }
    Ok(value)
}

fn validate_optional_non_negative_f64(
    field_name: &str,
    value: Option<f64>,
) -> Result<Option<f64>, String> {
    match value {
        Some(v) => Ok(Some(validate_non_negative_f64(field_name, v)?)),
        None => Ok(None),
    }
}

fn normalize_optional_tag(
    value: Option<String>,
    field_name: &str,
    max_len: usize,
) -> Result<Option<String>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if trimmed.chars().any(|c| c.is_control()) {
        return Err(format!("{field_name} contains control characters"));
    }

    if trimmed.len() > max_len {
        return Err(format!(
            "{field_name} is too long (max {max_len} characters)"
        ));
    }

    Ok(Some(trimmed.to_string()))
}

/// Gets the app data directory for settings storage
pub(crate) fn get_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))
}

/// Deep merge JSON objects (used for partial settings updates)
fn merge_json(base: &mut serde_json::Value, patch: serde_json::Value) {
    use serde_json::Value;
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                let base_value = base_map.entry(key).or_insert(Value::Null);
                merge_json(base_value, patch_value);
            }
        }
        (base, patch) => {
            *base = patch;
        }
    }
}

// =============================================================================
// App Lifecycle Commands
// =============================================================================

/// Performs best-effort cleanup when the user closes the window.
///
/// This command is intentionally resilient: failures should never prevent the app from exiting.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(_state))]
pub async fn app_cleanup(_state: State<'_, AppState>) -> Result<AppCleanupResult, String> {
    tracing::info!("App cleanup requested");

    // Currently the frontend handles prompting/saving unsaved projects.
    // Background workers are spawned as async tasks and will stop when the process exits.
    Ok(AppCleanupResult {
        project_saved: false,
        workers_shutdown: true,
        error: None,
    })
}

/// Updates the backend runtime playhead position for cross-layer synchronization.
///
/// Notes:
/// - Runtime-only state (not persisted in project files)
/// - Input is strictly validated and clamped to known duration
/// - Emits `playback:changed` for interested listeners
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app), fields(position_sec = payload.position_sec))]
pub async fn set_playhead_position(
    payload: SetPlayheadPositionPayload,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<PlayheadSyncStateDto, String> {
    use tauri::Emitter;

    let mut position_sec = validate_non_negative_f64("positionSec", payload.position_sec)?;
    let duration_sec = validate_optional_non_negative_f64("durationSec", payload.duration_sec)?;
    let sequence_id = normalize_optional_tag(payload.sequence_id, "sequenceId", 128)?;
    let source = normalize_optional_tag(payload.source, "source", 64)?;
    let is_playing = payload.is_playing.unwrap_or(false);

    // Clamp to known duration for deterministic backend state.
    if let Some(duration) = duration_sec {
        position_sec = position_sec.min(duration);
    }

    let dto = {
        let mut playback_sync = state.playback_sync.lock().await;
        playback_sync.position_sec = position_sec;
        playback_sync.sequence_id = sequence_id;
        playback_sync.last_source = source;
        playback_sync.is_playing = is_playing;
        playback_sync.duration_sec = duration_sec;
        playback_sync.updated_at = chrono::Utc::now().to_rfc3339();
        PlayheadSyncStateDto::from_runtime(&playback_sync)
    };

    if let Err(error) = app.emit(crate::ipc::event_names::PLAYBACK_CHANGED, &dto) {
        tracing::warn!("Failed to emit playback:changed event: {}", error);
    }

    Ok(dto)
}

/// Reads the latest backend runtime playhead position.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn get_playhead_position(
    state: State<'_, AppState>,
) -> Result<PlayheadSyncStateDto, String> {
    let playback_sync = state.playback_sync.lock().await;
    Ok(PlayheadSyncStateDto::from_runtime(&playback_sync))
}

// =============================================================================
// Settings Commands
// =============================================================================

/// Gets application settings
#[tauri::command]
#[specta::specta]
pub async fn get_settings(app: tauri::AppHandle) -> Result<AppSettingsDto, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);
    let settings = manager.load();
    Ok(settings.into())
}

/// Saves application settings
#[tauri::command]
#[specta::specta]
pub async fn set_settings(app: tauri::AppHandle, settings: AppSettingsDto) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);
    let app_settings: AppSettings = settings.into();
    manager.save(&app_settings).map(|_| ())
}

/// Updates a partial section of settings (merge with existing)
#[tauri::command]
#[specta::specta]
pub async fn update_settings(
    app: tauri::AppHandle,
    partial: serde_json::Value,
) -> Result<AppSettingsDto, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);

    // Load current settings
    let current = manager.load();
    let mut current_json = serde_json::to_value(&current)
        .map_err(|e| format!("Failed to serialize current settings: {}", e))?;

    // Deep merge the partial update
    merge_json(&mut current_json, partial);

    // Deserialize back to AppSettings
    let updated: AppSettings = serde_json::from_value(current_json)
        .map_err(|e| format!("Failed to apply settings update: {}", e))?;

    // Save and return
    let saved = manager.save(&updated)?;
    Ok(saved.into())
}

/// Resets settings to defaults
#[tauri::command]
#[specta::specta]
pub async fn reset_settings(app: tauri::AppHandle) -> Result<AppSettingsDto, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);
    let settings = manager.reset()?;
    Ok(settings.into())
}

// =============================================================================
// Credential Commands (Secure API Key Storage)
// =============================================================================

use crate::core::credentials::{CredentialType, CredentialVault};

/// Stores an API key securely in the encrypted vault
///
/// The API key is encrypted at rest using XChaCha20-Poly1305 and stored
/// in a secure vault file. Keys are never stored in plaintext.
#[tauri::command]
#[specta::specta]
pub async fn store_credential(
    app: tauri::AppHandle,
    provider: String,
    api_key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let vault_path = app_data_dir.join("credentials.vault");

    // Lazily initialize and then reuse the in-memory vault instance.
    // This avoids expensive key derivation and prevents file-level races.
    let mut guard = state.credential_vault.lock().await;
    if guard.is_none() {
        *guard = Some(
            CredentialVault::new(vault_path)
                .map_err(|e| format!("Failed to initialize credential vault: {}", e))?,
        );
    }
    let vault = guard
        .as_ref()
        .ok_or_else(|| "Credential vault unavailable".to_string())?;

    let credential_type: CredentialType = provider
        .parse()
        .map_err(|e: crate::core::credentials::CredentialError| e.to_string())?;

    vault
        .store(credential_type, &api_key)
        .await
        .map_err(|e| format!("Failed to store credential: {}", e))?;

    tracing::info!("Stored credential for provider: {}", provider);

    Ok(())
}

/// Checks if a credential exists in the vault (without retrieving it)
#[tauri::command]
#[specta::specta]
pub async fn has_credential(app: tauri::AppHandle, provider: String) -> Result<bool, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let vault_path = app_data_dir.join("credentials.vault");

    if !vault_path.exists() {
        return Ok(false);
    }

    let state = app.state::<AppState>();
    let mut guard = state.credential_vault.lock().await;
    if guard.is_none() {
        *guard = Some(
            CredentialVault::new(vault_path)
                .map_err(|e| format!("Failed to initialize credential vault: {}", e))?,
        );
    }
    let vault = guard
        .as_ref()
        .ok_or_else(|| "Credential vault unavailable".to_string())?;

    let credential_type: CredentialType = provider
        .parse()
        .map_err(|e: crate::core::credentials::CredentialError| e.to_string())?;

    Ok(vault.exists(credential_type).await)
}

/// Deletes a credential from the vault
#[tauri::command]
#[specta::specta]
pub async fn delete_credential(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let vault_path = app_data_dir.join("credentials.vault");

    if !vault_path.exists() {
        return Ok(());
    }

    let state = app.state::<AppState>();
    let mut guard = state.credential_vault.lock().await;
    if guard.is_none() {
        *guard = Some(
            CredentialVault::new(vault_path)
                .map_err(|e| format!("Failed to initialize credential vault: {}", e))?,
        );
    }
    let vault = guard
        .as_ref()
        .ok_or_else(|| "Credential vault unavailable".to_string())?;

    let credential_type: CredentialType = provider
        .parse()
        .map_err(|e: crate::core::credentials::CredentialError| e.to_string())?;

    vault
        .delete(credential_type)
        .await
        .map_err(|e| format!("Failed to delete credential: {}", e))?;

    tracing::info!("Deleted credential for provider: {}", provider);

    Ok(())
}

/// Gets the status of all credentials (which ones are configured)
#[tauri::command]
#[specta::specta]
pub async fn get_credential_status(app: tauri::AppHandle) -> Result<CredentialStatusDto, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let vault_path = app_data_dir.join("credentials.vault");

    if !vault_path.exists() {
        return Ok(CredentialStatusDto {
            openai: false,
            anthropic: false,
            google: false,
            seedance: false,
        });
    }

    let state = app.state::<AppState>();
    let mut guard = state.credential_vault.lock().await;
    if guard.is_none() {
        *guard = Some(
            CredentialVault::new(vault_path)
                .map_err(|e| format!("Failed to initialize credential vault: {}", e))?,
        );
    }
    let vault = guard
        .as_ref()
        .ok_or_else(|| "Credential vault unavailable".to_string())?;

    Ok(CredentialStatusDto {
        openai: vault.exists(CredentialType::OpenaiApiKey).await,
        anthropic: vault.exists(CredentialType::AnthropicApiKey).await,
        google: vault.exists(CredentialType::GoogleApiKey).await,
        seedance: vault.exists(CredentialType::SeedanceApiKey).await,
    })
}

// =============================================================================
// Update Commands
// =============================================================================

/// Checks for available updates
#[tauri::command]
#[specta::specta]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateCheckResultDto, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater()
        .map_err(|e| format!("Updater not available: {}", e))?;

    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateCheckResult::Available {
            version: update.version.clone(),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }
        .into()),
        Ok(None) => Ok(UpdateCheckResult::UpToDate {
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
        .into()),
        Err(e) => Ok(UpdateCheckResult::Error {
            message: e.to_string(),
        }
        .into()),
    }
}

/// Gets current app version
#[tauri::command]
#[specta::specta]
pub fn get_current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Relaunches the application.
///
/// This is intentionally implemented on the Rust side to avoid depending on a
/// separate process plugin on the frontend.
#[tauri::command]
#[specta::specta]
pub fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

/// Downloads and installs an update
/// Returns true if restart is needed
#[tauri::command]
#[specta::specta]
pub async fn download_and_install_update(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater()
        .map_err(|e| format!("Updater not available: {}", e))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {}", e))?
        .ok_or_else(|| "No update available".to_string())?;

    // Download the update
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            |chunk_len, content_length| {
                downloaded += chunk_len as u64;
                tracing::debug!("Downloaded {} of {:?} bytes", downloaded, content_length);
            },
            || {
                tracing::info!("Download complete, verifying...");
            },
        )
        .await
        .map_err(|e| format!("Failed to download update: {}", e))?;

    // Install the update
    update
        .install(bytes)
        .map_err(|e| format!("Failed to install update: {}", e))?;

    tracing::info!("Update installed successfully, restart required");
    Ok(true)
}

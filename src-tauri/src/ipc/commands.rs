//! Tauri IPC Commands
//!
//! Defines all commands exposed to the frontend via Tauri's invoke system.
//! All types are exported to TypeScript via tauri-specta for type-safe API calls.

use std::path::PathBuf;

use specta::Type;
use tauri::State;

use crate::core::{
    commands::{
        CreateSequenceCommand, ImportAssetCommand, InsertClipCommand, MoveClipCommand,
        RemoveAssetCommand, RemoveClipCommand, SplitClipCommand, TrimClipCommand,
        UpdateAssetCommand,
    },
    ffmpeg::FFmpegProgress,
    jobs::{Job, JobStatus, JobType, Priority},
    performance::memory::{CacheStats, PoolStats},
    CoreError,
};
use crate::{ActiveProject, AppState};

// =============================================================================
// Project Commands
// =============================================================================

/// Creates a new project
#[tauri::command]
pub async fn create_project(
    name: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectInfo, String> {
    let project_path = PathBuf::from(&path);

    let project =
        ActiveProject::create(&name, project_path.clone()).map_err(|e| e.to_ipc_error())?;

    let info = ProjectInfo {
        id: project.state.meta.id.clone(),
        name: project.state.meta.name.clone(),
        path: path.clone(),
        created_at: project.state.meta.created_at.clone(),
    };

    // Store in app state
    let mut guard = state.project.lock().await;
    *guard = Some(project);

    Ok(info)
}

/// Opens an existing project
#[tauri::command]
pub async fn open_project(path: String, state: State<'_, AppState>) -> Result<ProjectInfo, String> {
    let project_path = PathBuf::from(&path);

    if !project_path.exists() {
        return Err(CoreError::ProjectNotFound(path).to_ipc_error());
    }

    let project = ActiveProject::open(project_path).map_err(|e| e.to_ipc_error())?;

    let info = ProjectInfo {
        id: project.state.meta.id.clone(),
        name: project.state.meta.name.clone(),
        path: path.clone(),
        created_at: project.state.meta.created_at.clone(),
    };

    // Store in app state
    let mut guard = state.project.lock().await;
    *guard = Some(project);

    Ok(info)
}

/// Saves the current project
#[tauri::command]
pub async fn save_project(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    project.save().map_err(|e| e.to_ipc_error())
}

/// Gets current project info
#[tauri::command]
pub async fn get_project_info(state: State<'_, AppState>) -> Result<Option<ProjectInfo>, String> {
    let guard = state.project.lock().await;

    Ok(guard.as_ref().map(|p| ProjectInfo {
        id: p.state.meta.id.clone(),
        name: p.state.meta.name.clone(),
        path: p.path.to_string_lossy().to_string(),
        created_at: p.state.meta.created_at.clone(),
    }))
}

/// Gets the full project state for frontend sync
#[tauri::command]
pub async fn get_project_state(state: State<'_, AppState>) -> Result<ProjectStateDto, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    Ok(ProjectStateDto {
        meta: ProjectMetaDto {
            name: project.state.meta.name.clone(),
            version: project.state.meta.version.clone(),
            created_at: project.state.meta.created_at.clone(),
            modified_at: project.state.meta.modified_at.clone(),
            description: project.state.meta.description.clone(),
            author: project.state.meta.author.clone(),
        },
        assets: project.state.assets.values().cloned().collect(),
        sequences: project.state.sequences.values().cloned().collect(),
        active_sequence_id: project.state.active_sequence_id.clone(),
        is_dirty: project.state.is_dirty,
    })
}

// =============================================================================
// Asset Commands
// =============================================================================

/// Imports an asset into the project
///
/// Automatically queues proxy generation job for video assets > 720p.
/// Returns the job_id if a proxy job was queued.
#[tauri::command]
pub async fn import_asset(
    uri: String,
    state: State<'_, AppState>,
) -> Result<AssetImportResult, String> {
    use crate::core::assets::{requires_proxy, ProxyStatus};
    use std::path::PathBuf;

    fn validate_local_file_path(uri: &str) -> Result<PathBuf, String> {
        let trimmed = uri.trim();
        if trimmed.is_empty() {
            return Err("Asset path is empty".to_string());
        }

        // Prevent accidental remote/URL imports from crossing into ffprobe/ffmpeg calls.
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return Err("Only local file paths are supported for asset import".to_string());
        }

        let path = PathBuf::from(trimmed);
        if !path.is_absolute() {
            return Err(format!("Asset path must be absolute: {}", path.display()));
        }

        let metadata = std::fs::metadata(&path)
            .map_err(|_| format!("Asset file not found: {}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("Asset path is not a file: {}", path.display()));
        }

        Ok(path)
    }

    // Phase 1: Import asset (holds project lock)
    let (asset_id, name, op_id, needs_proxy) = {
        let mut guard = state.project.lock().await;
        let project = guard
            .as_mut()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        // Create import command
        let path = validate_local_file_path(&uri)?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        let command = ImportAssetCommand::new(&name, &uri);
        let asset_id = command.asset_id().to_string();

        // Execute command
        let result = project
            .executor
            .execute(Box::new(command), &mut project.state)
            .map_err(|e| e.to_ipc_error())?;

        // Check if proxy generation is needed
        let needs_proxy = project
            .state
            .assets
            .get(&asset_id)
            .map(|asset| requires_proxy(&asset.kind, asset.video.as_ref()))
            .unwrap_or(false);

        (asset_id, name, result.op_id, needs_proxy)
    }; // project lock released here

    // Phase 2: Queue proxy job if needed (separate lock scope)
    let job_id = if needs_proxy {
        let proxy_job = Job::new(
            JobType::ProxyGeneration,
            serde_json::json!({
                "assetId": asset_id,
                "inputPath": uri,
            }),
        )
        .with_priority(Priority::Normal);

        let submitted_job_id = proxy_job.id.clone();

        // Submit to worker pool (holds job_pool lock briefly)
        let submit_result = {
            let pool = state.job_pool.lock().await;
            pool.submit(proxy_job)
        };

        match submit_result {
            Ok(_) => {
                tracing::info!(
                    "Queued proxy generation job for asset {} ({})",
                    asset_id,
                    name
                );

                // Phase 3: Update asset status (re-acquire project lock briefly)
                {
                    let mut guard = state.project.lock().await;
                    if let Some(project) = guard.as_mut() {
                        let cmd = UpdateAssetCommand::new(&asset_id)
                            .with_proxy_status(ProxyStatus::Pending);
                        if let Err(e) = project
                            .executor
                            .execute_without_history(Box::new(cmd), &mut project.state)
                        {
                            tracing::warn!(
                                "Failed to persist asset {} proxy status update: {}",
                                asset_id,
                                e
                            );
                        }
                    }
                }

                Some(submitted_job_id)
            }
            Err(e) => {
                tracing::warn!("Failed to queue proxy job for asset {}: {}", asset_id, e);
                None
            }
        }
    } else {
        None
    };

    Ok(AssetImportResult {
        asset_id,
        name,
        op_id,
        job_id,
    })
}

/// Gets all assets in the project
#[tauri::command]
pub async fn get_assets(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    Ok(project
        .state
        .assets
        .values()
        .filter_map(|a| serde_json::to_value(a).ok())
        .collect())
}

/// Generates thumbnail for an asset and updates the asset's thumbnail URL
#[tauri::command]
pub async fn generate_asset_thumbnail(
    asset_id: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
) -> Result<Option<String>, String> {
    use crate::core::assets::thumbnail::{asset_kind_from_path, ThumbnailService};
    use std::path::Path;

    // Get asset info from state
    let (asset_path, asset_kind, project_path) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        let path = Path::new(&asset.uri);
        let kind = asset_kind_from_path(path);

        (asset.uri.clone(), kind, project.path.clone())
    };

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard
        .runner()
        .ok_or_else(|| "FFmpeg not initialized".to_string())?;

    // Create thumbnail service
    let thumbnail_service = ThumbnailService::new(project_path, ffmpeg.clone());
    let asset_path = Path::new(&asset_path);

    // Generate thumbnail
    let result = thumbnail_service
        .generate_for_asset(&asset_id, asset_path, &asset_kind)
        .await;

    match result {
        Ok(thumb_path) => {
            let thumb_url = thumbnail_service.thumbnail_url(&asset_id);

            // Update asset's thumbnail URL in state
            if let Some(url) = &thumb_url {
                let mut guard = state.project.lock().await;

                if let Some(project) = guard.as_mut() {
                    let cmd = UpdateAssetCommand::new(&asset_id)
                        .with_thumbnail_url(Some(url.to_string()));
                    if let Err(e) = project
                        .executor
                        .execute_without_history(Box::new(cmd), &mut project.state)
                    {
                        tracing::warn!(
                            "Failed to persist thumbnail URL for asset {}: {}",
                            asset_id,
                            e
                        );
                    }
                }
            }

            tracing::info!(
                "Generated thumbnail for asset {}: {:?}",
                asset_id,
                thumb_path
            );
            Ok(thumb_url)
        }
        Err(e) => {
            tracing::warn!("Failed to generate thumbnail for {}: {}", asset_id, e);
            Ok(None)
        }
    }
}

/// Generates a proxy video for an asset for smooth preview playback
#[tauri::command]
pub async fn generate_proxy_for_asset(
    asset_id: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri::Emitter;

    // Get asset info from state
    let (asset_path, project_path) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        (asset.uri.clone(), project.path.clone())
    };

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard
        .runner()
        .ok_or_else(|| "FFmpeg not initialized".to_string())?;

    // Create proxy directory
    let proxy_dir = project_path.join(".openreelio").join("proxy");
    std::fs::create_dir_all(&proxy_dir)
        .map_err(|e| format!("Failed to create proxy directory: {}", e))?;

    // Output path for proxy
    let proxy_path = proxy_dir.join(format!("{}.mp4", asset_id));
    let input_path = std::path::Path::new(&asset_path);

    // Create progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<FFmpegProgress>(100);
    let asset_id_clone = asset_id.clone();
    let app_handle_clone = app_handle.clone();

    // Emit canonical proxy-start event (frontend listens to `asset:proxy-*`).
    // This command is a legacy/manual path (not the job-worker proxy pipeline).
    let _ = app_handle.emit(
        "asset:proxy-generating",
        serde_json::json!({
            "assetId": asset_id.clone(),
            "jobId": "manual-ffmpeg"
        }),
    );

    // Spawn legacy progress forwarding task
    tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            let _ = app_handle_clone.emit(
                "proxy-progress",
                serde_json::json!({
                    "assetId": asset_id_clone,
                    "percent": progress.percent,
                    "frame": progress.frame,
                    "totalFrames": progress.total_frames,
                    "fps": progress.fps,
                    "etaSeconds": progress.eta_seconds,
                }),
            );
        }
    });

    // Generate proxy
    match ffmpeg
        .generate_proxy(input_path, &proxy_path, Some(progress_tx))
        .await
    {
        Ok(()) => {
            let proxy_url = format!("file://{}", proxy_path.display());

            // Update asset's proxy URL in state
            {
                let mut guard = state.project.lock().await;

                if let Some(project) = guard.as_mut() {
                    let cmd = UpdateAssetCommand::new(&asset_id)
                        .with_proxy_status(crate::core::assets::ProxyStatus::Ready)
                        .with_proxy_url(Some(proxy_url.clone()));
                    if let Err(e) = project
                        .executor
                        .execute_without_history(Box::new(cmd), &mut project.state)
                    {
                        tracing::warn!("Failed to persist proxy URL for asset {}: {}", asset_id, e);
                    }
                }
            }

            tracing::info!("Generated proxy for asset {}: {:?}", asset_id, proxy_path);

            // Emit canonical completion event
            let _ = app_handle.emit(
                "asset:proxy-ready",
                serde_json::json!({
                    "assetId": asset_id.clone(),
                    "proxyPath": proxy_path.display().to_string(),
                    "proxyUrl": proxy_url,
                }),
            );

            // Emit legacy completion event
            let _ = app_handle.emit(
                "proxy-complete",
                serde_json::json!({
                    "assetId": asset_id.clone(),
                    "proxyUrl": proxy_url,
                }),
            );

            Ok(Some(proxy_url))
        }
        Err(e) => {
            tracing::warn!("Failed to generate proxy for {}: {}", asset_id, e);

            // Emit canonical error event
            let _ = app_handle.emit(
                "asset:proxy-failed",
                serde_json::json!({
                    "assetId": asset_id.clone(),
                    "error": e.to_string(),
                }),
            );

            // Emit legacy error event
            let _ = app_handle.emit(
                "proxy-error",
                serde_json::json!({
                    "assetId": asset_id.clone(),
                    "error": e.to_string(),
                }),
            );

            Err(format!("Proxy generation failed: {}", e))
        }
    }
}

/// Updates the proxy status and URL for an asset
///
/// Called by the frontend when receiving `asset:proxy-ready` or `asset:proxy-failed` events.
#[tauri::command]
pub async fn update_asset_proxy(
    asset_id: String,
    proxy_url: Option<String>,
    proxy_status: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::core::assets::ProxyStatus;

    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    // Parse the proxy status string
    let status = match proxy_status.as_str() {
        "notNeeded" => ProxyStatus::NotNeeded,
        "pending" => ProxyStatus::Pending,
        "generating" => ProxyStatus::Generating,
        "ready" => ProxyStatus::Ready,
        "failed" => ProxyStatus::Failed,
        _ => return Err(format!("Invalid proxy status: {}", proxy_status)),
    };

    let mut cmd = UpdateAssetCommand::new(&asset_id).with_proxy_status(status);
    if let Some(url) = proxy_url {
        cmd = cmd.with_proxy_url(Some(url));
    }

    project
        .executor
        .execute_without_history(Box::new(cmd), &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    tracing::info!(
        "Updated asset {} proxy status to {}",
        asset_id,
        proxy_status
    );

    Ok(())
}

/// Gets waveform peak data for an asset.
///
/// Returns normalized peak values (0.0 - 1.0) for audio visualization.
/// Returns None if waveform has not been generated yet.
#[tauri::command]
pub async fn get_waveform_data(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Option<crate::core::ffmpeg::WaveformData>, String> {
    // Get project path
    let project_path = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        project.path.clone()
    };

    // Check cache directory for waveform JSON
    let waveform_path = project_path
        .join(".openreelio")
        .join("cache")
        .join("waveforms")
        .join(format!("{}.json", asset_id));

    if !waveform_path.exists() {
        return Ok(None);
    }

    // Read and parse waveform JSON
    let json = tokio::fs::read_to_string(&waveform_path)
        .await
        .map_err(|e| format!("Failed to read waveform file: {}", e))?;

    let waveform: crate::core::ffmpeg::WaveformData =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse waveform JSON: {}", e))?;

    Ok(Some(waveform))
}

/// Generates waveform peak data for an asset.
///
/// Extracts audio peaks from the asset and saves as JSON.
/// Emits `waveform-complete` event on success, `waveform-error` on failure.
#[tauri::command]
pub async fn generate_waveform_for_asset(
    asset_id: String,
    samples_per_second: Option<u32>,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<Option<crate::core::ffmpeg::WaveformData>, String> {
    use tauri::Emitter;

    // Get asset info from state
    let (asset_path, project_path) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        (asset.uri.clone(), project.path.clone())
    };

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard
        .runner()
        .ok_or_else(|| "FFmpeg not initialized".to_string())?;

    // Create waveform cache directory
    let cache_dir = project_path
        .join(".openreelio")
        .join("cache")
        .join("waveforms");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create waveform cache directory: {}", e))?;

    // Output path for waveform JSON
    let waveform_path = cache_dir.join(format!("{}.json", asset_id));
    let input_path = std::path::Path::new(&asset_path);
    let sps = samples_per_second.unwrap_or(100);

    // Emit generating event
    let _ = app_handle.emit(
        "waveform-generating",
        serde_json::json!({
            "assetId": asset_id,
        }),
    );

    // Generate waveform
    match ffmpeg
        .generate_waveform_json(input_path, &waveform_path, sps)
        .await
    {
        Ok(waveform) => {
            tracing::info!(
                "Generated waveform for asset {}: {:?}",
                asset_id,
                waveform_path
            );

            // Emit completion event
            let _ = app_handle.emit(
                "waveform-complete",
                serde_json::json!({
                    "assetId": asset_id,
                    "samplesPerSecond": waveform.samples_per_second,
                    "peakCount": waveform.peaks.len(),
                    "durationSec": waveform.duration_sec,
                }),
            );

            Ok(Some(waveform))
        }
        Err(e) => {
            tracing::warn!("Failed to generate waveform for {}: {}", asset_id, e);

            // Emit error event
            let _ = app_handle.emit(
                "waveform-error",
                serde_json::json!({
                    "assetId": asset_id,
                    "error": e.to_string(),
                }),
            );

            Err(format!("Waveform generation failed: {}", e))
        }
    }
}

/// Removes an asset from the project
#[tauri::command]
pub async fn remove_asset(asset_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let command = RemoveAssetCommand::new(&asset_id);
    project
        .executor
        .execute(Box::new(command), &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    Ok(())
}

// =============================================================================
// Timeline Commands
// =============================================================================

/// Gets all sequences in the project
#[tauri::command]
pub async fn get_sequences(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    Ok(project
        .state
        .sequences
        .values()
        .filter_map(|s| serde_json::to_value(s).ok())
        .collect())
}

/// Creates a new sequence
#[tauri::command]
pub async fn create_sequence(
    name: String,
    format: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    // Use CreateSequenceCommand for proper undo/redo support and ops logging
    let command = CreateSequenceCommand::new(&name, &format);

    let result = project
        .executor
        .execute(Box::new(command), &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    // Get the created sequence to return
    let seq_id = result.created_ids.first().ok_or("No sequence created")?;
    let sequence = project
        .state
        .sequences
        .get(seq_id)
        .ok_or("Sequence not found after creation")?;

    serde_json::to_value(sequence).map_err(|e| e.to_string())
}

/// Gets a specific sequence by ID
#[tauri::command]
pub async fn get_sequence(
    sequence_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| CoreError::SequenceNotFound(sequence_id).to_ipc_error())?;

    serde_json::to_value(sequence).map_err(|e| e.to_string())
}

// =============================================================================
// Edit Commands
// =============================================================================

use crate::ipc::payloads::CommandPayload;

/// Executes an edit command
#[tauri::command]
pub async fn execute_command(
    command_type: String,
    payload: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<CommandResultDto, String> {
    let started_at = std::time::Instant::now();
    let command_type_for_log = command_type.clone();
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    // Strict validation via CommandPayload::parse
    let typed_command = CommandPayload::parse(command_type, payload)?;

    // Map strict CommandPayload to the internal Command trait objects
    let command: Box<dyn crate::core::commands::Command> = match typed_command {
        CommandPayload::InsertClip(p) => Box::new(InsertClipCommand::new(
            &p.sequence_id,
            &p.track_id,
            &p.asset_id,
            p.timeline_start,
        )),
        CommandPayload::RemoveClip(p) => Box::new(RemoveClipCommand::new(
            &p.sequence_id,
            &p.track_id,
            &p.clip_id,
        )),
        CommandPayload::MoveClip(p) => Box::new(MoveClipCommand::new(
            &p.sequence_id,
            &p.track_id,
            &p.clip_id,
            p.new_timeline_in,
            p.new_track_id,
        )),
        CommandPayload::TrimClip(p) => Box::new(TrimClipCommand::new(
            &p.sequence_id,
            &p.track_id,
            &p.clip_id,
            p.new_source_in,
            p.new_source_out,
            p.new_timeline_in,
        )),
        CommandPayload::ImportAsset(p) => Box::new(ImportAssetCommand::new(&p.name, &p.uri)),
        CommandPayload::RemoveAsset(p) => Box::new(RemoveAssetCommand::new(&p.asset_id)),
        CommandPayload::CreateSequence(p) => Box::new(CreateSequenceCommand::new(
            &p.name,
            &p.format.unwrap_or_else(|| "1080p".to_string()),
        )),
        CommandPayload::SplitClip(p) => Box::new(SplitClipCommand::new(
            &p.sequence_id,
            &p.track_id,
            &p.clip_id,
            p.split_time,
        )),
        CommandPayload::UpdateCaption(p) => Box::new(
            crate::core::commands::UpdateCaptionCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.caption_id,
            )
            .with_text(p.text)
            .with_time_range(p.start_sec, p.end_sec),
        ),
    };

    let result = project
        .executor
        .execute(command, &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    tracing::debug!(
        command_type = %command_type_for_log,
        op_id = %result.op_id,
        elapsed_ms = started_at.elapsed().as_millis(),
        "execute_command completed"
    );

    Ok(CommandResultDto {
        op_id: result.op_id,
        created_ids: result.created_ids,
        deleted_ids: result.deleted_ids,
    })
}

/// Undoes the last command
#[tauri::command]
pub async fn undo(state: State<'_, AppState>) -> Result<UndoRedoResult, String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    project
        .executor
        .undo(&mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    Ok(UndoRedoResult {
        success: true,
        can_undo: project.executor.can_undo(),
        can_redo: project.executor.can_redo(),
    })
}

/// Redoes the last undone command
#[tauri::command]
pub async fn redo(state: State<'_, AppState>) -> Result<UndoRedoResult, String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    project
        .executor
        .redo(&mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    Ok(UndoRedoResult {
        success: true,
        can_undo: project.executor.can_undo(),
        can_redo: project.executor.can_redo(),
    })
}

/// Checks if undo is available
#[tauri::command]
pub async fn can_undo(state: State<'_, AppState>) -> Result<bool, String> {
    let guard = state.project.lock().await;

    Ok(guard
        .as_ref()
        .map(|p| p.executor.can_undo())
        .unwrap_or(false))
}

/// Checks if redo is available
#[tauri::command]
pub async fn can_redo(state: State<'_, AppState>) -> Result<bool, String> {
    let guard = state.project.lock().await;

    Ok(guard
        .as_ref()
        .map(|p| p.executor.can_redo())
        .unwrap_or(false))
}

// =============================================================================
// Job Commands
// =============================================================================

/// Background job information.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobInfoDto {
    /// Unique job ID
    pub id: String,
    /// Job type (e.g., "proxy_generation", "transcription")
    pub job_type: String,
    /// Priority level ("background", "normal", "preview", "user_request")
    pub priority: String,
    /// Current job status
    pub status: JobStatusDto,
    /// ISO 8601 creation timestamp
    pub created_at: String,
    /// ISO 8601 completion timestamp (if completed)
    pub completed_at: Option<String>,
}

/// Job execution status.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum JobStatusDto {
    /// Job is waiting in queue
    Queued,
    /// Job is currently executing
    Running {
        /// Progress percentage (0.0 - 1.0)
        progress: f32,
        /// Optional status message
        message: Option<String>,
    },
    /// Job completed successfully
    Completed {
        /// Result data
        result: serde_json::Value,
    },
    /// Job failed with error
    Failed {
        /// Error message
        error: String,
    },
    /// Job was cancelled by user
    Cancelled,
}

impl From<&Job> for JobInfoDto {
    fn from(job: &Job) -> Self {
        let job_type = match job.job_type {
            JobType::ProxyGeneration => "proxy_generation",
            JobType::ThumbnailGeneration => "thumbnail_generation",
            JobType::WaveformGeneration => "waveform_generation",
            JobType::Indexing => "indexing",
            JobType::Transcription => "transcription",
            JobType::PreviewRender => "preview_render",
            JobType::FinalRender => "final_render",
            JobType::AICompletion => "ai_completion",
        };

        let priority = match job.priority {
            Priority::Background => "background",
            Priority::Normal => "normal",
            Priority::Preview => "preview",
            Priority::UserRequest => "user_request",
        };

        let status = match &job.status {
            JobStatus::Queued => JobStatusDto::Queued,
            JobStatus::Running { progress, message } => JobStatusDto::Running {
                progress: *progress,
                message: message.clone(),
            },
            JobStatus::Completed { result } => JobStatusDto::Completed {
                result: result.clone(),
            },
            JobStatus::Failed { error } => JobStatusDto::Failed {
                error: error.clone(),
            },
            JobStatus::Cancelled => JobStatusDto::Cancelled,
        };

        Self {
            id: job.id.clone(),
            job_type: job_type.to_string(),
            priority: priority.to_string(),
            status,
            created_at: job.created_at.clone(),
            completed_at: job.completed_at.clone(),
        }
    }
}

/// Gets all jobs from the worker pool (both active and queued)
#[tauri::command]
pub async fn get_jobs(state: State<'_, AppState>) -> Result<Vec<JobInfoDto>, String> {
    let pool = state.job_pool.lock().await;

    // Get all jobs (active + queued)
    let all_jobs: Vec<JobInfoDto> = pool.all_jobs().iter().map(JobInfoDto::from).collect();

    tracing::debug!(
        "get_jobs: {} total ({} active, {} queued)",
        all_jobs.len(),
        pool.active_jobs().len(),
        pool.queue_len()
    );

    Ok(all_jobs)
}

/// Submits a new job to the worker pool
#[tauri::command]
pub async fn submit_job(
    job_type: String,
    priority: Option<String>,
    payload: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let job_type_enum = match job_type.as_str() {
        "proxy_generation" => JobType::ProxyGeneration,
        "thumbnail_generation" => JobType::ThumbnailGeneration,
        "waveform_generation" => JobType::WaveformGeneration,
        "indexing" => JobType::Indexing,
        "transcription" => JobType::Transcription,
        "preview_render" => JobType::PreviewRender,
        "final_render" => JobType::FinalRender,
        "ai_completion" => JobType::AICompletion,
        _ => return Err(format!("Unknown job type: {}", job_type)),
    };

    let priority_enum = match priority.as_deref() {
        Some("background") => Priority::Background,
        Some("normal") | None => Priority::Normal,
        Some("preview") => Priority::Preview,
        Some("user_request") => Priority::UserRequest,
        Some(other) => return Err(format!("Unknown priority: {}", other)),
    };

    let job = Job::new(job_type_enum, payload).with_priority(priority_enum);

    let pool = state.job_pool.lock().await;

    let job_id = pool.submit(job).map_err(|e| e.to_string())?;

    tracing::info!("Submitted job: {} (type: {})", job_id, job_type);

    Ok(job_id)
}

/// Gets a specific job by ID
#[tauri::command]
pub async fn get_job(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<Option<JobInfoDto>, String> {
    let pool = state.job_pool.lock().await;

    Ok(pool.get_job(&job_id).as_ref().map(JobInfoDto::from))
}

/// Cancels a job by ID
#[tauri::command]
pub async fn cancel_job(job_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let pool = state.job_pool.lock().await;

    let cancelled = pool.cancel(&job_id);

    if cancelled {
        tracing::info!("Cancelled job: {}", job_id);
    } else {
        tracing::debug!("Job not found or already completed: {}", job_id);
    }

    Ok(cancelled)
}

/// Gets the current queue statistics
#[tauri::command]
pub async fn get_job_stats(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let pool = state.job_pool.lock().await;

    let active_jobs = pool.active_jobs();
    let running_count = active_jobs.iter().filter(|j| j.is_running()).count();
    let pending_count = pool.queue_len();

    Ok(serde_json::json!({
        "queueLength": pending_count,
        "activeCount": active_jobs.len(),
        "runningCount": running_count,
        "numWorkers": pool.num_workers(),
    }))
}

// =============================================================================
// Render Commands
// =============================================================================

/// Starts final render export
///
/// This command validates the export settings before starting the render,
/// and reports real-time progress via Tauri events.
#[tauri::command]
pub async fn start_render(
    sequence_id: String,
    output_path: String,
    preset: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<RenderStartResult, String> {
    use crate::core::render::{
        validate_export_settings, ExportEngine, ExportPreset, ExportProgress, ExportSettings,
    };
    use std::path::PathBuf;
    use tauri::Emitter;

    // Get sequence and assets from project state
    let (sequence, assets) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?
            .clone();

        let assets: std::collections::HashMap<String, crate::core::assets::Asset> = project
            .state
            .assets
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        (sequence, assets)
    };

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    // Parse preset
    let export_preset = match preset.to_lowercase().as_str() {
        "youtube_1080p" | "youtube1080p" => ExportPreset::Youtube1080p,
        "youtube_4k" | "youtube4k" => ExportPreset::Youtube4k,
        "youtube_shorts" | "youtubeshorts" => ExportPreset::YoutubeShorts,
        "twitter" => ExportPreset::Twitter,
        "instagram" => ExportPreset::Instagram,
        "webm" | "webm_vp9" => ExportPreset::WebmVp9,
        "prores" => ExportPreset::ProRes,
        _ => ExportPreset::Youtube1080p, // Default
    };

    // Create export settings
    let settings = ExportSettings::from_preset(export_preset, PathBuf::from(&output_path));

    // Validate export settings before starting
    let validation = validate_export_settings(&sequence, &assets, &settings);
    if !validation.is_valid {
        let error_msg = validation.errors.join("; ");
        return Err(format!("Export validation failed: {}", error_msg));
    }

    // Log warnings but continue
    for warning in &validation.warnings {
        tracing::warn!("Export warning: {}", warning);
    }

    // Create export engine
    let engine = ExportEngine::new(ffmpeg.clone());
    let job_id = ulid::Ulid::new().to_string();
    let job_id_clone = job_id.clone();
    let job_id_for_error = job_id.clone();

    // Create progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<ExportProgress>(100);
    let app_handle_clone = app_handle.clone();

    // Spawn progress forwarding task
    tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            let _ = app_handle_clone.emit(
                "render-progress",
                serde_json::json!({
                    "jobId": job_id_clone,
                    "frame": progress.frame,
                    "totalFrames": progress.total_frames,
                    "percent": progress.percent,
                    "fps": progress.fps,
                    "etaSeconds": progress.eta_seconds,
                    "message": progress.message,
                }),
            );
        }
    });

    // Spawn export task in background to not block IPC
    let sequence_clone = sequence.clone();
    let assets_clone = assets.clone();
    let settings_clone = settings.clone();
    let app_handle_for_task = app_handle.clone();
    let job_id_for_task = job_id.clone();

    tokio::spawn(async move {
        match engine
            .export_sequence(
                &sequence_clone,
                &assets_clone,
                &settings_clone,
                Some(progress_tx),
            )
            .await
        {
            Ok(result) => {
                tracing::info!(
                    "Export completed: {} ({:.1}s, {} bytes)",
                    result.output_path.display(),
                    result.encoding_time_sec,
                    result.file_size
                );

                // Emit completion event
                let _ = app_handle_for_task.emit(
                    "render-complete",
                    serde_json::json!({
                        "jobId": job_id_for_task,
                        "outputPath": result.output_path.to_string_lossy().to_string(),
                        "durationSec": result.duration_sec,
                        "fileSize": result.file_size,
                        "encodingTimeSec": result.encoding_time_sec,
                    }),
                );
            }
            Err(e) => {
                tracing::error!("Export failed: {}", e);

                // Emit error event
                let _ = app_handle_for_task.emit(
                    "render-error",
                    serde_json::json!({
                        "jobId": job_id_for_task,
                        "error": e.to_string(),
                    }),
                );
            }
        }
    });

    // Return immediately with job ID - completion will be via events
    Ok(RenderStartResult {
        job_id: job_id_for_error,
        output_path,
        status: "started".to_string(),
    })
}

// =============================================================================
// AI Commands
// =============================================================================

/// Analyzes user intent and generates an EditScript
#[tauri::command]
pub async fn analyze_intent(
    intent: String,
    context: AIContextDto,
    state: State<'_, AppState>,
) -> Result<EditScriptDto, String> {
    #[allow(unused_imports)]
    use crate::core::ai::{EditCommand, EditScript};

    // Validate input
    if intent.trim().is_empty() {
        return Err("Intent cannot be empty".to_string());
    }

    // Get project state for context enrichment
    let (asset_ids, track_ids, timeline_duration) = {
        let guard = state.project.lock().await;

        if let Some(project) = guard.as_ref() {
            let asset_ids: Vec<String> = project.state.assets.keys().cloned().collect();
            let (track_ids, duration) = if let Some(seq_id) = &project.state.active_sequence_id {
                if let Some(seq) = project.state.sequences.get(seq_id) {
                    let tracks: Vec<String> = seq.tracks.iter().map(|t| t.id.clone()).collect();
                    let dur = seq.duration();
                    (tracks, dur)
                } else {
                    (vec![], 0.0)
                }
            } else {
                (vec![], 0.0)
            };
            (asset_ids, track_ids, duration)
        } else {
            (vec![], vec![], 0.0)
        }
    };

    // Parse the intent using pattern matching for common video editing commands
    let script =
        parse_intent_to_script(&intent, &asset_ids, &track_ids, timeline_duration, &context)?;

    Ok(EditScriptDto {
        intent: script.intent,
        commands: script
            .commands
            .into_iter()
            .map(|cmd| EditCommandDto {
                command_type: cmd.command_type,
                params: cmd.params,
                description: cmd.description,
            })
            .collect(),
        requires: script
            .requires
            .into_iter()
            .map(|r| RequirementDto {
                kind: format!("{:?}", r.kind).to_lowercase(),
                query: r.query,
                provider: r.provider,
                params: r.params,
            })
            .collect(),
        qc_rules: script.qc_rules,
        risk: RiskAssessmentDto {
            copyright: format!("{:?}", script.risk.copyright).to_lowercase(),
            nsfw: format!("{:?}", script.risk.nsfw).to_lowercase(),
        },
        explanation: script.explanation,
        preview_plan: script.preview_plan.map(|p| PreviewPlanDto {
            ranges: p
                .ranges
                .into_iter()
                .map(|r| PreviewRangeDto {
                    start_sec: r.start_sec,
                    end_sec: r.end_sec,
                })
                .collect(),
            full_render: p.full_render,
        }),
    })
}

/// Creates a Proposal from an EditScript and stores it for review
#[tauri::command]
pub async fn create_proposal(
    edit_script: EditScriptDto,
    state: State<'_, AppState>,
) -> Result<ProposalDto, String> {
    let proposal_id = ulid::Ulid::new().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();

    // For now, store proposal in-memory (could be persisted to project state later)
    let proposal = ProposalDto {
        id: proposal_id.clone(),
        edit_script,
        status: "pending".to_string(),
        created_at,
        preview_job_id: None,
        applied_op_ids: None,
    };

    // Validate the script has commands
    if proposal.edit_script.commands.is_empty() {
        return Err("EditScript must have at least one command".to_string());
    }

    // Verify project is open
    let guard = state.project.lock().await;
    guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    Ok(proposal)
}

/// Applies an EditScript by executing its commands
#[tauri::command]
pub async fn apply_edit_script(
    edit_script: EditScriptDto,
    state: State<'_, AppState>,
) -> Result<ApplyEditScriptResult, String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let mut applied_op_ids: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // Get active sequence ID
    let sequence_id = project
        .state
        .active_sequence_id
        .clone()
        .ok_or_else(|| "No active sequence".to_string())?;

    // Execute each command in order
    for cmd in &edit_script.commands {
        let validate_time_sec = |field: &str, value: f64| -> Result<(), String> {
            if value.is_finite() && value >= 0.0 {
                Ok(())
            } else {
                Err(format!(
                    "Invalid {field}: must be a finite, non-negative number"
                ))
            }
        };

        let mut payload = cmd.params.clone();
        let Some(obj) = payload.as_object_mut() else {
            errors.push(format!(
                "Invalid params for {}: expected JSON object",
                cmd.command_type
            ));
            continue;
        };

        let needs_sequence_id = matches!(
            cmd.command_type.as_str(),
            "InsertClip"
                | "SplitClip"
                | "DeleteClip"
                | "RemoveClip"
                | "TrimClip"
                | "MoveClip"
                | "UpdateCaption"
        );
        if needs_sequence_id && !obj.contains_key("sequenceId") {
            obj.insert(
                "sequenceId".to_string(),
                serde_json::json!(sequence_id.clone()),
            );
        }

        let sequence_id_for_cmd = obj
            .get("sequenceId")
            .and_then(|v| v.as_str())
            .unwrap_or(sequence_id.as_str())
            .to_string();

        // Some AI scripts omit trackId (they identify clips only). Inject it from current state.
        let needs_track_id = matches!(
            cmd.command_type.as_str(),
            "SplitClip" | "DeleteClip" | "RemoveClip" | "TrimClip" | "MoveClip" | "UpdateCaption"
        );
        if needs_track_id && !obj.contains_key("trackId") {
            if let Some(clip_id) = obj.get("clipId").and_then(|v| v.as_str()) {
                let track_id = match find_track_for_clip(project, &sequence_id_for_cmd, clip_id) {
                    Ok(id) => id,
                    Err(e) => {
                        errors.push(e);
                        continue;
                    }
                };
                obj.insert("trackId".to_string(), serde_json::json!(track_id));
            }
        }

        let typed_command = match CommandPayload::parse(cmd.command_type.clone(), payload) {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!(
                    "Command parse failed ({}): {}",
                    cmd.command_type, e
                ));
                continue;
            }
        };

        let command: Box<dyn crate::core::commands::Command> = match typed_command {
            CommandPayload::InsertClip(p) => {
                if let Err(e) = validate_time_sec("timelineStart", p.timeline_start) {
                    errors.push(format!("Command validation failed (InsertClip): {e}"));
                    continue;
                }
                Box::new(InsertClipCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.asset_id,
                    p.timeline_start,
                ))
            }
            CommandPayload::RemoveClip(p) => Box::new(RemoveClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
            )),
            CommandPayload::MoveClip(p) => {
                if let Err(e) = validate_time_sec("newTimelineIn", p.new_timeline_in) {
                    errors.push(format!("Command validation failed (MoveClip): {e}"));
                    continue;
                }
                Box::new(MoveClipCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.new_timeline_in,
                    p.new_track_id,
                ))
            }
            CommandPayload::TrimClip(p) => {
                if let Some(t) = p.new_source_in {
                    if let Err(e) = validate_time_sec("newSourceIn", t) {
                        errors.push(format!("Command validation failed (TrimClip): {e}"));
                        continue;
                    }
                }
                if let Some(t) = p.new_source_out {
                    if let Err(e) = validate_time_sec("newSourceOut", t) {
                        errors.push(format!("Command validation failed (TrimClip): {e}"));
                        continue;
                    }
                }
                if let Some(t) = p.new_timeline_in {
                    if let Err(e) = validate_time_sec("newTimelineIn", t) {
                        errors.push(format!("Command validation failed (TrimClip): {e}"));
                        continue;
                    }
                }
                Box::new(TrimClipCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.new_source_in,
                    p.new_source_out,
                    p.new_timeline_in,
                ))
            }
            CommandPayload::SplitClip(p) => {
                if let Err(e) = validate_time_sec("splitTime", p.split_time) {
                    errors.push(format!("Command validation failed (SplitClip): {e}"));
                    continue;
                }
                Box::new(SplitClipCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.split_time,
                ))
            }
            CommandPayload::ImportAsset(p) => Box::new(ImportAssetCommand::new(&p.name, &p.uri)),
            CommandPayload::RemoveAsset(p) => Box::new(RemoveAssetCommand::new(&p.asset_id)),
            CommandPayload::CreateSequence(p) => Box::new(CreateSequenceCommand::new(
                &p.name,
                &p.format.unwrap_or_else(|| "1080p".to_string()),
            )),
            CommandPayload::UpdateCaption(p) => Box::new(
                crate::core::commands::UpdateCaptionCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.caption_id,
                )
                .with_text(p.text)
                .with_time_range(p.start_sec, p.end_sec),
            ),
        };

        match project.executor.execute(command, &mut project.state) {
            Ok(result) => {
                applied_op_ids.push(result.op_id);
            }
            Err(e) => {
                errors.push(format!("Command execution failed: {}", e));
            }
        }
    }

    Ok(ApplyEditScriptResult {
        success: errors.is_empty(),
        applied_op_ids,
        errors,
    })
}

/// Validates an EditScript without executing
#[tauri::command]
pub async fn validate_edit_script(
    edit_script: EditScriptDto,
    state: State<'_, AppState>,
) -> Result<ValidationResultDto, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let mut issues: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // Check for empty commands
    if edit_script.commands.is_empty() {
        issues.push("EditScript has no commands".to_string());
    }

    // Validate each command
    for (i, cmd) in edit_script.commands.iter().enumerate() {
        match cmd.command_type.as_str() {
            "InsertClip" => {
                if cmd.params.get("trackId").is_none() {
                    issues.push(format!("InsertClip command {} missing trackId", i));
                }
                if cmd.params.get("assetId").is_none() {
                    issues.push(format!("InsertClip command {} missing assetId", i));
                } else if let Some(asset_id) = cmd.params.get("assetId").and_then(|v| v.as_str()) {
                    if !project.state.assets.contains_key(asset_id) {
                        warnings.push(format!("Asset {} not found in project", asset_id));
                    }
                }
            }
            "SplitClip" | "DeleteClip" | "TrimClip" | "MoveClip" => {
                if cmd.params.get("clipId").is_none() {
                    issues.push(format!("{} command {} missing clipId", cmd.command_type, i));
                }
            }
            _ => {
                warnings.push(format!("Unknown command type: {}", cmd.command_type));
            }
        }
    }

    // Check risk levels
    if edit_script.risk.copyright == "high" {
        warnings.push("High copyright risk detected".to_string());
    }
    if edit_script.risk.nsfw == "likely" || edit_script.risk.nsfw == "high" {
        warnings.push("High NSFW risk detected".to_string());
    }

    Ok(ValidationResultDto {
        is_valid: issues.is_empty(),
        issues,
        warnings,
    })
}

// Helper function to parse natural language intent into EditScript
fn parse_intent_to_script(
    intent: &str,
    asset_ids: &[String],
    track_ids: &[String],
    timeline_duration: f64,
    context: &AIContextDto,
) -> Result<crate::core::ai::EditScript, String> {
    use crate::core::ai::{EditCommand, EditScript, RiskAssessment};

    let intent_lower = intent.to_lowercase();
    let mut script = EditScript::new(intent);

    // Pattern: "Cut/trim the first X seconds"
    if (intent_lower.contains("cut")
        || intent_lower.contains("trim")
        || intent_lower.contains("잘라"))
        && (intent_lower.contains("first")
            || intent_lower.contains("앞")
            || intent_lower.contains("처음"))
    {
        // Extract seconds using regex-like pattern
        let seconds = extract_seconds(&intent_lower).unwrap_or(5.0);

        if let Some(clip_id) = context.selected_clips.first() {
            // Split at the specified time, then delete the first part
            let explanation = format!(
                "This will split the clip at {} seconds. You may then delete the first segment.",
                seconds
            );
            script = script
                .add_command(
                    EditCommand::split_clip(clip_id, seconds)
                        .with_description(&format!("Split clip at {} seconds", seconds)),
                )
                .with_explanation(&explanation);
        } else if !track_ids.is_empty() {
            script = script.with_explanation("Please select a clip first, then try again.");
        }
    }
    // Pattern: "Add/Insert clip at X seconds"
    else if (intent_lower.contains("add")
        || intent_lower.contains("insert")
        || intent_lower.contains("추가"))
        && (intent_lower.contains("clip") || intent_lower.contains("클립"))
    {
        let at_time = extract_seconds(&intent_lower).unwrap_or(timeline_duration);

        if let (Some(asset_id), Some(track_id)) = (asset_ids.first(), track_ids.first()) {
            let explanation = format!(
                "Inserting clip from first available asset at {} seconds on the first track.",
                at_time
            );
            script = script
                .add_command(EditCommand::insert_clip(track_id, asset_id, at_time))
                .with_explanation(&explanation);
        } else {
            script = script.with_explanation("No assets or tracks available. Import media first.");
        }
    }
    // Pattern: "Delete/Remove the selected clip(s)"
    else if (intent_lower.contains("delete")
        || intent_lower.contains("remove")
        || intent_lower.contains("삭제"))
        && (intent_lower.contains("clip")
            || intent_lower.contains("클립")
            || intent_lower.contains("selected"))
    {
        if context.selected_clips.is_empty() {
            script = script.with_explanation("No clips selected. Please select clips to delete.");
        } else {
            for clip_id in &context.selected_clips {
                script = script.add_command(
                    EditCommand::delete_clip(clip_id)
                        .with_description(&format!("Delete clip {}", clip_id)),
                );
            }
            let explanation = format!(
                "Deleting {} selected clip(s).",
                context.selected_clips.len()
            );
            script = script.with_explanation(&explanation);
        }
    }
    // Pattern: "Move clip to X seconds"
    else if (intent_lower.contains("move") || intent_lower.contains("이동"))
        && (intent_lower.contains("clip") || intent_lower.contains("클립"))
    {
        let to_time = extract_seconds(&intent_lower).unwrap_or(0.0);

        if let Some(clip_id) = context.selected_clips.first() {
            let explanation = format!("Moving selected clip to {} seconds.", to_time);
            script = script
                .add_command(
                    EditCommand::move_clip(clip_id, to_time, None)
                        .with_description(&format!("Move clip to {} seconds", to_time)),
                )
                .with_explanation(&explanation);
        } else {
            script = script.with_explanation("Please select a clip to move.");
        }
    }
    // Default: Return explanation that we couldn't parse the intent
    else {
        let explanation = format!(
            "I couldn't understand the command '{}'. Try commands like:\n\
            - 'Cut the first 5 seconds'\n\
            - 'Add clip at 10 seconds'\n\
            - 'Delete selected clips'\n\
            - 'Move clip to 5 seconds'",
            intent
        );
        script = script.with_explanation(&explanation);
    }

    script.risk = RiskAssessment::low();
    Ok(script)
}

// Helper function to extract seconds from a string
fn extract_seconds(text: &str) -> Option<f64> {
    // Simple pattern: look for numbers followed by optional "s", "sec", "seconds", "초"
    let re_patterns = [
        r"(\d+(?:\.\d+)?)\s*(?:s|sec|seconds|초)",
        r"(\d+(?:\.\d+)?)\s+second",
        r"first\s+(\d+(?:\.\d+)?)",
        r"앞\s*(\d+(?:\.\d+)?)",
        r"(\d+(?:\.\d+)?)\s*초",
    ];

    for pattern in &re_patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(caps) = re.captures(text) {
                if let Some(num_str) = caps.get(1) {
                    if let Ok(num) = num_str.as_str().parse::<f64>() {
                        return Some(num);
                    }
                }
            }
        }
    }

    // Fallback: just find any number
    if let Ok(re) = regex::Regex::new(r"(\d+(?:\.\d+)?)") {
        if let Some(caps) = re.captures(text) {
            if let Some(num_str) = caps.get(1) {
                if let Ok(num) = num_str.as_str().parse::<f64>() {
                    return Some(num);
                }
            }
        }
    }

    None
}

// Helper function to find which track contains a clip
fn find_track_for_clip(
    project: &crate::ActiveProject,
    sequence_id: &str,
    clip_id: &str,
) -> Result<String, String> {
    let sequence = project
        .state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?;

    for track in &sequence.tracks {
        if track.clips.iter().any(|c| c.id == clip_id) {
            return Ok(track.id.clone());
        }
    }

    Err(format!("Clip {} not found in sequence", clip_id))
}

// =============================================================================
// DTOs (Data Transfer Objects)
// =============================================================================

/// Project information returned when creating or opening a project.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// Unique project identifier (ULID format)
    pub id: String,
    /// Human-readable project name
    pub name: String,
    /// Absolute path to project directory
    pub path: String,
    /// ISO 8601 timestamp of project creation
    pub created_at: String,
}

/// Project metadata information.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetaDto {
    /// Project display name
    pub name: String,
    /// Project format version
    pub version: String,
    /// ISO 8601 creation timestamp
    pub created_at: String,
    /// ISO 8601 last modification timestamp
    pub modified_at: String,
    /// Optional project description
    pub description: Option<String>,
    /// Optional author name
    pub author: Option<String>,
}

/// Full project state for frontend synchronization.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStateDto {
    /// Project metadata
    pub meta: ProjectMetaDto,
    /// All assets in the project
    pub assets: Vec<crate::core::assets::Asset>,
    /// All sequences in the project
    pub sequences: Vec<crate::core::timeline::Sequence>,
    /// Currently active sequence ID
    pub active_sequence_id: Option<String>,
    /// Whether project has unsaved changes
    pub is_dirty: bool,
}

/// Result of importing an asset into the project.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportResult {
    /// Generated asset ID (ULID)
    pub asset_id: String,
    /// Asset display name (from filename)
    pub name: String,
    /// Operation ID for undo/redo tracking
    pub op_id: String,
    /// Background job ID for proxy/thumbnail generation (if any)
    pub job_id: Option<String>,
}

/// Result of executing an edit command.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandResultDto {
    /// Operation ID for tracking in undo/redo history
    pub op_id: String,
    /// IDs of entities created by this command
    pub created_ids: Vec<String>,
    /// IDs of entities deleted by this command
    pub deleted_ids: Vec<String>,
}

/// Result of an undo or redo operation.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UndoRedoResult {
    /// Whether the operation was successful
    pub success: bool,
    /// Whether more undo operations are available
    pub can_undo: bool,
    /// Whether more redo operations are available
    pub can_redo: bool,
}

/// Result of starting a render export job.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderStartResult {
    /// Job ID for tracking render progress
    pub job_id: String,
    /// Output file path
    pub output_path: String,
    /// Initial status ("started")
    pub status: String,
}

// =============================================================================
// AI DTOs
// =============================================================================

/// Context information for AI intent analysis.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AIContextDto {
    /// Current playhead position in seconds
    pub playhead_position: f64,
    /// IDs of currently selected clips
    pub selected_clips: Vec<String>,
    /// IDs of currently selected tracks
    pub selected_tracks: Vec<String>,
    /// Nearby transcript text for context
    pub transcript_context: Option<String>,
    /// Timeline duration in seconds
    pub timeline_duration: Option<f64>,
    /// Available asset IDs
    #[serde(default)]
    pub asset_ids: Vec<String>,
    /// Available track IDs
    #[serde(default)]
    pub track_ids: Vec<String>,
}

/// AI-generated edit script containing commands to execute.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditScriptDto {
    /// Original user intent/prompt
    pub intent: String,
    /// List of edit commands to execute
    pub commands: Vec<EditCommandDto>,
    /// External requirements (assets to fetch, etc.)
    pub requires: Vec<RequirementDto>,
    /// QC rules to apply after execution
    pub qc_rules: Vec<String>,
    /// Risk assessment for the edit
    pub risk: RiskAssessmentDto,
    /// Human-readable explanation of the edit
    pub explanation: String,
    /// Preview plan for the edit
    pub preview_plan: Option<PreviewPlanDto>,
}

/// Preview plan for an EditScript.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPlanDto {
    /// Time ranges to preview
    pub ranges: Vec<PreviewRangeDto>,
    /// Whether full render is needed
    pub full_render: bool,
}

/// A time range for preview.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRangeDto {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
}

/// A single edit command within an EditScript.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditCommandDto {
    /// Command type (e.g., "InsertClip", "SplitClip")
    pub command_type: String,
    /// Command parameters as JSON
    pub params: serde_json::Value,
    /// Human-readable description of what this command does
    pub description: Option<String>,
}

/// External requirement for an EditScript (e.g., asset to fetch).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RequirementDto {
    /// Requirement type (e.g., "assetSearch", "assetGenerate")
    pub kind: String,
    /// Search query or generation prompt
    pub query: Option<String>,
    /// Provider to use (e.g., "unsplash", "pexels")
    pub provider: Option<String>,
    /// Additional parameters
    pub params: Option<serde_json::Value>,
}

/// Risk assessment for an AI-generated edit.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RiskAssessmentDto {
    /// Copyright risk level ("none", "low", "medium", "high")
    pub copyright: String,
    /// NSFW risk level ("none", "low", "medium", "high")
    pub nsfw: String,
}

/// AI proposal awaiting user approval.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDto {
    /// Unique proposal ID
    pub id: String,
    /// The edit script to be applied
    pub edit_script: EditScriptDto,
    /// Current status ("pending", "applied", "rejected")
    pub status: String,
    /// ISO 8601 creation timestamp
    pub created_at: String,
    /// Job ID for preview generation (if any)
    pub preview_job_id: Option<String>,
    /// Operation IDs if proposal was applied
    pub applied_op_ids: Option<Vec<String>>,
}

/// Result of applying an EditScript.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEditScriptResult {
    /// Whether all commands were applied successfully
    pub success: bool,
    /// Operation IDs of successfully applied commands
    pub applied_op_ids: Vec<String>,
    /// Error messages for failed commands
    pub errors: Vec<String>,
}

/// Result of validating an EditScript.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResultDto {
    /// Whether the EditScript is valid
    pub is_valid: bool,
    /// Critical issues that prevent execution
    pub issues: Vec<String>,
    /// Non-critical warnings
    pub warnings: Vec<String>,
}

// =============================================================================
// Performance/Memory Commands
// =============================================================================

/// Memory usage statistics.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatsDto {
    /// Memory pool statistics
    pub pool_stats: PoolStatsDto,
    /// Cache statistics
    pub cache_stats: CacheStatsDto,
    /// Total allocated bytes (Rust side)
    pub allocated_bytes: u64,
    /// System memory info (if available)
    pub system_memory: Option<SystemMemoryDto>,
}

/// Memory pool statistics.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatsDto {
    /// Total number of memory blocks in pool
    pub total_blocks: usize,
    /// Number of currently allocated blocks
    pub allocated_blocks: usize,
    /// Total pool size in bytes
    pub total_size_bytes: u64,
    /// Currently used size in bytes
    pub used_size_bytes: u64,
    /// Total allocation requests
    pub allocation_count: u64,
    /// Total release operations
    pub release_count: u64,
    /// Allocations served from pool
    pub pool_hits: u64,
    /// Allocations that required new allocation
    pub pool_misses: u64,
    /// Hit rate (0.0 - 1.0)
    pub hit_rate: f64,
}

impl From<PoolStats> for PoolStatsDto {
    fn from(stats: PoolStats) -> Self {
        let total = stats.pool_hits + stats.pool_misses;
        let hit_rate = if total > 0 {
            stats.pool_hits as f64 / total as f64
        } else {
            0.0
        };

        Self {
            total_blocks: stats.total_blocks,
            allocated_blocks: stats.allocated_blocks,
            total_size_bytes: stats.total_size_bytes,
            used_size_bytes: stats.used_size_bytes,
            allocation_count: stats.allocation_count,
            release_count: stats.release_count,
            pool_hits: stats.pool_hits,
            pool_misses: stats.pool_misses,
            hit_rate,
        }
    }
}

/// Cache usage statistics.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatsDto {
    /// Number of entries in cache
    pub entry_count: usize,
    /// Total cache size in bytes
    pub total_size_bytes: u64,
    /// Cache hit count
    pub hits: u64,
    /// Cache miss count
    pub misses: u64,
    /// Number of evicted entries
    pub evictions: u64,
    /// Cache hit rate (0.0 - 1.0)
    pub hit_rate: f64,
}

impl From<CacheStats> for CacheStatsDto {
    fn from(stats: CacheStats) -> Self {
        Self {
            entry_count: stats.entry_count,
            total_size_bytes: stats.total_size_bytes,
            hits: stats.hits,
            misses: stats.misses,
            evictions: stats.evictions,
            hit_rate: stats.hit_rate,
        }
    }
}

/// System memory information.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemoryDto {
    /// Total physical memory in bytes
    pub total_bytes: u64,
    /// Available memory in bytes
    pub available_bytes: u64,
    /// Used memory in bytes
    pub used_bytes: u64,
    /// Usage percentage (0-100)
    pub usage_percent: f64,
}

/// Result of memory cleanup operation.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCleanupResult {
    /// Bytes freed from pool shrink
    pub pool_bytes_freed: u64,
    /// Cache entries evicted
    pub cache_entries_evicted: usize,
    /// Total bytes freed
    pub total_bytes_freed: u64,
}

/// Gets memory statistics from the backend
#[tauri::command]
pub async fn get_memory_stats(state: State<'_, AppState>) -> Result<MemoryStatsDto, String> {
    let memory_state = state.memory_pool.lock().await;
    let cache_state = state.cache_manager.lock().await;

    let pool_stats = memory_state.get_stats().await;
    let cache_stats = cache_state.get_stats().await;
    let allocated_bytes = memory_state.allocated_bytes();

    // Get system memory info
    let system_memory = get_system_memory_info();

    Ok(MemoryStatsDto {
        pool_stats: PoolStatsDto::from(pool_stats),
        cache_stats: CacheStatsDto::from(cache_stats),
        allocated_bytes,
        system_memory,
    })
}

/// Triggers memory cleanup (shrink pools, evict expired cache)
#[tauri::command]
pub async fn trigger_memory_cleanup(
    state: State<'_, AppState>,
) -> Result<MemoryCleanupResult, String> {
    let memory_state = state.memory_pool.lock().await;
    let cache_state = state.cache_manager.lock().await;

    // Shrink memory pool (free unused blocks)
    let pool_bytes_freed = memory_state.shrink().await as u64;

    // Get cache stats before eviction
    let cache_before = cache_state.get_stats().await;

    // Evict expired cache entries based on TTL
    let cache_entries_evicted = cache_state.evict_expired().await;

    // Calculate bytes freed from cache
    let cache_after = cache_state.get_stats().await;
    let cache_bytes_freed = cache_before
        .total_size_bytes
        .saturating_sub(cache_after.total_size_bytes);

    let total_bytes_freed = pool_bytes_freed + cache_bytes_freed;

    tracing::info!(
        "Memory cleanup: pool freed {} bytes, cache evicted {} entries ({} bytes)",
        pool_bytes_freed,
        cache_entries_evicted,
        cache_bytes_freed
    );

    Ok(MemoryCleanupResult {
        pool_bytes_freed,
        cache_entries_evicted,
        total_bytes_freed,
    })
}

/// Gets system memory information
///
/// Returns None since sysinfo is not currently enabled.
/// To enable system memory info, add sysinfo as a dependency and feature.
fn get_system_memory_info() -> Option<SystemMemoryDto> {
    // sysinfo crate is not currently enabled as a dependency
    // Return None to indicate system memory info is unavailable
    None
}

// =============================================================================
// Transcription Commands
// =============================================================================

/// Result of speech-to-text transcription.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResultDto {
    /// Detected or specified language code
    pub language: String,
    /// Transcribed segments with timestamps
    pub segments: Vec<TranscriptionSegmentDto>,
    /// Total audio duration in seconds
    pub duration: f64,
    /// Full transcription text (all segments concatenated)
    pub full_text: String,
}

/// A single transcription segment with timing.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegmentDto {
    /// Start time in seconds
    pub start_time: f64,
    /// End time in seconds
    pub end_time: f64,
    /// Transcribed text for this segment
    pub text: String,
}

/// Options for transcription request.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOptionsDto {
    /// Language code (e.g., "en", "ko") or "auto" for detection
    pub language: Option<String>,
    /// Whether to translate to English
    pub translate: Option<bool>,
    /// Whisper model to use ("tiny", "base", "small", "medium", "large")
    pub model: Option<String>,
}

/// Checks if transcription is available
#[tauri::command]
pub async fn is_transcription_available() -> Result<bool, String> {
    Ok(crate::core::captions::whisper::is_whisper_available())
}

/// Transcribes an asset's audio content
///
/// This command extracts audio from the asset, runs Whisper transcription,
/// and returns the transcribed text with timestamps.
#[tauri::command]
pub async fn transcribe_asset(
    asset_id: String,
    options: Option<TranscriptionOptionsDto>,
    state: State<'_, AppState>,
) -> Result<TranscriptionResultDto, String> {
    use crate::core::captions::{
        audio::{extract_audio_for_transcription, load_audio_samples},
        whisper::{TranscriptionOptions, WhisperEngine, WhisperModel},
    };
    use std::path::PathBuf;

    // Check if whisper is available
    if !crate::core::captions::whisper::is_whisper_available() {
        return Err("Transcription is not available. Rebuild with --features whisper".to_string());
    }

    // Get asset from project
    let (asset_path, asset_name) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        (PathBuf::from(&asset.uri), asset.name.clone())
    };

    tracing::info!(
        "Starting transcription for asset: {} ({})",
        asset_name,
        asset_id
    );

    // Determine model to use
    let model_name = options
        .as_ref()
        .and_then(|o| o.model.as_deref())
        .unwrap_or("base");
    let model = model_name
        .parse::<WhisperModel>()
        .unwrap_or(WhisperModel::Base);

    // Get model path
    let models_dir = crate::core::captions::whisper::default_models_dir();
    let model_path = models_dir.join(model.filename());

    if !model_path.exists() {
        return Err(format!(
            "Whisper model not found at {}. Please download the {} model.",
            model_path.display(),
            model.name()
        ));
    }

    // Create temp directory for audio extraction
    let temp_dir = std::env::temp_dir()
        .join("openreelio")
        .join("transcription");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let audio_path = temp_dir.join(format!("{}.wav", asset_id));

    // RAII guard for temp file cleanup (ensures cleanup on both success and error)
    struct TempFileGuard(PathBuf);
    impl Drop for TempFileGuard {
        fn drop(&mut self) {
            if self.0.exists() {
                let _ = std::fs::remove_file(&self.0);
                tracing::debug!("Cleaned up temp audio file: {}", self.0.display());
            }
        }
    }
    let _temp_guard = TempFileGuard(audio_path.clone());

    // Create transcription options before moving into spawn_blocking
    let whisper_options = TranscriptionOptions {
        language: options.as_ref().and_then(|o| o.language.clone()),
        translate: options.as_ref().and_then(|o| o.translate).unwrap_or(false),
        threads: 0, // Auto-detect
        initial_prompt: None,
    };

    // Run heavy blocking operations (FFmpeg, file I/O, Whisper inference) in spawn_blocking
    let result = tokio::task::spawn_blocking(move || {
        // Extract audio from asset
        tracing::debug!("Extracting audio to: {}", audio_path.display());
        extract_audio_for_transcription(&asset_path, &audio_path, None)
            .map_err(|e| format!("Audio extraction failed: {}", e))?;

        // Load audio samples
        let samples = load_audio_samples(&audio_path)
            .map_err(|e| format!("Failed to load audio samples: {}", e))?;

        tracing::debug!("Loaded {} audio samples", samples.len());

        // Create whisper engine and transcribe
        let engine = WhisperEngine::new(&model_path)
            .map_err(|e| format!("Failed to load Whisper model: {}", e))?;

        let result = engine
            .transcribe(&samples, &whisper_options)
            .map_err(|e| format!("Transcription failed: {}", e))?;

        tracing::info!(
            "Transcription complete: {} segments, {:.1}s duration",
            result.segments.len(),
            result.duration
        );

        Ok::<_, String>(result)
    })
    .await
    .map_err(|e| format!("Transcription task panicked: {}", e))??;

    // Convert to DTO - get full_text before consuming segments
    let full_text = result.full_text();
    Ok(TranscriptionResultDto {
        language: result.language,
        segments: result
            .segments
            .into_iter()
            .map(|s| TranscriptionSegmentDto {
                start_time: s.start_time,
                end_time: s.end_time,
                text: s.text,
            })
            .collect(),
        duration: result.duration,
        full_text,
    })
}

/// Submits a transcription job to the worker pool
#[tauri::command]
pub async fn submit_transcription_job(
    asset_id: String,
    options: Option<TranscriptionOptionsDto>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Resolve asset path at submission time so the job remains runnable even if
    // the project is closed later.
    let input_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;
        asset.uri.clone()
    };

    // Create job payload
    let payload = serde_json::json!({
        "assetId": asset_id,
        "inputPath": input_path,
        "model": options.as_ref().and_then(|o| o.model.clone()),
        "language": options.as_ref().and_then(|o| o.language.clone()),
        "translate": options.as_ref().and_then(|o| o.translate),
        "options": options,
    });

    // Submit to job pool
    let job = Job::new(JobType::Transcription, payload).with_priority(Priority::UserRequest);
    let pool = state.job_pool.lock().await;
    let job_id = pool.submit(job).map_err(|e| e.to_string())?;

    tracing::info!(
        "Submitted transcription job: {} for asset: {}",
        job_id,
        asset_id
    );

    Ok(job_id)
}

// =============================================================================
// Search Commands (Meilisearch)
// =============================================================================

/// Options for full-text search queries.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptionsDto {
    /// Maximum number of results per index
    pub limit: Option<usize>,
    /// Offset for pagination
    pub offset: Option<usize>,
    /// Filter by asset IDs
    pub asset_ids: Option<Vec<String>>,
    /// Filter by project ID
    pub project_id: Option<String>,
    /// Search only specific indexes ("assets", "transcripts")
    pub indexes: Option<Vec<String>>,
}

/// Search result for an asset.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetSearchResultDto {
    /// Asset ID
    pub id: String,
    /// Asset display name
    pub name: String,
    /// File path
    pub path: String,
    /// Asset kind ("video", "audio", "image", etc.)
    pub kind: String,
    /// Duration in seconds (for video/audio)
    pub duration: Option<f64>,
    /// Associated tags
    pub tags: Vec<String>,
}

/// Search result for a transcript segment.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchResultDto {
    /// Segment ID
    pub id: String,
    /// Parent asset ID
    pub asset_id: String,
    /// Matched text content
    pub text: String,
    /// Start time in seconds
    pub start_time: f64,
    /// End time in seconds
    pub end_time: f64,
    /// Language code
    pub language: Option<String>,
}

/// Combined search results from all indexes.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultsDto {
    /// Matching assets
    pub assets: Vec<AssetSearchResultDto>,
    /// Matching transcript segments
    pub transcripts: Vec<TranscriptSearchResultDto>,
    /// Total asset matches (estimated)
    pub asset_total: Option<usize>,
    /// Total transcript matches (estimated)
    pub transcript_total: Option<usize>,
    /// Query processing time in milliseconds
    pub processing_time_ms: u64,
}

// =============================================================================
// SQLite Search Commands (Always Available)
// =============================================================================

/// Search query parameters for SQLite-based search
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryDto {
    /// Text to search for
    pub text: Option<String>,
    /// Search modality: "text", "visual", "audio", "hybrid"
    pub modality: Option<String>,
    /// Duration filter: [min, max] in seconds
    pub duration_range: Option<(f64, f64)>,
    /// Filter by specific asset IDs
    #[serde(alias = "filterAssetIds")]
    pub asset_ids: Option<Vec<String>>,
    /// Minimum quality score (0.0 - 1.0)
    pub min_quality: Option<f64>,
    /// Maximum number of results
    #[serde(alias = "resultLimit")]
    pub limit: Option<usize>,
}

/// A single search result from SQLite search
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultDto {
    /// Asset ID
    pub asset_id: String,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Relevance score (0.0 - 1.0)
    pub score: f64,
    /// Reasons for the match
    pub reasons: Vec<String>,
    /// Thumbnail URI (if available)
    pub thumbnail_uri: Option<String>,
    /// Source of the match: "transcript", "shot", "audio", "multiple", "unknown"
    pub source: String,
}

/// Search response with results and metadata
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponseDto {
    /// Search results
    pub results: Vec<SearchResultDto>,
    /// Total number of results found
    pub total: usize,
    /// Query processing time in milliseconds
    pub processing_time_ms: u64,
}

/// Searches assets using SQLite-based search engine (always available)
///
/// This command performs search across transcripts and shots stored in the
/// project's index database. Unlike Meilisearch, this is always available
/// without additional feature flags.
#[tauri::command]
pub async fn search_assets(
    query: SearchQueryDto,
    state: State<'_, AppState>,
) -> Result<SearchResponseDto, String> {
    use crate::core::indexing::IndexDb;
    use crate::core::search::{SearchEngine, SearchFilters, SearchModality, SearchQuery};
    use std::time::Instant;

    let start = Instant::now();

    // Get project and index database
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    // Open (or create) the project's index database.
    //
    // Note: We avoid storing a persistent rusqlite Connection in `ActiveProject`
    // because `rusqlite::Connection` is not `Send` and would complicate cross-thread state.
    let index_db_path = project.path.join("index.db");
    let index_db = (if index_db_path.exists() {
        IndexDb::open(&index_db_path)
    } else {
        IndexDb::create(&index_db_path)
    })
    .map_err(|e| e.to_ipc_error())?;

    // Build search query
    let modality = match query.modality.as_deref() {
        Some("visual") => SearchModality::Visual,
        Some("audio") => SearchModality::Audio,
        Some("hybrid") => SearchModality::Hybrid,
        _ => SearchModality::Text,
    };

    let search_query = SearchQuery {
        text: query.text,
        duration_hint: query.duration_range,
        modality,
        filters: SearchFilters {
            asset_ids: query.asset_ids,
            min_quality: query.min_quality,
            ..Default::default()
        },
        limit: query.limit.unwrap_or(20),
    };

    // Perform search
    let engine = SearchEngine::new(&index_db);
    let results = engine.search(&search_query).map_err(|e| e.to_ipc_error())?;

    // Convert to DTOs
    let result_dtos: Vec<SearchResultDto> = results
        .iter()
        .map(|r| SearchResultDto {
            asset_id: r.asset_id.clone(),
            start_sec: r.start_sec,
            end_sec: r.end_sec,
            score: r.score,
            reasons: r.reasons.clone(),
            thumbnail_uri: r.thumbnail_uri.clone(),
            source: match r.source {
                crate::core::search::SearchResultSource::Transcript => "transcript".to_string(),
                crate::core::search::SearchResultSource::Shot => "shot".to_string(),
                crate::core::search::SearchResultSource::Audio => "audio".to_string(),
                crate::core::search::SearchResultSource::Multiple => "multiple".to_string(),
                crate::core::search::SearchResultSource::Unknown => "unknown".to_string(),
            },
        })
        .collect();

    let total = result_dtos.len();
    let processing_time_ms = start.elapsed().as_millis() as u64;

    Ok(SearchResponseDto {
        results: result_dtos,
        total,
        processing_time_ms,
    })
}

// =============================================================================
// Meilisearch Commands (Feature-Gated)
// =============================================================================

/// Checks if Meilisearch is available and ready.
///
/// This is a best-effort check that may attempt lazy sidecar startup.
#[tauri::command]
pub async fn is_meilisearch_available(state: State<'_, AppState>) -> Result<bool, String> {
    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Ok(false);
    }

    let service = match get_search_service(&state).await {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };

    match service.ensure_ready().await {
        Ok(()) => Ok(true),
        Err(e) => {
            tracing::debug!("Meilisearch not ready: {}", e);
            Ok(false)
        }
    }
}

/// Performs a full-text search using Meilisearch
#[tauri::command]
pub async fn search_content(
    query: String,
    options: Option<SearchOptionsDto>,
    state: State<'_, AppState>,
) -> Result<SearchResultsDto, String> {
    use crate::core::search::meilisearch::SearchOptions;

    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Err(
            "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
        );
    }

    let search_options = match options {
        Some(opts) => SearchOptions {
            limit: opts.limit.unwrap_or(20),
            offset: opts.offset.unwrap_or(0),
            asset_ids: opts.asset_ids,
            project_id: opts.project_id,
            indexes: opts.indexes,
        },
        None => SearchOptions::with_limit(20),
    };

    let service = get_search_service(&state).await?;

    tracing::debug!(
        "Meilisearch query: '{}' (limit {}, offset {})",
        query,
        search_options.limit,
        search_options.offset
    );

    let results = service.search(&query, &search_options).await?;

    Ok(SearchResultsDto {
        assets: results
            .assets
            .hits
            .into_iter()
            .map(|a| AssetSearchResultDto {
                id: a.id,
                name: a.name,
                path: a.path,
                kind: a.kind,
                duration: a.duration,
                tags: a.tags,
            })
            .collect(),
        transcripts: results
            .transcripts
            .hits
            .into_iter()
            .map(|t| TranscriptSearchResultDto {
                id: t.id,
                asset_id: t.asset_id,
                text: t.text,
                start_time: t.start_time,
                end_time: t.end_time,
                language: t.language,
            })
            .collect(),
        asset_total: results.assets.estimated_total_hits,
        transcript_total: results.transcripts.estimated_total_hits,
        processing_time_ms: results.total_processing_time_ms,
    })
}

/// Indexes an asset in Meilisearch
#[tauri::command]
pub async fn index_asset_for_search(
    asset_id: String,
    name: String,
    path: String,
    kind: String,
    duration: Option<f64>,
    tags: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::core::search::meilisearch::AssetDocument;

    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Err(
            "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
        );
    }

    let mut doc = AssetDocument::new(&asset_id, &name, &path, &kind);
    if let Some(dur) = duration {
        doc = doc.with_duration(dur);
    }
    if let Some(tags) = tags {
        doc = doc.with_tags(tags);
    }
    // If a project is open, attach its ID for filtering.
    if let Some(project_id) = {
        let guard = state.project.lock().await;
        guard.as_ref().map(|p| p.state.meta.id.clone())
    } {
        doc = doc.with_project_id(&project_id);
    }

    let service = get_search_service(&state).await?;
    service.index_asset(&doc).await?;

    tracing::info!(
        "Indexed asset for search: {} ({}) kind={} duration={:?}",
        asset_id,
        name,
        kind,
        duration
    );

    Ok(())
}

/// Indexes transcript segments for an asset
#[tauri::command]
pub async fn index_transcripts_for_search(
    asset_id: String,
    segments: Vec<TranscriptionSegmentDto>,
    language: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::core::search::meilisearch::TranscriptDocument;

    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Err(
            "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
        );
    }

    let service = get_search_service(&state).await?;

    let mut docs = Vec::with_capacity(segments.len());
    let mut skipped = 0usize;

    for (i, seg) in segments.into_iter().enumerate() {
        if seg.end_time < seg.start_time {
            skipped += 1;
            tracing::warn!(
                "Skipping invalid transcript segment (end < start) asset={} start={} end={}",
                asset_id,
                seg.start_time,
                seg.end_time
            );
            continue;
        }

        let mut doc = TranscriptDocument::new(
            &format!("{}_{}", asset_id, i),
            &asset_id,
            &seg.text,
            seg.start_time,
            seg.end_time,
        );
        if let Some(lang) = language.as_deref() {
            doc = doc.with_language(lang);
        }
        docs.push(doc);
    }

    if docs.is_empty() {
        tracing::info!(
            "No valid transcript segments to index for asset {} (skipped {})",
            asset_id,
            skipped
        );
        return Ok(());
    }

    service.index_transcripts(&asset_id, &docs).await?;

    tracing::info!(
        "Indexed {} transcript segments for asset {} (skipped {})",
        docs.len(),
        asset_id,
        skipped
    );

    Ok(())
}

/// Removes an asset and its transcripts from the search index
#[tauri::command]
pub async fn remove_asset_from_search(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Err(
            "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
        );
    }

    let service = get_search_service(&state).await?;
    service.delete_asset(&asset_id).await?;

    tracing::info!("Removed asset {} from search index", asset_id);
    Ok(())
}

async fn get_search_service(
    state: &State<'_, AppState>,
) -> Result<std::sync::Arc<crate::core::search::meilisearch::SearchService>, String> {
    let mut guard = state.search_service.lock().await;

    if let Some(service) = guard.as_ref() {
        return Ok(std::sync::Arc::clone(service));
    }

    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Err(
            "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
        );
    }

    let service = std::sync::Arc::new(crate::core::search::meilisearch::SearchService::new(
        crate::core::search::meilisearch::SidecarConfig::default(),
    ));
    *guard = Some(std::sync::Arc::clone(&service));
    Ok(service)
}

// =============================================================================
// AI Provider Commands
// =============================================================================

/// AI provider status DTO
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatusDto {
    /// Provider type (openai, anthropic, local)
    pub provider_type: Option<String>,
    /// Whether a provider is configured
    pub is_configured: bool,
    /// Whether the provider is available
    pub is_available: bool,
    /// Current model being used
    pub current_model: Option<String>,
    /// Available models for this provider
    pub available_models: Vec<String>,
    /// Error message if any
    pub error_message: Option<String>,
}

/// AI provider configuration DTO
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigDto {
    /// Provider type: "openai", "anthropic", or "local"
    pub provider_type: String,
    /// API key (for cloud providers)
    pub api_key: Option<String>,
    /// Base URL (for custom endpoints or local models)
    pub base_url: Option<String>,
    /// Model to use
    pub model: Option<String>,
}

/// Configures an AI provider
#[tauri::command]
pub async fn configure_ai_provider(
    config: ProviderConfigDto,
    state: State<'_, AppState>,
) -> Result<ProviderStatusDto, String> {
    use crate::core::ai::{create_provider, ProviderConfig, ProviderRuntimeStatus, ProviderType};

    fn validate_base_url(url: &str, allow_http: bool) -> Result<(), String> {
        let url = url.trim();
        if url.is_empty() {
            return Err("Base URL cannot be empty".to_string());
        }

        if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("Base URL contains invalid whitespace/control characters".to_string());
        }

        let is_http = url.starts_with("http://");
        let is_https = url.starts_with("https://");
        if !is_http && !is_https {
            return Err("Base URL must start with http:// or https://".to_string());
        }
        if is_http && !allow_http {
            return Err("Base URL must use https:// for cloud providers".to_string());
        }

        Ok(())
    }

    let provider_type: ProviderType = config.provider_type.parse().map_err(|e: String| e)?;

    let provider_config = match provider_type {
        ProviderType::OpenAI => {
            let api_key = config
                .api_key
                .ok_or_else(|| "API key is required for OpenAI".to_string())?;
            let mut cfg = ProviderConfig::openai(&api_key);
            if let Some(model) = &config.model {
                cfg = cfg.with_model(model);
            }
            if let Some(url) = &config.base_url {
                validate_base_url(url, false)?;
                cfg = cfg.with_base_url(url);
            }
            cfg
        }
        ProviderType::Anthropic => {
            let api_key = config
                .api_key
                .ok_or_else(|| "API key is required for Anthropic".to_string())?;
            let mut cfg = ProviderConfig::anthropic(&api_key);
            if let Some(model) = &config.model {
                cfg = cfg.with_model(model);
            }
            if let Some(url) = &config.base_url {
                validate_base_url(url, false)?;
                cfg = cfg.with_base_url(url);
            }
            cfg
        }
        ProviderType::Local => {
            let mut cfg = ProviderConfig::local(config.base_url.as_deref());
            if let Some(url) = &config.base_url {
                validate_base_url(url, true)?;
            }
            if let Some(model) = &config.model {
                cfg = cfg.with_model(model);
            }
            cfg
        }
    };

    // Create the provider
    let provider = create_provider(provider_config).map_err(|e| e.to_ipc_error())?;

    // Run a real connectivity/auth check.
    let provider_name = provider.name().to_string();
    let is_configured = provider.is_available();
    let (is_available, error_message) = match provider.health_check().await {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e.to_string())),
    };

    // Get available models based on provider type
    let available_models = match provider_type {
        ProviderType::OpenAI => crate::core::ai::OpenAIProvider::available_models(),
        ProviderType::Anthropic => crate::core::ai::AnthropicProvider::available_models(),
        ProviderType::Local => crate::core::ai::LocalProvider::common_models(),
    };

    // Set the provider on the gateway with cached status
    let gateway = state.ai_gateway.lock().await;
    gateway
        .set_provider_boxed_with_status(
            provider,
            ProviderRuntimeStatus {
                provider_type: Some(provider_type.to_string()),
                is_configured,
                is_available,
                current_model: config.model.clone(),
                available_models: available_models.clone(),
                error_message: error_message.clone(),
            },
        )
        .await;

    tracing::info!(
        "Configured AI provider: {} (configured: {}, available: {})",
        provider_name,
        is_configured,
        is_available
    );

    Ok(ProviderStatusDto {
        provider_type: Some(provider_type.to_string()),
        is_configured,
        is_available,
        current_model: config.model,
        available_models,
        error_message,
    })
}

/// Gets the current AI provider status
#[tauri::command]
pub async fn get_ai_provider_status(
    state: State<'_, AppState>,
) -> Result<ProviderStatusDto, String> {
    let gateway = state.ai_gateway.lock().await;
    let status = gateway.provider_status().await;

    Ok(ProviderStatusDto {
        provider_type: status.provider_type,
        is_configured: status.is_configured,
        is_available: status.is_available,
        current_model: status.current_model,
        available_models: status.available_models,
        error_message: status.error_message,
    })
}

/// Clears the current AI provider
#[tauri::command]
pub async fn clear_ai_provider(state: State<'_, AppState>) -> Result<(), String> {
    let gateway = state.ai_gateway.lock().await;
    gateway.clear_provider().await;

    tracing::info!("Cleared AI provider");
    Ok(())
}

/// Tests the AI connection by making a simple request
#[tauri::command]
pub async fn test_ai_connection(state: State<'_, AppState>) -> Result<String, String> {
    let gateway = state.ai_gateway.lock().await;

    if !gateway.is_configured().await {
        return Err("No AI provider configured".to_string());
    }

    let provider_name = gateway.provider_name().await.unwrap_or_default();

    match gateway.health_check().await {
        Ok(()) => {
            gateway.update_provider_status(true, None).await;
            tracing::info!("AI provider health check succeeded: {}", provider_name);
            Ok(format!("AI provider '{}' is reachable", provider_name))
        }
        Err(e) => {
            gateway
                .update_provider_status(false, Some(e.to_string()))
                .await;
            tracing::warn!("AI provider health check failed: {} ({})", provider_name, e);
            Err(format!(
                "AI provider '{}' is not reachable: {}",
                provider_name, e
            ))
        }
    }
}

/// Generates an EditScript from natural language using the AI provider
#[tauri::command]
pub async fn generate_edit_script_with_ai(
    intent: String,
    context: AIContextDto,
    state: State<'_, AppState>,
) -> Result<EditScriptDto, String> {
    use crate::core::ai::EditContext;

    let gateway = state.ai_gateway.lock().await;

    if !gateway.is_configured().await {
        return Err("No AI provider configured. Configure an AI provider in Settings.".to_string());
    }
    if !gateway.has_provider().await {
        return Err(
            "AI provider not reachable. Use 'Test connection' in Settings to verify connectivity."
                .to_string(),
        );
    }

    // Build the edit context
    let mut edit_context = EditContext::new()
        .with_duration(context.timeline_duration.unwrap_or(0.0))
        .with_assets(context.asset_ids.clone())
        .with_tracks(context.track_ids.clone())
        .with_selection(context.selected_clips.clone())
        .with_playhead(context.playhead_position);

    if let Some(ref transcript) = context.transcript_context {
        edit_context = edit_context.with_transcript(transcript);
    }

    // Generate edit script using the AI gateway
    let edit_script = gateway
        .generate_edit_script(&intent, &edit_context)
        .await
        .map_err(|e| e.to_ipc_error())?;

    // Convert to DTO
    Ok(EditScriptDto {
        intent: edit_script.intent,
        commands: edit_script
            .commands
            .into_iter()
            .map(|cmd| EditCommandDto {
                command_type: cmd.command_type,
                params: cmd.params,
                description: cmd.description,
            })
            .collect(),
        requires: edit_script
            .requires
            .into_iter()
            .map(|req| RequirementDto {
                kind: format!("{:?}", req.kind).to_lowercase(),
                query: req.query,
                provider: req.provider,
                params: req.params,
            })
            .collect(),
        qc_rules: edit_script.qc_rules,
        risk: RiskAssessmentDto {
            copyright: format!("{:?}", edit_script.risk.copyright).to_lowercase(),
            nsfw: format!("{:?}", edit_script.risk.nsfw).to_lowercase(),
        },
        explanation: edit_script.explanation,
        preview_plan: edit_script.preview_plan.map(|p| PreviewPlanDto {
            ranges: p
                .ranges
                .into_iter()
                .map(|r| PreviewRangeDto {
                    start_sec: r.start_sec,
                    end_sec: r.end_sec,
                })
                .collect(),
            full_render: p.full_render,
        }),
    })
}

/// Gets available AI models for a provider type
#[tauri::command]
pub async fn get_available_ai_models(provider_type: String) -> Result<Vec<String>, String> {
    use crate::core::ai::ProviderType;

    let ptype: ProviderType = provider_type.parse().map_err(|e: String| e)?;

    let models = match ptype {
        ProviderType::OpenAI => crate::core::ai::OpenAIProvider::available_models(),
        ProviderType::Anthropic => crate::core::ai::AnthropicProvider::available_models(),
        ProviderType::Local => crate::core::ai::LocalProvider::common_models(),
    };

    Ok(models)
}

// =============================================================================
// Command Registration
// =============================================================================

/// Returns all IPC command handlers for Tauri
pub fn get_handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        // Project
        create_project,
        open_project,
        save_project,
        get_project_info,
        get_project_state,
        // Assets
        import_asset,
        get_assets,
        remove_asset,
        generate_asset_thumbnail,
        generate_proxy_for_asset,
        update_asset_proxy,
        get_waveform_data,
        generate_waveform_for_asset,
        // Timeline
        get_sequences,
        create_sequence,
        get_sequence,
        // Edit
        execute_command,
        undo,
        redo,
        can_undo,
        can_redo,
        // Jobs
        get_jobs,
        cancel_job,
        // FFmpeg Utilities (from core::ffmpeg::commands)
        crate::core::ffmpeg::check_ffmpeg,
        crate::core::ffmpeg::extract_frame,
        crate::core::ffmpeg::probe_media,
        crate::core::ffmpeg::generate_thumbnail,
        crate::core::ffmpeg::generate_waveform,
        // Render
        start_render,
        // AI
        analyze_intent,
        create_proposal,
        apply_edit_script,
        validate_edit_script,
        // AI Provider
        configure_ai_provider,
        get_ai_provider_status,
        clear_ai_provider,
        test_ai_connection,
        generate_edit_script_with_ai,
        get_available_ai_models,
        // Performance/Memory
        get_memory_stats,
        trigger_memory_cleanup,
        // Transcription
        is_transcription_available,
        transcribe_asset,
        submit_transcription_job,
        // Search
        search_assets,
        is_meilisearch_available,
        search_content,
        index_asset_for_search,
        index_transcripts_for_search,
        remove_asset_from_search,
    ]
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_project_info_serialization() {
        let info = ProjectInfo {
            id: "test_id".to_string(),
            name: "Test Project".to_string(),
            path: "/path/to/project".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("testId") || json.contains("id")); // camelCase or snake_case
        assert!(json.contains("Test Project"));
    }

    #[test]
    fn test_command_result_dto_serialization() {
        let result = CommandResultDto {
            op_id: "op_001".to_string(),
            created_ids: vec!["clip_001".to_string()],
            deleted_ids: vec![],
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("opId") || json.contains("op_id"));
        assert!(json.contains("clip_001"));
    }

    #[test]
    fn test_undo_redo_result_serialization() {
        let result = UndoRedoResult {
            success: true,
            can_undo: true,
            can_redo: false,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("true"));
        assert!(json.contains("canUndo") || json.contains("can_undo"));
    }
}

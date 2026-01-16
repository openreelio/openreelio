//! Tauri IPC Commands
//!
//! Defines all commands exposed to the frontend via Tauri's invoke system.

use std::path::PathBuf;

use tauri::State;

use crate::core::{
    commands::{
        CreateSequenceCommand, ImportAssetCommand, InsertClipCommand, MoveClipCommand,
        RemoveAssetCommand, RemoveClipCommand, SplitClipCommand, TrimClipCommand,
    },
    ffmpeg::FFmpegProgress,
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
        id: ulid::Ulid::new().to_string(),
        name: project.state.meta.name.clone(),
        path: path.clone(),
        created_at: project.state.meta.created_at.clone(),
    };

    // Store in app state
    let mut guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;
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
        id: ulid::Ulid::new().to_string(),
        name: project.state.meta.name.clone(),
        path: path.clone(),
        created_at: project.state.meta.created_at.clone(),
    };

    // Store in app state
    let mut guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;
    *guard = Some(project);

    Ok(info)
}

/// Saves the current project
#[tauri::command]
pub async fn save_project(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    project.save().map_err(|e| e.to_ipc_error())
}

/// Gets current project info
#[tauri::command]
pub async fn get_project_info(state: State<'_, AppState>) -> Result<Option<ProjectInfo>, String> {
    let guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

    Ok(guard.as_ref().map(|p| ProjectInfo {
        id: ulid::Ulid::new().to_string(),
        name: p.state.meta.name.clone(),
        path: p.path.to_string_lossy().to_string(),
        created_at: p.state.meta.created_at.clone(),
    }))
}

/// Gets the full project state for frontend sync
#[tauri::command]
pub async fn get_project_state(state: State<'_, AppState>) -> Result<ProjectStateDto, String> {
    let guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

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
        assets: project
            .state
            .assets
            .values()
            .map(|a| serde_json::to_value(a).unwrap_or_default())
            .collect(),
        sequences: project
            .state
            .sequences
            .values()
            .map(|s| serde_json::to_value(s).unwrap_or_default())
            .collect(),
        active_sequence_id: project.state.active_sequence_id.clone(),
        is_dirty: project.state.is_dirty,
    })
}

// =============================================================================
// Asset Commands
// =============================================================================

/// Imports an asset into the project
#[tauri::command]
pub async fn import_asset(
    uri: String,
    state: State<'_, AppState>,
) -> Result<AssetImportResult, String> {
    let mut guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    // Create import command
    let path = std::path::Path::new(&uri);
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

    Ok(AssetImportResult {
        asset_id,
        name,
        op_id: result.op_id,
        job_id: None, // TODO: Add job for proxy generation
    })
}

/// Gets all assets in the project
#[tauri::command]
pub async fn get_assets(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

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
        let guard = state
            .project
            .lock()
            .map_err(|_| "Failed to acquire lock".to_string())?;

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
                let mut guard = state
                    .project
                    .lock()
                    .map_err(|_| "Failed to acquire lock".to_string())?;

                if let Some(project) = guard.as_mut() {
                    if let Some(asset) = project.state.assets.get_mut(&asset_id) {
                        asset.set_thumbnail_url(Some(url.to_string()));
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
        let guard = state
            .project
            .lock()
            .map_err(|_| "Failed to acquire lock".to_string())?;

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

    // Spawn progress forwarding task
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
                let mut guard = state
                    .project
                    .lock()
                    .map_err(|_| "Failed to acquire lock".to_string())?;

                if let Some(project) = guard.as_mut() {
                    if let Some(asset) = project.state.assets.get_mut(&asset_id) {
                        asset.set_proxy_url(Some(proxy_url.clone()));
                    }
                }
            }

            tracing::info!("Generated proxy for asset {}: {:?}", asset_id, proxy_path);

            // Emit completion event
            let _ = app_handle.emit(
                "proxy-complete",
                serde_json::json!({
                    "assetId": asset_id,
                    "proxyUrl": proxy_url,
                }),
            );

            Ok(Some(proxy_url))
        }
        Err(e) => {
            tracing::warn!("Failed to generate proxy for {}: {}", asset_id, e);

            // Emit error event
            let _ = app_handle.emit(
                "proxy-error",
                serde_json::json!({
                    "assetId": asset_id,
                    "error": e.to_string(),
                }),
            );

            Err(format!("Proxy generation failed: {}", e))
        }
    }
}

/// Removes an asset from the project
#[tauri::command]
pub async fn remove_asset(asset_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

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
    let guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

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
    let mut guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

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
    let guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

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

/// Executes an edit command
#[tauri::command]
pub async fn execute_command(
    command_type: String,
    payload: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<CommandResultDto, String> {
    let mut guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    // Route to appropriate command based on type
    let command: Box<dyn crate::core::commands::Command> = match command_type.as_str() {
        "insertClip" | "InsertClip" => {
            let seq_id = payload["sequenceId"].as_str().ok_or("Missing sequenceId")?;
            let track_id = payload["trackId"].as_str().ok_or("Missing trackId")?;
            let asset_id = payload["assetId"].as_str().ok_or("Missing assetId")?;
            let timeline_in = payload["timelineIn"].as_f64().unwrap_or(0.0);

            Box::new(InsertClipCommand::new(
                seq_id,
                track_id,
                asset_id,
                timeline_in,
            ))
        }
        "removeClip" | "RemoveClip" | "deleteClip" | "DeleteClip" => {
            let seq_id = payload["sequenceId"].as_str().ok_or("Missing sequenceId")?;
            let track_id = payload["trackId"].as_str().ok_or("Missing trackId")?;
            let clip_id = payload["clipId"].as_str().ok_or("Missing clipId")?;

            Box::new(RemoveClipCommand::new(seq_id, track_id, clip_id))
        }
        "moveClip" | "MoveClip" => {
            let seq_id = payload["sequenceId"].as_str().ok_or("Missing sequenceId")?;
            let track_id = payload["trackId"].as_str().ok_or("Missing trackId")?;
            let clip_id = payload["clipId"].as_str().ok_or("Missing clipId")?;
            let new_timeline_in = payload["newTimelineIn"]
                .as_f64()
                .ok_or("Missing newTimelineIn")?;
            let new_track_id = payload["newTrackId"].as_str().map(|s| s.to_string());

            Box::new(MoveClipCommand::new(
                seq_id,
                track_id,
                clip_id,
                new_timeline_in,
                new_track_id,
            ))
        }
        "trimClip" | "TrimClip" => {
            let seq_id = payload["sequenceId"].as_str().ok_or("Missing sequenceId")?;
            let track_id = payload["trackId"].as_str().ok_or("Missing trackId")?;
            let clip_id = payload["clipId"].as_str().ok_or("Missing clipId")?;
            let new_source_in = payload["newSourceIn"].as_f64();
            let new_source_out = payload["newSourceOut"].as_f64();
            let new_timeline_in = payload["newTimelineIn"].as_f64();

            Box::new(TrimClipCommand::new(
                seq_id,
                track_id,
                clip_id,
                new_source_in,
                new_source_out,
                new_timeline_in,
            ))
        }
        "importAsset" | "ImportAsset" => {
            let name = payload["name"].as_str().ok_or("Missing name")?;
            let uri = payload["uri"].as_str().ok_or("Missing uri")?;

            Box::new(ImportAssetCommand::new(name, uri))
        }
        "removeAsset" | "RemoveAsset" => {
            let asset_id = payload["assetId"].as_str().ok_or("Missing assetId")?;

            Box::new(RemoveAssetCommand::new(asset_id))
        }
        "createSequence" | "CreateSequence" => {
            let name = payload["name"].as_str().ok_or("Missing name")?;
            let format = payload["format"].as_str().unwrap_or("1080p");

            Box::new(CreateSequenceCommand::new(name, format))
        }
        "splitClip" | "SplitClip" => {
            let seq_id = payload["sequenceId"].as_str().ok_or("Missing sequenceId")?;
            let track_id = payload["trackId"].as_str().ok_or("Missing trackId")?;
            let clip_id = payload["clipId"].as_str().ok_or("Missing clipId")?;
            let split_time = payload["splitTime"].as_f64().ok_or("Missing splitTime")?;

            Box::new(SplitClipCommand::new(seq_id, track_id, clip_id, split_time))
        }
        _ => {
            return Err(CoreError::InvalidCommand(format!(
                "Unknown command type: {}",
                command_type
            ))
            .to_ipc_error())
        }
    };

    let result = project
        .executor
        .execute(command, &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    Ok(CommandResultDto {
        op_id: result.op_id,
        created_ids: result.created_ids,
        deleted_ids: result.deleted_ids,
    })
}

/// Undoes the last command
#[tauri::command]
pub async fn undo(state: State<'_, AppState>) -> Result<UndoRedoResult, String> {
    let mut guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

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
    let mut guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

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
    let guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

    Ok(guard
        .as_ref()
        .map(|p| p.executor.can_undo())
        .unwrap_or(false))
}

/// Checks if redo is available
#[tauri::command]
pub async fn can_redo(state: State<'_, AppState>) -> Result<bool, String> {
    let guard = state
        .project
        .lock()
        .map_err(|_| "Failed to acquire lock".to_string())?;

    Ok(guard
        .as_ref()
        .map(|p| p.executor.can_redo())
        .unwrap_or(false))
}

// =============================================================================
// Job Commands
// =============================================================================

/// Gets all jobs
#[tauri::command]
pub async fn get_jobs() -> Result<Vec<serde_json::Value>, String> {
    // TODO: Implement job management
    Ok(vec![])
}

/// Cancels a job
#[tauri::command]
pub async fn cancel_job(_job_id: String) -> Result<bool, String> {
    // TODO: Implement job cancellation
    Ok(false)
}

// =============================================================================
// Render Commands
// =============================================================================

/// Starts final render export
#[tauri::command]
pub async fn start_render(
    sequence_id: String,
    output_path: String,
    preset: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<RenderStartResult, String> {
    use crate::core::render::{ExportEngine, ExportPreset, ExportProgress, ExportSettings};
    use std::path::PathBuf;
    use tauri::Emitter;

    // Get sequence and assets from project state
    let (sequence, assets) = {
        let guard = state
            .project
            .lock()
            .map_err(|_| "Failed to acquire lock".to_string())?;

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
    let ffmpeg = ffmpeg_guard
        .runner()
        .ok_or_else(|| "FFmpeg not initialized".to_string())?;

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

    // Create export engine and start export
    let engine = ExportEngine::new(ffmpeg.clone());
    let job_id = ulid::Ulid::new().to_string();
    let job_id_clone = job_id.clone();

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

    // Run export with progress callback
    match engine
        .export_sequence(&sequence, &assets, &settings, Some(progress_tx))
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
            let _ = app_handle.emit(
                "render-complete",
                serde_json::json!({
                    "jobId": job_id,
                    "outputPath": result.output_path.to_string_lossy().to_string(),
                    "durationSec": result.duration_sec,
                    "fileSize": result.file_size,
                    "encodingTimeSec": result.encoding_time_sec,
                }),
            );

            Ok(RenderStartResult {
                job_id,
                output_path: result.output_path.to_string_lossy().to_string(),
                status: "completed".to_string(),
            })
        }
        Err(e) => {
            // Emit error event
            let _ = app_handle.emit(
                "render-error",
                serde_json::json!({
                    "jobId": job_id,
                    "error": e.to_string(),
                }),
            );
            Err(format!("Export failed: {}", e))
        }
    }
}

// =============================================================================
// DTOs (Data Transfer Objects)
// =============================================================================

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetaDto {
    pub name: String,
    pub version: String,
    pub created_at: String,
    pub modified_at: String,
    pub description: Option<String>,
    pub author: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStateDto {
    pub meta: ProjectMetaDto,
    pub assets: Vec<serde_json::Value>,
    pub sequences: Vec<serde_json::Value>,
    pub active_sequence_id: Option<String>,
    pub is_dirty: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportResult {
    pub asset_id: String,
    pub name: String,
    pub op_id: String,
    pub job_id: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResultDto {
    pub op_id: String,
    pub created_ids: Vec<String>,
    pub deleted_ids: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRedoResult {
    pub success: bool,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStartResult {
    pub job_id: String,
    pub output_path: String,
    pub status: String,
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
        // Render
        start_render,
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

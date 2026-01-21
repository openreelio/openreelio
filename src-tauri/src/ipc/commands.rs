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
    let mut guard = state.project.lock().await;

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
                let mut guard = state.project.lock().await;

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

/// Executes an edit command
#[tauri::command]
pub async fn execute_command(
    command_type: String,
    payload: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<CommandResultDto, String> {
    let mut guard = state.project.lock().await;

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

/// Job info DTO for frontend
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfoDto {
    pub id: String,
    pub job_type: String,
    pub priority: String,
    pub status: JobStatusDto,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// Job status DTO for frontend
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum JobStatusDto {
    Queued,
    Running {
        progress: f32,
        message: Option<String>,
    },
    Completed {
        result: serde_json::Value,
    },
    Failed {
        error: String,
    },
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
            })
            .collect(),
        qc_rules: script.qc_rules,
        risk: RiskAssessmentDto {
            copyright: format!("{:?}", script.risk.copyright).to_lowercase(),
            nsfw: format!("{:?}", script.risk.nsfw).to_lowercase(),
        },
        explanation: script.explanation,
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
        // Build payload with sequence_id injected
        let mut payload = cmd.params.clone();
        if payload.get("sequenceId").is_none() {
            payload["sequenceId"] = serde_json::json!(sequence_id);
        }

        // Create command
        let command: Result<Box<dyn crate::core::commands::Command>, String> =
            match cmd.command_type.as_str() {
                "InsertClip" => {
                    let track_id = payload["trackId"]
                        .as_str()
                        .ok_or("Missing trackId")?
                        .to_string();
                    let asset_id = payload["assetId"]
                        .as_str()
                        .ok_or("Missing assetId")?
                        .to_string();
                    let timeline_in = payload["timelineStart"]
                        .as_f64()
                        .or_else(|| payload["timelineIn"].as_f64())
                        .unwrap_or(0.0);

                    Ok(Box::new(InsertClipCommand::new(
                        &sequence_id,
                        &track_id,
                        &asset_id,
                        timeline_in,
                    )))
                }
                "SplitClip" => {
                    let clip_id = payload["clipId"]
                        .as_str()
                        .ok_or("Missing clipId")?
                        .to_string();
                    let at_sec = payload["atTimelineSec"]
                        .as_f64()
                        .or_else(|| payload["splitTime"].as_f64())
                        .ok_or("Missing split time")?;

                    // Find the track containing this clip
                    let track_id = find_track_for_clip(project, &sequence_id, &clip_id)?;

                    Ok(Box::new(SplitClipCommand::new(
                        &sequence_id,
                        &track_id,
                        &clip_id,
                        at_sec,
                    )))
                }
                "DeleteClip" => {
                    let clip_id = payload["clipId"]
                        .as_str()
                        .ok_or("Missing clipId")?
                        .to_string();

                    let track_id = find_track_for_clip(project, &sequence_id, &clip_id)?;

                    Ok(Box::new(RemoveClipCommand::new(
                        &sequence_id,
                        &track_id,
                        &clip_id,
                    )))
                }
                "TrimClip" => {
                    let clip_id = payload["clipId"]
                        .as_str()
                        .ok_or("Missing clipId")?
                        .to_string();
                    let new_start = payload["newStart"].as_f64();
                    let new_end = payload["newEnd"].as_f64();

                    let track_id = find_track_for_clip(project, &sequence_id, &clip_id)?;

                    Ok(Box::new(TrimClipCommand::new(
                        &sequence_id,
                        &track_id,
                        &clip_id,
                        new_start,
                        new_end,
                        None,
                    )))
                }
                "MoveClip" => {
                    let clip_id = payload["clipId"]
                        .as_str()
                        .ok_or("Missing clipId")?
                        .to_string();
                    let new_start = payload["newStart"].as_f64().ok_or("Missing newStart")?;
                    let new_track_id = payload["newTrackId"].as_str().map(|s| s.to_string());

                    let track_id = find_track_for_clip(project, &sequence_id, &clip_id)?;

                    Ok(Box::new(MoveClipCommand::new(
                        &sequence_id,
                        &track_id,
                        &clip_id,
                        new_start,
                        new_track_id,
                    )))
                }
                _ => Err(format!("Unknown command type: {}", cmd.command_type)),
            };

        match command {
            Ok(cmd) => match project.executor.execute(cmd, &mut project.state) {
                Ok(result) => {
                    applied_op_ids.push(result.op_id);
                }
                Err(e) => {
                    errors.push(format!("Command execution failed: {}", e));
                }
            },
            Err(e) => {
                errors.push(e);
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
// AI DTOs
// =============================================================================

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIContextDto {
    pub playhead_position: f64,
    pub selected_clips: Vec<String>,
    pub selected_tracks: Vec<String>,
    pub transcript_context: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditScriptDto {
    pub intent: String,
    pub commands: Vec<EditCommandDto>,
    pub requires: Vec<RequirementDto>,
    pub qc_rules: Vec<String>,
    pub risk: RiskAssessmentDto,
    pub explanation: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCommandDto {
    pub command_type: String,
    pub params: serde_json::Value,
    pub description: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementDto {
    pub kind: String,
    pub query: Option<String>,
    pub provider: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskAssessmentDto {
    pub copyright: String,
    pub nsfw: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDto {
    pub id: String,
    pub edit_script: EditScriptDto,
    pub status: String,
    pub created_at: String,
    pub preview_job_id: Option<String>,
    pub applied_op_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEditScriptResult {
    pub success: bool,
    pub applied_op_ids: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResultDto {
    pub is_valid: bool,
    pub issues: Vec<String>,
    pub warnings: Vec<String>,
}

// =============================================================================
// Performance/Memory Commands
// =============================================================================

/// Memory statistics DTO for frontend
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatsDto {
    /// Pool statistics
    pub pool_stats: PoolStatsDto,
    /// Cache statistics
    pub cache_stats: CacheStatsDto,
    /// Total allocated bytes (Rust side)
    pub allocated_bytes: u64,
    /// System memory info
    pub system_memory: Option<SystemMemoryDto>,
}

/// Pool statistics DTO
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatsDto {
    pub total_blocks: usize,
    pub allocated_blocks: usize,
    pub total_size_bytes: u64,
    pub used_size_bytes: u64,
    pub allocation_count: u64,
    pub release_count: u64,
    pub pool_hits: u64,
    pub pool_misses: u64,
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

/// Cache statistics DTO
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatsDto {
    pub entry_count: usize,
    pub total_size_bytes: u64,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
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

/// System memory information
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
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

/// Memory cleanup result
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
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

/// DTO for transcription result
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResultDto {
    /// Detected or specified language
    pub language: String,
    /// Transcribed segments
    pub segments: Vec<TranscriptionSegmentDto>,
    /// Total duration in seconds
    pub duration: f64,
    /// Full transcription text
    pub full_text: String,
}

/// DTO for a transcription segment
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegmentDto {
    /// Start time in seconds
    pub start_time: f64,
    /// End time in seconds
    pub end_time: f64,
    /// Transcribed text
    pub text: String,
}

/// DTO for transcription options
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOptionsDto {
    /// Language code (e.g., "en", "ko") or "auto" for detection
    pub language: Option<String>,
    /// Whether to translate to English
    pub translate: Option<bool>,
    /// Whisper model to use (tiny, base, small, medium, large)
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
    // Create job payload
    let payload = serde_json::json!({
        "assetId": asset_id,
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

/// DTO for search options
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
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
    /// Search only specific indexes (assets, transcripts)
    pub indexes: Option<Vec<String>>,
}

/// DTO for asset search results
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSearchResultDto {
    /// Asset ID
    pub id: String,
    /// Asset name
    pub name: String,
    /// File path
    pub path: String,
    /// Asset kind
    pub kind: String,
    /// Duration in seconds
    pub duration: Option<f64>,
    /// Tags
    pub tags: Vec<String>,
}

/// DTO for transcript search results
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchResultDto {
    /// Segment ID
    pub id: String,
    /// Asset ID
    pub asset_id: String,
    /// Text content
    pub text: String,
    /// Start time in seconds
    pub start_time: f64,
    /// End time in seconds
    pub end_time: f64,
    /// Language code
    pub language: Option<String>,
}

/// DTO for combined search results
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultsDto {
    /// Asset results
    pub assets: Vec<AssetSearchResultDto>,
    /// Transcript results
    pub transcripts: Vec<TranscriptSearchResultDto>,
    /// Total number of asset hits (estimated)
    pub asset_total: Option<usize>,
    /// Total number of transcript hits (estimated)
    pub transcript_total: Option<usize>,
    /// Processing time in milliseconds
    pub processing_time_ms: u64,
}

/// Checks if Meilisearch is available
#[tauri::command]
pub async fn is_meilisearch_available() -> Result<bool, String> {
    Ok(crate::core::search::meilisearch::is_meilisearch_available())
}

/// Performs a full-text search using Meilisearch
#[tauri::command]
pub async fn search_content(
    query: String,
    options: Option<SearchOptionsDto>,
) -> Result<SearchResultsDto, String> {
    use crate::core::search::meilisearch::{is_meilisearch_available, SearchOptions};

    // Check if Meilisearch is available
    if !is_meilisearch_available() {
        return Err("Meilisearch feature not enabled".to_string());
    }

    // For now, return empty results since we need a running Meilisearch instance
    // In production, this would connect to the indexer
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

    // Log the search query
    tracing::debug!(
        "Search query: '{}', limit: {}, offset: {}",
        query,
        search_options.limit,
        search_options.offset
    );

    // Return empty results for now (requires running Meilisearch instance)
    Ok(SearchResultsDto {
        assets: vec![],
        transcripts: vec![],
        asset_total: Some(0),
        transcript_total: Some(0),
        processing_time_ms: 0,
    })
}

/// Indexes an asset in Meilisearch
#[tauri::command]
pub async fn index_asset_for_search(
    asset_id: String,
    name: String,
    _path: String,
    _kind: String,
    duration: Option<f64>,
    _tags: Option<Vec<String>>,
) -> Result<(), String> {
    use crate::core::search::meilisearch::is_meilisearch_available;

    if !is_meilisearch_available() {
        return Err("Meilisearch feature not enabled".to_string());
    }

    tracing::info!(
        "Indexing asset for search: {} ({}) - duration: {:?}",
        asset_id,
        name,
        duration
    );

    // In production, this would add to the Meilisearch index
    Ok(())
}

/// Indexes transcript segments for an asset
#[tauri::command]
pub async fn index_transcripts_for_search(
    asset_id: String,
    segments: Vec<TranscriptionSegmentDto>,
    language: Option<String>,
) -> Result<(), String> {
    use crate::core::search::meilisearch::is_meilisearch_available;

    if !is_meilisearch_available() {
        return Err("Meilisearch feature not enabled".to_string());
    }

    tracing::info!(
        "Indexing {} transcript segments for asset: {} (language: {:?})",
        segments.len(),
        asset_id,
        language
    );

    // In production, this would add to the Meilisearch index
    Ok(())
}

/// Removes an asset and its transcripts from the search index
#[tauri::command]
pub async fn remove_asset_from_search(asset_id: String) -> Result<(), String> {
    use crate::core::search::meilisearch::is_meilisearch_available;

    if !is_meilisearch_available() {
        return Err("Meilisearch feature not enabled".to_string());
    }

    tracing::info!("Removing asset from search index: {}", asset_id);

    // In production, this would remove from the Meilisearch index
    Ok(())
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
        // Performance/Memory
        get_memory_stats,
        trigger_memory_cleanup,
        // Transcription
        is_transcription_available,
        transcribe_asset,
        submit_transcription_job,
        // Search (Meilisearch)
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

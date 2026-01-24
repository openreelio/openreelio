//! Tauri IPC Commands
//!
//! Defines all commands exposed to the frontend via Tauri's invoke system.
//! All types are exported to TypeScript via tauri-specta for type-safe API calls.

use std::path::PathBuf;

use specta::Type;
use tauri::{Manager, State};

use crate::core::{
    assets::{Asset, ProxyStatus},
    commands::{
        CreateSequenceCommand, ImportAssetCommand, InsertClipCommand, MoveClipCommand,
        RemoveAssetCommand, RemoveClipCommand, SplitClipCommand, TrimClipCommand,
        UpdateAssetCommand,
    },
    ffmpeg::FFmpegProgress,
    fs::{
        default_export_allowed_roots, validate_existing_project_dir, validate_local_input_path,
        validate_path_id_component, validate_scoped_output_path,
    },
    jobs::{Job, JobStatus, JobType, Priority},
    performance::memory::{CacheStats, PoolStats},
    settings::{AppSettings, SettingsManager},
    timeline::Sequence,
    CoreError,
};
use crate::ipc::serialize_to_json_string;
use crate::{ActiveProject, AppState};

fn allow_project_asset_protocol(
    state: &AppState,
    project_path: &std::path::Path,
    assets: &[Asset],
) {
    // Allow the project-managed runtime directory used by previews, thumbnails, waveforms, etc.
    state.allow_asset_protocol_directory(&project_path.join(".openreelio"), true);

    // Allow imported asset source files (read-only via the asset protocol).
    // This is intentionally scoped to the files referenced by the project state, not arbitrary paths.
    for asset in assets {
        let uri = asset.uri.trim();
        if uri.is_empty() {
            continue;
        }

        let path = PathBuf::from(uri);
        if !path.is_absolute() {
            tracing::warn!(
                "Skipping non-absolute asset uri for asset protocol scope: assetId={}, uri={}",
                asset.id,
                uri
            );
            continue;
        }

        // Only allow existing files to avoid pre-authorizing future paths.
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.is_file() {
                state.allow_asset_protocol_file(&path);
            }
        }
    }
}

fn forbid_project_asset_protocol(
    state: &AppState,
    project_path: &std::path::Path,
    assets: &[Asset],
) {
    // Forbid the project-managed runtime directory.
    state.forbid_asset_protocol_directory(&project_path.join(".openreelio"), true);

    // Forbid imported asset source files.
    for asset in assets {
        let uri = asset.uri.trim();
        if uri.is_empty() {
            continue;
        }

        let path = PathBuf::from(uri);
        if !path.is_absolute() {
            continue;
        }

        // Forbid the path regardless of current existence to avoid stale scope entries.
        state.forbid_asset_protocol_file(&path);
    }
}

// =============================================================================
// Project Commands
// =============================================================================

/// Creates a new project
///
/// This function uses atomic operations to prevent TOCTOU race conditions:
/// 1. Creates a lock file to prevent concurrent project creation
/// 2. Verifies directory state while holding the lock
/// 3. Creates project files atomically
#[tauri::command]
#[tracing::instrument(skip(state), fields(project_name = %name, project_path = %path))]
pub async fn create_project(
    name: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectInfo, String> {
    use fs2::FileExt;
    use std::fs::OpenOptions;

    let name_trimmed = name.trim();
    if name_trimmed.is_empty() {
        return Err("Project name is empty".to_string());
    }
    if name_trimmed.chars().any(|c| c.is_control()) {
        return Err("Project name contains control characters".to_string());
    }
    if name_trimmed.len() > 100 {
        return Err("Project name is too long (max 100 characters)".to_string());
    }

    // If another project is open, refuse to replace it if it has unsaved changes.
    let previous_scope = {
        let guard = state.project.lock().await;
        if let Some(p) = guard.as_ref() {
            if p.state.is_dirty {
                return Err("A project is already open with unsaved changes. Save it before creating a new project.".to_string());
            }

            let assets: Vec<Asset> = p.state.assets.values().cloned().collect();
            Some((p.path.clone(), assets))
        } else {
            None
        }
    };

    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Project path is empty".to_string());
    }

    let project_path = PathBuf::from(trimmed);
    if !project_path.is_absolute() {
        return Err(format!(
            "Project path must be absolute: {}",
            project_path.display()
        ));
    }

    // Create parent directory if needed (but not the project directory itself yet)
    if let Some(parent) = project_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create parent directory: {e}"))?;
        }
    }

    // Create a lock file in the parent directory to serialize project creation
    let lock_path = project_path.with_extension("lock");
    let lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|e| format!("Failed to create project lock file: {e}"))?;

    // Acquire exclusive lock to prevent concurrent project creation
    lock_file
        .lock_exclusive()
        .map_err(|e| format!("Failed to acquire project lock: {e}"))?;

    // After acquiring the lock, verify the directory state
    // This prevents TOCTOU race conditions
    let result = (|| {
        if project_path.exists() {
            if !project_path.is_dir() {
                return Err(format!(
                    "Project path must be a directory: {}",
                    project_path.display()
                ));
            }

            // Check for existing project files (our own files)
            let has_project_json = project_path.join("project.json").exists();
            let has_ops_log = project_path.join("ops.jsonl").exists();
            if has_project_json || has_ops_log {
                return Err(format!(
                    "A project already exists at: {}",
                    project_path.display()
                ));
            }

            // Check if directory is non-empty (excluding hidden files we might have created)
            let has_user_files = std::fs::read_dir(&project_path)
                .map_err(|e| format!("Failed to read project directory: {e}"))?
                .filter_map(|e| e.ok())
                .any(|entry| {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    // Allow hidden directories that might be for caching
                    !name_str.starts_with('.')
                });

            if has_user_files {
                return Err(format!(
                    "Project directory is not empty: {}",
                    project_path.display()
                ));
            }
        }

        // Create project with atomic file operations
        let project = ActiveProject::create(name_trimmed, project_path.clone())
            .map_err(|e| e.to_ipc_error())?;

        tracing::info!(
            "Created new project '{}' at {}",
            name,
            project_path.display()
        );

        Ok(project)
    })();

    // Release lock and clean up lock file.
    // Dropping the file handle releases the OS-level lock.
    drop(lock_file);
    let _ = std::fs::remove_file(&lock_path);

    let project = result?;

    // Canonicalize after creation to avoid mixed path representations.
    let project_path_canon =
        std::fs::canonicalize(&project.path).unwrap_or_else(|_| project.path.clone());

    let info = ProjectInfo {
        id: project.state.meta.id.clone(),
        name: project.state.meta.name.clone(),
        path: project_path_canon.to_string_lossy().to_string(),
        created_at: project.state.meta.created_at.clone(),
    };

    // Store in app state
    let mut guard = state.project.lock().await;

    // Replace the existing project (if any) after forbidding its asset protocol scope.
    if let Some((old_path, old_assets)) = previous_scope {
        forbid_project_asset_protocol(&state, &old_path, &old_assets);
    }

    *guard = Some(project);

    // Allowlist the project-managed workspace for previews/thumbnails.
    // Asset files themselves are allowlisted on import.
    allow_project_asset_protocol(&state, &project_path_canon, &[]);

    Ok(info)
}

/// Opens an existing project
#[tauri::command]
#[tracing::instrument(skip(state), fields(project_path = %path))]
pub async fn open_project(path: String, state: State<'_, AppState>) -> Result<ProjectInfo, String> {
    // If another project is open, refuse to replace it if it has unsaved changes.
    let previous_scope = {
        let guard = state.project.lock().await;
        if let Some(p) = guard.as_ref() {
            if p.state.is_dirty {
                return Err("A project is already open with unsaved changes. Save it before opening another project.".to_string());
            }

            let assets: Vec<Asset> = p.state.assets.values().cloned().collect();
            Some((p.path.clone(), assets))
        } else {
            None
        }
    };

    let project_path = validate_existing_project_dir(&path, "Project path")
        .map_err(|e| CoreError::ValidationError(e).to_ipc_error())?;
    let path = project_path.to_string_lossy().to_string();

    let project = ActiveProject::open(project_path).map_err(|e| e.to_ipc_error())?;
    let assets_for_scope: Vec<Asset> = project.state.assets.values().cloned().collect();
    let project_path_for_scope =
        std::fs::canonicalize(&project.path).unwrap_or_else(|_| project.path.clone());

    let info = ProjectInfo {
        id: project.state.meta.id.clone(),
        name: project.state.meta.name.clone(),
        path: path.clone(),
        created_at: project.state.meta.created_at.clone(),
    };

    // Store in app state
    let mut guard = state.project.lock().await;

    // Replace the existing project (if any) after forbidding its asset protocol scope.
    if let Some((old_path, old_assets)) = previous_scope {
        forbid_project_asset_protocol(&state, &old_path, &old_assets);
    }

    *guard = Some(project);

    // Restrict asset protocol to exactly what the opened project needs.
    allow_project_asset_protocol(&state, &project_path_for_scope, &assets_for_scope);

    Ok(info)
}

/// Closes the current project, optionally requiring it to be saved.
#[tauri::command]
pub async fn close_project(
    require_saved: Option<bool>,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let require_saved = require_saved.unwrap_or(true);

    let previous_scope = {
        let mut guard = state.project.lock().await;
        let Some(p) = guard.take() else {
            return Ok(false);
        };

        if require_saved && p.state.is_dirty {
            // Restore the project back into state.
            *guard = Some(p);
            return Err("Project has unsaved changes. Save it before closing.".to_string());
        }

        let assets: Vec<Asset> = p.state.assets.values().cloned().collect();
        (p.path, assets)
    };

    forbid_project_asset_protocol(&state, &previous_scope.0, &previous_scope.1);
    Ok(true)
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
#[tracing::instrument(skip(state), fields(uri = %uri))]
pub async fn import_asset(
    uri: String,
    state: State<'_, AppState>,
) -> Result<AssetImportResult, String> {
    use crate::core::assets::{requires_proxy, ProxyStatus};

    // Phase 1: Import asset (holds project lock)
    let (asset_id, name, op_id, needs_proxy) = {
        let mut guard = state.project.lock().await;
        let project = guard
            .as_mut()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        // Create import command - use centralized path validation
        let path = validate_local_input_path(&uri, "Asset path")?;
        state.allow_asset_protocol_file(&path);
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
pub async fn get_assets(state: State<'_, AppState>) -> Result<Vec<Asset>, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    Ok(project.state.assets.values().cloned().collect())
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

    validate_path_id_component(&asset_id, "assetId")?;

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

    validate_path_id_component(&asset_id, "assetId")?;

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
            // Return raw file path; frontend converts to asset protocol via convertFileSrc().
            let proxy_url = proxy_path.to_string_lossy().to_string();

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
                    "proxyUrl": proxy_url.clone(),
                }),
            );

            // Emit legacy completion event
            let _ = app_handle.emit(
                "proxy-complete",
                serde_json::json!({
                    "assetId": asset_id.clone(),
                    "proxyUrl": proxy_url.clone(),
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
    proxy_status: ProxyStatus,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_path_id_component(&asset_id, "assetId")?;

    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let mut cmd = UpdateAssetCommand::new(&asset_id).with_proxy_status(proxy_status.clone());
    if let Some(url) = proxy_url {
        cmd = cmd.with_proxy_url(Some(url));
    }

    project
        .executor
        .execute_without_history(Box::new(cmd), &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    tracing::info!(
        "Updated asset {} proxy status to {:?}",
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
    validate_path_id_component(&asset_id, "assetId")?;

    // Get project path and verify asset exists.
    let project_path = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        if !project.state.assets.contains_key(&asset_id) {
            return Ok(None);
        }

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

    validate_path_id_component(&asset_id, "assetId")?;

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
pub async fn get_sequences(state: State<'_, AppState>) -> Result<Vec<Sequence>, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    Ok(project.state.sequences.values().cloned().collect())
}

/// Creates a new sequence
#[tauri::command]
pub async fn create_sequence(
    name: String,
    format: String,
    state: State<'_, AppState>,
) -> Result<Sequence, String> {
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

    Ok(sequence.clone())
}

/// Gets a specific sequence by ID
#[tauri::command]
pub async fn get_sequence(
    sequence_id: String,
    state: State<'_, AppState>,
) -> Result<Sequence, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| CoreError::SequenceNotFound(sequence_id).to_ipc_error())?;

    Ok(sequence.clone())
}

// =============================================================================
// Edit Commands
// =============================================================================

use crate::ipc::payloads::CommandPayload;

/// Executes an edit command
#[tauri::command]
#[tracing::instrument(skip(state, payload), fields(command_type = %command_type))]
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
#[tracing::instrument(skip(state, payload), fields(job_type = %job_type))]
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
#[tracing::instrument(skip(state, ffmpeg_state, app_handle), fields(sequence_id = %sequence_id, preset = %preset, output_path = %output_path))]
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
    use tauri::Emitter;

    // Get sequence/assets + project path from project state
    let (sequence, assets, project_path) = {
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

        (sequence, assets, project.path.clone())
    };

    // Validate output path within allowed roots (defense-in-depth for compromised renderer).
    let roots = default_export_allowed_roots(&project_path);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    let validated_output_path =
        validate_scoped_output_path(&output_path, "Output path", &root_refs)?;
    tracing::debug!(
        "Validated output path: {} (allowedRoots={})",
        validated_output_path.display(),
        root_refs
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );

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

    // Create export settings using validated path
    let settings = ExportSettings::from_preset(export_preset, validated_output_path.clone());

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

    let requires = script
        .requires
        .into_iter()
        .map(|r| {
            Ok(RequirementDto {
                kind: serialize_to_json_string(&r.kind)
                    .map_err(|e| format!("Failed to serialize requirement kind: {e}"))?,
                query: r.query,
                provider: r.provider,
                params: r.params,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let copyright = serialize_to_json_string(&script.risk.copyright)
        .map_err(|e| format!("Failed to serialize risk.copyright: {e}"))?;
    let nsfw = serialize_to_json_string(&script.risk.nsfw)
        .map_err(|e| format!("Failed to serialize risk.nsfw: {e}"))?;

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
        requires,
        qc_rules: script.qc_rules,
        risk: RiskAssessmentDto { copyright, nsfw },
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

    // Helper for time validation (defined once, used in loop)
    let validate_time_sec = |field: &str, value: f64| -> Result<(), String> {
        if value.is_finite() && value >= 0.0 {
            Ok(())
        } else {
            Err(format!(
                "Invalid {field}: must be a finite, non-negative number"
            ))
        }
    };

    // Execute each command in order
    for cmd in &edit_script.commands {
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
        if !cmd.params.is_object() {
            issues.push(format!(
                "{} command {} has invalid params: expected JSON object",
                cmd.command_type, i
            ));
            continue;
        }

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
                if let Some(v) = cmd.params.get("timelineStart").and_then(|v| v.as_f64()) {
                    if !v.is_finite() || v < 0.0 {
                        issues.push(format!(
                            "InsertClip command {} has invalid timelineStart: must be finite and non-negative",
                            i
                        ));
                    }
                }
            }
            "SplitClip" | "DeleteClip" | "TrimClip" | "MoveClip" => {
                if cmd.params.get("clipId").is_none() {
                    issues.push(format!("{} command {} missing clipId", cmd.command_type, i));
                }
            }
            _ => {
                issues.push(format!("Unknown command type: {}", cmd.command_type));
            }
        }
    }

    // Check risk levels
    match edit_script.risk.copyright.as_str() {
        "none" | "low" | "medium" | "high" => {}
        other => issues.push(format!("Invalid risk.copyright value: {}", other)),
    }
    match edit_script.risk.nsfw.as_str() {
        "none" | "possible" | "likely" => {}
        other => issues.push(format!("Invalid risk.nsfw value: {}", other)),
    }

    if edit_script.risk.copyright == "high" {
        warnings.push("High copyright risk detected".to_string());
    }
    if edit_script.risk.nsfw == "likely" {
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
    /// NSFW risk level ("none", "possible", "likely")
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
// Caption Export Commands
// =============================================================================

/// Export format for captions
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CaptionExportFormat {
    /// SubRip format (.srt)
    Srt,
    /// WebVTT format (.vtt)
    Vtt,
}

/// Caption data for export
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptionForExport {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Caption text
    pub text: String,
    /// Optional speaker name
    pub speaker: Option<String>,
}

/// Exports captions to a file in the specified format
///
/// # Arguments
///
/// * `captions` - Array of captions to export
/// * `output_path` - File path where captions will be saved
/// * `format` - Export format (SRT or VTT)
#[tauri::command]
pub async fn export_captions(
    captions: Vec<CaptionForExport>,
    output_path: String,
    format: CaptionExportFormat,
) -> Result<(), String> {
    use crate::core::captions::{export_srt, export_vtt, Caption};
    use std::fs;
    use std::path::Path;

    // Convert to internal Caption type
    let internal_captions: Vec<Caption> = captions
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let mut caption = Caption::new(&format!("cap_{}", i), c.start_sec, c.end_sec, &c.text);
            caption.speaker = c.speaker;
            caption
        })
        .collect();

    // Export to the specified format
    let content = match format {
        CaptionExportFormat::Srt => export_srt(&internal_captions),
        CaptionExportFormat::Vtt => export_vtt(&internal_captions),
    };

    // Write to file
    let output = Path::new(&output_path);
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create output directory: {}", e))?;
        }
    }

    fs::write(output, content).map_err(|e| format!("Failed to write caption file: {}", e))?;

    tracing::info!(
        "Exported {} captions to {} as {:?}",
        internal_captions.len(),
        output_path,
        format
    );

    Ok(())
}

/// Gets caption content as a string in the specified format (without writing to file)
#[tauri::command]
pub async fn get_captions_as_string(
    captions: Vec<CaptionForExport>,
    format: CaptionExportFormat,
) -> Result<String, String> {
    use crate::core::captions::{export_srt, export_vtt, Caption};

    // Convert to internal Caption type
    let internal_captions: Vec<Caption> = captions
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let mut caption = Caption::new(&format!("cap_{}", i), c.start_sec, c.end_sec, &c.text);
            caption.speaker = c.speaker;
            caption
        })
        .collect();

    // Export to the specified format
    let content = match format {
        CaptionExportFormat::Srt => export_srt(&internal_captions),
        CaptionExportFormat::Vtt => export_vtt(&internal_captions),
    };

    Ok(content)
}

// =============================================================================
// Shot Detection Commands
// =============================================================================

/// Configuration options for shot detection
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShotDetectionConfig {
    /// Scene change detection threshold (0.0 - 1.0)
    /// Lower values detect more scene changes
    pub threshold: Option<f64>,
    /// Minimum shot duration in seconds
    pub min_shot_duration: Option<f64>,
}

impl Default for ShotDetectionConfig {
    fn default() -> Self {
        Self {
            threshold: Some(0.3),
            min_shot_duration: Some(0.5),
        }
    }
}

/// Detected shot data for frontend
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShotDto {
    /// Unique shot ID
    pub id: String,
    /// Asset ID this shot belongs to
    pub asset_id: String,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Path to keyframe thumbnail (if generated)
    pub keyframe_path: Option<String>,
    /// Quality score (0.0 - 1.0)
    pub quality_score: Option<f64>,
    /// Tags/labels for this shot
    pub tags: Vec<String>,
}

impl From<crate::core::indexing::Shot> for ShotDto {
    fn from(shot: crate::core::indexing::Shot) -> Self {
        Self {
            id: shot.id,
            asset_id: shot.asset_id,
            start_sec: shot.start_sec,
            end_sec: shot.end_sec,
            keyframe_path: shot.keyframe_path,
            quality_score: shot.quality_score,
            tags: shot.tags,
        }
    }
}

/// Result of shot detection operation
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShotDetectionResult {
    /// Number of shots detected
    pub shot_count: usize,
    /// Detected shots
    pub shots: Vec<ShotDto>,
    /// Total video duration in seconds
    pub total_duration: f64,
}

/// Detects shots/scenes in a video file
///
/// # Arguments
///
/// * `asset_id` - The asset ID to detect shots for
/// * `video_path` - Path to the video file
/// * `config` - Optional detection configuration
///
/// # Returns
///
/// Shot detection result containing all detected shots
#[tauri::command]
pub async fn detect_shots(
    asset_id: String,
    video_path: String,
    config: Option<ShotDetectionConfig>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    state: State<'_, AppState>,
) -> Result<ShotDetectionResult, String> {
    use crate::core::indexing::{IndexDb, ShotDetector, ShotDetectorConfig};

    validate_path_id_component(&asset_id, "Asset ID")?;

    let video_path_ref = std::path::Path::new(&video_path);
    let video_path_canon = std::fs::canonicalize(video_path_ref)
        .map_err(|e| format!("Failed to resolve video path '{}': {}", video_path, e))?;

    let metadata = std::fs::metadata(&video_path_canon)
        .map_err(|e| format!("Failed to stat video file '{}': {}", video_path, e))?;
    if !metadata.is_file() {
        return Err(format!(
            "Expected a file path, got a directory: {}",
            video_path
        ));
    }

    // Resolve FFmpeg paths from global FFmpegState (bundled or system).
    let ffmpeg_info = {
        let guard = ffmpeg_state.read().await;
        guard.info().cloned()
    };

    let ffmpeg_info = match ffmpeg_info {
        Some(info) => info,
        None => {
            // Best-effort initialization (system FFmpeg only) in case the command
            // is called before app startup initialization completes.
            let mut guard = ffmpeg_state.write().await;
            let _ = guard.initialize(None);
            guard
                .info()
                .cloned()
                .ok_or_else(|| "FFmpeg is not available".to_string())?
        }
    };

    // Build detector config
    let detector_config = if let Some(cfg) = config {
        let threshold = cfg.threshold.unwrap_or(0.3);
        if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
            return Err("threshold must be a finite number between 0.0 and 1.0".to_string());
        }

        let min_shot_duration = cfg.min_shot_duration.unwrap_or(0.5);
        if !min_shot_duration.is_finite() || min_shot_duration < 0.0 {
            return Err("minShotDuration must be a finite number >= 0".to_string());
        }

        ShotDetectorConfig {
            threshold,
            min_shot_duration,
            generate_keyframes: false,
            keyframe_dir: None,
            ffmpeg_path: Some(ffmpeg_info.ffmpeg_path.clone()),
            ffprobe_path: Some(ffmpeg_info.ffprobe_path.clone()),
            ..ShotDetectorConfig::default()
        }
    } else {
        ShotDetectorConfig {
            ffmpeg_path: Some(ffmpeg_info.ffmpeg_path.clone()),
            ffprobe_path: Some(ffmpeg_info.ffprobe_path.clone()),
            ..ShotDetectorConfig::default()
        }
    };

    let detector = ShotDetector::with_config(detector_config);

    tracing::info!(
        "Shot detection started: asset_id={}, video_path={}",
        asset_id,
        video_path_canon.to_string_lossy()
    );

    // Detect shots
    let shots = detector
        .detect(&video_path_canon, &asset_id)
        .await
        .map_err(|e| e.to_ipc_error())?;

    // Calculate total duration from shots
    let total_duration = shots.last().map(|s| s.end_sec).unwrap_or(0.0);

    // Save to database if project is open.
    // Do not hold the project mutex while doing SQLite I/O.
    let index_db_path = {
        if let Ok(guard) = state.project.try_lock() {
            guard.as_ref().map(|project| project.path.join("index.db"))
        } else {
            None
        }
    };

    if let Some(index_db_path) = index_db_path {
        let index_db = if index_db_path.exists() {
            IndexDb::open(&index_db_path)
        } else {
            IndexDb::create(&index_db_path)
        };

        if let Ok(db) = index_db {
            // Retry a few times to mitigate transient SQLITE_BUSY (concurrent writers).
            let mut last_err: Option<String> = None;
            for attempt in 0..3 {
                match detector.save_to_db(&db, &shots) {
                    Ok(()) => {
                        last_err = None;
                        break;
                    }
                    Err(e) => {
                        last_err = Some(e.to_string());
                        tokio::time::sleep(std::time::Duration::from_millis(
                            50 * (attempt + 1) as u64,
                        ))
                        .await;
                    }
                }
            }
            if let Some(e) = last_err {
                tracing::warn!("Failed to save shots to database after retries: {}", e);
            }
        }
    }

    let shot_count = shots.len();
    let shot_dtos: Vec<ShotDto> = shots.into_iter().map(ShotDto::from).collect();

    tracing::info!(
        "Detected {} shots in asset {} ({:.2}s total)",
        shot_count,
        asset_id,
        total_duration
    );

    Ok(ShotDetectionResult {
        shot_count,
        shots: shot_dtos,
        total_duration,
    })
}

/// Retrieves cached shots for an asset from the database
///
/// # Arguments
///
/// * `asset_id` - The asset ID to get shots for
///
/// # Returns
///
/// List of shots if found, empty list otherwise
#[tauri::command]
pub async fn get_asset_shots(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ShotDto>, String> {
    use crate::core::indexing::{IndexDb, ShotDetector};

    validate_path_id_component(&asset_id, "Asset ID")?;

    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project open".to_string())?;

    // Open (or create) the project's index database
    let index_db_path = project.path.join("index.db");
    if !index_db_path.exists() {
        // No database yet, return empty list
        return Ok(Vec::new());
    }

    let index_db = IndexDb::open(&index_db_path).map_err(|e| e.to_ipc_error())?;

    let shots = ShotDetector::load_from_db(&index_db, &asset_id).map_err(|e| e.to_ipc_error())?;

    Ok(shots.into_iter().map(ShotDto::from).collect())
}

/// Deletes all shots for an asset from the database
///
/// # Arguments
///
/// * `asset_id` - The asset ID to delete shots for
#[tauri::command]
pub async fn delete_asset_shots(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::core::indexing::IndexDb;

    validate_path_id_component(&asset_id, "Asset ID")?;

    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project open".to_string())?;

    // Open the project's index database
    let index_db_path = project.path.join("index.db");
    if !index_db_path.exists() {
        // No database yet, nothing to delete
        return Ok(());
    }

    let index_db = IndexDb::open(&index_db_path).map_err(|e| e.to_ipc_error())?;

    let conn = index_db.connection();
    conn.execute("DELETE FROM shots WHERE asset_id = ?", [&asset_id])
        .map_err(|e| format!("Failed to delete shots: {}", e))?;

    tracing::info!("Deleted shots for asset {}", asset_id);

    Ok(())
}

/// Checks if shot detection is available (requires FFmpeg)
#[tauri::command]
pub async fn is_shot_detection_available(
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
) -> Result<bool, String> {
    // Best-effort initialization in case startup init hasn't completed yet.
    {
        let guard = ffmpeg_state.read().await;
        if guard.is_available() {
            return Ok(true);
        }
    }

    let mut guard = ffmpeg_state.write().await;
    let _ = guard.initialize(None);
    Ok(guard.is_available())
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
        ProviderType::Gemini => {
            let api_key = config
                .api_key
                .ok_or_else(|| "API key is required for Gemini".to_string())?;
            let mut cfg = ProviderConfig::gemini(&api_key);
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
        ProviderType::Gemini => crate::core::ai::GeminiProvider::available_models(),
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
    let requires = edit_script
        .requires
        .into_iter()
        .map(|req| {
            Ok(RequirementDto {
                kind: serialize_to_json_string(&req.kind)
                    .map_err(|e| format!("Failed to serialize requirement kind: {e}"))?,
                query: req.query,
                provider: req.provider,
                params: req.params,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let copyright = serialize_to_json_string(&edit_script.risk.copyright)
        .map_err(|e| format!("Failed to serialize risk.copyright: {e}"))?;
    let nsfw = serialize_to_json_string(&edit_script.risk.nsfw)
        .map_err(|e| format!("Failed to serialize risk.nsfw: {e}"))?;

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
        requires,
        qc_rules: edit_script.qc_rules,
        risk: RiskAssessmentDto { copyright, nsfw },
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
        ProviderType::Gemini => crate::core::ai::GeminiProvider::available_models(),
        ProviderType::Local => crate::core::ai::LocalProvider::common_models(),
    };

    Ok(models)
}

// =============================================================================
// Settings Commands
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
        }
    }
}

/// Gets the app data directory for settings storage
fn get_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))
}

/// Gets application settings
#[tauri::command]
pub async fn get_settings(app: tauri::AppHandle) -> Result<AppSettingsDto, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);
    let settings = manager.load();
    Ok(settings.into())
}

/// Saves application settings
#[tauri::command]
pub async fn set_settings(app: tauri::AppHandle, settings: AppSettingsDto) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);
    let app_settings: AppSettings = settings.into();
    manager.save(&app_settings).map(|_| ())
}

/// Updates a partial section of settings (merge with existing)
#[tauri::command]
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
pub async fn reset_settings(app: tauri::AppHandle) -> Result<AppSettingsDto, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);
    let settings = manager.reset()?;
    Ok(settings.into())
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
// Update Commands
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

/// Checks for available updates
#[tauri::command]
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
pub fn get_current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Relaunches the application.
///
/// This is intentionally implemented on the Rust side to avoid depending on a
/// separate process plugin on the frontend.
#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

/// Downloads and installs an update
/// Returns true if restart is needed
#[tauri::command]
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
        // Caption Export
        export_captions,
        get_captions_as_string,
        // Shot Detection
        detect_shots,
        get_asset_shots,
        delete_asset_shots,
        is_shot_detection_available,
        // Search
        search_assets,
        is_meilisearch_available,
        search_content,
        index_asset_for_search,
        index_transcripts_for_search,
        remove_asset_from_search,
        // Settings
        get_settings,
        set_settings,
        update_settings,
        reset_settings,
        // Updates
        check_for_updates,
        get_current_version,
        relaunch_app,
        download_and_install_update,
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

//! Workspace IPC Commands
//!
//! Tauri commands for workspace-based asset management:
//! scanning, file tree, auto-registration, and watching.
//!
//! Files discovered during a workspace scan are automatically registered as
//! project assets. The old manual `register_workspace_file` /
//! `register_workspace_files` commands have been removed in favour of this
//! auto-registration approach.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::State;
use walkdir::{DirEntry, WalkDir};

use crate::core::assets::{media_kind_from_extension, AssetKind};
use crate::core::fs::{
    validate_local_input_path, validate_scoped_output_path, validate_workspace_relative_path,
    write_bytes_atomic_no_symlink,
};
use crate::core::project::{OpKind, Operation};
use crate::core::workspace::{
    ignore::IgnoreRules,
    service::{FileTreeEntry, WorkspaceService},
    watcher::{WorkspaceEvent, WorkspaceWatcher, WORKSPACE_EVENT_CHANNEL_CAPACITY},
};
use crate::core::CoreError;
use crate::{ActiveProject, AppState};
use tauri::{Emitter, Manager};

// =============================================================================
// Response Types
// =============================================================================

/// Result of a workspace scan operation
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceScanResultDto {
    /// Total number of media files found
    pub total_files: usize,
    /// Number of new files discovered
    pub new_files: usize,
    /// Number of files removed since last scan
    pub removed_files: usize,
    /// Number of files already registered as assets
    pub registered_files: usize,
    /// Number of files auto-registered during this scan
    pub auto_registered_files: usize,
}

/// A file imported into the workspace from an external OS file drop.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalWorkspaceImportedFileDto {
    pub source_path: String,
    pub relative_path: String,
    pub name: String,
    pub kind: AssetKind,
    pub file_size: u64,
    pub asset_id: Option<String>,
    pub already_in_workspace: bool,
}

/// Per-file import failure for batch external drops.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalWorkspaceImportFailureDto {
    pub source_path: String,
    pub message: String,
}

/// Result returned after importing external OS files into the workspace.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalWorkspaceImportResultDto {
    pub imported_files: Vec<ExternalWorkspaceImportedFileDto>,
    pub failed_files: Vec<ExternalWorkspaceImportFailureDto>,
}

/// A file tree entry for the frontend
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeEntryDto {
    /// Relative path within the project folder
    pub relative_path: String,
    /// Display name
    pub name: String,
    /// Whether this is a directory
    pub is_directory: bool,
    /// Asset kind (None for directories)
    pub kind: Option<AssetKind>,
    /// File size in bytes (None for directories)
    pub file_size: Option<u64>,
    /// Asset ID if registered as a project asset
    pub asset_id: Option<String>,
    /// Whether the associated asset is marked as missing
    #[serde(default)]
    pub missing: bool,
    /// Child entries (for directories)
    pub children: Vec<FileTreeEntryDto>,
}

/// Workspace document entry used by agentic file tools.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocumentEntryDto {
    pub relative_path: String,
    pub size_bytes: u64,
    pub modified_at_unix_sec: u64,
}

/// Full text payload for a workspace document.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocumentDto {
    pub relative_path: String,
    pub content: String,
    pub size_bytes: u64,
    pub modified_at_unix_sec: u64,
}

/// Result returned after writing a workspace document.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocumentWriteResultDto {
    pub relative_path: String,
    pub bytes_written: usize,
    pub created: bool,
}

const MAX_DOCUMENT_BYTES: usize = 512 * 1024;
const DEFAULT_DOCUMENT_LIST_LIMIT: usize = 500;
const MAX_DOCUMENT_LIST_LIMIT: usize = 2_000;

fn record_workspace_operation(
    project: &mut ActiveProject,
    operation: Operation,
) -> Result<(), String> {
    project
        .ops_log
        .append(&operation)
        .map_err(|e| e.to_ipc_error())?;
    project.state.last_op_id = Some(operation.id.clone());
    project.state.op_count += 1;
    project.state.is_dirty = true;
    project.state.meta.touch_at(&operation.timestamp);
    Ok(())
}

fn record_workspace_asset_imports(
    project: &mut ActiveProject,
    asset_ids: &[String],
) -> Result<(), String> {
    for asset_id in asset_ids {
        let asset =
            project.state.assets.get(asset_id).cloned().ok_or_else(|| {
                format!("Workspace asset not found after registration: {asset_id}")
            })?;
        let payload = serde_json::to_value(&asset)
            .map_err(|e| format!("Failed to serialize workspace asset import payload: {e}"))?;
        record_workspace_operation(project, Operation::new(OpKind::AssetImport, payload))?;
    }
    Ok(())
}

fn record_workspace_asset_updates(
    project: &mut ActiveProject,
    asset_ids: &[String],
) -> Result<(), String> {
    for asset_id in asset_ids {
        let asset = project
            .state
            .assets
            .get(asset_id)
            .ok_or_else(|| format!("Workspace asset not found for update: {asset_id}"))?;
        let payload = serde_json::json!({
            "assetId": asset.id,
            "uri": asset.uri,
            "fileSize": asset.file_size,
            "relativePath": asset.relative_path,
            "workspaceManaged": asset.workspace_managed,
            "missing": asset.missing,
        });
        record_workspace_operation(project, Operation::new(OpKind::AssetUpdate, payload))?;
    }
    Ok(())
}

// =============================================================================
// IPC Commands
// =============================================================================

/// Scan the project workspace for media files and auto-register them as assets.
/// Also starts (or restarts) the live filesystem watcher for this project.
#[tauri::command]
#[specta::specta]
pub async fn scan_workspace(state: State<'_, AppState>) -> Result<WorkspaceScanResultDto, String> {
    // Collect everything we need while holding the project lock, then release it
    // before starting the watcher (the watcher event loop also locks the project).
    let project_root;
    let dto;

    {
        let mut guard = state.project.lock().await;
        let project = guard
            .as_mut()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let existing_asset_ids: std::collections::HashSet<String> =
            project.state.assets.keys().cloned().collect();

        project_root = project.path.clone();
        let service = WorkspaceService::open(project_root.clone()).map_err(|e| e.to_ipc_error())?;

        let result = service.initial_scan().map_err(|e| e.to_ipc_error())?;

        // Auto-register all discovered files as project assets
        let auto_registered = service
            .auto_register_discovered_files(&mut project.state, &project_root)
            .map_err(|e| e.to_ipc_error())?;

        let new_asset_ids: Vec<String> = project
            .state
            .assets
            .keys()
            .filter(|asset_id| !existing_asset_ids.contains(*asset_id))
            .cloned()
            .collect();

        record_workspace_asset_imports(project, &new_asset_ids)?;

        // Allow the asset protocol to serve newly registered files
        for asset in project.state.assets.values() {
            if asset.workspace_managed {
                let resolved_path = std::path::PathBuf::from(&asset.uri);
                state.allow_asset_protocol_file(&resolved_path);
            }
        }

        tracing::info!(
            total = result.total_files,
            new = result.new_files,
            removed = result.removed_files,
            registered = result.registered_files,
            auto_registered = auto_registered,
            "Workspace scan completed"
        );

        dto = WorkspaceScanResultDto {
            total_files: result.total_files,
            new_files: result.new_files,
            removed_files: result.removed_files,
            registered_files: result.registered_files,
            auto_registered_files: auto_registered,
        };
    } // project lock released here

    // Start (or restart) the live workspace watcher now that the scan is done.
    if let Err(e) = start_workspace_watcher(project_root, &state).await {
        // Non-fatal: the scan result is valid; live watching just won't work.
        tracing::warn!(error = %e, "Could not start workspace file watcher");
    }

    Ok(dto)
}

/// Stops the active workspace watcher and event-processing loop.
async fn stop_workspace_watcher_unlocked(state: &AppState) {
    if let Some(handle) = state.workspace_event_loop.lock().await.take() {
        handle.abort();
    }

    if let Some(mut watcher) = state.workspace_watcher.lock().await.take() {
        watcher.stop();
    }
}

/// Stops workspace watching while holding the watcher lifecycle lock.
pub async fn stop_workspace_watcher(state: &AppState) {
    let _lifecycle_guard = state.workspace_watcher_lifecycle.lock().await;
    stop_workspace_watcher_unlocked(state).await;
}

/// Start (or restart) the workspace filesystem watcher for the given project.
///
/// Stops any previously running watcher and event-processing loop, then
/// creates fresh ones. The event loop:
///   1. Updates the on-disk workspace index for each change
///   2. Updates the in-memory project state (marks assets missing / reconnects them)
///   3. Auto-registers newly discovered files as project assets
///   4. Emits `workspace:file-added`, `workspace:file-removed`, or
///      `workspace:file-modified` Tauri events so the frontend refreshes its tree
async fn start_workspace_watcher(project_root: PathBuf, state: &AppState) -> Result<(), String> {
    use std::sync::Arc;

    let Some(app_handle) = state.app_handle.get().cloned() else {
        return Err("AppHandle not yet initialized; cannot start workspace watcher".to_string());
    };

    let _lifecycle_guard = state.workspace_watcher_lifecycle.lock().await;

    stop_workspace_watcher_unlocked(state).await;

    let ignore_rules = Arc::new(IgnoreRules::load(&project_root));
    let (event_tx, event_rx) =
        tokio::sync::mpsc::channel::<WorkspaceEvent>(WORKSPACE_EVENT_CHANNEL_CAPACITY);
    let watcher =
        WorkspaceWatcher::start(project_root.clone(), Arc::clone(&ignore_rules), event_tx)
            .map_err(|e| format!("Failed to start workspace watcher: {e}"))?;

    // --- Spawn the event-processing loop ---
    let project_root_for_loop = project_root.clone();

    let loop_handle = tokio::spawn(async move {
        // Keep one WorkspaceService (= one SQLite connection) open for the
        // lifetime of the loop rather than reopening it on every event.
        let service = match WorkspaceService::open(project_root_for_loop.clone()) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    "Workspace watcher event loop: could not open service; loop aborted"
                );
                return;
            }
        };

        let mut rx = event_rx;
        while let Some(event) = rx.recv().await {
            // 1. Update the on-disk workspace index
            if let Err(e) = service.handle_event(&event) {
                tracing::warn!(error = %e, "Workspace watcher: failed to update index");
            }

            // 2. Update the in-memory project state + auto-register
            {
                let app_state = app_handle.state::<crate::AppState>();
                let mut guard = app_state.project.lock().await;
                if let Some(project) = guard.as_mut() {
                    match &event {
                        WorkspaceEvent::FileRemoved(rel_path) => {
                            let mut updated_asset_ids = Vec::new();
                            for asset in project.state.assets.values_mut() {
                                if !asset.missing
                                    && asset.relative_path.as_deref() == Some(rel_path.as_str())
                                {
                                    asset.missing = true;
                                    updated_asset_ids.push(asset.id.clone());
                                    tracing::info!(
                                        path = %rel_path,
                                        "Asset marked missing (file removed externally)"
                                    );
                                }
                            }

                            if let Err(e) =
                                record_workspace_asset_updates(project, &updated_asset_ids)
                            {
                                tracing::warn!(
                                    error = %e,
                                    "Workspace watcher: failed to persist missing-asset updates"
                                );
                            }
                        }
                        WorkspaceEvent::FileAdded(rel_path)
                        | WorkspaceEvent::FileModified(rel_path) => {
                            let existing_asset_ids: std::collections::HashSet<String> =
                                project.state.assets.keys().cloned().collect();
                            let mut updated_asset_ids = Vec::new();

                            // Reconnect previously missing assets at this path
                            for asset in project.state.assets.values_mut() {
                                if asset.missing
                                    && asset.relative_path.as_deref() == Some(rel_path.as_str())
                                {
                                    asset.missing = false;
                                    updated_asset_ids.push(asset.id.clone());
                                    tracing::info!(
                                        path = %rel_path,
                                        "Asset reconnected (file re-appeared)"
                                    );
                                }
                            }
                            // Auto-register any brand-new files
                            if let Err(e) = service.auto_register_discovered_files(
                                &mut project.state,
                                &project_root_for_loop,
                            ) {
                                tracing::warn!(
                                    error = %e,
                                    "Workspace watcher: failed to auto-register files"
                                );
                            }

                            let new_asset_ids: Vec<String> = project
                                .state
                                .assets
                                .keys()
                                .filter(|asset_id| !existing_asset_ids.contains(*asset_id))
                                .cloned()
                                .collect();

                            if let Err(e) = record_workspace_asset_imports(project, &new_asset_ids)
                            {
                                tracing::warn!(
                                    error = %e,
                                    "Workspace watcher: failed to persist auto-registered assets"
                                );
                            }

                            if let Err(e) =
                                record_workspace_asset_updates(project, &updated_asset_ids)
                            {
                                tracing::warn!(
                                    error = %e,
                                    "Workspace watcher: failed to persist asset reconnection updates"
                                );
                            }

                            // Allow asset-protocol access for all managed assets
                            for asset in project.state.assets.values() {
                                if asset.workspace_managed {
                                    let path = PathBuf::from(&asset.uri);
                                    app_state.allow_asset_protocol_file(&path);
                                }
                            }
                        }
                    }
                }
            } // project lock released here

            // 3. Notify the frontend
            let (event_name, rel_path) = match &event {
                WorkspaceEvent::FileAdded(p) => ("workspace:file-added", p.clone()),
                WorkspaceEvent::FileRemoved(p) => ("workspace:file-removed", p.clone()),
                WorkspaceEvent::FileModified(p) => ("workspace:file-modified", p.clone()),
            };

            let kind = kind_string_for_path(&rel_path);
            let payload = serde_json::json!({
                "relativePath": rel_path,
                "kind": kind,
            });

            if let Err(e) = app_handle.emit(event_name, payload) {
                tracing::warn!(
                    event = event_name,
                    error = %e,
                    "Workspace watcher: failed to emit event"
                );
            }
        }

        tracing::debug!("Workspace watcher event loop ended");
    });

    {
        let mut watcher_guard = state.workspace_watcher.lock().await;
        *watcher_guard = Some(watcher);
    }

    {
        let mut loop_guard = state.workspace_event_loop.lock().await;
        *loop_guard = Some(loop_handle);
    }

    tracing::info!(
        project = %project_root.display(),
        "Workspace file watcher started"
    );

    Ok(())
}

/// Returns the lowercase media-kind string for a relative path, or `None` for
/// non-media files.  Used to populate `WorkspaceFileEvent.kind` payloads.
fn kind_string_for_path(relative_path: &str) -> Option<String> {
    let ext = std::path::Path::new(relative_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    media_kind_from_extension(ext).map(|kind| {
        match kind {
            AssetKind::Video => "video",
            AssetKind::Audio => "audio",
            AssetKind::Image => "image",
            AssetKind::Subtitle => "subtitle",
            AssetKind::Font => "font",
            AssetKind::EffectPreset | AssetKind::MemePack => "other",
        }
        .to_string()
    })
}

/// Get the workspace file tree with asset_id populated from project state
#[tauri::command]
#[specta::specta]
pub async fn get_workspace_tree(
    state: State<'_, AppState>,
) -> Result<Vec<FileTreeEntryDto>, String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let service = WorkspaceService::open(project.path.clone()).map_err(|e| e.to_ipc_error())?;

    let tree = service.get_file_tree().map_err(|e| e.to_ipc_error())?;

    // Build a lookup from relative_path -> (asset_id, missing) using project state
    let path_to_asset: std::collections::HashMap<String, (String, bool)> = project
        .state
        .assets
        .iter()
        .filter_map(|(id, asset)| {
            asset
                .relative_path
                .as_ref()
                .map(|rp| (rp.clone(), (id.clone(), asset.missing)))
        })
        .collect();

    // Build a lookup from asset_id -> missing for index-provided asset_ids
    let asset_id_to_missing: std::collections::HashMap<String, bool> = project
        .state
        .assets
        .iter()
        .map(|(id, asset)| (id.clone(), asset.missing))
        .collect();

    Ok(tree
        .into_iter()
        .map(|e| convert_tree_entry_with_assets(e, &path_to_asset, &asset_id_to_missing))
        .collect())
}

/// Import absolute local file paths from an OS drag/drop into the project workspace.
#[tauri::command]
#[specta::specta]
pub async fn import_external_files_to_workspace(
    source_paths: Vec<String>,
    target_dir: Option<String>,
    state: State<'_, AppState>,
) -> Result<ExternalWorkspaceImportResultDto, String> {
    if source_paths.is_empty() {
        return Err("At least one source path is required".to_string());
    }

    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
    let project_root = project.path.clone();

    let normalized_target_dir = normalize_external_import_target_dir(target_dir.as_deref())?;
    let source_paths_for_copy = source_paths;
    let target_dir_for_copy = normalized_target_dir.clone();
    let project_root_for_copy = project_root.clone();

    let mut result = tokio::task::spawn_blocking(move || {
        copy_external_files_into_workspace(
            &project_root_for_copy,
            &source_paths_for_copy,
            target_dir_for_copy.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("External workspace import task failed: {e}"))??;

    if result.imported_files.is_empty() {
        return Ok(result);
    }

    let imported_relative_paths: Vec<String>;

    {
        let existing_asset_ids: HashSet<String> = project.state.assets.keys().cloned().collect();
        let service = WorkspaceService::open(project.path.clone()).map_err(|e| e.to_ipc_error())?;

        for imported_file in &result.imported_files {
            if let Err(error) = service.handle_event(&WorkspaceEvent::FileAdded(
                imported_file.relative_path.clone(),
            )) {
                result.failed_files.push(ExternalWorkspaceImportFailureDto {
                    source_path: imported_file.source_path.clone(),
                    message: format!(
                        "File was copied but could not be indexed as '{}': {}",
                        imported_file.relative_path, error
                    ),
                });
            }
        }

        service
            .auto_register_discovered_files(&mut project.state, &project.path)
            .map_err(|e| e.to_ipc_error())?;

        let new_asset_ids: Vec<String> = project
            .state
            .assets
            .keys()
            .filter(|asset_id| !existing_asset_ids.contains(*asset_id))
            .cloned()
            .collect();

        record_workspace_asset_imports(project, &new_asset_ids)?;

        for imported_file in &mut result.imported_files {
            imported_file.asset_id = project
                .state
                .assets
                .values()
                .find(|asset| {
                    asset.relative_path.as_deref() == Some(imported_file.relative_path.as_str())
                })
                .map(|asset| asset.id.clone());
        }

        for asset in project.state.assets.values() {
            if asset.workspace_managed {
                let resolved_path = PathBuf::from(&asset.uri);
                state.allow_asset_protocol_file(&resolved_path);
            }
        }

        imported_relative_paths = result
            .imported_files
            .iter()
            .map(|file| file.relative_path.clone())
            .collect();
    }

    drop(guard);

    if let Some(app_handle) = state.app_handle.get() {
        for relative_path in imported_relative_paths {
            let payload = serde_json::json!({
                "relativePath": relative_path,
                "kind": kind_string_for_path(&relative_path),
            });

            if let Err(error) = app_handle.emit("workspace:file-added", payload) {
                tracing::warn!(
                    path = %relative_path,
                    error = %error,
                    "Failed to emit external workspace import event"
                );
            }
        }
    }

    Ok(result)
}

/// Reveal a workspace file in the system file explorer
#[tauri::command]
#[specta::specta]
pub async fn reveal_in_explorer(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let abs_path = project.path.join(&relative_path);

    // Ensure the resolved path stays within the project root
    let canonical_root = project
        .path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project root: {}", e))?;
    if let Ok(canonical_target) = abs_path.canonicalize() {
        if !canonical_target.starts_with(&canonical_root) {
            return Err("Path is outside the project directory".to_string());
        }
    }

    if !abs_path.exists() {
        return Err(format!("File not found: {}", abs_path.display()));
    }

    // Determine the target to reveal: if it's a file, reveal its parent directory
    // selecting the file; if it's a directory, just open it.
    #[cfg(target_os = "windows")]
    {
        let path_str = abs_path.to_string_lossy().to_string();
        let mut command = std::process::Command::new("explorer");
        if abs_path.is_file() {
            command.args(["/select,", &path_str]);
        } else {
            command.arg(&path_str);
        }
        command
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &abs_path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open on the parent directory
        let target = if abs_path.is_file() {
            abs_path.parent().unwrap_or(&abs_path).to_path_buf()
        } else {
            abs_path.clone()
        };
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    Ok(())
}

/// List text documents in the workspace so agents can discover editable files
/// like AGENTS.md, CLAUDE.md, and project docs.
#[tauri::command]
#[specta::specta]
pub async fn list_workspace_documents(
    query: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceDocumentEntryDto>, String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let normalized_query = query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(str::to_lowercase);

    let requested_limit = limit.unwrap_or(DEFAULT_DOCUMENT_LIST_LIMIT as u32) as usize;
    let bounded_limit = requested_limit.clamp(1, MAX_DOCUMENT_LIST_LIMIT);

    let mut entries: Vec<WorkspaceDocumentEntryDto> = Vec::new();

    for entry in WalkDir::new(&project.path)
        .max_depth(16)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_walk_workspace_entry)
    {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                tracing::debug!(error = %err, "Skipping unreadable workspace entry");
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        if !is_text_document_path(path) {
            continue;
        }

        let relative = match path.strip_prefix(&project.path) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        if let Some(query) = normalized_query.as_ref() {
            if !relative.to_lowercase().contains(query) {
                continue;
            }
        }

        let metadata = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(err) => {
                tracing::debug!(path = %path.display(), error = %err, "Skipping file with unreadable metadata");
                continue;
            }
        };

        let modified_at_unix_sec = metadata
            .modified()
            .ok()
            .and_then(|ts| ts.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        entries.push(WorkspaceDocumentEntryDto {
            relative_path: relative,
            size_bytes: metadata.len(),
            modified_at_unix_sec,
        });

        if entries.len() >= bounded_limit {
            break;
        }
    }

    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(entries)
}

/// Read UTF-8 text content from a workspace document.
#[tauri::command]
#[specta::specta]
pub async fn read_workspace_document(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<WorkspaceDocumentDto, String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let absolute_path = resolve_workspace_path(&project.path, &relative_path, false)?;

    if !absolute_path.is_file() {
        return Err(format!("Not a file: {}", absolute_path.display()));
    }

    if !is_text_document_path(&absolute_path) {
        return Err("File type is not supported for text editing".to_string());
    }

    let metadata = std::fs::metadata(&absolute_path)
        .map_err(|e| format!("Failed to stat file '{}': {}", relative_path, e))?;

    if metadata.len() > MAX_DOCUMENT_BYTES as u64 {
        return Err(format!(
            "File is too large for agent editing ({} bytes, max {})",
            metadata.len(),
            MAX_DOCUMENT_BYTES
        ));
    }

    let bytes = std::fs::read(&absolute_path)
        .map_err(|e| format!("Failed to read file '{}': {}", relative_path, e))?;

    if bytes.contains(&0) {
        return Err("Binary file content is not supported".to_string());
    }

    let content =
        String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8 text".to_string())?;

    let modified_at_unix_sec = metadata
        .modified()
        .ok()
        .and_then(|ts| ts.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let normalized_relative = absolute_path
        .strip_prefix(&project.path)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or(relative_path);

    Ok(WorkspaceDocumentDto {
        relative_path: normalized_relative,
        content,
        size_bytes: metadata.len(),
        modified_at_unix_sec,
    })
}

/// Write UTF-8 text content to a workspace document.
#[tauri::command]
#[specta::specta]
pub async fn write_workspace_document(
    relative_path: String,
    content: String,
    create_if_missing: Option<bool>,
    state: State<'_, AppState>,
) -> Result<WorkspaceDocumentWriteResultDto, String> {
    let project_path = {
        let guard = state.project.lock().await;
        guard
            .as_ref()
            .map(|project| project.path.clone())
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?
    };

    let allow_create = create_if_missing.unwrap_or(true);
    let content_bytes = content.into_bytes();
    if content_bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "Content is too large ({} bytes, max {})",
            content_bytes.len(),
            MAX_DOCUMENT_BYTES
        ));
    }

    tokio::task::spawn_blocking(move || {
        let absolute_path = resolve_workspace_output_path(&project_path, &relative_path)?;

        if !is_text_document_path(&absolute_path) {
            return Err("File type is not supported for text editing".to_string());
        }

        let existed = absolute_path.exists();
        if existed && !absolute_path.is_file() {
            return Err(format!("Not a file: {}", absolute_path.display()));
        }
        if !existed && !allow_create {
            return Err(format!("File not found: {}", relative_path));
        }

        write_bytes_atomic_no_symlink(&absolute_path, &content_bytes, "workspace document")
            .map_err(|e| format!("Failed to write file '{}': {}", relative_path, e))?;

        let normalized_relative = absolute_path
            .strip_prefix(&project_path)
            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            .unwrap_or(relative_path);

        Ok(WorkspaceDocumentWriteResultDto {
            relative_path: normalized_relative,
            bytes_written: content_bytes.len(),
            created: !existed,
        })
    })
    .await
    .map_err(|e| format!("Workspace document write task failed: {e}"))?
}

// =============================================================================
// Helpers
// =============================================================================

fn should_walk_workspace_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }

    if entry.file_type().is_file() {
        return true;
    }

    let name = entry.file_name().to_string_lossy().to_lowercase();
    !matches!(
        name.as_str(),
        ".git" | "node_modules" | ".openreelio" | "dist" | "target" | "build"
    )
}

fn is_text_document_path(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };

    let normalized_name = file_name.to_lowercase();
    if matches!(
        normalized_name.as_str(),
        "dockerfile"
            | "makefile"
            | "license"
            | "license.md"
            | "readme"
            | "readme.md"
            | "agents.md"
            | "claude.md"
            | ".gitignore"
            | ".openreelignore"
    ) {
        return true;
    }

    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };

    matches!(
        ext.to_lowercase().as_str(),
        "md" | "markdown"
            | "txt"
            | "srt"
            | "vtt"
            | "json"
            | "jsonc"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "csv"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "rs"
            | "py"
            | "java"
            | "c"
            | "cc"
            | "cpp"
            | "h"
            | "hpp"
            | "css"
            | "scss"
            | "html"
            | "htm"
            | "sql"
            | "sh"
            | "ps1"
            | "bat"
            | "ini"
            | "cfg"
            | "conf"
            | "log"
    )
}

fn resolve_workspace_path(
    project_root: &Path,
    relative_path: &str,
    allow_missing: bool,
) -> Result<PathBuf, String> {
    let relative = validate_workspace_relative_path(relative_path)?;
    let absolute = project_root.join(relative);

    let canonical_root = project_root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project root: {}", e))?;

    if absolute.exists() {
        let canonical_target = absolute
            .canonicalize()
            .map_err(|e| format!("Cannot resolve path '{}': {}", relative_path, e))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err("Path is outside the project directory".to_string());
        }
        return Ok(canonical_target);
    }

    if !allow_missing {
        return Err(format!("File not found: {}", relative_path));
    }

    let mut existing_ancestor = absolute
        .parent()
        .ok_or_else(|| "Invalid target path".to_string())?;

    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| "Cannot resolve a valid parent directory".to_string())?;
    }

    let canonical_parent = existing_ancestor.canonicalize().map_err(|e| {
        format!(
            "Cannot resolve parent directory for '{}': {}",
            relative_path, e
        )
    })?;

    if !canonical_parent.starts_with(&canonical_root) {
        return Err("Path is outside the project directory".to_string());
    }

    Ok(absolute)
}

fn resolve_workspace_output_path(
    project_root: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let relative = validate_workspace_relative_path(relative_path)?;
    let absolute = project_root.join(relative);
    let absolute_str = absolute.to_string_lossy().to_string();
    validate_scoped_output_path(&absolute_str, "workspace document path", &[project_root])
}

fn normalize_external_import_target_dir(
    target_dir: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(raw_target_dir) = target_dir.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let relative = validate_workspace_relative_path(raw_target_dir)?;
    Ok(normalize_workspace_relative_path(&relative))
}

fn normalize_workspace_relative_path(path: &Path) -> Option<String> {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn workspace_relative_path(project_root: &Path, absolute_path: &Path) -> Result<String, String> {
    let relative = absolute_path
        .strip_prefix(project_root)
        .map_err(|_| "Path is outside the project directory".to_string())?;
    let normalized = relative.to_string_lossy().replace('\\', "/");
    validate_workspace_relative_path(&normalized)?;
    Ok(normalized)
}

fn parent_workspace_dir(relative_path: &str) -> Option<String> {
    Path::new(relative_path)
        .parent()
        .and_then(normalize_workspace_relative_path)
}

fn resolve_external_import_target_directory(
    project_root: &Path,
    target_dir: Option<&str>,
) -> Result<PathBuf, String> {
    let canonical_root = project_root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project root: {e}"))?;

    let directory = match target_dir {
        Some(relative_dir) if !relative_dir.is_empty() => {
            let relative = validate_workspace_relative_path(relative_dir)?;
            canonical_root.join(relative)
        }
        _ => canonical_root.clone(),
    };

    let canonical_directory = directory
        .canonicalize()
        .map_err(|e| format!("Drop target folder not found: {e}"))?;

    if !canonical_directory.starts_with(&canonical_root) {
        return Err("Drop target is outside the project directory".to_string());
    }

    if !canonical_directory.is_dir() {
        return Err("Drop target is not a workspace folder".to_string());
    }

    Ok(canonical_directory)
}

fn sanitize_external_import_file_name(file_name: &str) -> String {
    let sanitized = file_name
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '\0' | '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        "imported-file".to_string()
    } else {
        sanitized
    }
}

fn collision_file_name(file_name: &str, collision_index: usize) -> String {
    if collision_index == 0 {
        return file_name.to_string();
    }

    let path = Path::new(file_name);
    let extension = path.extension().and_then(|value| value.to_str());
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(file_name);

    match extension {
        Some(extension) if !extension.is_empty() => {
            format!("{stem} {collision_index}.{extension}")
        }
        _ => format!("{file_name} {collision_index}"),
    }
}

fn unique_external_import_destination(
    project_root: &Path,
    target_dir: Option<&str>,
    file_name: &str,
    reserved_relative_paths: &mut HashSet<String>,
) -> Result<(PathBuf, String), String> {
    for collision_index in 0..10_000 {
        let candidate_name = collision_file_name(file_name, collision_index);
        let relative_path = match target_dir {
            Some(target_dir) if !target_dir.is_empty() => format!("{target_dir}/{candidate_name}"),
            _ => candidate_name,
        };

        validate_workspace_relative_path(&relative_path)?;

        if reserved_relative_paths.contains(&relative_path) {
            continue;
        }

        let absolute_path = project_root.join(&relative_path);
        let absolute_path_string = absolute_path.to_string_lossy().to_string();
        let validated_path = validate_scoped_output_path(
            &absolute_path_string,
            "workspace import path",
            &[project_root],
        )?;

        if validated_path.exists() {
            continue;
        }

        reserved_relative_paths.insert(relative_path.clone());
        return Ok((validated_path, relative_path));
    }

    Err(format!(
        "Could not find an available destination name for '{}'",
        file_name
    ))
}

fn copy_file_no_overwrite(source_path: &Path, destination_path: &Path) -> Result<u64, String> {
    let parent = destination_path
        .parent()
        .ok_or_else(|| format!("Destination has no parent: {}", destination_path.display()))?;

    let mut source_file = std::fs::File::open(source_path).map_err(|e| {
        format!(
            "Failed to open source file '{}': {e}",
            source_path.display()
        )
    })?;
    let mut temp_file = tempfile::Builder::new()
        .prefix(".openreelio-import-")
        .tempfile_in(parent)
        .map_err(|e| format!("Failed to create temporary import file: {e}"))?;

    let bytes_copied = std::io::copy(&mut source_file, temp_file.as_file_mut())
        .map_err(|e| format!("Failed to copy file '{}': {e}", source_path.display()))?;

    temp_file
        .as_file_mut()
        .sync_all()
        .map_err(|e| format!("Failed to flush imported file: {e}"))?;

    match temp_file.persist_noclobber(destination_path) {
        Ok(_) => Ok(bytes_copied),
        Err(error) => Err(format!(
            "Failed to finalize imported file '{}': {}",
            destination_path.display(),
            error.error
        )),
    }
}

fn copy_external_files_into_workspace(
    project_root: &Path,
    source_paths: &[String],
    target_dir: Option<&str>,
) -> Result<ExternalWorkspaceImportResultDto, String> {
    let canonical_project_root = project_root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve project root: {e}"))?;
    let target_directory =
        resolve_external_import_target_directory(&canonical_project_root, target_dir)?;
    let normalized_target_dir = target_dir.and_then(|value| {
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    });

    let mut imported_files = Vec::new();
    let mut failed_files = Vec::new();
    let mut seen_sources: HashSet<PathBuf> = HashSet::new();
    let mut reserved_relative_paths: HashSet<String> = HashSet::new();

    for source_path in source_paths {
        match copy_single_external_file_into_workspace(
            &canonical_project_root,
            &target_directory,
            normalized_target_dir.as_deref(),
            source_path,
            &mut seen_sources,
            &mut reserved_relative_paths,
        ) {
            Ok(Some(imported_file)) => imported_files.push(imported_file),
            Ok(None) => {}
            Err(message) => failed_files.push(ExternalWorkspaceImportFailureDto {
                source_path: source_path.clone(),
                message,
            }),
        }
    }

    Ok(ExternalWorkspaceImportResultDto {
        imported_files,
        failed_files,
    })
}

fn copy_single_external_file_into_workspace(
    canonical_project_root: &Path,
    target_directory: &Path,
    target_dir: Option<&str>,
    source_path: &str,
    seen_sources: &mut HashSet<PathBuf>,
    reserved_relative_paths: &mut HashSet<String>,
) -> Result<Option<ExternalWorkspaceImportedFileDto>, String> {
    let source = validate_local_input_path(source_path, "sourcePath")?;
    if !seen_sources.insert(source.clone()) {
        return Ok(None);
    }

    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Invalid source file name: {}", source.display()))?;
    let file_name = sanitize_external_import_file_name(file_name);
    let extension = Path::new(&file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let kind = media_kind_from_extension(extension).ok_or_else(|| {
        format!(
            "Unsupported file type '{}'",
            Path::new(&file_name)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("unknown")
        )
    })?;

    let metadata = std::fs::metadata(&source)
        .map_err(|e| format!("Failed to read source metadata '{}': {e}", source.display()))?;

    let source_workspace_relative = if source.starts_with(canonical_project_root) {
        Some(workspace_relative_path(canonical_project_root, &source)?)
    } else {
        None
    };

    let desired_relative_path =
        workspace_relative_path(canonical_project_root, &target_directory.join(&file_name))?;

    if let Some(existing_relative_path) = source_workspace_relative.as_ref() {
        let existing_parent = parent_workspace_dir(existing_relative_path);
        if existing_parent.as_deref() == target_dir
            && Path::new(existing_relative_path)
                .file_name()
                .and_then(|value| value.to_str())
                == Some(file_name.as_str())
        {
            return Ok(Some(ExternalWorkspaceImportedFileDto {
                source_path: source_path.to_string(),
                relative_path: existing_relative_path.clone(),
                name: file_name,
                kind,
                file_size: metadata.len(),
                asset_id: None,
                already_in_workspace: true,
            }));
        }
    }

    let (destination_path, relative_path) =
        if !canonical_project_root.join(&desired_relative_path).exists()
            && !reserved_relative_paths.contains(&desired_relative_path)
        {
            validate_workspace_relative_path(&desired_relative_path)?;
            let absolute_path = canonical_project_root.join(&desired_relative_path);
            let absolute_path_string = absolute_path.to_string_lossy().to_string();
            let validated_path = validate_scoped_output_path(
                &absolute_path_string,
                "workspace import path",
                &[canonical_project_root],
            )?;
            reserved_relative_paths.insert(desired_relative_path.clone());
            (validated_path, desired_relative_path)
        } else {
            unique_external_import_destination(
                canonical_project_root,
                target_dir,
                &file_name,
                reserved_relative_paths,
            )?
        };

    copy_file_no_overwrite(&source, &destination_path)?;

    Ok(Some(ExternalWorkspaceImportedFileDto {
        source_path: source_path.to_string(),
        relative_path,
        name: file_name,
        kind,
        file_size: metadata.len(),
        asset_id: None,
        already_in_workspace: false,
    }))
}

/// Convert internal FileTreeEntry to DTO, populating asset_id and missing flag
/// from project state when the index entry doesn't have them yet.
fn convert_tree_entry_with_assets(
    entry: FileTreeEntry,
    path_to_asset: &std::collections::HashMap<String, (String, bool)>,
    asset_id_to_missing: &std::collections::HashMap<String, bool>,
) -> FileTreeEntryDto {
    // Prefer the index-stored asset_id, fall back to the project state lookup
    let (asset_id, missing) = if let Some(ref idx_asset_id) = entry.asset_id {
        // Use index asset_id only if it still exists in project state.
        // Otherwise, fall back to relative-path mapping to avoid stale IDs.
        if let Some(is_missing) = asset_id_to_missing.get(idx_asset_id).copied() {
            (Some(idx_asset_id.clone()), is_missing)
        } else if let Some((state_asset_id, is_missing)) = path_to_asset.get(&entry.relative_path) {
            (Some(state_asset_id.clone()), *is_missing)
        } else {
            (None, false)
        }
    } else if let Some((state_asset_id, is_missing)) = path_to_asset.get(&entry.relative_path) {
        (Some(state_asset_id.clone()), *is_missing)
    } else {
        (None, false)
    };

    FileTreeEntryDto {
        relative_path: entry.relative_path,
        name: entry.name,
        is_directory: entry.is_directory,
        kind: entry.kind,
        file_size: entry.file_size,
        asset_id,
        missing,
        children: entry
            .children
            .into_iter()
            .map(|e| convert_tree_entry_with_assets(e, path_to_asset, asset_id_to_missing))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::workspace::service::FileTreeEntry;
    use std::fs;

    #[test]
    fn convert_tree_entry_uses_index_asset_id_when_present() {
        let entry = FileTreeEntry {
            relative_path: "footage/clip.mp4".to_string(),
            name: "clip.mp4".to_string(),
            is_directory: false,
            kind: Some(AssetKind::Video),
            file_size: Some(1024),
            asset_id: Some("asset-from-index".to_string()),
            missing: false,
            children: vec![],
        };

        let path_lookup = std::collections::HashMap::new();
        let mut id_lookup = std::collections::HashMap::new();
        id_lookup.insert("asset-from-index".to_string(), false);
        let dto = convert_tree_entry_with_assets(entry, &path_lookup, &id_lookup);
        assert_eq!(dto.asset_id, Some("asset-from-index".to_string()));
        assert!(!dto.missing);
    }

    #[test]
    fn convert_tree_entry_falls_back_to_project_state_lookup() {
        let entry = FileTreeEntry {
            relative_path: "footage/clip.mp4".to_string(),
            name: "clip.mp4".to_string(),
            is_directory: false,
            kind: Some(AssetKind::Video),
            file_size: Some(1024),
            asset_id: None,
            missing: false,
            children: vec![],
        };

        let mut path_lookup = std::collections::HashMap::new();
        path_lookup.insert(
            "footage/clip.mp4".to_string(),
            ("asset-from-state".to_string(), false),
        );
        let id_lookup = std::collections::HashMap::new();

        let dto = convert_tree_entry_with_assets(entry, &path_lookup, &id_lookup);
        assert_eq!(dto.asset_id, Some("asset-from-state".to_string()));
        assert!(!dto.missing);
    }

    #[test]
    fn convert_tree_entry_returns_none_when_no_asset_id() {
        let entry = FileTreeEntry {
            relative_path: "footage/clip.mp4".to_string(),
            name: "clip.mp4".to_string(),
            is_directory: false,
            kind: Some(AssetKind::Video),
            file_size: Some(1024),
            asset_id: None,
            missing: false,
            children: vec![],
        };

        let path_lookup = std::collections::HashMap::new();
        let id_lookup = std::collections::HashMap::new();
        let dto = convert_tree_entry_with_assets(entry, &path_lookup, &id_lookup);
        assert_eq!(dto.asset_id, None);
        assert!(!dto.missing);
    }

    #[test]
    fn convert_tree_entry_populates_missing_from_state() {
        let entry = FileTreeEntry {
            relative_path: "footage/clip.mp4".to_string(),
            name: "clip.mp4".to_string(),
            is_directory: false,
            kind: Some(AssetKind::Video),
            file_size: Some(1024),
            asset_id: Some("asset-missing".to_string()),
            missing: false,
            children: vec![],
        };

        let path_lookup = std::collections::HashMap::new();
        let mut id_lookup = std::collections::HashMap::new();
        id_lookup.insert("asset-missing".to_string(), true);
        let dto = convert_tree_entry_with_assets(entry, &path_lookup, &id_lookup);
        assert_eq!(dto.asset_id, Some("asset-missing".to_string()));
        assert!(dto.missing);
    }

    #[test]
    fn convert_tree_entry_falls_back_when_index_asset_id_is_stale() {
        let entry = FileTreeEntry {
            relative_path: "footage/clip.mp4".to_string(),
            name: "clip.mp4".to_string(),
            is_directory: false,
            kind: Some(AssetKind::Video),
            file_size: Some(1024),
            asset_id: Some("asset-stale".to_string()),
            missing: false,
            children: vec![],
        };

        let mut path_lookup = std::collections::HashMap::new();
        path_lookup.insert(
            "footage/clip.mp4".to_string(),
            ("asset-from-state".to_string(), false),
        );
        let id_lookup = std::collections::HashMap::new();

        let dto = convert_tree_entry_with_assets(entry, &path_lookup, &id_lookup);
        assert_eq!(dto.asset_id, Some("asset-from-state".to_string()));
        assert!(!dto.missing);
    }

    #[test]
    fn is_text_document_path_allows_known_doc_and_code_extensions() {
        assert!(is_text_document_path(Path::new("AGENTS.md")));
        assert!(is_text_document_path(Path::new("CLAUDE.md")));
        assert!(is_text_document_path(Path::new("src/main.ts")));
        assert!(is_text_document_path(Path::new("captions/subtitles.srt")));
        assert!(is_text_document_path(Path::new("captions/subtitles.vtt")));
        assert!(!is_text_document_path(Path::new("video/movie.mp4")));
    }

    #[test]
    fn validate_relative_path_rejects_traversal_and_absolute_paths() {
        assert!(validate_workspace_relative_path("docs/readme.md").is_ok());
        assert!(validate_workspace_relative_path("../secrets.txt").is_err());

        let absolute_candidate = if cfg!(windows) {
            "C:/temp/file.txt"
        } else {
            "/tmp/file.txt"
        };
        assert!(validate_workspace_relative_path(absolute_candidate).is_err());
    }

    #[test]
    fn validate_relative_path_rejects_reserved_workspace_directories() {
        assert!(validate_workspace_relative_path(".openreelio/state/snapshot.json").is_err());
        assert!(validate_workspace_relative_path(".git/hooks/pre-commit").is_err());
        assert!(validate_workspace_relative_path("node_modules/pkg/index.js").is_err());
        assert!(validate_workspace_relative_path("dist/assets/index.js").is_err());
        assert!(validate_workspace_relative_path("target/debug/app.log").is_err());
    }

    #[test]
    fn kind_string_for_path_recognizes_extended_audio_extensions() {
        assert_eq!(
            kind_string_for_path("audio/voice.opus"),
            Some("audio".to_string())
        );
        assert_eq!(
            kind_string_for_path("audio/ambience.oga"),
            Some("audio".to_string())
        );
        assert_eq!(
            kind_string_for_path("audio/podcast.weba"),
            Some("audio".to_string())
        );
    }

    #[test]
    fn resolve_workspace_path_stays_inside_project_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();

        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/readme.md"), "hello").unwrap();

        let existing = resolve_workspace_path(root, "docs/readme.md", false).unwrap();
        assert!(existing.ends_with(Path::new("docs/readme.md")));

        let new_file = resolve_workspace_path(root, "docs/new.md", true).unwrap();
        assert!(new_file.ends_with(Path::new("docs/new.md")));

        let traversal = resolve_workspace_path(root, "../outside.md", true);
        assert!(traversal.is_err());
    }

    #[test]
    fn resolve_workspace_path_returns_not_found_when_missing_and_disallowed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();

        let result = resolve_workspace_path(root, "docs/missing.md", false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[test]
    fn resolve_workspace_output_path_creates_safe_parent_inside_project() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();

        let output = resolve_workspace_output_path(root, "docs/new.md").unwrap();
        assert!(output.ends_with(Path::new("docs/new.md")));
        assert!(root.join("docs").is_dir());
    }

    #[test]
    fn sanitize_external_import_file_name_replaces_unsafe_characters() {
        assert_eq!(
            sanitize_external_import_file_name("my:clip?.mp4"),
            "my_clip_.mp4"
        );
        assert_eq!(sanitize_external_import_file_name("..."), "imported-file");
    }

    #[test]
    fn unique_external_import_destination_uses_collision_suffixes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("footage")).unwrap();
        fs::write(root.join("footage/clip.mp4"), "existing").unwrap();

        let mut reserved = HashSet::new();
        let (_path, relative_path) =
            unique_external_import_destination(root, Some("footage"), "clip.mp4", &mut reserved)
                .unwrap();

        assert_eq!(relative_path, "footage/clip 1.mp4");
        assert!(reserved.contains("footage/clip 1.mp4"));
    }

    #[test]
    fn copy_external_files_into_workspace_copies_supported_media_to_target_dir() {
        let project = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join("footage")).unwrap();
        fs::write(source_dir.path().join("clip.mp4"), b"media").unwrap();

        let source_path = source_dir
            .path()
            .join("clip.mp4")
            .to_string_lossy()
            .to_string();
        let result =
            copy_external_files_into_workspace(project.path(), &[source_path], Some("footage"))
                .unwrap();

        assert!(result.failed_files.is_empty());
        assert_eq!(result.imported_files.len(), 1);
        assert_eq!(result.imported_files[0].relative_path, "footage/clip.mp4");
        assert_eq!(result.imported_files[0].kind, AssetKind::Video);
        assert!(project.path().join("footage/clip.mp4").is_file());
    }

    #[test]
    fn copy_external_files_into_workspace_reports_unsupported_files() {
        let project = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        fs::write(source_dir.path().join("notes.txt"), b"text").unwrap();

        let source_path = source_dir
            .path()
            .join("notes.txt")
            .to_string_lossy()
            .to_string();
        let result = copy_external_files_into_workspace(project.path(), &[source_path], None)
            .expect("batch import should return per-file failures");

        assert!(result.imported_files.is_empty());
        assert_eq!(result.failed_files.len(), 1);
        assert!(result.failed_files[0]
            .message
            .contains("Unsupported file type"));
        assert!(!project.path().join("notes.txt").exists());
    }
}

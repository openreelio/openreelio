//! Workspace IPC Commands
//!
//! Tauri commands for workspace-based asset management:
//! scanning, file tree, file registration, and watching.

use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::core::assets::{Asset, AssetKind, AudioInfo, VideoInfo};
use crate::core::workspace::index::IndexEntry;
use crate::core::workspace::path_resolver;
use crate::core::workspace::service::{FileTreeEntry, WorkspaceService};
use crate::core::CoreError;
use crate::AppState;

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
    /// Child entries (for directories)
    pub children: Vec<FileTreeEntryDto>,
}

/// Result of registering a workspace file
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RegisterFileResultDto {
    /// The generated asset ID
    pub asset_id: String,
    /// The relative path that was registered
    pub relative_path: String,
    /// Whether this was already registered (returned existing ID)
    pub already_registered: bool,
}

// =============================================================================
// IPC Commands
// =============================================================================

/// Scan the project workspace for media files
#[tauri::command]
#[specta::specta]
pub async fn scan_workspace(state: State<'_, AppState>) -> Result<WorkspaceScanResultDto, String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let service = WorkspaceService::open(project.path.clone()).map_err(|e| e.to_ipc_error())?;

    let result = service.initial_scan().map_err(|e| e.to_ipc_error())?;

    tracing::info!(
        total = result.total_files,
        new = result.new_files,
        removed = result.removed_files,
        registered = result.registered_files,
        "Workspace scan completed"
    );

    Ok(WorkspaceScanResultDto {
        total_files: result.total_files,
        new_files: result.new_files,
        removed_files: result.removed_files,
        registered_files: result.registered_files,
    })
}

/// Get the workspace file tree
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
    Ok(tree.into_iter().map(convert_tree_entry).collect())
}

/// Register a workspace file as a project asset (auto-import)
#[tauri::command]
#[specta::specta]
pub async fn register_workspace_file(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<RegisterFileResultDto, String> {
    use crate::core::commands::ImportAssetCommand;

    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let project_root = project.path.clone();
    let relative_path = normalize_relative_workspace_path(&project_root, &relative_path)?;

    // Check if already registered in the workspace index
    let service = WorkspaceService::open(project_root.clone()).map_err(|e| e.to_ipc_error())?;
    let asset_kind = ensure_index_entry_for_registration(&service, &relative_path)?;

    if let Some(entry) = service
        .index()
        .get(&relative_path)
        .map_err(|e| e.to_ipc_error())?
    {
        if let Some(asset_id) = &entry.asset_id {
            if project.state.assets.contains_key(asset_id) {
                return Ok(RegisterFileResultDto {
                    asset_id: asset_id.clone(),
                    relative_path,
                    already_registered: true,
                });
            }

            tracing::warn!(
                path = %entry.relative_path,
                stale_asset_id = %asset_id,
                "Workspace index contained stale registration; re-registering file"
            );
            service
                .index()
                .unmark_registered(&entry.relative_path)
                .map_err(|e| e.to_ipc_error())?;
        }
    }

    // Resolve the file name
    let name = std::path::Path::new(&relative_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    // Create import command with kind validated by workspace scanner/index.
    let asset = create_asset_for_kind(&name, &relative_path, asset_kind);

    let command = ImportAssetCommand::from_asset(asset).with_project_root(project_root.clone());

    let asset_id = command.asset_id().to_string();

    // Execute the import
    project
        .executor
        .execute(Box::new(command), &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    if let Some(asset) = project.state.assets.get(&asset_id) {
        let resolved_path = std::path::PathBuf::from(&asset.uri);
        state.allow_asset_protocol_file(&resolved_path);
    }

    // Mark as registered in workspace index
    if let Err(e) = service.index().mark_registered(&relative_path, &asset_id) {
        tracing::warn!(
            path = %relative_path,
            asset_id = %asset_id,
            error = %e,
            "Failed to mark file as registered in workspace index"
        );
    }

    Ok(RegisterFileResultDto {
        asset_id,
        relative_path,
        already_registered: false,
    })
}

/// Batch register multiple workspace files
#[tauri::command]
#[specta::specta]
pub async fn register_workspace_files(
    relative_paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<RegisterFileResultDto>, String> {
    use crate::core::commands::ImportAssetCommand;

    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let project_root = project.path.clone();
    let service = WorkspaceService::open(project_root.clone()).map_err(|e| e.to_ipc_error())?;

    let mut results = Vec::with_capacity(relative_paths.len());

    for raw_relative_path in relative_paths {
        let relative_path =
            match normalize_relative_workspace_path(&project_root, &raw_relative_path) {
                Ok(path) => path,
                Err(error) => {
                    tracing::warn!(
                        path = %raw_relative_path,
                        error = %error,
                        "Skipping invalid workspace registration path"
                    );
                    continue;
                }
            };

        let asset_kind = match ensure_index_entry_for_registration(&service, &relative_path) {
            Ok(kind) => kind,
            Err(error) => {
                tracing::warn!(
                    path = %relative_path,
                    error = %error,
                    "Skipping workspace file that is unsupported or ignored"
                );
                continue;
            }
        };

        // Check if already registered
        if let Ok(Some(entry)) = service.index().get(&relative_path) {
            if let Some(asset_id) = &entry.asset_id {
                if project.state.assets.contains_key(asset_id) {
                    results.push(RegisterFileResultDto {
                        asset_id: asset_id.clone(),
                        relative_path,
                        already_registered: true,
                    });
                    continue;
                }

                tracing::warn!(
                    path = %entry.relative_path,
                    stale_asset_id = %asset_id,
                    "Batch registration found stale workspace index entry; re-registering"
                );
                if let Err(e) = service.index().unmark_registered(&entry.relative_path) {
                    tracing::warn!(
                        path = %entry.relative_path,
                        error = %e,
                        "Failed to clear stale workspace registration"
                    );
                }
            }
        }

        let name = std::path::Path::new(&relative_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        let asset = create_asset_for_kind(&name, &relative_path, asset_kind);

        let command = ImportAssetCommand::from_asset(asset).with_project_root(project_root.clone());

        let asset_id = command.asset_id().to_string();

        match project
            .executor
            .execute(Box::new(command), &mut project.state)
        {
            Ok(_) => {
                if let Some(asset) = project.state.assets.get(&asset_id) {
                    let resolved_path = std::path::PathBuf::from(&asset.uri);
                    state.allow_asset_protocol_file(&resolved_path);
                }

                if let Err(e) = service.index().mark_registered(&relative_path, &asset_id) {
                    tracing::warn!(
                        path = %relative_path,
                        asset_id = %asset_id,
                        error = %e,
                        "Failed to mark file as registered in workspace index"
                    );
                }
                results.push(RegisterFileResultDto {
                    asset_id,
                    relative_path,
                    already_registered: false,
                });
            }
            Err(e) => {
                tracing::warn!(
                    path = %relative_path,
                    error = %e,
                    "Failed to register workspace file"
                );
            }
        }
    }

    Ok(results)
}

// =============================================================================
// Helpers
// =============================================================================

/// Create an Asset with the already-validated workspace kind.
fn create_asset_for_kind(name: &str, relative_path: &str, kind: AssetKind) -> Asset {
    let asset = match kind {
        AssetKind::Video => Asset::new_video(name, "", VideoInfo::default()),
        AssetKind::Audio => Asset::new_audio(name, "", AudioInfo::default()),
        AssetKind::Image => Asset::new_image(name, "", 0, 0),
        other_kind @ (AssetKind::Subtitle
        | AssetKind::Font
        | AssetKind::EffectPreset
        | AssetKind::MemePack) => {
            let mut generic = Asset::new_video(name, "", VideoInfo::default());
            generic.kind = other_kind;
            generic.video = None;
            generic.audio = None;
            generic
        }
    };

    asset
        .with_relative_path(relative_path)
        .as_workspace_managed()
}

fn ensure_index_entry_for_registration(
    service: &WorkspaceService,
    relative_path: &str,
) -> Result<AssetKind, String> {
    let existing = service
        .index()
        .get(relative_path)
        .map_err(|e| e.to_ipc_error())?;

    let discovered = service
        .scanner()
        .scan_path(std::path::Path::new(relative_path))
        .ok_or_else(|| {
            if existing.is_some() {
                if let Err(error) = service.index().remove(relative_path) {
                    tracing::warn!(
                        path = %relative_path,
                        error = %error,
                        "Failed to remove stale workspace index entry for unsupported file"
                    );
                }
            }

            format!(
                "Workspace file is not a supported media asset or is ignored: {}",
                relative_path
            )
        })?;

    let modified_at = discovered
        .modified_at
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);

    let kind = discovered.kind.clone();
    let entry = IndexEntry {
        relative_path: discovered.relative_path,
        kind,
        file_size: discovered.file_size,
        modified_at,
        asset_id: existing.and_then(|entry| entry.asset_id),
        indexed_at: chrono::Utc::now().timestamp(),
        metadata_extracted: false,
    };

    let result_kind = entry.kind.clone();
    service
        .index()
        .upsert(&entry)
        .map_err(|e| e.to_ipc_error())?;
    Ok(result_kind)
}

fn normalize_relative_workspace_path(
    project_root: &std::path::Path,
    raw_path: &str,
) -> Result<String, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("relativePath is empty".to_string());
    }

    let normalized = trimmed.replace('\\', "/");
    let absolute_path = project_root.join(&normalized);

    if !path_resolver::is_inside_project(project_root, &absolute_path) {
        return Err("relativePath escapes the project root".to_string());
    }

    if !absolute_path.exists() {
        return Err(format!(
            "Workspace file not found: {}",
            absolute_path.display()
        ));
    }

    if !absolute_path.is_file() {
        return Err(format!(
            "Workspace path is not a file: {}",
            absolute_path.display()
        ));
    }

    path_resolver::to_relative(project_root, &absolute_path)
        .ok_or_else(|| "Failed to normalize workspace relative path".to_string())
}

/// Convert internal FileTreeEntry to DTO
fn convert_tree_entry(entry: FileTreeEntry) -> FileTreeEntryDto {
    FileTreeEntryDto {
        relative_path: entry.relative_path,
        name: entry.name,
        is_directory: entry.is_directory,
        kind: entry.kind,
        file_size: entry.file_size,
        asset_id: entry.asset_id,
        children: entry.children.into_iter().map(convert_tree_entry).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_index_entry_registers_unscanned_media_file() {
        let dir = tempfile::tempdir().unwrap();
        let media_dir = dir.path().join("footage");
        std::fs::create_dir_all(&media_dir).unwrap();
        std::fs::write(media_dir.join("clip.mp4"), "video").unwrap();

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        let kind = ensure_index_entry_for_registration(&service, "footage/clip.mp4").unwrap();

        assert_eq!(kind, AssetKind::Video);

        let entry = service.index().get("footage/clip.mp4").unwrap();
        assert!(entry.is_some());
        assert_eq!(entry.unwrap().kind, AssetKind::Video);
    }

    #[test]
    fn ensure_index_entry_rejects_unsupported_file_type() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), "not media").unwrap();

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        let result = ensure_index_entry_for_registration(&service, "notes.txt");

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not a supported media asset"));
    }

    #[test]
    fn ensure_index_entry_removes_stale_entry_when_file_becomes_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes.txt"), "not media").unwrap();

        let service = WorkspaceService::open(dir.path().to_path_buf()).unwrap();
        let stale_entry = IndexEntry {
            relative_path: "notes.txt".to_string(),
            kind: AssetKind::Video,
            file_size: 9,
            modified_at: 0,
            asset_id: Some("asset_stale".to_string()),
            indexed_at: 0,
            metadata_extracted: false,
        };
        service.index().upsert(&stale_entry).unwrap();

        let result = ensure_index_entry_for_registration(&service, "notes.txt");
        assert!(result.is_err());

        let post = service.index().get("notes.txt").unwrap();
        assert!(post.is_none());
    }

    #[test]
    fn normalize_relative_workspace_path_rejects_parent_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let result = normalize_relative_workspace_path(dir.path(), "../outside.mp4");

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("escapes the project root"));
    }

    #[test]
    fn create_asset_for_kind_handles_non_av_kinds_without_video_metadata() {
        let asset =
            create_asset_for_kind("captions.srt", "captions/captions.srt", AssetKind::Subtitle);

        assert_eq!(asset.kind, AssetKind::Subtitle);
        assert!(asset.workspace_managed);
        assert_eq!(
            asset.relative_path.as_deref(),
            Some("captions/captions.srt")
        );
        assert!(asset.video.is_none());
        assert!(asset.audio.is_none());
    }
}

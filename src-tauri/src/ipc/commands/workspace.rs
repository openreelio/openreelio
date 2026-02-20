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
use tauri::State;

use crate::core::assets::AssetKind;
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
    /// Number of files auto-registered during this scan
    pub auto_registered_files: usize,
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

// =============================================================================
// IPC Commands
// =============================================================================

/// Scan the project workspace for media files and auto-register them as assets
#[tauri::command]
#[specta::specta]
pub async fn scan_workspace(state: State<'_, AppState>) -> Result<WorkspaceScanResultDto, String> {
    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let project_root = project.path.clone();
    let service = WorkspaceService::open(project_root.clone()).map_err(|e| e.to_ipc_error())?;

    let result = service.initial_scan().map_err(|e| e.to_ipc_error())?;

    // Auto-register all discovered files as project assets
    let auto_registered = service
        .auto_register_discovered_files(&mut project.state, &project_root)
        .map_err(|e| e.to_ipc_error())?;

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

    Ok(WorkspaceScanResultDto {
        total_files: result.total_files,
        new_files: result.new_files,
        removed_files: result.removed_files,
        registered_files: result.registered_files,
        auto_registered_files: auto_registered,
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
        std::process::Command::new("explorer")
            .args(["/select,", &path_str])
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

// =============================================================================
// Helpers
// =============================================================================

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
}

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
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::State;
use walkdir::{DirEntry, WalkDir};

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
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let allow_create = create_if_missing.unwrap_or(true);
    let absolute_path = resolve_workspace_path(&project.path, &relative_path, true)?;

    if !is_text_document_path(&absolute_path) {
        return Err("File type is not supported for text editing".to_string());
    }

    let content_bytes = content.as_bytes();
    if content_bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "Content is too large ({} bytes, max {})",
            content_bytes.len(),
            MAX_DOCUMENT_BYTES
        ));
    }

    let existed = absolute_path.exists();
    if existed && !absolute_path.is_file() {
        return Err(format!("Not a file: {}", absolute_path.display()));
    }
    if !existed && !allow_create {
        return Err(format!("File not found: {}", relative_path));
    }

    if let Some(parent) = absolute_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create parent directories for '{}': {}",
                relative_path, e
            )
        })?;
    }

    std::fs::write(&absolute_path, content_bytes)
        .map_err(|e| format!("Failed to write file '{}': {}", relative_path, e))?;

    let normalized_relative = absolute_path
        .strip_prefix(&project.path)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or(relative_path);

    Ok(WorkspaceDocumentWriteResultDto {
        relative_path: normalized_relative,
        bytes_written: content_bytes.len(),
        created: !existed,
    })
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

fn validate_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err("relativePath is required".to_string());
    }

    if trimmed.chars().any(|c| c.is_control()) {
        return Err("relativePath contains control characters".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        return Err("Path must be relative to project root".to_string());
    }

    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Path cannot contain parent directory traversal".to_string());
    }

    Ok(candidate)
}

fn resolve_workspace_path(
    project_root: &Path,
    relative_path: &str,
    allow_missing: bool,
) -> Result<PathBuf, String> {
    let relative = validate_relative_path(relative_path)?;
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
        assert!(!is_text_document_path(Path::new("video/movie.mp4")));
    }

    #[test]
    fn validate_relative_path_rejects_traversal_and_absolute_paths() {
        assert!(validate_relative_path("docs/readme.md").is_ok());
        assert!(validate_relative_path("../secrets.txt").is_err());

        let absolute_candidate = if cfg!(windows) {
            "C:/temp/file.txt"
        } else {
            "/tmp/file.txt"
        };
        assert!(validate_relative_path(absolute_candidate).is_err());
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
}

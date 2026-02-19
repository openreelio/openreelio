//! Filesystem Commands
//!
//! Commands for filesystem operations: create folder, rename, move, delete.
//! All operations work on real filesystem paths and update asset paths accordingly.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::core::{assets::Asset, project::ProjectState, AssetId, CoreError, CoreResult};

use super::traits::{Command, CommandResult};

/// Normalize a path by resolving `.` and `..` components without filesystem access.
/// This prevents traversal attacks even when `canonicalize()` is not available.
fn normalize_path_components(path: &Path) -> PathBuf {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                // Only pop if we have a normal component to pop
                if matches!(components.last(), Some(std::path::Component::Normal(_))) {
                    components.pop();
                }
                // Otherwise keep it (will be caught by starts_with check)
            }
            std::path::Component::CurDir => { /* skip */ }
            other => components.push(other),
        }
    }
    components.iter().collect()
}

/// Validate that a path is inside the project root (no escaping via ..)
fn validate_inside_project(project_root: &Path, target: &Path) -> CoreResult<()> {
    // First check: reject any raw `..` components in the relative portion
    let normalized_target = normalize_path_components(target);
    let normalized_root = normalize_path_components(project_root);

    if !normalized_target.starts_with(&normalized_root) {
        return Err(CoreError::ValidationError(format!(
            "Path escapes project root: {}",
            target.display()
        )));
    }

    // Second check: if paths exist on disk, use canonicalize for symlink resolution
    if let (Ok(canonical_root), Ok(canonical_target)) =
        (project_root.canonicalize(), target.canonicalize())
    {
        if !canonical_target.starts_with(&canonical_root) {
            return Err(CoreError::ValidationError(format!(
                "Path escapes project root (via symlink): {}",
                target.display()
            )));
        }
    } else if target.exists() {
        // Target exists but canonicalize failed — suspicious
        return Err(CoreError::ValidationError(format!(
            "Cannot resolve path: {}",
            target.display()
        )));
    }
    // If target doesn't exist (new file/folder), the normalized check above is sufficient

    Ok(())
}

fn join_relative_path(parent: &Path, name: &str) -> String {
    parent.join(name).to_string_lossy().replace('\\', "/")
}

// =============================================================================
// CreateFolderCommand
// =============================================================================

/// Creates a new folder on the real filesystem
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderCommand {
    relative_path: String,
    #[serde(skip)]
    project_root: Option<PathBuf>,
    #[serde(skip)]
    created: bool,
}

impl CreateFolderCommand {
    pub fn new(relative_path: &str, project_root: PathBuf) -> Self {
        Self {
            relative_path: relative_path.to_string(),
            project_root: Some(project_root),
            created: false,
        }
    }
}

impl Command for CreateFolderCommand {
    fn execute(&mut self, _state: &mut ProjectState) -> CoreResult<CommandResult> {
        let project_root = self.project_root.as_ref().ok_or_else(|| {
            CoreError::Internal("CreateFolderCommand: project_root not set".to_string())
        })?;

        let target = project_root.join(&self.relative_path);
        validate_inside_project(project_root, &target)?;

        if target.exists() {
            return Err(CoreError::InvalidCommand(format!(
                "Folder already exists: {}",
                self.relative_path
            )));
        }

        std::fs::create_dir_all(&target).map_err(|e| {
            CoreError::Internal(format!(
                "Failed to create folder '{}': {}",
                self.relative_path, e
            ))
        })?;
        self.created = true;

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id))
    }

    fn undo(&self, _state: &mut ProjectState) -> CoreResult<()> {
        if self.created {
            if let Some(ref project_root) = self.project_root {
                let target = project_root.join(&self.relative_path);
                // Only remove if empty — ignore NotFound (already cleaned up)
                match std::fs::remove_dir(&target) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        return Err(CoreError::Internal(format!(
                            "Failed to undo folder creation '{}': {}",
                            self.relative_path, e
                        )));
                    }
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "CreateFolder"
    }

    fn to_json(&self) -> serde_json::Value {
        json!({ "relativePath": self.relative_path })
    }
}

// =============================================================================
// RenameFileCommand
// =============================================================================

/// Renames a file or folder on disk and updates asset paths
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFileCommand {
    old_relative_path: String,
    new_name: String,
    #[serde(skip)]
    project_root: Option<PathBuf>,
    /// (asset_id, old_relative_path, new_relative_path)
    #[serde(skip)]
    affected_assets: Vec<(AssetId, String, String)>,
}

impl RenameFileCommand {
    pub fn new(old_relative_path: &str, new_name: &str, project_root: PathBuf) -> Self {
        Self {
            old_relative_path: old_relative_path.to_string(),
            new_name: new_name.to_string(),
            project_root: Some(project_root),
            affected_assets: vec![],
        }
    }
}

impl Command for RenameFileCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let project_root = self.project_root.as_ref().ok_or_else(|| {
            CoreError::Internal("RenameFileCommand: project_root not set".to_string())
        })?;

        // Validate name doesn't contain path separators
        if self.new_name.contains('/') || self.new_name.contains('\\') {
            return Err(CoreError::InvalidCommand(
                "New name cannot contain path separators".to_string(),
            ));
        }

        let old_path = project_root.join(&self.old_relative_path);
        validate_inside_project(project_root, &old_path)?;

        if !old_path.exists() {
            return Err(CoreError::NotFound(format!(
                "File not found: {}",
                self.old_relative_path
            )));
        }

        let new_relative_path = if let Some(parent) = Path::new(&self.old_relative_path).parent() {
            if parent.as_os_str().is_empty() {
                self.new_name.clone()
            } else {
                join_relative_path(parent, &self.new_name)
            }
        } else {
            self.new_name.clone()
        };

        let new_path = project_root.join(&new_relative_path);
        validate_inside_project(project_root, &new_path)?;

        if new_path.exists() {
            return Err(CoreError::InvalidCommand(format!(
                "Target already exists: {}",
                new_relative_path
            )));
        }

        // Perform the filesystem rename
        std::fs::rename(&old_path, &new_path).map_err(|e| {
            CoreError::Internal(format!(
                "Failed to rename '{}' to '{}': {}",
                self.old_relative_path, new_relative_path, e
            ))
        })?;

        let is_directory = new_path.is_dir();

        // Update affected assets
        self.affected_assets.clear();
        let old_prefix = &self.old_relative_path;
        let new_prefix = &new_relative_path;

        for asset in state.assets.values_mut() {
            if let Some(ref rel_path) = asset.relative_path {
                let matches = if is_directory {
                    rel_path == old_prefix || rel_path.starts_with(&format!("{}/", old_prefix))
                } else {
                    rel_path == old_prefix
                };

                if matches {
                    let old_rel = rel_path.clone();
                    let new_rel = if is_directory {
                        rel_path.replacen(old_prefix, new_prefix, 1)
                    } else {
                        new_relative_path.clone()
                    };

                    self.affected_assets
                        .push((asset.id.clone(), old_rel, new_rel.clone()));

                    // Update asset fields
                    asset.relative_path = Some(new_rel);
                    let new_abs = project_root.join(asset.relative_path.as_ref().unwrap());
                    asset.uri = new_abs.to_string_lossy().to_string();
                    if !is_directory {
                        asset.name = self.new_name.clone();
                    }
                }
            }
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(ref project_root) = self.project_root {
            let new_relative_path =
                if let Some(parent) = Path::new(&self.old_relative_path).parent() {
                    if parent.as_os_str().is_empty() {
                        self.new_name.clone()
                    } else {
                        join_relative_path(parent, &self.new_name)
                    }
                } else {
                    self.new_name.clone()
                };

            let old_path = project_root.join(&self.old_relative_path);
            let new_path = project_root.join(&new_relative_path);

            // Reverse the filesystem rename
            std::fs::rename(&new_path, &old_path).map_err(|e| {
                CoreError::Internal(format!(
                    "Failed to undo rename '{}' -> '{}': {}",
                    new_relative_path, self.old_relative_path, e
                ))
            })?;

            // Restore asset paths
            for (asset_id, old_rel, _new_rel) in &self.affected_assets {
                if let Some(asset) = state.assets.get_mut(asset_id) {
                    asset.relative_path = Some(old_rel.clone());
                    let abs = project_root.join(old_rel);
                    asset.uri = abs.to_string_lossy().to_string();
                    // Restore name from old path
                    if let Some(name) = Path::new(old_rel).file_name() {
                        asset.name = name.to_string_lossy().to_string();
                    }
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RenameFile"
    }

    fn to_json(&self) -> serde_json::Value {
        json!({
            "oldRelativePath": self.old_relative_path,
            "newName": self.new_name,
        })
    }
}

// =============================================================================
// MoveFileCommand
// =============================================================================

/// Moves a file or folder to a new location and updates asset paths
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveFileCommand {
    source_path: String,
    dest_folder_path: String,
    #[serde(skip)]
    project_root: Option<PathBuf>,
    #[serde(skip)]
    affected_assets: Vec<(AssetId, String, String)>,
}

impl MoveFileCommand {
    pub fn new(source_path: &str, dest_folder_path: &str, project_root: PathBuf) -> Self {
        Self {
            source_path: source_path.to_string(),
            dest_folder_path: dest_folder_path.to_string(),
            project_root: Some(project_root),
            affected_assets: vec![],
        }
    }
}

impl Command for MoveFileCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let project_root = self.project_root.as_ref().ok_or_else(|| {
            CoreError::Internal("MoveFileCommand: project_root not set".to_string())
        })?;

        let src = project_root.join(&self.source_path);
        validate_inside_project(project_root, &src)?;

        if !src.exists() {
            return Err(CoreError::NotFound(format!(
                "Source not found: {}",
                self.source_path
            )));
        }

        let dest_dir = if self.dest_folder_path.is_empty() {
            project_root.to_path_buf()
        } else {
            project_root.join(&self.dest_folder_path)
        };
        validate_inside_project(project_root, &dest_dir)?;

        if !dest_dir.is_dir() {
            return Err(CoreError::NotFound(format!(
                "Destination folder not found: {}",
                self.dest_folder_path
            )));
        }

        let file_name = src
            .file_name()
            .ok_or_else(|| CoreError::Internal("Source has no filename".to_string()))?;
        let dest = dest_dir.join(file_name);

        if dest.exists() {
            return Err(CoreError::InvalidCommand(format!(
                "Target already exists: {}",
                dest.display()
            )));
        }

        // Compute new relative path
        let new_relative_path = dest
            .strip_prefix(project_root)
            .map_err(|_| CoreError::Internal("Cannot compute relative path".to_string()))?
            .to_string_lossy()
            .replace('\\', "/");

        // Perform the filesystem move
        std::fs::rename(&src, &dest).map_err(|e| {
            CoreError::Internal(format!(
                "Failed to move '{}' to '{}': {}",
                self.source_path, new_relative_path, e
            ))
        })?;

        let is_directory = dest.is_dir();
        let old_prefix = &self.source_path;
        let new_prefix = &new_relative_path;

        // Update affected assets
        self.affected_assets.clear();
        for asset in state.assets.values_mut() {
            if let Some(ref rel_path) = asset.relative_path {
                let matches = if is_directory {
                    rel_path == old_prefix || rel_path.starts_with(&format!("{}/", old_prefix))
                } else {
                    rel_path == old_prefix
                };

                if matches {
                    let old_rel = rel_path.clone();
                    let new_rel = if is_directory {
                        rel_path.replacen(old_prefix, new_prefix, 1)
                    } else {
                        new_relative_path.clone()
                    };

                    self.affected_assets
                        .push((asset.id.clone(), old_rel, new_rel.clone()));
                    asset.relative_path = Some(new_rel);
                    let new_abs = project_root.join(asset.relative_path.as_ref().unwrap());
                    asset.uri = new_abs.to_string_lossy().to_string();
                }
            }
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(ref project_root) = self.project_root {
            // Reconstruct the paths to reverse
            let file_name = Path::new(&self.source_path).file_name().unwrap_or_default();
            let dest_dir = if self.dest_folder_path.is_empty() {
                project_root.to_path_buf()
            } else {
                project_root.join(&self.dest_folder_path)
            };
            let current_path = dest_dir.join(file_name);
            let original_path = project_root.join(&self.source_path);

            std::fs::rename(&current_path, &original_path).map_err(|e| {
                CoreError::Internal(format!(
                    "Failed to undo move '{}' -> '{}': {}",
                    current_path.display(),
                    original_path.display(),
                    e
                ))
            })?;

            // Restore asset paths
            for (asset_id, old_rel, _new_rel) in &self.affected_assets {
                if let Some(asset) = state.assets.get_mut(asset_id) {
                    asset.relative_path = Some(old_rel.clone());
                    let abs = project_root.join(old_rel);
                    asset.uri = abs.to_string_lossy().to_string();
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "MoveFile"
    }

    fn to_json(&self) -> serde_json::Value {
        json!({
            "sourcePath": self.source_path,
            "destFolderPath": self.dest_folder_path,
        })
    }
}

// =============================================================================
// DeleteFileCommand
// =============================================================================

/// Deletes a file or folder (moves to OS trash) and handles asset cleanup
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFileCommand {
    relative_path: String,
    #[serde(skip)]
    project_root: Option<PathBuf>,
    /// Assets that were marked as missing (id, was_missing_before)
    #[serde(skip)]
    affected_assets: Vec<(AssetId, bool)>,
    /// Assets that were fully removed (not referenced by clips)
    #[serde(skip)]
    removed_assets: Vec<Asset>,
}

impl DeleteFileCommand {
    pub fn new(relative_path: &str, project_root: PathBuf) -> Self {
        Self {
            relative_path: relative_path.to_string(),
            project_root: Some(project_root),
            affected_assets: vec![],
            removed_assets: vec![],
        }
    }

    /// Check if an asset is referenced by any clip in any sequence
    fn is_asset_in_use(asset_id: &str, state: &ProjectState) -> bool {
        state.sequences.values().any(|seq| {
            seq.tracks
                .iter()
                .any(|track| track.clips.iter().any(|clip| clip.asset_id == asset_id))
        })
    }
}

impl Command for DeleteFileCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let project_root = self.project_root.as_ref().ok_or_else(|| {
            CoreError::Internal("DeleteFileCommand: project_root not set".to_string())
        })?;

        let target = project_root.join(&self.relative_path);
        validate_inside_project(project_root, &target)?;

        if !target.exists() {
            return Err(CoreError::NotFound(format!(
                "File not found: {}",
                self.relative_path
            )));
        }

        let is_directory = target.is_dir();

        // Find and handle affected assets
        self.affected_assets.clear();
        self.removed_assets.clear();

        let old_prefix = &self.relative_path;
        let asset_ids_to_process: Vec<(AssetId, String)> = state
            .assets
            .values()
            .filter_map(|asset| {
                if let Some(ref rel_path) = asset.relative_path {
                    let matches = if is_directory {
                        rel_path == old_prefix || rel_path.starts_with(&format!("{}/", old_prefix))
                    } else {
                        rel_path == old_prefix
                    };
                    if matches {
                        return Some((asset.id.clone(), rel_path.clone()));
                    }
                }
                None
            })
            .collect();

        for (asset_id, _rel_path) in &asset_ids_to_process {
            if Self::is_asset_in_use(asset_id, state) {
                // Mark as missing instead of removing
                if let Some(asset) = state.assets.get_mut(asset_id) {
                    let was_missing = asset.missing;
                    asset.missing = true;
                    self.affected_assets.push((asset_id.clone(), was_missing));
                }
            } else {
                // Remove entirely
                if let Some(asset) = state.assets.remove(asset_id) {
                    self.removed_assets.push(asset);
                }
            }
        }

        // Move to trash
        trash::delete(&target).map_err(|e| {
            // If trash fails, restore state and return error
            for asset in &self.removed_assets {
                state.assets.insert(asset.id.clone(), asset.clone());
            }
            for (asset_id, was_missing) in &self.affected_assets {
                if let Some(asset) = state.assets.get_mut(asset_id) {
                    asset.missing = *was_missing;
                }
            }
            CoreError::Internal(format!("Failed to delete '{}': {}", self.relative_path, e))
        })?;

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        // Note: We cannot restore from trash programmatically.
        // But we can restore the asset state.
        for asset in &self.removed_assets {
            state.assets.insert(asset.id.clone(), asset.clone());
        }
        for (asset_id, was_missing) in &self.affected_assets {
            if let Some(asset) = state.assets.get_mut(asset_id) {
                asset.missing = *was_missing;
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "DeleteFile"
    }

    fn to_json(&self) -> serde_json::Value {
        json!({ "relativePath": self.relative_path })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::VideoInfo;

    fn create_test_state() -> ProjectState {
        ProjectState::new_empty("Test")
    }

    #[test]
    fn test_create_folder_command() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = create_test_state();

        let mut cmd = CreateFolderCommand::new("new_folder", dir.path().to_path_buf());
        let result = cmd.execute(&mut state);
        assert!(result.is_ok());
        assert!(dir.path().join("new_folder").is_dir());

        // Undo
        cmd.undo(&mut state).unwrap();
        assert!(!dir.path().join("new_folder").exists());
    }

    #[test]
    fn test_create_folder_already_exists() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("existing")).unwrap();
        let mut state = create_test_state();

        let mut cmd = CreateFolderCommand::new("existing", dir.path().to_path_buf());
        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_rename_file_command() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("old.mp4"), b"test").unwrap();

        let mut state = create_test_state();
        let asset = Asset::new_video(
            "old.mp4",
            &dir.path().join("old.mp4").to_string_lossy(),
            VideoInfo::default(),
        )
        .with_relative_path("old.mp4")
        .as_workspace_managed();
        let asset_id = asset.id.clone();
        state.assets.insert(asset_id.clone(), asset);

        let mut cmd = RenameFileCommand::new("old.mp4", "new.mp4", dir.path().to_path_buf());
        cmd.execute(&mut state).unwrap();

        assert!(dir.path().join("new.mp4").exists());
        assert!(!dir.path().join("old.mp4").exists());

        let asset = state.assets.get(&asset_id).unwrap();
        assert_eq!(asset.relative_path, Some("new.mp4".to_string()));
        assert_eq!(asset.name, "new.mp4");
    }

    #[test]
    fn test_move_file_command() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("dest")).unwrap();
        std::fs::write(dir.path().join("clip.mp4"), b"test").unwrap();

        let mut state = create_test_state();
        let asset = Asset::new_video(
            "clip.mp4",
            &dir.path().join("clip.mp4").to_string_lossy(),
            VideoInfo::default(),
        )
        .with_relative_path("clip.mp4")
        .as_workspace_managed();
        let asset_id = asset.id.clone();
        state.assets.insert(asset_id.clone(), asset);

        let mut cmd = MoveFileCommand::new("clip.mp4", "dest", dir.path().to_path_buf());
        cmd.execute(&mut state).unwrap();

        assert!(dir.path().join("dest/clip.mp4").exists());
        assert!(!dir.path().join("clip.mp4").exists());

        let asset = state.assets.get(&asset_id).unwrap();
        assert_eq!(asset.relative_path, Some("dest/clip.mp4".to_string()));
    }

    #[test]
    fn test_validate_inside_project() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        // Valid path
        assert!(validate_inside_project(dir.path(), &dir.path().join("sub/file.mp4")).is_ok());
    }
}

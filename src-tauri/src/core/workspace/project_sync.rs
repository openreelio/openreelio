//! Workspace to project synchronization
//!
//! Applies workspace filesystem events to the in-memory project and records
//! them in the operation log, so a session that watched a folder change ends
//! up with the same state a reopen would replay.
//!
//! Kept out of the IPC layer deliberately. The watcher loop calls this while
//! holding the project lock, so nothing here may emit Tauri events or grant
//! asset-protocol access — those belong to the caller, after the lock is
//! released. Being Tauri-free also means this module is compiled (and
//! therefore testable) by `cargo test --lib`, unlike `ipc::commands`.

use std::collections::HashSet;
use std::path::Path;

use crate::core::project::{OpKind, Operation};
use crate::ActiveProject;

use super::service::WorkspaceService;
use super::watcher::WorkspaceEvent;

/// Result of applying one workspace filesystem event to the in-memory project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceEventOutcome {
    /// The event was applied to memory and persisted to the operation log.
    Applied,
    /// Nothing usable happened: either the project changed on disk before the
    /// event could be applied, or the append that would have persisted it
    /// failed. Either way this session's memory can no longer be trusted to
    /// match a replay of the log, so the caller must ask the frontend to
    /// reload from disk.
    Diverged,
}

/// Applies one workspace filesystem event to the in-memory project and persists
/// it as operations.
///
/// Refuses before touching memory when another process moved the operation log,
/// the same way [`crate::core::commands::CommandExecutor`] does: a mutation that
/// cannot be appended would leave this session's memory permanently disagreeing
/// with what reopening the project replays, and a swallowed append error is
/// exactly that divergence made silent.
pub fn apply_workspace_event_to_project(
    project: &mut ActiveProject,
    event: &WorkspaceEvent,
    service: &WorkspaceService,
    project_root: &Path,
) -> WorkspaceEventOutcome {
    if let Err(e) = project.ensure_no_external_changes() {
        tracing::warn!(
            error = %e,
            "Workspace watcher: project changed on disk; event not applied"
        );
        return WorkspaceEventOutcome::Diverged;
    }

    match event {
        WorkspaceEvent::FileRemoved(rel_path) => {
            let mut updated_asset_ids = Vec::new();
            for asset in project.state.assets.values_mut() {
                if !asset.missing && asset.relative_path.as_deref() == Some(rel_path.as_str()) {
                    asset.missing = true;
                    updated_asset_ids.push(asset.id.clone());
                    tracing::info!(
                        path = %rel_path,
                        "Asset marked missing (file removed externally)"
                    );
                }
            }

            if let Err(e) = record_workspace_asset_updates(project, &updated_asset_ids) {
                tracing::warn!(
                    error = %e,
                    "Workspace watcher: failed to persist missing-asset updates"
                );
                return WorkspaceEventOutcome::Diverged;
            }

            WorkspaceEventOutcome::Applied
        }
        WorkspaceEvent::FileAdded(rel_path) | WorkspaceEvent::FileModified(rel_path) => {
            let existing_asset_ids: HashSet<String> =
                project.state.assets.keys().cloned().collect();
            let mut updated_asset_ids = Vec::new();

            // Reconnect previously missing assets at this path
            for asset in project.state.assets.values_mut() {
                if asset.missing && asset.relative_path.as_deref() == Some(rel_path.as_str()) {
                    asset.missing = false;
                    updated_asset_ids.push(asset.id.clone());
                    tracing::info!(
                        path = %rel_path,
                        "Asset reconnected (file re-appeared)"
                    );
                }
            }
            // Auto-register any brand-new files
            if let Err(e) = service.auto_register_discovered_files(&mut project.state, project_root)
            {
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

            if let Err(e) = record_workspace_asset_imports(project, &new_asset_ids) {
                tracing::warn!(
                    error = %e,
                    "Workspace watcher: failed to persist auto-registered assets"
                );
                return WorkspaceEventOutcome::Diverged;
            }

            if let Err(e) = record_workspace_asset_updates(project, &updated_asset_ids) {
                tracing::warn!(
                    error = %e,
                    "Workspace watcher: failed to persist asset reconnection updates"
                );
                return WorkspaceEventOutcome::Diverged;
            }

            WorkspaceEventOutcome::Applied
        }
        // Project state files are handled before indexing; the watcher loop
        // never reaches here with one.
        WorkspaceEvent::ProjectStateChanged(_) => WorkspaceEventOutcome::Applied,
    }
}

/// Appends one workspace-originated operation and advances the project's
/// bookkeeping the same way an edit command would.
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

/// Records an `AssetImport` operation for each newly registered workspace asset.
pub fn record_workspace_asset_imports(
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

/// Records an `AssetUpdate` operation for each workspace asset whose file
/// availability changed.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::Asset;
    use std::fs;

    /// Creates a project holding one registered, workspace-managed asset backed
    /// by a real file, and returns the asset id.
    fn project_with_workspace_asset(project_path: &Path) -> (ActiveProject, String) {
        let mut project =
            ActiveProject::create("Watcher Project", project_path.to_path_buf()).unwrap();

        fs::create_dir_all(project_path.join("footage")).unwrap();
        let media_path = project_path.join("footage/clip.png");
        fs::write(&media_path, b"image bytes").unwrap();

        let mut asset = Asset::new_image(
            "clip.png",
            media_path.to_string_lossy().as_ref(),
            1920,
            1080,
        );
        asset.relative_path = Some("footage/clip.png".to_string());
        asset.workspace_managed = true;
        let asset_id = asset.id.clone();
        project.state.assets.insert(asset_id.clone(), asset);

        (project, asset_id)
    }

    /// Appends an operation from a second process holding the same directory,
    /// which moves the on-disk log past this session's watermark.
    fn append_external_op(project_path: &Path) {
        let other_process = ActiveProject::open(project_path.to_path_buf()).unwrap();
        other_process
            .ops_log
            .append(&Operation::new(
                OpKind::AssetImport,
                serde_json::json!({ "assetId": "external_asset" }),
            ))
            .unwrap();
    }

    /// Scenario: another process moved the log before the watcher event landed.
    #[test]
    fn apply_workspace_event_diverges_without_mutating_after_an_external_edit() {
        // Given a session that has gone stale behind another process
        let temp = tempfile::tempdir().unwrap();
        let project_path = temp.path().join("watched_project");
        let (mut project, asset_id) = project_with_workspace_asset(&project_path);
        let service = WorkspaceService::open(project_path.clone()).unwrap();

        append_external_op(&project_path);
        let ops_before = project.on_disk_op_count().unwrap();

        // When the watcher reports the asset's file as removed
        let outcome = apply_workspace_event_to_project(
            &mut project,
            &WorkspaceEvent::FileRemoved("footage/clip.png".to_string()),
            &service,
            &project_path,
        );

        // Then the event is refused and nothing is left half-applied
        assert_eq!(outcome, WorkspaceEventOutcome::Diverged);
        assert!(
            !project.state.assets[&asset_id].missing,
            "asset must not be marked missing when the event cannot be persisted"
        );
        assert_eq!(
            project.on_disk_op_count().unwrap(),
            ops_before,
            "nothing may be appended on top of the external operations"
        );
    }

    /// Scenario: the ordinary case, with the log still where this session left it.
    #[test]
    fn apply_workspace_event_marks_asset_missing_and_appends_one_update_op() {
        // Given a project nobody else has touched
        let temp = tempfile::tempdir().unwrap();
        let project_path = temp.path().join("watched_project");
        let (mut project, asset_id) = project_with_workspace_asset(&project_path);
        let service = WorkspaceService::open(project_path.clone()).unwrap();

        let ops_before = project.on_disk_op_count().unwrap();

        // When the watcher reports the asset's file as removed
        let outcome = apply_workspace_event_to_project(
            &mut project,
            &WorkspaceEvent::FileRemoved("footage/clip.png".to_string()),
            &service,
            &project_path,
        );

        // Then the asset is marked missing and the change is recorded once
        assert_eq!(outcome, WorkspaceEventOutcome::Applied);
        assert!(project.state.assets[&asset_id].missing);
        assert_eq!(project.on_disk_op_count().unwrap(), ops_before + 1);
    }
}

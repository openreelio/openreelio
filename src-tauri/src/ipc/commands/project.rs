//! Project lifecycle commands
//!
//! Tauri IPC commands for creating, opening, closing, saving projects,
//! and querying project state.

use std::path::PathBuf;

use specta::Type;
use tauri::State;

use crate::core::{assets::Asset, fs::validate_existing_project_dir, CoreError};
use crate::{ActiveProject, AppState};

// =============================================================================
// Helper Functions
// =============================================================================

/// Attempts to remove a lock file with retries.
///
/// On Windows, file locks can persist briefly after the handle is dropped.
/// This function retries removal with exponential backoff to handle transient failures.
fn remove_lock_file_with_retry(lock_path: &std::path::Path) {
    const MAX_RETRIES: u32 = 3;
    const INITIAL_DELAY_MS: u64 = 50;

    for attempt in 0..MAX_RETRIES {
        match std::fs::remove_file(lock_path) {
            Ok(_) => {
                tracing::debug!("Lock file removed successfully: {}", lock_path.display());
                return;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // File already removed, nothing to do
                return;
            }
            Err(e) => {
                if attempt < MAX_RETRIES - 1 {
                    let delay = INITIAL_DELAY_MS * (1 << attempt); // Exponential backoff
                    tracing::debug!(
                        "Failed to remove lock file (attempt {}/{}): {}. Retrying in {}ms...",
                        attempt + 1,
                        MAX_RETRIES,
                        e,
                        delay
                    );
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                } else {
                    tracing::warn!(
                        "Failed to remove lock file after {} attempts: {}. \
                         File may need manual cleanup: {}",
                        MAX_RETRIES,
                        e,
                        lock_path.display()
                    );
                }
            }
        }
    }
}

pub(crate) fn allow_project_asset_protocol(
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

pub(crate) fn forbid_project_asset_protocol(
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
// DTOs
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
    /// Resolved text clip payloads (clipId -> TextClipData)
    pub text_clips: Vec<TextClipDataDto>,
    /// Whether project has unsaved changes
    pub is_dirty: bool,
}

/// Resolved text payload for a timeline text clip.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextClipDataDto {
    /// Sequence containing the clip.
    pub sequence_id: String,
    /// Track containing the clip.
    pub track_id: String,
    /// Clip ID for map lookup.
    pub clip_id: String,
    /// Fully resolved text styling/content payload.
    pub text_data: crate::core::text::TextClipData,
}

// =============================================================================
// Commands
// =============================================================================

/// Creates a new project
///
/// This function uses atomic operations to prevent TOCTOU race conditions:
/// 1. Creates a lock file to prevent concurrent project creation
/// 2. Verifies directory state while holding the lock
/// 3. Creates project files atomically
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(project_name = %name, project_path = %path))]
pub async fn create_project(
    name: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectInfo, String> {
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

    // Perform filesystem work in a blocking task to avoid stalling the async runtime.
    let name_for_create = name_trimmed.to_string();
    let project_path_for_create = project_path.clone();

    let project = tokio::task::spawn_blocking(move || -> Result<ActiveProject, String> {
        use fs2::FileExt;
        use std::fs::OpenOptions;

        // Create parent directory if needed (but not the project directory itself yet).
        if let Some(parent) = project_path_for_create.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent directory: {e}"))?;
            }
        }

        // Create a lock file in the parent directory to serialize project creation.
        let lock_path = project_path_for_create.with_extension("lock");
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| format!("Failed to create project lock file: {e}"))?;

        // Acquire exclusive lock to prevent concurrent project creation.
        lock_file
            .lock_exclusive()
            .map_err(|e| format!("Failed to acquire project lock: {e}"))?;

        // After acquiring the lock, verify the directory state.
        // This prevents TOCTOU race conditions.
        let result = (|| {
            if project_path_for_create.exists() {
                if !project_path_for_create.is_dir() {
                    return Err(format!(
                        "Project path must be a directory: {}",
                        project_path_for_create.display()
                    ));
                }

                // Check for existing project files (legacy root layout or hidden state layout).
                let has_project_json = project_path_for_create.join("project.json").exists();
                let has_ops_log = project_path_for_create.join("ops.jsonl").exists();
                let has_snapshot = project_path_for_create.join("snapshot.json").exists();
                let state_dir = project_path_for_create.join(".openreelio").join("state");
                let has_hidden_project_json = state_dir.join("project.json").exists();
                let has_hidden_ops_log = state_dir.join("ops.jsonl").exists();
                let has_hidden_snapshot = state_dir.join("snapshot.json").exists();
                if has_project_json
                    || has_ops_log
                    || has_snapshot
                    || has_hidden_project_json
                    || has_hidden_ops_log
                    || has_hidden_snapshot
                {
                    return Err(format!(
                        "A project already exists at: {}",
                        project_path_for_create.display()
                    ));
                }

                // Check if directory is non-empty (excluding hidden files we might have created).
                let has_user_files = std::fs::read_dir(&project_path_for_create)
                    .map_err(|e| format!("Failed to read project directory: {e}"))?
                    .filter_map(|e| e.ok())
                    .any(|entry| {
                        let name = entry.file_name();
                        let name_str = name.to_string_lossy();
                        // Allow hidden directories that might be for caching.
                        !name_str.starts_with('.')
                    });

                if has_user_files {
                    return Err(format!(
                        "Project directory is not empty: {}",
                        project_path_for_create.display()
                    ));
                }
            }

            // Create project with atomic file operations.
            ActiveProject::create(&name_for_create, project_path_for_create.clone())
                .map_err(|e| e.to_ipc_error())
        })();

        // Release lock and clean up lock file.
        // Dropping the file handle releases the OS-level lock.
        // On Windows, the lock may persist briefly, so we use retry logic.
        drop(lock_file);
        remove_lock_file_with_retry(&lock_path);

        result
    })
    .await
    .map_err(|e| format!("Project creation task failed: {e}"))??;

    tracing::info!(
        "Created new project '{}' at {}",
        name,
        project_path.display()
    );

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
#[specta::specta]
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

    // Opening can involve large reads + replays; keep it off the async runtime threads.
    let project = tokio::task::spawn_blocking(move || ActiveProject::open(project_path))
        .await
        .map_err(|e| format!("Project open task failed: {e}"))?
        .map_err(|e| e.to_ipc_error())?;
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

/// Opens a folder as a project, initializing project files if they don't exist.
///
/// This is the primary entry point for the folder-based workspace workflow:
/// - If the folder already contains project state files (legacy or hidden layout),
///   it opens as an existing project.
/// - If the folder is empty or contains only media files (no project files), it initializes
///   a new project in-place, deriving the project name from the folder name.
///
/// This replaces the old two-step "create project" flow (name + parent -> subfolder).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(project_path = %path))]
pub async fn open_or_init_project(
    path: String,
    state: State<'_, AppState>,
) -> Result<ProjectInfo, String> {
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

    // Check if the directory exists; create it if not.
    if !project_path.exists() {
        std::fs::create_dir_all(&project_path)
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    } else if !project_path.is_dir() {
        return Err(format!(
            "Path is not a directory: {}",
            project_path.display()
        ));
    }

    // Determine whether this is an existing project or needs initialization.
    let has_project_json = project_path.join("project.json").exists();
    let has_ops_log = project_path.join("ops.jsonl").exists();
    let has_snapshot = project_path.join("snapshot.json").exists();
    let hidden_state_dir = project_path.join(".openreelio").join("state");
    let has_hidden_project_json = hidden_state_dir.join("project.json").exists();
    let has_hidden_ops_log = hidden_state_dir.join("ops.jsonl").exists();
    let has_hidden_snapshot = hidden_state_dir.join("snapshot.json").exists();
    let is_existing_project = has_project_json
        || has_ops_log
        || has_snapshot
        || has_hidden_project_json
        || has_hidden_ops_log
        || has_hidden_snapshot;

    let project_path_clone = project_path.clone();
    let project = if is_existing_project {
        // Open the existing project.
        tracing::info!("Opening existing project at {}", project_path.display());
        tokio::task::spawn_blocking(move || ActiveProject::open(project_path_clone))
            .await
            .map_err(|e| format!("Project open task failed: {e}"))?
            .map_err(|e| e.to_ipc_error())?
    } else {
        // Initialize a new project in this folder.
        // Derive the project name from the folder name.
        let folder_name = project_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Untitled Project")
            .to_string();
        tracing::info!(
            "Initializing new project '{}' at {}",
            folder_name,
            project_path.display()
        );
        tokio::task::spawn_blocking(move || ActiveProject::create(&folder_name, project_path_clone))
            .await
            .map_err(|e| format!("Project creation task failed: {e}"))?
            .map_err(|e| e.to_ipc_error())?
    };

    let assets_for_scope: Vec<Asset> = project.state.assets.values().cloned().collect();
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

    // Allowlist the project directory for asset protocol.
    allow_project_asset_protocol(&state, &project_path_canon, &assets_for_scope);

    Ok(info)
}

/// Closes the current project, optionally requiring it to be saved.
#[tauri::command]
#[specta::specta]
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
///
/// After a successful save, the project's `is_dirty` flag is reset to `false`,
/// allowing users to close or open another project without warnings.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn save_project(state: State<'_, AppState>) -> Result<(), String> {
    use crate::core::project::Snapshot;

    let started_at = std::time::Instant::now();
    let (snapshot_path, meta_path, state_snapshot, last_op_id_before) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
        (
            project.snapshot_path.clone(),
            project.meta_path.clone(),
            project.state.clone(),
            project.state.last_op_id.clone(),
        )
    };

    // Perform disk IO on a blocking worker thread.
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        Snapshot::save(
            &snapshot_path,
            &state_snapshot,
            state_snapshot.last_op_id.as_deref(),
        )
        .map_err(|e| e.to_ipc_error())?;

        crate::core::fs::atomic_write_json_pretty(&meta_path, &state_snapshot.meta)
            .map_err(|e| e.to_ipc_error())?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Project save task failed: {e}"))??;

    // Only clear the dirty flag if no newer op was applied during the save window.
    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    if project.state.last_op_id == last_op_id_before {
        project.state.is_dirty = false;
        tracing::debug!("Project saved successfully, is_dirty reset to false");
    } else {
        tracing::warn!(
            last_op_id_before = ?last_op_id_before,
            last_op_id_after = ?project.state.last_op_id,
            "Project state changed during save; keeping is_dirty=true"
        );
    }

    tracing::info!(
        elapsed_ms = started_at.elapsed().as_millis(),
        "save_project completed"
    );
    Ok(())
}

/// Gets current project info
#[tauri::command]
#[specta::specta]
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
#[specta::specta]
pub async fn get_project_state(state: State<'_, AppState>) -> Result<ProjectStateDto, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let text_clips = project
        .state
        .sequences
        .values()
        .flat_map(|sequence| {
            sequence.tracks.iter().flat_map(|track| {
                track.clips.iter().filter_map(|clip| {
                    crate::core::commands::get_text_data(clip, &project.state).map(|text_data| {
                        TextClipDataDto {
                            sequence_id: sequence.id.clone(),
                            track_id: track.id.clone(),
                            clip_id: clip.id.clone(),
                            text_data,
                        }
                    })
                })
            })
        })
        .collect();

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
        text_clips,
        is_dirty: project.state.is_dirty,
    })
}

/// Returns all resolved text clip payloads for a sequence.
///
/// This is used by preview/inspector UIs that need fully resolved text styling
/// from TextOverlay effects without parsing effect internals on the frontend.
#[tauri::command]
#[specta::specta]
pub async fn get_sequence_text_clip_data(
    sequence_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<TextClipDataDto>, String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let sequence = project
        .state
        .sequences
        .get(&sequence_id)
        .ok_or_else(|| CoreError::SequenceNotFound(sequence_id.clone()).to_ipc_error())?;

    let text_clips = sequence
        .tracks
        .iter()
        .flat_map(|track| {
            track.clips.iter().filter_map(|clip| {
                crate::core::commands::get_text_data(clip, &project.state).map(|text_data| {
                    TextClipDataDto {
                        sequence_id: sequence.id.clone(),
                        track_id: track.id.clone(),
                        clip_id: clip.id.clone(),
                        text_data,
                    }
                })
            })
        })
        .collect();

    Ok(text_clips)
}

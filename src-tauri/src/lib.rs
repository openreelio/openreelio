//! OpenReelio Core Library
//!
//! AI Agent-driven, prompt-based video editing IDE.
//! This library contains the core editing engine, command system,
//! and all business logic for the application.
//!
//! ## TypeScript Bindings
//!
//! All IPC types can be exported to TypeScript via tauri-specta.
//! Run `cargo run --manifest-path src-tauri/Cargo.toml --bin export_bindings` to regenerate `src/bindings.ts`.

pub mod core;
pub mod ipc;

use std::path::{Path, PathBuf};
#[cfg(all(not(test), feature = "gui"))]
use std::{collections::HashMap, sync::Arc};

// NOTE: Unit tests in this repository intentionally avoid linking the Tauri runtime.
// On some Windows environments, dynamic dependencies of the webview stack can prevent
// the Rust test harness from starting.
//
// Core business logic is tested without Tauri; the Tauri app entrypoint is compiled
// only for non-test builds. The `gui` feature gates all Tauri-specific code so that
// the library can be compiled without webview dependencies (e.g. for the CLI binary).
#[cfg(all(not(test), feature = "gui"))]
use std::sync::OnceLock;
#[cfg(all(not(test), feature = "gui"))]
use tauri::Manager;
#[cfg(all(not(test), feature = "gui"))]
use tokio::sync::Mutex;

use crate::core::{
    commands::CommandExecutor,
    project::{OpsLog, ProjectHistory, ProjectMeta, ProjectState, Snapshot},
    OpId,
};

#[cfg(all(not(test), feature = "gui"))]
use crate::core::{
    ai::AIGateway,
    jobs::WorkerPool,
    performance::memory::{CacheManager, MemoryPool},
    search::meilisearch::SearchService,
    workspace::watcher::WorkspaceWatcher,
};

// =============================================================================
// Application State
// =============================================================================

/// Active project information
pub struct ActiveProject {
    /// Project directory path
    pub path: PathBuf,
    /// Directory containing persistent project state files (ops/snapshot/meta)
    pub state_dir: PathBuf,
    /// Absolute path to the project metadata file
    pub meta_path: PathBuf,
    /// Absolute path to the project snapshot file
    pub snapshot_path: PathBuf,
    /// Absolute path to the persistent history manifest
    pub history_path: PathBuf,
    /// Project state (in-memory)
    pub state: ProjectState,
    /// Command executor with undo/redo
    pub executor: CommandExecutor,
    /// Operations log path.
    ///
    /// The handle is guarded (see [`OpsLog::begin_guarded_session`]), so it —
    /// and the executor handle derived from it — reject appends made on top of
    /// another process's edits, and reject history rewrites the same way. That
    /// is where external-edit safety is enforced; no caller has to remember a
    /// check.
    ///
    /// Every session is guarded, GUI and `openreelio-cli` alike. A CLI
    /// invocation opens, edits and exits, so it only ever collides with a
    /// process editing the same project *at the same time* — which is exactly
    /// the case that must not silently interleave.
    pub ops_log: OpsLog,
    /// Persistent history metadata used by headless clients.
    pub history: ProjectHistory,
    /// Operations this session folded into the history manifest when it opened.
    ///
    /// Empty for the normal case, where the manifest already described the
    /// whole log. A non-empty list means the ops log had a tail the manifest
    /// did not know about — another writer's work, adopted as history to build
    /// on. Callers that reposition history report it, because unwinding past
    /// entries nobody in this session wrote is not something to do silently.
    pub adopted_op_ids: Vec<String>,
}

pub struct PreparedProjectSave {
    pub snapshot_path: PathBuf,
    pub meta_path: PathBuf,
    pub history_path: PathBuf,
    pub state_snapshot: ProjectState,
    pub history_snapshot: ProjectHistory,
    pub saved_last_op_id: Option<String>,
    /// Guarded log handle of the session that prepared this save.
    ///
    /// [`ActiveProject::write_prepared_save`] runs without the project lock, so
    /// the save carries the guard with it: the history manifest is written
    /// inside the guard's lock, and the write advances this session's history
    /// baseline instead of leaving it describing the pre-save file.
    pub session_log: OpsLog,
}

impl ActiveProject {
    fn history_command_type(op_kind: &crate::core::project::OpKind) -> &'static str {
        match op_kind {
            crate::core::project::OpKind::AssetImport => "ImportAsset",
            crate::core::project::OpKind::AssetRemove => "RemoveAsset",
            crate::core::project::OpKind::AssetUpdate => "UpdateAsset",
            crate::core::project::OpKind::ClipAdd => "InsertClip",
            crate::core::project::OpKind::ClipRemove => "RemoveClip",
            crate::core::project::OpKind::ClipMove => "MoveClip",
            crate::core::project::OpKind::ClipTrim => "TrimClip",
            crate::core::project::OpKind::ClipSplit => "SplitClip",
            crate::core::project::OpKind::ClipUpdate => "SetClipAudio",
            crate::core::project::OpKind::CompoundClipCreate => "CreateCompoundClip",
            crate::core::project::OpKind::CompoundClipUnnest => "UnnestCompoundClip",
            crate::core::project::OpKind::ClipGroup => "GroupClips",
            crate::core::project::OpKind::ClipUngroup => "UngroupClips",
            crate::core::project::OpKind::ClipLink => "LinkClips",
            crate::core::project::OpKind::ClipUnlink => "UnlinkClips",
            crate::core::project::OpKind::TrackAdd => "AddTrack",
            crate::core::project::OpKind::TrackRemove => "RemoveTrack",
            crate::core::project::OpKind::TrackReorder => "ReorderTracks",
            crate::core::project::OpKind::TrackUpdate => "RenameTrack",
            crate::core::project::OpKind::EffectAdd => "AddEffect",
            crate::core::project::OpKind::EffectRemove => "RemoveEffect",
            crate::core::project::OpKind::EffectUpdate => "UpdateEffect",
            crate::core::project::OpKind::MarkerAdd => "AddMarker",
            crate::core::project::OpKind::MarkerRemove => "RemoveMarker",
            crate::core::project::OpKind::CaptionAdd => "AddCaption",
            crate::core::project::OpKind::CaptionRemove => "RemoveCaption",
            crate::core::project::OpKind::CaptionUpdate => "UpdateCaption",
            crate::core::project::OpKind::TextClipAdd => "AddTextClip",
            crate::core::project::OpKind::TextClipUpdate => "UpdateTextClip",
            crate::core::project::OpKind::TextClipRemove => "RemoveTextClip",
            crate::core::project::OpKind::SequenceCreate => "CreateSequence",
            crate::core::project::OpKind::SequenceUpdate => "UpdateSequence",
            crate::core::project::OpKind::SequenceRemove => "RemoveSequence",
            crate::core::project::OpKind::ProjectCreate => "CreateProject",
            crate::core::project::OpKind::ProjectSettings => "UpdateProjectSettings",
            crate::core::project::OpKind::Batch => "Batch",
            crate::core::project::OpKind::FolderCreate => "CreateFolder",
            crate::core::project::OpKind::FileRename => "RenameFile",
            crate::core::project::OpKind::FileMove => "MoveFile",
            crate::core::project::OpKind::FileDelete => "DeleteFile",
            crate::core::project::OpKind::BinCreate => "CreateBin",
            crate::core::project::OpKind::BinRemove => "RemoveBin",
            crate::core::project::OpKind::BinRename => "RenameBin",
            crate::core::project::OpKind::BinMove => "MoveBin",
            crate::core::project::OpKind::BinUpdateColor => "SetBinColor",
            crate::core::project::OpKind::WorkspaceScan => "WorkspaceScan",
        }
    }

    fn default_state_dir(project_root: &Path) -> PathBuf {
        project_root.join(".openreelio").join("state")
    }

    fn state_ops_path(state_dir: &Path) -> PathBuf {
        state_dir.join("ops.jsonl")
    }

    fn state_meta_path(state_dir: &Path) -> PathBuf {
        state_dir.join("project.json")
    }

    fn state_snapshot_path(state_dir: &Path) -> PathBuf {
        state_dir.join("snapshot.json")
    }

    fn state_history_path(state_dir: &Path) -> PathBuf {
        state_dir.join("history.json")
    }

    fn legacy_ops_path(project_root: &Path) -> PathBuf {
        project_root.join("ops.jsonl")
    }

    fn legacy_meta_path(project_root: &Path) -> PathBuf {
        project_root.join("project.json")
    }

    fn legacy_snapshot_path(project_root: &Path) -> PathBuf {
        project_root.join("snapshot.json")
    }

    fn move_state_file_if_needed(src: &Path, dst: &Path) -> crate::core::CoreResult<()> {
        use std::cmp::Ordering;

        fn read_ops_line_count(path: &Path) -> Option<usize> {
            let file = std::fs::File::open(path).ok()?;
            let reader = std::io::BufReader::new(file);
            let count = std::io::BufRead::lines(reader)
                .map_while(Result::ok)
                .filter(|line| !line.trim().is_empty())
                .count();
            Some(count)
        }

        fn read_snapshot_op_count(path: &Path) -> Option<u64> {
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
            value
                .get("opCount")
                .or_else(|| value.get("op_count"))
                .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n.max(0) as u64)))
        }

        fn read_project_modified_unix_ms(path: &Path) -> Option<i64> {
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
            let modified = value
                .get("modifiedAt")
                .or_else(|| value.get("modified_at"))
                .or_else(|| value.get("createdAt"))
                .or_else(|| value.get("created_at"))?
                .as_str()?;
            let parsed = chrono::DateTime::parse_from_rfc3339(modified).ok()?;
            Some(parsed.timestamp_millis())
        }

        fn compare_state_freshness_by_content(src: &Path, dst: &Path) -> Option<Ordering> {
            let file_name = dst.file_name()?.to_string_lossy();
            match file_name.as_ref() {
                "ops.jsonl" => Some(read_ops_line_count(src)?.cmp(&read_ops_line_count(dst)?)),
                "snapshot.json" => {
                    Some(read_snapshot_op_count(src)?.cmp(&read_snapshot_op_count(dst)?))
                }
                "project.json" => Some(
                    read_project_modified_unix_ms(src)?.cmp(&read_project_modified_unix_ms(dst)?),
                ),
                _ => None,
            }
        }

        fn files_are_identical(left: &Path, right: &Path) -> bool {
            let left_meta = match std::fs::metadata(left) {
                Ok(meta) => meta,
                Err(_) => return false,
            };
            let right_meta = match std::fs::metadata(right) {
                Ok(meta) => meta,
                Err(_) => return false,
            };
            if left_meta.len() != right_meta.len() {
                return false;
            }

            let mut left_file = match std::fs::File::open(left) {
                Ok(file) => file,
                Err(_) => return false,
            };
            let mut right_file = match std::fs::File::open(right) {
                Ok(file) => file,
                Err(_) => return false,
            };

            let mut left_buf = [0u8; 8192];
            let mut right_buf = [0u8; 8192];

            loop {
                let left_read = match std::io::Read::read(&mut left_file, &mut left_buf) {
                    Ok(read) => read,
                    Err(_) => return false,
                };
                let right_read = match std::io::Read::read(&mut right_file, &mut right_buf) {
                    Ok(read) => read,
                    Err(_) => return false,
                };

                if left_read != right_read {
                    return false;
                }
                if left_read == 0 {
                    return true;
                }
                if left_buf[..left_read] != right_buf[..right_read] {
                    return false;
                }
            }
        }

        if !src.exists() {
            return Ok(());
        }

        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }

        if dst.exists() {
            enum ExistingTargetAction {
                PromoteSource,
                CleanupStaleSource,
                KeepBoth,
            }

            let source_modified = std::fs::metadata(src).and_then(|m| m.modified()).ok();
            let target_modified = std::fs::metadata(dst).and_then(|m| m.modified()).ok();
            let content_order = compare_state_freshness_by_content(src, dst);
            let action = match content_order {
                Some(Ordering::Greater) => ExistingTargetAction::PromoteSource,
                Some(Ordering::Less) => ExistingTargetAction::CleanupStaleSource,
                Some(Ordering::Equal) => {
                    if files_are_identical(src, dst) {
                        ExistingTargetAction::CleanupStaleSource
                    } else {
                        match (source_modified, target_modified) {
                            (Some(source), Some(target)) if source > target => {
                                ExistingTargetAction::PromoteSource
                            }
                            (Some(source), Some(target)) if source < target => {
                                ExistingTargetAction::CleanupStaleSource
                            }
                            _ => ExistingTargetAction::KeepBoth,
                        }
                    }
                }
                None => match (source_modified, target_modified) {
                    (Some(source), Some(target)) if source > target => {
                        ExistingTargetAction::PromoteSource
                    }
                    (Some(source), Some(target)) if source < target => {
                        ExistingTargetAction::CleanupStaleSource
                    }
                    (Some(_), Some(_)) => {
                        if files_are_identical(src, dst) {
                            ExistingTargetAction::CleanupStaleSource
                        } else {
                            ExistingTargetAction::KeepBoth
                        }
                    }
                    (Some(_), None) => ExistingTargetAction::PromoteSource,
                    _ => ExistingTargetAction::KeepBoth,
                },
            };

            match action {
                ExistingTargetAction::PromoteSource => {
                    std::fs::copy(src, dst).map_err(crate::core::CoreError::IoError)?;
                    tracing::info!(
                        from = %src.display(),
                        to = %dst.display(),
                        "Promoted newer legacy project state file"
                    );
                    if let Err(remove_err) = std::fs::remove_file(src) {
                        tracing::warn!(
                            from = %src.display(),
                            error = %remove_err,
                            "Failed to remove legacy project state file"
                        );
                    }
                }
                ExistingTargetAction::CleanupStaleSource => {
                    tracing::debug!(
                        from = %src.display(),
                        to = %dst.display(),
                        "Discarding stale legacy project state file"
                    );
                    if let Err(remove_err) = std::fs::remove_file(src) {
                        tracing::warn!(
                            from = %src.display(),
                            error = %remove_err,
                            "Failed to remove stale legacy project state file"
                        );
                    }
                }
                ExistingTargetAction::KeepBoth => {
                    tracing::warn!(
                        from = %src.display(),
                        to = %dst.display(),
                        "Unable to compare legacy and hidden state file timestamps; keeping both"
                    );
                }
            }

            return Ok(());
        }

        match std::fs::rename(src, dst) {
            Ok(()) => Ok(()),
            Err(rename_err) => {
                // Cross-volume or antivirus interference can make rename fail on Windows.
                // Fallback to copy + best-effort remove.
                std::fs::copy(src, dst).map_err(crate::core::CoreError::IoError)?;
                if let Err(remove_err) = std::fs::remove_file(src) {
                    tracing::warn!(
                        from = %src.display(),
                        to = %dst.display(),
                        error = %remove_err,
                        "Copied legacy project state file but failed to remove original"
                    );
                }
                tracing::debug!(
                    from = %src.display(),
                    to = %dst.display(),
                    error = %rename_err,
                    "Legacy project state migrated via copy fallback"
                );
                Ok(())
            }
        }
    }

    /// Creates a new project with default sequence and tracks
    ///
    /// The default sequence is created via Command to ensure proper ops log recording.
    /// This maintains Event Sourcing integrity - all state changes are recorded.
    pub fn create(name: &str, path: PathBuf) -> crate::core::CoreResult<Self> {
        use crate::core::commands::CreateSequenceCommand;

        // Create project directory if it doesn't exist
        std::fs::create_dir_all(&path)?;
        let state_dir = Self::default_state_dir(&path);
        std::fs::create_dir_all(&state_dir)?;

        let ops_path = Self::state_ops_path(&state_dir);
        let snapshot_path = Self::state_snapshot_path(&state_dir);
        let meta_path = Self::state_meta_path(&state_dir);
        let history_path = Self::state_history_path(&state_dir);

        // Start with empty state - default sequence will be added via Command
        let mut state = ProjectState::new_empty(name);

        // Create OpsLog instances - one for ActiveProject, one for executor.
        // Both point to the same file but operate independently; this is safe
        // because OpsLog performs atomic appends. The executor handle is derived
        // with `shared_handle` so appends made through it count towards the same
        // session-local append counter and share the external-change watermark.
        let mut ops_log = OpsLog::new(&ops_path);
        // Guard first, so even the bootstrap sequence command below writes
        // through the guarded path.
        ops_log.begin_guarded_session()?;
        let mut executor = CommandExecutor::with_ops_log(ops_log.shared_handle());

        // Create default sequence via Command to ensure ops log recording
        // This maintains Event Sourcing principle: all changes go through commands
        let default_sequence_cmd = CreateSequenceCommand::new("Sequence 1", "1080p");
        let default_sequence_result =
            executor.execute(Box::new(default_sequence_cmd), &mut state)?;

        // Clear undo history so users can't accidentally undo the initial setup
        // The operation is still recorded in ops.jsonl for recovery purposes
        executor.clear_history();

        // Save initial snapshot (includes the default sequence from command)
        Snapshot::save(&snapshot_path, &state, state.last_op_id.as_deref())?;

        // Save project metadata
        crate::core::fs::atomic_write_json_pretty(&meta_path, &state.meta)?;

        let history = ProjectHistory {
            version: "1.0.0".to_string(),
            base_meta: Some(state.meta.clone()),
            applied_op_ids: vec![default_sequence_result.op_id],
            redo_op_ids: Vec::new(),
            discarded_op_ids: Vec::new(),
            protected_prefix_len: 1,
        };
        // Through the guard, so the session's history baseline starts out
        // describing the manifest it just wrote.
        ops_log.write_history_manifest(&history_path, |path| history.save(path))?;

        Ok(Self {
            path,
            state_dir,
            meta_path,
            snapshot_path,
            history_path,
            state,
            executor,
            ops_log,
            history,
            // A project this session just created has no history but its own.
            adopted_op_ids: Vec::new(),
        })
    }

    /// Opens an existing project
    pub fn open(path: PathBuf) -> crate::core::CoreResult<Self> {
        let state_dir = Self::default_state_dir(&path);
        std::fs::create_dir_all(&state_dir)?;

        let mut ops_path = Self::state_ops_path(&state_dir);
        let mut snapshot_path = Self::state_snapshot_path(&state_dir);
        let mut meta_path = Self::state_meta_path(&state_dir);
        let history_path = Self::state_history_path(&state_dir);

        let legacy_ops_path = Self::legacy_ops_path(&path);
        let legacy_snapshot_path = Self::legacy_snapshot_path(&path);
        let legacy_meta_path = Self::legacy_meta_path(&path);

        // One-time migration from legacy root files to the hidden state directory.
        if let Err(e) = Self::move_state_file_if_needed(&legacy_ops_path, &ops_path) {
            tracing::warn!(
                error = %e,
                from = %legacy_ops_path.display(),
                to = %ops_path.display(),
                "Failed to migrate legacy ops log"
            );
            if !ops_path.exists() && legacy_ops_path.exists() {
                ops_path = legacy_ops_path;
            }
        }

        if let Err(e) = Self::move_state_file_if_needed(&legacy_snapshot_path, &snapshot_path) {
            tracing::warn!(
                error = %e,
                from = %legacy_snapshot_path.display(),
                to = %snapshot_path.display(),
                "Failed to migrate legacy snapshot"
            );
            if !snapshot_path.exists() && legacy_snapshot_path.exists() {
                snapshot_path = legacy_snapshot_path;
            }
        }

        if let Err(e) = Self::move_state_file_if_needed(&legacy_meta_path, &meta_path) {
            tracing::warn!(
                error = %e,
                from = %legacy_meta_path.display(),
                to = %meta_path.display(),
                "Failed to migrate legacy project metadata"
            );
            if !meta_path.exists() && legacy_meta_path.exists() {
                meta_path = legacy_meta_path;
            }
        }

        // Load project metadata (used as fallback if no snapshot exists)
        let meta: ProjectMeta = if meta_path.exists() {
            let file = std::fs::File::open(&meta_path)?;
            serde_json::from_reader(file)?
        } else {
            ProjectMeta::new("Untitled")
        };

        let mut ops_log = OpsLog::new(&ops_path);
        // Replay the log, read the history manifest and take the external-change
        // baseline in one critical section. Sampling the baseline separately
        // would leave a window in which another process writes, so the session
        // would start life already disagreeing with the files it had just
        // replayed.
        let opened = ops_log.begin_guarded_session_reading_all(&history_path)?;
        let read_result = opened.operations;
        let has_history_manifest = opened.history_manifest.is_some();
        let mut history = match opened.history_manifest.as_deref() {
            Some(bytes) => match ProjectHistory::from_json_slice(bytes) {
                Ok(history) => history,
                Err(error) => {
                    tracing::warn!(
                        error = %error,
                        path = %history_path.display(),
                        "Failed to load history manifest. Rebuilding history from ops log."
                    );
                    ProjectHistory::from_operations(&read_result.operations, meta.clone())
                }
            },
            None => ProjectHistory::from_operations(&read_result.operations, meta.clone()),
        };
        if history.base_meta.is_none() {
            history.base_meta = Some(meta.clone());
        }
        let adopted_op_ids =
            Self::sync_history_with_operations(&mut history, &read_result.operations);
        let history_meta = history.base_meta.clone().unwrap_or_else(|| meta.clone());

        // Load state from history when available. Fall back to snapshot + replay or full ops replay.
        let mut state = if !history.applied_op_ids.is_empty() || has_history_manifest {
            let by_id: std::collections::HashMap<&str, crate::core::project::Operation> =
                read_result
                    .operations
                    .iter()
                    .map(|op| (op.id.as_str(), op.clone()))
                    .collect();
            let active_ops = history
                .applied_op_ids
                .iter()
                .filter_map(|op_id| by_id.get(op_id.as_str()).cloned())
                .collect::<Vec<_>>();
            ProjectState::from_operations(active_ops, history_meta.clone())?
        } else if Snapshot::exists(&snapshot_path) {
            match Snapshot::load_with_replay(&snapshot_path, &ops_log) {
                Ok(state) => state,
                Err(e) => {
                    tracing::warn!(
                        "Failed to load snapshot ({}). Rebuilding state from ops log.",
                        e
                    );
                    ProjectState::from_ops_log(&ops_log, meta.clone())?
                }
            }
        } else {
            ProjectState::from_ops_log(&ops_log, meta)?
        };
        Self::scope_loaded_assets(&mut state, &path, "opening the project");

        // Create executor with its own OpsLog handle (both point to same file and
        // share the session-local append counter).
        let executor = CommandExecutor::with_ops_log(ops_log.shared_handle());

        Ok(Self {
            path,
            state_dir,
            meta_path,
            snapshot_path,
            history_path,
            state,
            executor,
            ops_log,
            history,
            adopted_op_ids,
        })
    }

    /// Applies the load-time asset scoping pass and logs what it quarantined.
    ///
    /// Every path that produces a [`ProjectState`] from files on disk routes
    /// through here, so a hostile `uri` is cleared once, centrally, before the
    /// state is handed to anything that renders, analyses or probes it.
    fn scope_loaded_assets(state: &mut ProjectState, project_root: &Path, during: &str) {
        let report = state.scope_assets_to_project(project_root);
        if report.is_empty() {
            return;
        }

        tracing::warn!(
            quarantined_assets = report.len(),
            project = %project_root.display(),
            during = during,
            "Quarantined assets whose stored paths were rejected as unsafe; \
             they are marked missing and must be relinked"
        );
    }

    /// Reads a project's state without opening an editing session.
    ///
    /// [`Self::open`] is a *session* open, and a session is a thing you have to
    /// build: it creates the hidden state directory, migrates legacy state files
    /// into it — renaming, copying and deleting — and takes the ops-log lock so
    /// the external-change guard has a baseline to compare against. Every one of
    /// those writes to disk. That is right for a command that is about to edit,
    /// and wrong for one that promised not to touch anything, which is why
    /// `otio import --dry-run` needs this: it has to read the project's assets
    /// and sequences to build the plan it prints, and printing a plan is not a
    /// reason to migrate somebody's files.
    ///
    /// So this creates nothing, moves nothing and locks nothing. It reads the
    /// state files where they already are — hidden directory first, legacy root
    /// second — and replays them.
    ///
    /// The cost of skipping the lock is that a line another process is midway
    /// through appending can be read as corrupt and skipped, so the state may be
    /// one operation behind a concurrent writer. That is acceptable for a
    /// preview and unacceptable for anything that writes, which is why this
    /// returns a bare [`ProjectState`]: there is no session to save through.
    pub fn read_state_without_session(path: &Path) -> crate::core::CoreResult<ProjectState> {
        // The read itself has three exits — history replay, snapshot-only
        // recovery, and plain replay — and the snapshot-only one never goes
        // through `from_operations`. Wrapping is what guarantees the scoping pass
        // cannot be missed by whichever exit a given project happens to take.
        let mut state = Self::read_state_without_session_unscoped(path)?;
        Self::scope_loaded_assets(&mut state, path, "reading the project without a session");
        Ok(state)
    }

    fn read_state_without_session_unscoped(path: &Path) -> crate::core::CoreResult<ProjectState> {
        let state_dir = Self::default_state_dir(path);

        // No migration: whichever copy exists is read where it lies.
        let pick = |current: PathBuf, legacy: PathBuf| {
            if current.exists() || !legacy.exists() {
                current
            } else {
                legacy
            }
        };
        let ops_path = pick(
            Self::state_ops_path(&state_dir),
            Self::legacy_ops_path(path),
        );
        let snapshot_path = pick(
            Self::state_snapshot_path(&state_dir),
            Self::legacy_snapshot_path(path),
        );
        let meta_path = pick(
            Self::state_meta_path(&state_dir),
            Self::legacy_meta_path(path),
        );
        let history_path = Self::state_history_path(&state_dir);

        let meta: ProjectMeta = if meta_path.exists() {
            let file = std::fs::File::open(&meta_path)?;
            serde_json::from_reader(file)?
        } else {
            ProjectMeta::new("Untitled")
        };

        let ops_log = OpsLog::new(&ops_path);
        let read_result = ops_log.read_all_with_archive_unlocked()?;
        let history_manifest = match std::fs::read(&history_path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };

        let mut history = match history_manifest.as_deref() {
            Some(bytes) => ProjectHistory::from_json_slice(bytes).unwrap_or_else(|_| {
                ProjectHistory::from_operations(&read_result.operations, meta.clone())
            }),
            None => ProjectHistory::from_operations(&read_result.operations, meta.clone()),
        };
        if history.base_meta.is_none() {
            history.base_meta = Some(meta.clone());
        }
        Self::sync_history_with_operations(&mut history, &read_result.operations);
        let history_meta = history.base_meta.clone().unwrap_or_else(|| meta.clone());

        if !history.applied_op_ids.is_empty() || history_manifest.is_some() {
            let by_id: std::collections::HashMap<&str, &crate::core::project::Operation> =
                read_result
                    .operations
                    .iter()
                    .map(|op| (op.id.as_str(), op))
                    .collect();
            let active_ops = history
                .applied_op_ids
                .iter()
                .filter_map(|op_id| by_id.get(op_id.as_str()).map(|op| (*op).clone()))
                .collect::<Vec<_>>();
            return ProjectState::from_operations(active_ops, history_meta);
        }

        if read_result.operations.is_empty() && Snapshot::exists(&snapshot_path) {
            // Only when there is nothing to replay: with operations in hand the
            // replay is authoritative, and reading the snapshot as well would
            // need the log's revision, which is exactly what the lock protects.
            let (state, _) = Snapshot::load(&snapshot_path)?;
            return Ok(state);
        }

        ProjectState::from_operations(read_result.operations, meta)
    }

    /// Number of operations this session expects the on-disk ops log to contain.
    ///
    /// This is the count observed when the session was opened plus every append
    /// it has performed since. Used by the workspace watcher to tell the app's
    /// own writes apart from foreign ones.
    pub fn expected_op_count(&self) -> u64 {
        self.ops_log.expected_op_count().unwrap_or_default()
    }

    /// Reads the number of operations currently present in the on-disk ops log.
    pub fn on_disk_op_count(&self) -> crate::core::CoreResult<u64> {
        Ok(self.ops_log.count()? as u64)
    }

    /// Fails when the on-disk operation log or history manifest no longer
    /// matches what this session wrote.
    ///
    /// A mismatch means another process (`openreelio-cli`, a second app window,
    /// an agent) appended to `ops.jsonl`
    /// ([`crate::core::CoreError::ExternalChangeDetected`]) or undid, redid or
    /// jumped through history, rewriting `history.json` without appending
    /// anything ([`crate::core::CoreError::ExternalHistoryChangeDetected`]).
    /// Continuing would interleave this session's stale state with the external
    /// edits — or silently revert them — so callers must surface the error and
    /// let the user reload instead of merging.
    ///
    /// This is a pre-flight convenience for callers that do bookkeeping before
    /// writing; enforcement itself lives in [`OpsLog::append`], so paths that
    /// forget to call this are still refused at the append.
    pub fn ensure_no_external_changes(&self) -> crate::core::CoreResult<()> {
        self.ops_log.ensure_no_external_changes()
    }

    /// Saves the project state
    ///
    /// After a successful save, the `is_dirty` flag is reset to `false`.
    /// This ensures the project can be closed or replaced without warnings.
    pub fn save(&mut self) -> crate::core::CoreResult<()> {
        let prepared = self.prepare_save()?;
        Self::write_prepared_save(&prepared)?;

        // Reset dirty flag after successful save
        self.state.is_dirty = false;
        tracing::debug!("Project saved successfully, is_dirty reset to false");

        Ok(())
    }

    pub fn prepare_save(&mut self) -> crate::core::CoreResult<PreparedProjectSave> {
        // Saving on top of external edits would snapshot this session's stale
        // state under the external head op id, silently discarding them.
        self.ensure_no_external_changes()?;
        self.sync_history_with_ops_log()?;
        self.state.last_op_id = self.history.current_head().map(str::to_string);
        self.state.op_count = self.history.applied_op_ids.len();
        let mut state_snapshot = self.state.clone();
        state_snapshot.is_dirty = false;

        Ok(PreparedProjectSave {
            snapshot_path: self.snapshot_path.clone(),
            meta_path: self.meta_path.clone(),
            history_path: self.history_path.clone(),
            state_snapshot,
            history_snapshot: self.history.clone(),
            saved_last_op_id: self.state.last_op_id.clone(),
            session_log: self.ops_log.shared_handle(),
        })
    }

    pub(crate) fn write_prepared_save(
        prepared: &PreparedProjectSave,
    ) -> crate::core::CoreResult<()> {
        Snapshot::save(
            &prepared.snapshot_path,
            &prepared.state_snapshot,
            prepared.state_snapshot.last_op_id.as_deref(),
        )?;

        crate::core::fs::atomic_write_json_pretty(
            &prepared.meta_path,
            &prepared.state_snapshot.meta,
        )?;
        // The manifest is guarded state, unlike the snapshot and metadata which
        // are regenerable caches: write it through the session's guard so a
        // concurrent process's undo cannot be overwritten, and so this session's
        // own write re-baselines it.
        prepared
            .session_log
            .write_history_manifest(&prepared.history_path, |path| {
                prepared.history_snapshot.save(path)
            })?;
        Ok(())
    }

    fn sync_history_with_ops_log(&mut self) -> crate::core::CoreResult<()> {
        let read_result = self.ops_log.read_all_with_archive()?;
        let _ = Self::sync_history_with_operations(&mut self.history, &read_result.operations);
        Ok(())
    }

    /// Folds operations the history manifest does not know about into it, and
    /// reports which ones were adopted.
    ///
    /// A CLI invocation opens, edits and exits, so operations appended by an
    /// earlier writer are history to build on rather than a conflict. The
    /// adopted ids are returned because "history I did not write" is exactly
    /// what a caller repositioning history has to be able to see.
    fn sync_history_with_operations(
        history: &mut ProjectHistory,
        operations: &[crate::core::project::Operation],
    ) -> Vec<String> {
        history.sanitize(operations);

        let known_ids: std::collections::HashSet<&str> = history
            .applied_op_ids
            .iter()
            .chain(history.redo_op_ids.iter())
            .chain(history.discarded_op_ids.iter())
            .map(String::as_str)
            .collect();
        let new_ids = if let Some(last_known_index) = operations
            .iter()
            .rposition(|op| known_ids.contains(op.id.as_str()))
        {
            operations
                .iter()
                .skip(last_known_index + 1)
                .map(|op| op.id.clone())
                .collect::<Vec<_>>()
        } else {
            operations
                .iter()
                .map(|op| op.id.clone())
                .collect::<Vec<_>>()
        };

        history.append_new_operations(new_ids.clone());
        history.sanitize(operations);

        new_ids
    }

    fn build_state_from_operations(
        &self,
        history: &mut ProjectHistory,
        operations: &[crate::core::project::Operation],
    ) -> crate::core::CoreResult<ProjectState> {
        history.sanitize(operations);

        let by_id: std::collections::HashMap<&str, crate::core::project::Operation> = operations
            .iter()
            .map(|op| (op.id.as_str(), op.clone()))
            .collect();
        let active_ops = history
            .applied_op_ids
            .iter()
            .filter_map(|op_id| by_id.get(op_id.as_str()).cloned())
            .collect::<Vec<_>>();

        let meta = history
            .base_meta
            .clone()
            .unwrap_or_else(|| self.state.meta.clone());
        let mut state = ProjectState::from_operations(active_ops, meta)?;
        // Undo, redo and history jumps rebuild the state from the same on-disk
        // operations, so a quarantined path is re-materialised every time unless
        // the pass runs again — the quarantine lives in the state, not the log.
        Self::scope_loaded_assets(&mut state, &self.path, "rebuilding project history");
        state.last_op_id = history.current_head().map(str::to_string);
        state.op_count = history.applied_op_ids.len();
        state.is_dirty = true;

        Ok(state)
    }

    fn apply_history_candidate(
        &mut self,
        mut candidate_history: ProjectHistory,
    ) -> crate::core::CoreResult<()> {
        let read_result = self.ops_log.read_all_with_archive()?;
        let _ = Self::sync_history_with_operations(&mut candidate_history, &read_result.operations);
        let candidate_state =
            self.build_state_from_operations(&mut candidate_history, &read_result.operations)?;
        // Undo/redo/jump rewrite the manifest without appending, so the guarded
        // write is the only thing standing between two processes' histories.
        self.ops_log
            .write_history_manifest(&self.history_path, |path| candidate_history.save(path))?;

        self.history = candidate_history;
        self.state = candidate_state;
        self.executor.clear_history();

        Ok(())
    }

    /// Excludes already-persisted operations from history replay.
    ///
    /// The ops log is append-only, so work that has to be rolled back cannot be
    /// deleted from disk: `CommandExecutor::execute` fsyncs each op before it
    /// returns, and `CommandExecutor::undo` only unwinds memory. Recording the
    /// ids as discarded is what stops the next `sync_history_with_ops_log` from
    /// mistaking those durable entries for new user edits and replaying them.
    ///
    /// Every transactional caller that rolls back — the agent plan executor and
    /// the CLI/MCP plan path — must call this, or the rollback silently reverts
    /// itself on the next open.
    ///
    /// Returns the requested ids that stay applied because they sit inside the
    /// history's protected prefix (the project's first `SequenceCreate` is
    /// never discardable). A non-empty result is a rollback shortfall, not a
    /// detail: those operations survive the next open, so the caller must not
    /// report a clean rollback.
    #[must_use = "a non-empty result means part of the rollback did not stick"]
    pub fn discard_persisted_operations(
        &mut self,
        op_ids: &[OpId],
    ) -> crate::core::CoreResult<Vec<OpId>> {
        if op_ids.is_empty() {
            return Ok(Vec::new());
        }

        let read_result = self.ops_log.read_all_with_archive()?;
        let _ = Self::sync_history_with_operations(&mut self.history, &read_result.operations);

        let mut candidate_history = self.history.clone();
        let skipped_protected = candidate_history.discard_operations(op_ids.iter().cloned());
        candidate_history.sanitize(&read_result.operations);

        let candidate_state =
            self.build_state_from_operations(&mut candidate_history, &read_result.operations)?;
        self.ops_log
            .write_history_manifest(&self.history_path, |path| candidate_history.save(path))?;

        self.history = candidate_history;
        self.state = candidate_state;
        self.executor.clear_history();

        Ok(skipped_protected)
    }

    fn visible_history_current_index_for(history: &ProjectHistory) -> i32 {
        (history
            .applied_op_ids
            .len()
            .saturating_sub(history.protected_prefix_len) as i32)
            - 1
    }

    fn visible_history_current_index(&self) -> i32 {
        Self::visible_history_current_index_for(&self.history)
    }

    pub fn can_undo_persisted(&mut self) -> crate::core::CoreResult<bool> {
        self.sync_history_with_ops_log()?;
        Ok(self.history.can_undo())
    }

    pub fn can_redo_persisted(&mut self) -> crate::core::CoreResult<bool> {
        self.sync_history_with_ops_log()?;
        Ok(self.history.can_redo())
    }

    pub fn persisted_history_entries(
        &mut self,
    ) -> crate::core::CoreResult<(
        Vec<crate::core::commands::HistoryEntryInfo>,
        Vec<crate::core::commands::HistoryEntryInfo>,
        i32,
    )> {
        self.sync_history_with_ops_log()?;

        let read_result = self.ops_log.read_all_with_archive()?;
        let op_by_id: std::collections::HashMap<&str, &crate::core::project::Operation> =
            read_result
                .operations
                .iter()
                .map(|op| (op.id.as_str(), op))
                .collect();

        let undo_entries = self
            .history
            .applied_op_ids
            .iter()
            .skip(self.history.protected_prefix_len)
            .enumerate()
            .filter_map(|(index, op_id)| {
                op_by_id
                    .get(op_id.as_str())
                    .map(|op| crate::core::commands::HistoryEntryInfo {
                        op_id: op.id.clone(),
                        command_type: Self::history_command_type(&op.kind).to_string(),
                        timestamp: op.timestamp.clone(),
                        index,
                    })
            })
            .collect::<Vec<_>>();

        let redo_base_index = undo_entries.len();
        let redo_entries = self
            .history
            .redo_op_ids
            .iter()
            .rev()
            .enumerate()
            .filter_map(|(offset, op_id)| {
                op_by_id
                    .get(op_id.as_str())
                    .map(|op| crate::core::commands::HistoryEntryInfo {
                        op_id: op.id.clone(),
                        command_type: Self::history_command_type(&op.kind).to_string(),
                        timestamp: op.timestamp.clone(),
                        index: redo_base_index + offset,
                    })
            })
            .collect::<Vec<_>>();

        Ok((
            undo_entries,
            redo_entries,
            self.visible_history_current_index(),
        ))
    }

    pub fn jump_to_history_index_persisted(
        &mut self,
        target_index: i32,
    ) -> crate::core::CoreResult<i32> {
        // Same hazard as undo/redo: history indices computed here would address
        // operations written by another process, or a history position another
        // process has already moved away from.
        self.ensure_no_external_changes()?;
        self.sync_history_with_ops_log()?;

        let visible_undo_len = self
            .history
            .applied_op_ids
            .len()
            .saturating_sub(self.history.protected_prefix_len);
        let total = (visible_undo_len + self.history.redo_op_ids.len()) as i32;
        if target_index < -1 || target_index >= total {
            return Err(crate::core::CoreError::Internal(format!(
                "History index {} out of range [-1, {})",
                target_index, total
            )));
        }

        let mut candidate_history = self.history.clone();
        let mut current_index = Self::visible_history_current_index_for(&candidate_history);
        while current_index > target_index {
            candidate_history.undo()?;
            current_index -= 1;
        }

        while current_index < target_index {
            candidate_history.redo()?;
            current_index += 1;
        }

        self.apply_history_candidate(candidate_history)?;

        Ok(self.visible_history_current_index())
    }

    /// Performs a persisted undo that survives process restarts.
    ///
    /// Fails with [`crate::core::CoreError::ExternalChangeDetected`] when another
    /// process appended operations, because the newest applied operation would
    /// then belong to that process rather than to this session, and with
    /// [`crate::core::CoreError::ExternalHistoryChangeDetected`] when another
    /// process moved through history itself, because undoing from this session's
    /// stale position would silently revert that move.
    pub fn undo_persisted(&mut self) -> crate::core::CoreResult<OpId> {
        self.ensure_no_external_changes()?;
        self.sync_history_with_ops_log()?;
        let mut candidate_history = self.history.clone();
        let op_id = candidate_history.undo()?;
        self.apply_history_candidate(candidate_history)?;
        Ok(op_id)
    }

    /// Performs a persisted redo that survives process restarts.
    ///
    /// Rejects external appends and external history moves exactly as
    /// [`ActiveProject::undo_persisted`] does.
    pub fn redo_persisted(&mut self) -> crate::core::CoreResult<OpId> {
        self.ensure_no_external_changes()?;
        self.sync_history_with_ops_log()?;
        let mut candidate_history = self.history.clone();
        let op_id = candidate_history.redo()?;
        self.apply_history_candidate(candidate_history)?;
        Ok(op_id)
    }
}

/// Application state shared across all commands
#[cfg(all(not(test), feature = "gui"))]
pub struct AppState {
    /// Currently active project (if any)
    pub project: Mutex<Option<ActiveProject>>,
    /// Background job worker pool
    pub job_pool: Mutex<WorkerPool>,
    /// Shutdown signal for background job workers.
    pub worker_shutdown: OnceLock<Arc<tokio::sync::Notify>>,
    /// Join handles for background job worker tasks.
    pub worker_handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Memory pool for efficient allocation
    pub memory_pool: Mutex<MemoryPool>,
    /// Cache manager for asset and render caching
    pub cache_manager: Mutex<CacheManager>,
    /// AI Gateway for LLM integration
    pub ai_gateway: Mutex<AIGateway>,
    /// Meilisearch service (sidecar + indexer), when enabled
    pub search_service: Mutex<Option<std::sync::Arc<SearchService>>>,
    /// AppHandle captured at startup for scope configuration helpers.
    pub app_handle: OnceLock<tauri::AppHandle>,

    /// Encrypted credential vault (lazy initialized).
    ///
    /// This is intentionally kept behind a process-wide mutex:
    /// - prevents concurrent reads/writes from racing on the vault file
    /// - avoids re-deriving keys and re-reading the vault on every IPC call
    pub credential_vault: Mutex<Option<crate::core::credentials::CredentialVault>>,

    /// Runtime playback sync state shared with the frontend.
    ///
    /// This is intentionally runtime-only (not persisted in project state).
    /// It provides a stable backend anchor for playhead/time synchronization,
    /// diagnostics, and cross-service coordination.
    pub playback_sync: Mutex<PlaybackSyncState>,

    /// Runtime source monitor state for dual-viewer 3-point editing workflow.
    ///
    /// This is runtime-only UI state (not persisted in project files).
    /// Tracks which asset is loaded, In/Out points, and source playhead position.
    pub source_monitor: Mutex<SourceMonitorState>,

    /// Active workspace file watcher (monitors the project directory for changes).
    ///
    /// Dropping the inner `WorkspaceWatcher` signals its background thread to stop.
    /// Replaced whenever a new project is scanned.
    pub workspace_watcher: Mutex<Option<WorkspaceWatcher>>,

    /// Serializes watcher lifecycle swaps so concurrent scans cannot interleave
    /// watcher replacement and leak background resources.
    pub workspace_watcher_lifecycle: Mutex<()>,

    /// Background task handle for the workspace watcher event-processing loop.
    ///
    /// The loop reads `WorkspaceEvent`s from the watcher channel, updates the
    /// asset index and project state, then emits Tauri events to the frontend.
    pub workspace_event_loop: Mutex<Option<tokio::task::JoinHandle<()>>>,

    /// Active integrated terminal sessions keyed by session ID.
    pub terminal_sessions: Mutex<HashMap<String, Arc<crate::ipc::terminal::TerminalSessionHandle>>>,

    /// Active Codex app-server process transports keyed by server ID.
    pub codex_app_server_sessions:
        Mutex<HashMap<String, Arc<crate::ipc::codex_app_server::CodexAppServerProcessHandle>>>,

    /// Active Claude Code headless process transports keyed by server ID.
    pub claude_headless_sessions:
        Mutex<HashMap<String, Arc<crate::ipc::claude_headless::ClaudeHeadlessProcessHandle>>>,

    /// Active in-app Claude login (`setup-token`) PTY sessions keyed by session ID.
    pub claude_login_sessions:
        Mutex<HashMap<String, Arc<crate::core::claude_login_pty::ClaudeLoginSessionHandle>>>,

    /// Active streamed Codex login (`codex login`) sessions keyed by session ID.
    pub codex_login_sessions:
        Mutex<HashMap<String, Arc<crate::core::codex_login::CodexLoginSessionHandle>>>,

    /// Lazily-started loopback MCP server that fronts OpenReelio tools for the
    /// Claude Code headless runtime. Started on first `start_claude_headless`.
    pub openreelio_mcp: Mutex<Option<Arc<crate::ipc::openreelio_mcp::OpenReelioMcpServer>>>,

    /// Managed-runtime ids (`"codex"` / `"claude"`) with an install/update in
    /// flight. Guards against concurrent install/update of the same runtime,
    /// which would race the binary/pointer swap. A plain `std::sync::Mutex` (not
    /// tokio) so the RAII release can run in `Drop` without awaiting.
    pub runtime_install_locks: std::sync::Mutex<std::collections::HashSet<&'static str>>,

    /// Runtime-only approval tokens issued for external agent mutation windows.
    pub external_agent_approval_tokens:
        Mutex<crate::core::external_agent::ExternalAgentApprovalTokenStore>,

    /// Session-scoped allow-list of directories the user confirmed via the native
    /// save dialog (`pick_export_destination`).
    ///
    /// Security model:
    /// - IPC is a trust boundary; the renderer (webview) could be compromised.
    /// - Export commands restrict writes to `default_export_allowed_roots` plus this set.
    /// - This set is populated ONLY from the parent directory of a path the user picked
    ///   in the native dialog, never from a path argument supplied by the renderer.
    /// - It is intentionally runtime-only (never persisted to disk) and reset per session.
    pub approved_export_dirs: Mutex<std::collections::HashSet<PathBuf>>,
}

/// Runtime source monitor state for dual-viewer workflow.
///
/// This is runtime-only UI state (not persisted in project files).
/// Tracks which asset is loaded in the source monitor and any In/Out points
/// set by the user for 3-point editing.
///
/// Note: This struct is unconditionally compiled (no feature gate) because it
/// is a pure data type with no Tauri dependencies, used in both GUI and tests.
#[derive(Clone, Debug)]
pub struct SourceMonitorState {
    /// Asset currently loaded in the source monitor.
    pub asset_id: Option<String>,
    /// In point for source clip (seconds). None means "start of asset".
    pub in_point: Option<f64>,
    /// Out point for source clip (seconds). None means "end of asset".
    pub out_point: Option<f64>,
    /// Current playhead position within the source asset (seconds).
    pub playhead_sec: f64,
}

impl Default for SourceMonitorState {
    fn default() -> Self {
        Self {
            asset_id: None,
            in_point: None,
            out_point: None,
            playhead_sec: 0.0,
        }
    }
}

impl SourceMonitorState {
    /// Loads an asset into the source monitor and resets transient marks/playhead.
    pub fn set_asset(&mut self, asset_id: Option<String>) {
        self.asset_id = asset_id;
        self.in_point = None;
        self.out_point = None;
        self.playhead_sec = 0.0;
    }

    /// Clears the source monitor runtime state.
    pub fn clear(&mut self) {
        self.set_asset(None);
    }

    /// Updates the source monitor In point and keeps the playhead aligned.
    pub fn set_in_point(&mut self, time_sec: f64) {
        self.in_point = Some(time_sec);
        self.playhead_sec = time_sec;
    }

    /// Updates the source monitor Out point and keeps the playhead aligned.
    pub fn set_out_point(&mut self, time_sec: f64) {
        self.out_point = Some(time_sec);
        self.playhead_sec = time_sec;
    }

    /// Updates the source monitor playhead without mutating In/Out points.
    pub fn set_playhead(&mut self, time_sec: f64) {
        self.playhead_sec = time_sec;
    }

    /// Clears source monitor In/Out points while preserving the current playhead.
    pub fn clear_in_out(&mut self) {
        self.in_point = None;
        self.out_point = None;
    }

    /// Returns the marked duration (out - in), or None if either point is unset.
    pub fn marked_duration(&self) -> Option<f64> {
        match (self.in_point, self.out_point) {
            (Some(i), Some(o)) => Some(o - i),
            _ => None,
        }
    }
}

#[cfg(all(not(test), feature = "gui"))]
#[derive(Clone, Debug)]
pub struct PlaybackSyncState {
    /// Current playhead position in seconds.
    pub position_sec: f64,
    /// Active sequence ID associated with the current position.
    pub sequence_id: Option<String>,
    /// Whether playback is active.
    pub is_playing: bool,
    /// Timeline duration in seconds, when known.
    pub duration_sec: Option<f64>,
    /// Last update source label (frontend/system).
    pub last_source: Option<String>,
    /// RFC3339 timestamp of last update.
    pub updated_at: String,
}

#[cfg(all(not(test), feature = "gui"))]
impl Default for PlaybackSyncState {
    fn default() -> Self {
        Self {
            position_sec: 0.0,
            sequence_id: None,
            is_playing: false,
            duration_sec: None,
            last_source: None,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[cfg(all(not(test), feature = "gui"))]
impl AppState {
    /// Creates a new empty app state
    pub fn new() -> Self {
        Self {
            project: Mutex::new(None),
            job_pool: Mutex::new(WorkerPool::with_defaults()),
            worker_shutdown: OnceLock::new(),
            worker_handles: Mutex::new(Vec::new()),
            memory_pool: Mutex::new(MemoryPool::new()),
            cache_manager: Mutex::new(CacheManager::new()),
            ai_gateway: Mutex::new(AIGateway::with_defaults()),
            search_service: Mutex::new(None),
            app_handle: OnceLock::new(),
            credential_vault: Mutex::new(None),
            playback_sync: Mutex::new(PlaybackSyncState::default()),
            source_monitor: Mutex::new(SourceMonitorState::default()),
            workspace_watcher: Mutex::new(None),
            workspace_watcher_lifecycle: Mutex::new(()),
            workspace_event_loop: Mutex::new(None),
            terminal_sessions: Mutex::new(HashMap::new()),
            codex_app_server_sessions: Mutex::new(HashMap::new()),
            claude_headless_sessions: Mutex::new(HashMap::new()),
            claude_login_sessions: Mutex::new(HashMap::new()),
            codex_login_sessions: Mutex::new(HashMap::new()),
            openreelio_mcp: Mutex::new(None),
            runtime_install_locks: std::sync::Mutex::new(std::collections::HashSet::new()),
            external_agent_approval_tokens: Mutex::new(
                crate::core::external_agent::ExternalAgentApprovalTokenStore::default(),
            ),
            approved_export_dirs: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Stores the app handle for later use (best-effort, idempotent).
    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        let _ = self.app_handle.set(handle);
    }

    /// Returns a snapshot of the session-scoped, user-approved export directories.
    ///
    /// Call sites combine this with `default_export_allowed_roots` to build the
    /// allowed roots passed to `validate_scoped_output_path`. Returning a clone keeps
    /// the lock scope short and avoids holding the mutex across path validation I/O.
    pub async fn approved_export_dirs_snapshot(&self) -> std::collections::HashSet<PathBuf> {
        self.approved_export_dirs.lock().await.clone()
    }

    /// Records the parent directory of a user-confirmed export path as approved.
    ///
    /// This is the ONLY way the approved set grows. The input must originate from the
    /// native save dialog (`pick_export_destination`), never from a renderer-supplied
    /// argument, so a compromised webview cannot widen the export allow-list.
    pub async fn approve_export_dir(&self, dir: PathBuf) {
        self.approved_export_dirs.lock().await.insert(dir);
    }

    /// Allowlist a directory for the asset protocol (best-effort).
    pub fn allow_asset_protocol_directory(&self, path: &std::path::Path, recursive: bool) {
        let Some(handle) = self.app_handle.get() else {
            return;
        };

        if let Err(e) = handle
            .asset_protocol_scope()
            .allow_directory(path, recursive)
        {
            tracing::warn!(
                "Failed to allow asset protocol directory {}: {}",
                path.display(),
                e
            );
        }
    }

    /// Allowlist a file for the asset protocol (best-effort).
    pub fn allow_asset_protocol_file(&self, path: &std::path::Path) {
        let Some(handle) = self.app_handle.get() else {
            return;
        };

        if let Err(e) = handle.asset_protocol_scope().allow_file(path) {
            tracing::warn!(
                "Failed to allow asset protocol file {}: {}",
                path.display(),
                e
            );
        }
    }

    /// Forbid a file for the asset protocol (best-effort).
    pub fn forbid_asset_protocol_file(&self, path: &std::path::Path) {
        let Some(handle) = self.app_handle.get() else {
            return;
        };

        if let Err(e) = handle.asset_protocol_scope().forbid_file(path) {
            tracing::warn!(
                "Failed to forbid asset protocol file {}: {}",
                path.display(),
                e
            );
        }
    }

    /// Forbid a directory for the asset protocol (best-effort).
    pub fn forbid_asset_protocol_directory(&self, path: &std::path::Path, recursive: bool) {
        let Some(handle) = self.app_handle.get() else {
            return;
        };

        if let Err(e) = handle
            .asset_protocol_scope()
            .forbid_directory(path, recursive)
        {
            tracing::warn!(
                "Failed to forbid asset protocol directory {}: {}",
                path.display(),
                e
            );
        }
    }

    /// Checks if a project is currently open
    pub async fn has_project(&self) -> bool {
        self.project.lock().await.is_some()
    }

    /// Requests background job workers to stop and aborts any that do not exit promptly.
    pub async fn shutdown_worker_pool(&self) -> bool {
        if let Some(shutdown) = self.worker_shutdown.get() {
            shutdown.notify_waiters();
        }

        let handles: Vec<tokio::task::JoinHandle<()>> =
            self.worker_handles.lock().await.drain(..).collect();
        if handles.is_empty() {
            return true;
        }

        let mut clean = true;
        for mut handle in handles {
            tokio::select! {
                result = &mut handle => match result {
                    Ok(()) => {}
                    Err(error) => {
                        tracing::warn!("Background worker task ended with error: {error}");
                        clean = false;
                    }
                },
                _ = tokio::time::sleep(tokio::time::Duration::from_secs(2)) => {
                    handle.abort();
                    let _ = handle.await;
                    tracing::warn!("Background worker did not stop within timeout");
                    clean = false;
                }
            }
        }

        clean
    }
}

#[cfg(all(not(test), feature = "gui"))]
impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Tauri Application Entry Point
// =============================================================================
#[cfg(all(not(test), feature = "gui"))]
mod tauri_app {
    use super::*;
    use crate::core::ffmpeg::create_ffmpeg_state;
    use std::sync::Arc;
    use tauri::Manager;
    use tokio::sync::Notify;

    static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

    fn init_logging(app: &tauri::AppHandle) {
        // Configure a log file in the platform app log dir (best effort).
        // Log to file for production debugging; stdout remains available in dev.
        let log_dir = app
            .path()
            .app_log_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from(".logs"));

        let _ = std::fs::create_dir_all(&log_dir);

        let file_appender = tracing_appender::rolling::daily(&log_dir, "openreelio.log");
        let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
        let _ = LOG_GUARD.set(guard);

        use tracing_subscriber::prelude::*;

        let env_filter = tracing_subscriber::EnvFilter::from_default_env()
            .add_directive(tracing::Level::INFO.into());

        let stdout_layer = tracing_subscriber::fmt::layer()
            .with_writer(std::io::stdout)
            .with_ansi(cfg!(debug_assertions));

        let file_layer = tracing_subscriber::fmt::layer()
            .with_writer(non_blocking)
            .with_ansi(false);

        let subscriber = tracing_subscriber::registry()
            .with(env_filter)
            .with(stdout_layer)
            .with(file_layer);

        // Avoid panics if already initialized (tests, plugin reloads).
        let _ = tracing::subscriber::set_global_default(subscriber);
    }

    /// Tauri command: Greet (placeholder for testing)
    #[tauri::command]
    #[specta::specta]
    fn greet(name: &str) -> String {
        format!("Hello, {}! Welcome to OpenReelio.", name)
    }

    /// Collects all commands for tauri-specta type export.
    /// This is used by the bindings generator.
    #[macro_export]
    macro_rules! collect_commands {
        () => {
            tauri_specta::collect_commands![
                // App lifecycle / runtime sync
                $crate::ipc::app_cleanup,
                $crate::ipc::list_system_font_families,
                $crate::ipc::set_playhead_position,
                $crate::ipc::get_playhead_position,
                // Project commands
                $crate::ipc::create_project,
                $crate::ipc::open_project,
                $crate::ipc::open_or_init_project,
                $crate::ipc::close_project,
                $crate::ipc::save_project,
                $crate::ipc::reload_project_from_disk,
                $crate::ipc::get_project_info,
                $crate::ipc::get_project_state,
                $crate::ipc::get_sequence_text_clip_data,
                $crate::ipc::get_sequence_hdr_settings,
                $crate::ipc::get_sequence_render_graph,
                $crate::ipc::get_effect_capabilities,
                // Asset commands
                $crate::ipc::import_asset,
                $crate::ipc::relink_asset,
                $crate::ipc::get_assets,
                $crate::ipc::remove_asset,
                $crate::ipc::generate_asset_thumbnail,
                $crate::ipc::generate_proxy_for_asset,
                $crate::ipc::update_asset_proxy,
                $crate::ipc::get_waveform_data,
                $crate::ipc::generate_waveform_for_asset,
                $crate::ipc::ensure_audio_preview_for_asset,
                // Timeline commands
                $crate::ipc::get_sequences,
                $crate::ipc::create_sequence,
                $crate::ipc::get_sequence,
                // Edit commands
                $crate::ipc::validate_command_payload,
                $crate::ipc::execute_command,
                $crate::ipc::undo,
                $crate::ipc::redo,
                $crate::ipc::can_undo,
                $crate::ipc::can_redo,
                // Undo history (S32-002)
                $crate::ipc::get_undo_history,
                $crate::ipc::jump_to_history_state,
                // Gap management commands (S24-004)
                $crate::ipc::find_gaps,
                // Edit point & marker navigation (S27-002)
                $crate::ipc::get_next_edit_point,
                $crate::ipc::get_prev_edit_point,
                $crate::ipc::get_next_marker,
                $crate::ipc::get_prev_marker,
                // Job commands
                $crate::ipc::get_jobs,
                $crate::ipc::submit_job,
                $crate::ipc::get_job,
                $crate::ipc::cancel_job,
                $crate::ipc::get_job_stats,
                // Render commands
                $crate::ipc::validate_export,
                $crate::ipc::start_render,
                $crate::ipc::render_range,
                $crate::ipc::batch_render,
                $crate::ipc::cancel_render,
                $crate::ipc::export_frame,
                $crate::ipc::extract_timeline_frames,
                $crate::ipc::sequence_inspection_summary,
                $crate::ipc::verify_sequence,
                $crate::ipc::export_audio_only,
                $crate::ipc::get_available_encoders,
                $crate::ipc::detect_gpu_devices,
                $crate::ipc::get_available_decoders,
                // Render cache commands
                $crate::ipc::get_cache_status,
                $crate::ipc::clear_render_cache,
                $crate::ipc::render_preview_cache,
                // Stabilization command
                $crate::ipc::stabilize_clip,
                // Smart reframe command
                $crate::ipc::smart_reframe,
                // Point tracking command
                $crate::ipc::track_point,
                // Interchange export commands (EDL, FCPXML, OTIO)
                $crate::ipc::export_edl,
                $crate::ipc::export_fcpxml,
                $crate::ipc::export_otio,
                // Export destination picker (native save dialog + allow-list)
                $crate::ipc::pick_export_destination,
                // AI commands
                $crate::ipc::analyze_intent,
                $crate::ipc::create_proposal,
                $crate::ipc::apply_edit_script,
                $crate::ipc::validate_edit_script,
                // AI Provider commands
                $crate::ipc::configure_ai_provider,
                $crate::ipc::get_ai_provider_status,
                $crate::ipc::clear_ai_provider,
                $crate::ipc::sync_ai_from_vault,
                $crate::ipc::test_ai_connection,
                $crate::ipc::generate_edit_script_with_ai,
                $crate::ipc::complete_with_ai_raw,
                $crate::ipc::chat_with_ai,
                $crate::ipc::get_available_ai_models,
                // External agent status commands
                $crate::ipc::get_codex_status,
                $crate::ipc::get_codex_model_catalog,
                $crate::ipc::start_codex_app_server,
                $crate::ipc::write_codex_app_server_message,
                $crate::ipc::stop_codex_app_server,
                $crate::ipc::create_external_agent_approval_token,
                $crate::ipc::get_external_agent_setup_info,
                $crate::ipc::configure_codex_agent_runtime,
                $crate::ipc::start_codex_login,
                $crate::ipc::start_codex_login_session,
                $crate::ipc::cancel_codex_login_session,
                $crate::ipc::logout_codex_agent_runtime,
                $crate::ipc::install_codex_cli,
                $crate::ipc::update_codex_cli,
                $crate::ipc::consume_external_agent_approval_token,
                $crate::ipc::revoke_external_agent_approval_token,
                // Claude Code external agent commands
                $crate::ipc::get_claude_status,
                $crate::ipc::configure_claude_agent_runtime,
                $crate::ipc::start_claude_login,
                $crate::ipc::start_claude_login_session,
                $crate::ipc::submit_claude_login_code,
                $crate::ipc::cancel_claude_login_session,
                $crate::ipc::logout_claude_agent_runtime,
                $crate::ipc::install_claude_cli,
                $crate::ipc::update_claude_cli,
                $crate::ipc::start_claude_headless,
                $crate::ipc::write_claude_headless_message,
                $crate::ipc::stop_claude_headless,
                $crate::ipc::respond_openreelio_mcp_call,
                $crate::ipc::wait_openreelio_mcp_ready,
                // AI Conversation persistence commands
                $crate::core::ai::conversation_commands::create_ai_session,
                $crate::core::ai::conversation_commands::list_ai_sessions,
                $crate::core::ai::conversation_commands::get_ai_session,
                $crate::core::ai::conversation_commands::create_agent_session,
                $crate::core::ai::conversation_commands::get_agent_session,
                $crate::core::ai::conversation_commands::get_external_agent_session_link,
                $crate::core::ai::conversation_commands::upsert_external_agent_session_link,
                $crate::core::ai::conversation_commands::start_agent_run,
                $crate::core::ai::conversation_commands::update_agent_run_phase,
                $crate::core::ai::conversation_commands::create_agent_delegation_record,
                $crate::core::ai::conversation_commands::update_agent_delegation_record,
                $crate::core::ai::conversation_commands::list_agent_delegation_records,
                $crate::core::ai::conversation_commands::record_agent_permission_decision,
                $crate::core::ai::conversation_commands::list_agent_permission_decisions,
                $crate::core::ai::conversation_commands::record_agent_compaction,
                $crate::core::ai::conversation_commands::list_agent_compactions,
                $crate::core::ai::conversation_commands::create_agent_resume_checkpoint,
                $crate::core::ai::conversation_commands::consume_agent_resume_checkpoint,
                $crate::core::ai::conversation_commands::list_agent_resume_checkpoints,
                $crate::core::ai::conversation_commands::save_ai_message,
                $crate::core::ai::conversation_commands::update_ai_part,
                $crate::core::ai::conversation_commands::mark_parts_compacted,
                $crate::core::ai::conversation_commands::delete_ai_session,
                $crate::core::ai::conversation_commands::archive_ai_session,
                $crate::core::ai::conversation_commands::update_ai_session_title,
                // AI Knowledge persistence commands
                $crate::core::ai::knowledge_commands::save_ai_knowledge,
                $crate::core::ai::knowledge_commands::query_ai_knowledge,
                $crate::core::ai::knowledge_commands::delete_ai_knowledge,
                // AI Streaming commands
                $crate::core::ai::streaming::stream_ai_completion,
                $crate::core::ai::streaming::abort_ai_stream,
                // FFmpeg commands
                $crate::core::ffmpeg::check_ffmpeg,
                $crate::core::ffmpeg::install_ffmpeg,
                $crate::core::ffmpeg::extract_frame,
                $crate::core::ffmpeg::generate_thumbnail,
                $crate::core::ffmpeg::probe_media,
                $crate::core::ffmpeg::generate_waveform,
                // Performance/Memory commands
                $crate::ipc::get_memory_stats,
                $crate::ipc::trigger_memory_cleanup,
                // Transcription commands
                $crate::ipc::is_transcription_available,
                $crate::ipc::get_transcription_status,
                $crate::ipc::download_whisper_model,
                $crate::ipc::transcribe_asset,
                $crate::ipc::transcribe_sequence,
                $crate::ipc::submit_transcription_job,
                $crate::ipc::export_captions,
                $crate::ipc::get_captions_as_string,
                $crate::ipc::detect_shots,
                $crate::ipc::get_asset_shots,
                $crate::ipc::delete_asset_shots,
                $crate::ipc::is_shot_detection_available,
                // Search commands
                $crate::ipc::search_assets,
                $crate::ipc::is_meilisearch_available,
                $crate::ipc::search_content,
                $crate::ipc::index_asset_for_search,
                $crate::ipc::index_transcripts_for_search,
                $crate::ipc::index_source_report_chunks,
                $crate::ipc::search_source_report_chunks,
                $crate::ipc::remove_asset_from_search,
                // Annotation commands
                $crate::ipc::get_annotation,
                $crate::ipc::analyze_asset,
                $crate::ipc::estimate_analysis_cost,
                $crate::ipc::delete_annotation,
                $crate::ipc::list_annotations,
                $crate::ipc::get_analysis_status,
                $crate::ipc::get_available_providers,
                $crate::ipc::configure_cloud_provider,
                $crate::ipc::remove_cloud_provider,
                // Analysis pipeline commands (ADR-048)
                $crate::ipc::analyze_video_full,
                $crate::ipc::get_analysis_bundle,
                $crate::ipc::analyze_timeline_clip,
                $crate::ipc::get_clip_analysis,
                $crate::ipc::map_timeline_to_source,
                $crate::ipc::sample_clip_frames,
                $crate::ipc::inspect_timeline_range,
                $crate::ipc::enrich_clip_perception,
                $crate::ipc::get_clip_perception,
                $crate::ipc::describe_timeline_clip,
                $crate::ipc::describe_timeline_range,
                $crate::ipc::search_clip_evidence,
                $crate::ipc::plan_semantic_clip_edit,
                $crate::ipc::import_diarization_json,
                $crate::ipc::run_external_diarization,
                // ESD commands (ADR-049)
                $crate::ipc::generate_esd,
                $crate::ipc::get_esd,
                $crate::ipc::list_esds,
                $crate::ipc::delete_esd,
                // Style transfer commands (ADR-050)
                $crate::ipc::apply_editing_style,
                // Color match (S38-002)
                $crate::ipc::auto_color_match,
                // Settings
                $crate::ipc::get_settings,
                $crate::ipc::set_settings,
                $crate::ipc::update_settings,
                $crate::ipc::reset_settings,
                // Credentials (Secure API Key Storage)
                $crate::ipc::store_credential,
                $crate::ipc::has_credential,
                $crate::ipc::delete_credential,
                $crate::ipc::get_credential_status,
                // Video Generation
                $crate::ipc::submit_video_generation,
                $crate::ipc::poll_generation_job,
                $crate::ipc::cancel_generation_job,
                $crate::ipc::estimate_generation_cost,
                $crate::ipc::download_generated_video,
                $crate::ipc::configure_seedance_provider,
                // Updates
                $crate::ipc::check_for_updates,
                $crate::ipc::get_current_version,
                $crate::ipc::relaunch_app,
                $crate::ipc::download_and_install_update,
                $crate::ipc::get_system_metrics,
                // Workspace commands
                $crate::ipc::scan_workspace,
                $crate::ipc::get_workspace_tree,
                $crate::ipc::import_external_files_to_workspace,
                $crate::ipc::reveal_in_explorer,
                $crate::ipc::list_workspace_documents,
                $crate::ipc::read_workspace_document,
                $crate::ipc::write_workspace_document,
                // Source monitor commands (S23 — 3-point editing)
                $crate::ipc::set_source_asset,
                $crate::ipc::set_source_in,
                $crate::ipc::set_source_out,
                $crate::ipc::set_source_playhead,
                $crate::ipc::clear_source_in_out,
                $crate::ipc::get_source_state,
                $crate::ipc::match_frame,
                $crate::ipc::reverse_match_frame,
                $crate::ipc::three_point_insert,
                // Agent commands
                $crate::ipc::write_agent_trace,
                $crate::ipc::list_agent_traces,
                $crate::ipc::read_agent_trace,
                $crate::ipc::execute_agent_plan,
                $crate::ipc::search_stock_media,
                $crate::ipc::import_stock_media_asset,
                // Integrated terminal commands
                $crate::ipc::list_terminal_profiles,
                $crate::ipc::start_terminal_session,
                $crate::ipc::write_terminal_input,
                $crate::ipc::resize_terminal_session,
                $crate::ipc::kill_terminal_session,
                $crate::ipc::close_terminal_session,
                // Agent memory commands
                $crate::ipc::save_agent_memory,
                $crate::ipc::get_agent_memory,
                $crate::ipc::delete_agent_memory,
                $crate::ipc::clear_agent_memory,
                // Audio ducking
                $crate::ipc::apply_audio_ducking,
                // Compound clip commands
                $crate::ipc::create_compound_clip,
                $crate::ipc::unnest_compound_clip,
                // Adjustment layer
                $crate::ipc::create_adjustment_layer,
                // Effect copy/paste
                $crate::ipc::copy_clip_effects,
                // Effect presets
                $crate::ipc::save_effect_preset,
                $crate::ipc::load_effect_preset,
                $crate::ipc::list_effect_presets,
                $crate::ipc::delete_effect_preset,
                // Transcript-based editing (S35-001)
                $crate::ipc::get_transcript_words,
                $crate::ipc::delete_transcript_range,
                $crate::ipc::reorder_transcript_segment,
                // Cleanup detection (S35-002)
                $crate::ipc::detect_silence_regions,
                $crate::ipc::detect_filler_words,
                $crate::ipc::remove_detected_regions,
            ]
        };
    }

    /// Initialize and run the Tauri application
    #[cfg_attr(mobile, tauri::mobile_entry_point)]
    pub fn run() {
        // Create shared FFmpeg state
        let ffmpeg_state = create_ffmpeg_state();
        // Resident preview decoders. Built lazily on the first preview frame,
        // because FFmpeg detection has not necessarily finished by now.
        let preview_decoders = crate::core::preview::create_preview_decoder_state();

        let builder = tauri::Builder::default()
            .manage(AppState::new())
            .manage(ffmpeg_state.clone())
            .manage(preview_decoders.clone())
            .plugin(tauri_plugin_dialog::init());

        // Enable updater for release builds by default. Development builds can
        // opt in with OPENREELIO_ENABLE_UPDATER=1; release builds can opt out
        // with OPENREELIO_ENABLE_UPDATER=0 for offline/internal distribution.
        let updater_enabled = match std::env::var("OPENREELIO_ENABLE_UPDATER").ok().as_deref() {
            Some("1") | Some("true") | Some("TRUE") => true,
            Some("0") | Some("false") | Some("FALSE") => false,
            _ => !cfg!(debug_assertions),
        };
        let builder = if updater_enabled {
            builder.plugin(tauri_plugin_updater::Builder::new().build())
        } else {
            builder
        };

        let built = builder.setup(move |app| {
            // Initialize logging (safe to call multiple times).
            init_logging(app.handle());

            tracing::info!("OpenReelio starting...");

            // Capture AppHandle for commands and configure base asset protocol scope.
            // The static scope in `tauri.conf.json` is deliberately minimal; we extend it at runtime
            // only for opened projects and imported assets.
            let app_state: tauri::State<'_, AppState> = app.state();
            app_state.set_app_handle(app.handle().clone());

            // Initialize process-wide runtime-discovery and Claude auth-mode flags
            // from persisted settings BEFORE any probe can run, so executable
            // discovery (codex/claude preferSystem) and the Claude readiness probe
            // honor the user's saved preferences on first use.
            if let Ok(app_data_dir) = app.path().app_data_dir() {
                let settings = crate::core::settings::SettingsManager::new(app_data_dir).load();
                crate::ipc::system::apply_runtime_discovery_prefs(&settings);
            }

            // Allow app-managed cache/data directories first.
            // These directories are used for proxies, thumbnails, frames, and other generated files.
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                tracing::debug!("Allowing asset protocol for cache dir: {}", cache_dir.display());
                app_state.allow_asset_protocol_directory(&cache_dir, true);
            }
            // Do NOT blanket-allow app_data_dir for the asset protocol.
            // It can contain sensitive files (e.g. credential vaults) that should only be accessed
            // via privileged IPC commands.
            if let Ok(data_dir) = app.path().app_data_dir() {
                let vault_path = data_dir.join("credentials.vault");
                if vault_path.exists() {
                    tracing::debug!(
                        "Forbidding asset protocol for credential vault: {}",
                        vault_path.display()
                    );
                    app_state.forbid_asset_protocol_file(&vault_path);
                }
            }

            // Defense-in-depth: forbid access to WebView internal data.
            // On Windows, app_local_data_dir and app_cache_dir often overlap, so we only forbid
            // the specific WebView data subdirectory to avoid blocking legitimate cache access.
            // The EBWebView directory contains Microsoft Edge WebView2 runtime data.
            if let Ok(local_data) = app.path().app_local_data_dir() {
                let webview_data = local_data.join("EBWebView");
                if webview_data.exists() {
                    tracing::debug!("Forbidding asset protocol for WebView data: {}", webview_data.display());
                    app_state.forbid_asset_protocol_directory(&webview_data, true);
                }
            }

            // Initialize FFmpeg (detection probes run on the blocking pool so
            // the async runtime is never blocked while holding the state lock)
            let ffmpeg = ffmpeg_state.clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match crate::core::ffmpeg::initialize_shared_ffmpeg(&ffmpeg, Some(handle)).await {
                    Ok(()) => {
                        let state = ffmpeg.read().await;
                        if let Some(info) = state.info() {
                            tracing::info!(
                                "FFmpeg initialized: version {} (bundled: {})",
                                info.version,
                                info.is_bundled
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            "FFmpeg not available: {}. Video features will be limited.",
                            e
                        );
                    }
                }
            });

            // Start background worker pool
            let ffmpeg_for_workers = ffmpeg_state.clone();
            let app_handle_for_workers = app.handle().clone();
            let shutdown = Arc::new(Notify::new());
            let _ = app_state.worker_shutdown.set(Arc::clone(&shutdown));

            // Get cache directory for job outputs
            let cache_dir = app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from(".cache"));

            // Start workers after FFmpeg initialization
            // We need to access the WorkerPool's Arc references before spawning
            let job_queue = {
                // Use blocking to get the Arc references from WorkerPool
                // This is safe during setup since we're not in an async context yet
                // Add timeout to prevent deadlock if lock is held during setup
                let pool_guard = tauri::async_runtime::block_on(async {
                    match tokio::time::timeout(
                        tokio::time::Duration::from_secs(10),
                        app_state.job_pool.lock(),
                    )
                    .await
                    {
                        Ok(guard) => Some(guard),
                        Err(_) => {
                            tracing::error!(
                                "Timeout acquiring job pool lock during startup. \
                                 Worker pool initialization skipped."
                            );
                            None
                        }
                    }
                });

                pool_guard.map(|guard| {
                    (
                        Arc::clone(&guard.queue),
                        Arc::clone(&guard.active_jobs),
                        guard.num_workers(),
                    )
                })
            };

            // Only start workers if we successfully acquired the job pool
            if let Some((queue_arc, active_jobs_arc, num_workers)) = job_queue {
                let shutdown_clone = Arc::clone(&shutdown);
                let app_handle_for_worker_state = app_handle_for_workers.clone();

                // Spawn workers using the cloned Arc references
                tauri::async_runtime::spawn(async move {
                    // Wait for FFmpeg to initialize
                    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;

                    // Start worker tasks that consume from the queue
                    let handles = crate::core::jobs::start_workers_with_arcs(
                        queue_arc,
                        active_jobs_arc,
                        num_workers,
                        ffmpeg_for_workers,
                        app_handle_for_workers,
                        cache_dir,
                        shutdown_clone,
                    );
                    app_handle_for_worker_state
                        .state::<AppState>()
                        .worker_handles
                        .lock()
                        .await
                        .extend(handles);

                    tracing::info!(
                        "Started {} background workers for job processing",
                        num_workers
                    );
                });
            } else {
                tracing::warn!(
                    "Background worker pool not started due to lock acquisition failure. \
                     Background jobs may not be processed."
                );
            }

            // Initialize Meilisearch service (optional)
            #[cfg(feature = "meilisearch")]
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let service = std::sync::Arc::new(SearchService::new(
                        crate::core::search::meilisearch::SidecarConfig::default(),
                    ));

                    // Best-effort warm-up so first query is fast.
                    if let Err(e) = service.ensure_ready().await {
                        tracing::warn!(
                            "Meilisearch not ready at startup: {}. Search will attempt lazy startup.",
                            e
                        );
                    } else {
                        tracing::info!("Meilisearch initialized and ready");
                    }

                    let state = app_handle.state::<AppState>();
                    let mut guard = state.search_service.lock().await;
                    *guard = Some(service);
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            // App lifecycle
            ipc::app_cleanup,
            ipc::list_system_font_families,
            ipc::set_playhead_position,
            ipc::get_playhead_position,
            // Project commands
            ipc::create_project,
            ipc::open_project,
            ipc::open_or_init_project,
            ipc::close_project,
            ipc::save_project,
            ipc::reload_project_from_disk,
            ipc::get_project_info,
            ipc::get_project_state,
            ipc::get_sequence_text_clip_data,
            ipc::get_sequence_hdr_settings,
            ipc::get_sequence_render_graph,
            ipc::get_effect_capabilities,
            // Asset commands
            ipc::import_asset,
            ipc::relink_asset,
            ipc::get_assets,
            ipc::remove_asset,
            ipc::generate_asset_thumbnail,
            ipc::generate_proxy_for_asset,
            ipc::update_asset_proxy,
            ipc::get_waveform_data,
            ipc::generate_waveform_for_asset,
            ipc::ensure_audio_preview_for_asset,
            // Timeline commands
            ipc::get_sequences,
            ipc::create_sequence,
            ipc::get_sequence,
            // Edit commands
            ipc::validate_command_payload,
            ipc::execute_command,
            ipc::undo,
            ipc::redo,
            ipc::can_undo,
            ipc::can_redo,
            // Undo history (S32-002)
            ipc::get_undo_history,
            ipc::jump_to_history_state,
            // Gap management commands (S24-004)
            ipc::find_gaps,
            // Edit point & marker navigation (S27-002)
            ipc::get_next_edit_point,
            ipc::get_prev_edit_point,
            ipc::get_next_marker,
            ipc::get_prev_marker,
            // Job commands
            ipc::get_jobs,
            ipc::submit_job,
            ipc::get_job,
            ipc::cancel_job,
            ipc::get_job_stats,
            // Render commands
            ipc::validate_export,
            ipc::start_render,
            ipc::render_range,
            ipc::batch_render,
            ipc::cancel_render,
            ipc::export_frame,
            ipc::extract_timeline_frames,
            ipc::sequence_inspection_summary,
            ipc::verify_sequence,
            ipc::export_audio_only,
            ipc::get_available_encoders,
            ipc::detect_gpu_devices,
            ipc::get_available_decoders,
            // Render cache commands
            ipc::get_cache_status,
            ipc::clear_render_cache,
            ipc::render_preview_cache,
            // Stabilization command
            ipc::stabilize_clip,
            // Smart reframe command
            ipc::smart_reframe,
            // Point tracking command
            ipc::track_point,
            // Interchange export commands (EDL, FCPXML, OTIO)
            ipc::export_edl,
            ipc::export_fcpxml,
            ipc::export_otio,
            // Export destination picker (native save dialog + allow-list)
            ipc::pick_export_destination,
            // AI commands
            ipc::analyze_intent,
            ipc::create_proposal,
            ipc::apply_edit_script,
            ipc::validate_edit_script,
            // AI Provider commands
            ipc::configure_ai_provider,
            ipc::get_ai_provider_status,
            ipc::clear_ai_provider,
            ipc::sync_ai_from_vault,
            ipc::test_ai_connection,
            ipc::generate_edit_script_with_ai,
            ipc::complete_with_ai_raw,
            ipc::chat_with_ai,
            ipc::get_available_ai_models,
            // External agent status commands
            ipc::get_codex_status,
            ipc::get_codex_model_catalog,
            ipc::start_codex_app_server,
            ipc::write_codex_app_server_message,
            ipc::stop_codex_app_server,
            ipc::create_external_agent_approval_token,
            ipc::get_external_agent_setup_info,
            ipc::configure_codex_agent_runtime,
            ipc::start_codex_login,
            ipc::start_codex_login_session,
            ipc::cancel_codex_login_session,
            ipc::logout_codex_agent_runtime,
            ipc::install_codex_cli,
            ipc::update_codex_cli,
            ipc::consume_external_agent_approval_token,
            ipc::revoke_external_agent_approval_token,
            // Claude Code external agent commands
            ipc::get_claude_status,
            ipc::configure_claude_agent_runtime,
            ipc::start_claude_login,
            ipc::start_claude_login_session,
            ipc::submit_claude_login_code,
            ipc::cancel_claude_login_session,
            ipc::logout_claude_agent_runtime,
            ipc::install_claude_cli,
            ipc::update_claude_cli,
            ipc::start_claude_headless,
            ipc::write_claude_headless_message,
            ipc::stop_claude_headless,
            ipc::respond_openreelio_mcp_call,
            ipc::wait_openreelio_mcp_ready,
            // AI Conversation persistence commands
            crate::core::ai::conversation_commands::create_ai_session,
            crate::core::ai::conversation_commands::list_ai_sessions,
            crate::core::ai::conversation_commands::get_ai_session,
            crate::core::ai::conversation_commands::create_agent_session,
            crate::core::ai::conversation_commands::get_agent_session,
            crate::core::ai::conversation_commands::get_external_agent_session_link,
            crate::core::ai::conversation_commands::upsert_external_agent_session_link,
            crate::core::ai::conversation_commands::start_agent_run,
            crate::core::ai::conversation_commands::update_agent_run_phase,
            crate::core::ai::conversation_commands::create_agent_delegation_record,
            crate::core::ai::conversation_commands::update_agent_delegation_record,
            crate::core::ai::conversation_commands::list_agent_delegation_records,
            crate::core::ai::conversation_commands::record_agent_permission_decision,
            crate::core::ai::conversation_commands::list_agent_permission_decisions,
            crate::core::ai::conversation_commands::record_agent_compaction,
            crate::core::ai::conversation_commands::list_agent_compactions,
            crate::core::ai::conversation_commands::create_agent_resume_checkpoint,
            crate::core::ai::conversation_commands::consume_agent_resume_checkpoint,
            crate::core::ai::conversation_commands::list_agent_resume_checkpoints,
            crate::core::ai::conversation_commands::save_ai_message,
            crate::core::ai::conversation_commands::update_ai_part,
            crate::core::ai::conversation_commands::mark_parts_compacted,
            crate::core::ai::conversation_commands::delete_ai_session,
            crate::core::ai::conversation_commands::archive_ai_session,
            crate::core::ai::conversation_commands::update_ai_session_title,
            // AI Knowledge persistence commands
            crate::core::ai::knowledge_commands::save_ai_knowledge,
            crate::core::ai::knowledge_commands::query_ai_knowledge,
            crate::core::ai::knowledge_commands::delete_ai_knowledge,
            // AI Streaming commands
            crate::core::ai::streaming::stream_ai_completion,
            crate::core::ai::streaming::abort_ai_stream,
            // FFmpeg commands
            crate::core::ffmpeg::check_ffmpeg,
            crate::core::ffmpeg::install_ffmpeg,
            crate::core::ffmpeg::extract_frame,
            crate::core::ffmpeg::generate_thumbnail,
            crate::core::ffmpeg::probe_media,
            crate::core::ffmpeg::generate_waveform,
            // Resident preview decoder. Deliberately outside `collect_commands!`:
            // it answers with raw bytes (`tauri::ipc::Response`), which Specta
            // cannot describe, and the frontend calls it through `invoke`.
            crate::core::preview::get_preview_frame,
            crate::core::preview::release_preview_decoders,
            // Performance/Memory commands
            ipc::get_memory_stats,
            ipc::trigger_memory_cleanup,
            // Transcription commands
            ipc::is_transcription_available,
            ipc::get_transcription_status,
            ipc::download_whisper_model,
            ipc::transcribe_asset,
            ipc::transcribe_sequence,
            ipc::submit_transcription_job,
            ipc::export_captions,
            ipc::get_captions_as_string,
            // Search commands
            ipc::search_assets,
            ipc::is_meilisearch_available,
            ipc::search_content,
            ipc::index_asset_for_search,
            ipc::index_transcripts_for_search,
            ipc::index_source_report_chunks,
            ipc::search_source_report_chunks,
            ipc::remove_asset_from_search,
            // Shot Detection
            ipc::detect_shots,
            ipc::get_asset_shots,
            ipc::delete_asset_shots,
            ipc::is_shot_detection_available,
            // Annotation commands
            ipc::get_annotation,
            ipc::analyze_asset,
            ipc::estimate_analysis_cost,
            ipc::delete_annotation,
            ipc::list_annotations,
            ipc::get_analysis_status,
            ipc::get_available_providers,
            ipc::configure_cloud_provider,
            ipc::remove_cloud_provider,
            // Analysis pipeline commands (ADR-048)
            ipc::analyze_video_full,
            ipc::get_analysis_bundle,
            ipc::analyze_timeline_clip,
            ipc::get_clip_analysis,
            ipc::map_timeline_to_source,
            ipc::sample_clip_frames,
            ipc::inspect_timeline_range,
            ipc::enrich_clip_perception,
            ipc::get_clip_perception,
            ipc::describe_timeline_clip,
            ipc::describe_timeline_range,
            ipc::search_clip_evidence,
            ipc::plan_semantic_clip_edit,
            ipc::import_diarization_json,
            ipc::run_external_diarization,
            // ESD commands (ADR-049)
            ipc::generate_esd,
            ipc::get_esd,
            ipc::list_esds,
            ipc::delete_esd,
            // Style transfer commands (ADR-050)
            ipc::apply_editing_style,
            // Color match (S38-002)
            ipc::auto_color_match,
            // Settings
            ipc::get_settings,
            ipc::set_settings,
            ipc::update_settings,
            ipc::reset_settings,
            // Credentials (Secure API Key Storage)
            ipc::store_credential,
            ipc::has_credential,
            ipc::delete_credential,
            ipc::get_credential_status,
            // Video Generation
            ipc::submit_video_generation,
            ipc::poll_generation_job,
            ipc::cancel_generation_job,
            ipc::estimate_generation_cost,
            ipc::download_generated_video,
            ipc::configure_seedance_provider,
            // Updates
            ipc::check_for_updates,
            ipc::get_current_version,
            ipc::relaunch_app,
            ipc::download_and_install_update,
            ipc::get_system_metrics,
            // Workspace commands
            ipc::scan_workspace,
            ipc::get_workspace_tree,
            ipc::import_external_files_to_workspace,
            ipc::reveal_in_explorer,
            ipc::list_workspace_documents,
            ipc::read_workspace_document,
            ipc::write_workspace_document,
            // Source monitor commands (S23 — 3-point editing)
            ipc::set_source_asset,
            ipc::set_source_in,
            ipc::set_source_out,
            ipc::set_source_playhead,
            ipc::clear_source_in_out,
            ipc::get_source_state,
            ipc::match_frame,
            ipc::reverse_match_frame,
            ipc::three_point_insert,
            // Agent commands
            ipc::write_agent_trace,
            ipc::list_agent_traces,
            ipc::read_agent_trace,
            ipc::execute_agent_plan,
            ipc::search_stock_media,
            ipc::import_stock_media_asset,
            // Integrated terminal commands
            ipc::list_terminal_profiles,
            ipc::start_terminal_session,
            ipc::write_terminal_input,
            ipc::resize_terminal_session,
            ipc::kill_terminal_session,
            ipc::close_terminal_session,
            // Agent memory commands
            ipc::save_agent_memory,
            ipc::get_agent_memory,
            ipc::delete_agent_memory,
            ipc::clear_agent_memory,
            // Audio ducking
            ipc::apply_audio_ducking,
            // Compound clip commands
            ipc::create_compound_clip,
            ipc::unnest_compound_clip,
            // Adjustment layer
            ipc::create_adjustment_layer,
            // Effect copy/paste
            ipc::copy_clip_effects,
            // Effect presets
            ipc::save_effect_preset,
            ipc::load_effect_preset,
            ipc::list_effect_presets,
            ipc::delete_effect_preset,
            // Transcript-based editing (S35-001)
            ipc::get_transcript_words,
            ipc::delete_transcript_range,
            ipc::reorder_transcript_segment,
            // Cleanup detection (S35-002)
            ipc::detect_silence_regions,
            ipc::detect_filler_words,
            ipc::remove_detected_regions,
        ])
        .build(tauri::generate_context!());

        let app = match built {
            Ok(app) => app,
            Err(e) => {
                tracing::error!("Error while building tauri application: {e}");
                std::process::exit(1);
            }
        };

        // Deterministic teardown on exit: synchronously stop external-agent child
        // processes so no orphaned `claude`/`codex` process outlives the app.
        //
        // NOTE: `kill_on_drop(true)` on the child handles is best-effort and is
        // NOT guaranteed when the process ends via `std::process::exit` (Rust
        // destructors do not run on `exit`), so teardown is performed explicitly
        // here. Windows Job Objects (kill the whole child tree on parent death)
        // would be the stronger guarantee and are a possible future hardening;
        // they are intentionally out of scope for now.
        app.run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                // Defensive: ignore individual teardown errors so exit always
                // proceeds. `block_on` is safe here — the run callback executes
                // on the main thread, not a tokio worker.
                let preview_decoders =
                    app_handle.state::<crate::core::preview::SharedPreviewDecoders>();
                tauri::async_runtime::block_on(async {
                    crate::ipc::shutdown_all_claude_headless_sessions(&state).await;
                    crate::ipc::shutdown_all_claude_login_sessions(&state).await;
                    crate::ipc::shutdown_all_codex_login_sessions(&state).await;
                    crate::ipc::shutdown_all_codex_app_servers(&state).await;
                    // Resident FFmpeg decoders are not reaped by `std::process::exit`
                    // either, so they are killed explicitly alongside the agents.
                    // Bounded: a decoder wedged on a pipe read must not be able
                    // to hold the whole application open.
                    if tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        preview_decoders.release_all(),
                    )
                    .await
                    .is_err()
                    {
                        tracing::warn!("Preview decoder teardown timed out during exit");
                    }
                });
            }
        });
    }
}

#[cfg(all(not(test), feature = "gui"))]
pub use tauri_app::run;

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The hostile spelling used by the load tests below.
    ///
    /// A share, because it is the worst of the three classes: on Windows the
    /// first thing that stats this path opens the SMB connection and leaks the
    /// NTLM handshake, so it has to be refused before any of the load paths
    /// touches it.
    const HOSTILE_ASSET_URI: &str = r"\\attacker.example\share\payload.mp4";

    fn hostile_asset() -> crate::core::assets::Asset {
        crate::core::assets::Asset::new_video(
            "payload",
            HOSTILE_ASSET_URI,
            crate::core::assets::VideoInfo::default(),
        )
    }

    /// Appends an `AssetImport` operation straight to `ops.jsonl`.
    ///
    /// Deliberately bypasses `ImportAssetCommand`, because that is the point:
    /// the command layer validates and the file does not, so this is exactly
    /// what a hand-edited, synced or agent-generated project folder looks like.
    fn append_raw_asset_import(
        project_path: &Path,
        asset: &crate::core::assets::Asset,
    ) -> crate::core::CoreResult<()> {
        let ops_path = project_path.join(".openreelio/state/ops.jsonl");
        let ops_log = OpsLog::new(&ops_path);
        ops_log.append(&crate::core::project::Operation::new(
            crate::core::project::OpKind::AssetImport,
            serde_json::to_value(asset).unwrap(),
        ))?;
        Ok(())
    }

    #[test]
    fn should_quarantine_a_hostile_asset_uri_when_opening_a_project() {
        // Given: a project folder whose ops log names a network share
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("hostile_open");
        let project = ActiveProject::create("Hostile Open", project_path.clone()).unwrap();
        drop(project);
        let asset = hostile_asset();
        append_raw_asset_import(&project_path, &asset).unwrap();

        // When: the project is opened
        let opened = ActiveProject::open(project_path).unwrap();

        // Then: it opens — a partly corrupt project must stay inspectable — but
        // the path never reaches the state the render pipeline reads.
        let loaded = opened
            .state
            .assets
            .get(&asset.id)
            .expect("the asset is still listed so it can be relinked");
        assert!(loaded.uri.is_empty());
        assert!(loaded.missing);
        assert_eq!(loaded.quarantined_uri.as_deref(), Some(HOSTILE_ASSET_URI));
    }

    #[test]
    fn should_quarantine_a_hostile_asset_uri_when_reading_without_a_session() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("hostile_read_only");
        let project = ActiveProject::create("Hostile Read Only", project_path.clone()).unwrap();
        drop(project);
        let asset = hostile_asset();
        append_raw_asset_import(&project_path, &asset).unwrap();

        let state = ActiveProject::read_state_without_session(&project_path).unwrap();

        let loaded = state.assets.get(&asset.id).expect("asset present");
        assert!(loaded.uri.is_empty());
        assert_eq!(loaded.quarantined_uri.as_deref(), Some(HOSTILE_ASSET_URI));
    }

    #[test]
    fn should_quarantine_a_hostile_asset_uri_carried_only_by_a_snapshot() {
        // Given: a project with nothing to replay, so the read takes the
        // snapshot-only exit that never goes through operation replay
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("hostile_snapshot");
        let project = ActiveProject::create("Hostile Snapshot", project_path.clone()).unwrap();
        let mut state = project.state.clone();
        drop(project);

        let asset = hostile_asset();
        state.assets.insert(asset.id.clone(), asset.clone());
        let state_dir = project_path.join(".openreelio/state");
        Snapshot::save(&state_dir.join("snapshot.json"), &state, None).unwrap();
        std::fs::write(state_dir.join("ops.jsonl"), "").unwrap();
        let _ = std::fs::remove_file(state_dir.join("history.json"));

        // When / Then
        let read = ActiveProject::read_state_without_session(&project_path).unwrap();
        let loaded = read.assets.get(&asset.id).expect("asset present");
        assert!(loaded.uri.is_empty());
        assert_eq!(loaded.quarantined_uri.as_deref(), Some(HOSTILE_ASSET_URI));

        let opened = ActiveProject::open(project_path).unwrap();
        let loaded = opened.state.assets.get(&asset.id).expect("asset present");
        assert!(loaded.uri.is_empty());
        assert_eq!(loaded.quarantined_uri.as_deref(), Some(HOSTILE_ASSET_URI));
    }

    #[test]
    fn should_not_resurrect_a_quarantined_uri_when_history_is_rebuilt() {
        // The quarantine lives in the state, not in the log, so every rebuild
        // from the same operations has to re-apply it — otherwise one undo hands
        // the share back to the render pipeline.
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("hostile_history");
        let project = ActiveProject::create("Hostile History", project_path.clone()).unwrap();
        drop(project);
        let asset = hostile_asset();
        append_raw_asset_import(&project_path, &asset).unwrap();

        let mut opened = ActiveProject::open(project_path).unwrap();
        opened.undo_persisted().unwrap();
        opened.redo_persisted().unwrap();

        let loaded = opened.state.assets.get(&asset.id).expect("asset present");
        assert!(loaded.uri.is_empty());
        assert_eq!(loaded.quarantined_uri.as_deref(), Some(HOSTILE_ASSET_URI));
    }

    #[test]
    fn should_keep_an_offline_asset_relinkable_when_opening_a_project() {
        // Regression guard for the deferral: a legitimate absolute path whose
        // file is gone must survive the load verbatim, because relink and
        // workspace auto-reconnect both read it back.
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("offline_open");
        let project = ActiveProject::create("Offline Open", project_path.clone()).unwrap();
        drop(project);

        let offline_uri = temp_dir
            .path()
            .join("footage")
            .join("deleted.mp4")
            .to_string_lossy()
            .to_string();
        let asset = crate::core::assets::Asset::new_video(
            "deleted",
            &offline_uri,
            crate::core::assets::VideoInfo::default(),
        )
        .with_relative_path("footage/deleted.mp4");
        append_raw_asset_import(&project_path, &asset).unwrap();

        let opened = ActiveProject::open(project_path).unwrap();

        let loaded = opened.state.assets.get(&asset.id).expect("asset present");
        assert_eq!(loaded.uri, offline_uri);
        assert_eq!(loaded.relative_path.as_deref(), Some("footage/deleted.mp4"));
        assert_eq!(loaded.quarantined_uri, None);
        assert!(!loaded.missing);
    }

    #[test]
    fn test_active_project_create() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("test_project");

        let project = ActiveProject::create("Test Project", project_path.clone()).unwrap();
        let state_dir = project_path.join(".openreelio/state");

        assert_eq!(project.state.meta.name, "Test Project");
        assert_eq!(project.path, project_path);
        assert_eq!(project.state_dir, state_dir);
        assert!(state_dir.join("project.json").exists());
        assert!(state_dir.join("snapshot.json").exists());
        assert!(state_dir.join("ops.jsonl").exists());
        assert!(state_dir.join("history.json").exists());
    }

    #[test]
    fn test_active_project_open() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("test_project");

        // Create project first
        let project = ActiveProject::create("Test Project", project_path.clone()).unwrap();
        drop(project);

        // Open the project
        let opened = ActiveProject::open(project_path).unwrap();
        assert_eq!(opened.state.meta.name, "Test Project");
    }

    #[test]
    fn test_active_project_open_falls_back_when_snapshot_is_corrupted() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("test_project");

        // Create project first
        let project = ActiveProject::create("Test Project", project_path.clone()).unwrap();
        drop(project);

        // Corrupt the snapshot file
        std::fs::write(
            project_path.join(".openreelio/state/snapshot.json"),
            "{not valid json",
        )
        .unwrap();

        // Open should still succeed by replaying ops.jsonl
        let opened = ActiveProject::open(project_path).unwrap();
        assert_eq!(opened.state.meta.name, "Test Project");
    }

    #[test]
    fn test_active_project_save() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("test_project");

        let mut project = ActiveProject::create("Test Project", project_path.clone()).unwrap();
        project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Updated Name"),
                ),
                &mut project.state,
            )
            .unwrap();
        project.save().unwrap();

        // Reopen and verify
        let reopened = ActiveProject::open(project_path).unwrap();
        assert_eq!(reopened.state.meta.name, "Updated Name");
    }

    #[test]
    fn test_active_project_save_clears_dirty_flag() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("test_project");

        let mut project = ActiveProject::create("Test Project", project_path.clone()).unwrap();

        // Execute a command to mark the project dirty.
        project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Updated Name"),
                ),
                &mut project.state,
            )
            .unwrap();
        assert!(project.state.is_dirty);

        // Save should reset the dirty flag
        project.save().unwrap();
        assert!(
            !project.state.is_dirty,
            "is_dirty should be false after save"
        );

        // Reopen and verify dirty flag starts as false
        let reopened = ActiveProject::open(project_path).unwrap();
        assert!(
            !reopened.state.is_dirty,
            "is_dirty should be false after reopen"
        );
    }

    #[test]
    fn test_active_project_persisted_undo_redo_survives_reopen() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("history_project");

        let mut project = ActiveProject::create("History Test", project_path.clone()).unwrap();
        project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Updated Name"),
                ),
                &mut project.state,
            )
            .unwrap();
        project.save().unwrap();
        drop(project);

        let mut reopened = ActiveProject::open(project_path.clone()).unwrap();
        reopened.undo_persisted().unwrap();
        reopened.save().unwrap();
        drop(reopened);

        let reopened_after_undo = ActiveProject::open(project_path.clone()).unwrap();
        assert_eq!(reopened_after_undo.state.meta.name, "History Test");
        drop(reopened_after_undo);

        let mut reopened_for_redo = ActiveProject::open(project_path.clone()).unwrap();
        reopened_for_redo.redo_persisted().unwrap();
        reopened_for_redo.save().unwrap();
        drop(reopened_for_redo);

        let reopened_after_redo = ActiveProject::open(project_path).unwrap();
        assert_eq!(reopened_after_redo.state.meta.name, "Updated Name");
    }

    #[test]
    fn test_active_project_persisted_undo_keeps_history_when_replay_fails() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("history_atomic_project");

        let mut project = ActiveProject::create("History Atomic", project_path.clone()).unwrap();
        project
            .ops_log
            .append(&crate::core::project::Operation::with_id(
                "corrupt-replay-op",
                crate::core::project::OpKind::AssetImport,
                serde_json::json!({}),
            ))
            .unwrap();
        project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Still Current"),
                ),
                &mut project.state,
            )
            .unwrap();
        project.save().unwrap();

        let history_before = project.history.clone();
        let history_file_before = std::fs::read(&project.history_path).unwrap();
        let state_name_before = project.state.meta.name.clone();
        let last_op_id_before = project.state.last_op_id.clone();
        let op_count_before = project.state.op_count;
        let is_dirty_before = project.state.is_dirty;
        let result = project.undo_persisted();

        assert!(result.is_err());
        assert_eq!(project.state.meta.name, state_name_before);
        assert_eq!(project.state.last_op_id, last_op_id_before);
        assert_eq!(project.state.op_count, op_count_before);
        assert_eq!(project.state.is_dirty, is_dirty_before);
        assert_eq!(
            std::fs::read(&project.history_path).unwrap(),
            history_file_before
        );
        assert_eq!(
            project.history.applied_op_ids,
            history_before.applied_op_ids
        );
        assert_eq!(project.history.redo_op_ids, history_before.redo_op_ids);
    }

    #[test]
    fn test_active_project_apply_history_candidate_keeps_concurrent_ops() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("history_concurrent_project");

        let mut project = ActiveProject::create("History Concurrent", project_path).unwrap();
        project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Undo Candidate"),
                ),
                &mut project.state,
            )
            .unwrap();
        project.save().unwrap();

        project.sync_history_with_ops_log().unwrap();
        let mut candidate_history = project.history.clone();
        candidate_history.undo().unwrap();

        project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Concurrent Update"),
                ),
                &mut project.state,
            )
            .unwrap();
        let concurrent_op_id = project.state.last_op_id.clone().unwrap();

        project.apply_history_candidate(candidate_history).unwrap();

        assert_eq!(project.state.meta.name, "Concurrent Update");
        assert_eq!(
            project.history.current_head(),
            Some(concurrent_op_id.as_str())
        );
        assert!(project.history.redo_op_ids.is_empty());
    }

    #[test]
    fn test_active_project_discard_persisted_operations_survives_reopen() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("history_discard_project");

        let mut project = ActiveProject::create("History Discard", project_path.clone()).unwrap();
        let result = project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Discarded Name"),
                ),
                &mut project.state,
            )
            .unwrap();

        assert_eq!(project.state.meta.name, "Discarded Name");

        let still_applied = project
            .discard_persisted_operations(std::slice::from_ref(&result.op_id))
            .unwrap();
        assert!(
            still_applied.is_empty(),
            "nothing here is protected: {still_applied:?}"
        );
        project.save().unwrap();

        assert_eq!(project.state.meta.name, "History Discard");
        assert!(!project.history.applied_op_ids.contains(&result.op_id));
        assert!(!project.history.redo_op_ids.contains(&result.op_id));
        assert!(project.history.discarded_op_ids.contains(&result.op_id));

        let reopened = ActiveProject::open(project_path).unwrap();
        assert_eq!(reopened.state.meta.name, "History Discard");
        assert!(!reopened.history.applied_op_ids.contains(&result.op_id));
        assert!(reopened.history.discarded_op_ids.contains(&result.op_id));
    }

    #[test]
    fn test_active_project_discard_preserves_created_active_sequence() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir
            .path()
            .join("history_discard_active_sequence_project");

        let mut project = ActiveProject::create("History Active", project_path).unwrap();
        let default_sequence_id = project.state.active_sequence_id.clone().unwrap();

        let create_result = project
            .executor
            .execute(
                Box::new(crate::core::commands::CreateSequenceCommand::new(
                    "Shorts Timeline",
                    "youtube_shorts",
                )),
                &mut project.state,
            )
            .unwrap();
        let shorts_sequence_id = create_result.created_ids[0].clone();
        assert_ne!(default_sequence_id, shorts_sequence_id);
        assert_eq!(
            project.state.active_sequence_id.as_deref(),
            Some(shorts_sequence_id.as_str())
        );

        let track_result = project
            .executor
            .execute(
                Box::new(crate::core::commands::AddTrackCommand::new(
                    &shorts_sequence_id,
                    "Temporary Captions",
                    crate::core::timeline::TrackKind::Caption,
                )),
                &mut project.state,
            )
            .unwrap();

        let still_applied = project
            .discard_persisted_operations(std::slice::from_ref(&track_result.op_id))
            .unwrap();
        assert!(
            still_applied.is_empty(),
            "nothing here is protected: {still_applied:?}"
        );

        assert_eq!(
            project.state.active_sequence_id.as_deref(),
            Some(shorts_sequence_id.as_str())
        );
        assert!(project.state.sequences.contains_key(&default_sequence_id));
        let shorts_sequence = project.state.sequences.get(&shorts_sequence_id).unwrap();
        assert!(!shorts_sequence
            .tracks
            .iter()
            .any(|track| track.name == "Temporary Captions"));
    }

    /// A discard that hits the protected prefix must say so.
    ///
    /// The project's first `SequenceCreate` is never discardable, so a
    /// transaction whose first step created it cannot be rolled back to
    /// nothing. Returning `Ok(())` there told every caller the rollback was
    /// clean while the operation stayed applied and came back on the next open.
    #[test]
    fn test_active_project_discard_reports_operations_the_protected_prefix_kept() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("history_discard_protected_project");
        std::fs::create_dir_all(&project_path).unwrap();

        // Opened rather than created, so the ops log starts empty and the first
        // command's operation becomes the protected head.
        let mut project = ActiveProject::open(project_path.clone()).unwrap();
        let created = project
            .executor
            .execute(
                Box::new(crate::core::commands::CreateSequenceCommand::new(
                    "Plan Sequence",
                    "1080p",
                )),
                &mut project.state,
            )
            .unwrap();

        let still_applied = project
            .discard_persisted_operations(std::slice::from_ref(&created.op_id))
            .unwrap();

        assert_eq!(
            still_applied,
            vec![created.op_id.clone()],
            "the protected operation stayed applied, so the caller has to hear about it"
        );
        assert!(project.history.applied_op_ids.contains(&created.op_id));
        assert!(!project.history.discarded_op_ids.contains(&created.op_id));
    }

    #[test]
    fn test_active_project_sync_appends_new_ops_after_discarded_operations() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("history_discard_future_project");

        let mut project = ActiveProject::create("History Future", project_path.clone()).unwrap();
        let discarded = project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Discarded Name"),
                ),
                &mut project.state,
            )
            .unwrap();

        let still_applied = project
            .discard_persisted_operations(std::slice::from_ref(&discarded.op_id))
            .unwrap();
        assert!(
            still_applied.is_empty(),
            "nothing here is protected: {still_applied:?}"
        );

        let kept = project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Kept Name"),
                ),
                &mut project.state,
            )
            .unwrap();
        project.save().unwrap();

        assert_eq!(project.state.meta.name, "Kept Name");
        assert!(project.history.discarded_op_ids.contains(&discarded.op_id));
        assert!(!project.history.applied_op_ids.contains(&discarded.op_id));
        assert!(project.history.applied_op_ids.contains(&kept.op_id));

        let reopened = ActiveProject::open(project_path).unwrap();
        assert_eq!(reopened.state.meta.name, "Kept Name");
        assert!(reopened.history.discarded_op_ids.contains(&discarded.op_id));
        assert!(!reopened.history.applied_op_ids.contains(&discarded.op_id));
        assert!(reopened.history.applied_op_ids.contains(&kept.op_id));
    }

    #[test]
    fn test_active_project_open_recovers_from_invalid_history_and_unsaved_ops() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("history_recovery_project");
        let state_dir = ActiveProject::default_state_dir(&project_path);
        let history_path = ActiveProject::state_history_path(&state_dir);

        let mut project = ActiveProject::create("History Recovery", project_path.clone()).unwrap();
        project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Recovered Name"),
                ),
                &mut project.state,
            )
            .unwrap();
        std::fs::write(&history_path, b"{ this is not valid json").unwrap();
        drop(project);

        let reopened = ActiveProject::open(project_path).unwrap();
        assert_eq!(reopened.state.meta.name, "Recovered Name");
    }

    #[test]
    fn test_active_project_open_uses_history_base_meta_after_persisted_undo_without_save() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("history_base_meta_project");

        let mut project = ActiveProject::create("Base Meta Test", project_path.clone()).unwrap();
        project
            .executor
            .execute(
                Box::new(
                    crate::core::commands::UpdateProjectSettingsCommand::new()
                        .with_name("Updated Name"),
                ),
                &mut project.state,
            )
            .unwrap();
        project.save().unwrap();
        drop(project);

        let mut reopened = ActiveProject::open(project_path.clone()).unwrap();
        reopened.undo_persisted().unwrap();
        drop(reopened);

        let reopened_after_undo = ActiveProject::open(project_path).unwrap();
        assert_eq!(reopened_after_undo.state.meta.name, "Base Meta Test");
    }

    #[test]
    fn test_active_project_open_migrates_legacy_root_state_files() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("legacy_project");

        // Create using current layout, then move files back to legacy root to simulate
        // pre-migration projects.
        let project = ActiveProject::create("Legacy Project", project_path.clone()).unwrap();
        drop(project);

        let state_dir = project_path.join(".openreelio/state");
        std::fs::rename(state_dir.join("ops.jsonl"), project_path.join("ops.jsonl")).unwrap();
        std::fs::rename(
            state_dir.join("project.json"),
            project_path.join("project.json"),
        )
        .unwrap();
        std::fs::rename(
            state_dir.join("snapshot.json"),
            project_path.join("snapshot.json"),
        )
        .unwrap();

        let reopened = ActiveProject::open(project_path.clone()).unwrap();
        assert_eq!(reopened.state.meta.name, "Legacy Project");

        // Legacy files should be moved into hidden state directory.
        assert!(state_dir.join("ops.jsonl").exists());
        assert!(state_dir.join("project.json").exists());
        assert!(state_dir.join("snapshot.json").exists());
        assert!(!project_path.join("ops.jsonl").exists());
        assert!(!project_path.join("project.json").exists());
        assert!(!project_path.join("snapshot.json").exists());
    }

    #[test]
    fn should_read_a_legacy_layout_project_without_migrating_or_locking_it() {
        // Given: a project whose state still sits in the legacy root files
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("read_only_legacy");
        let project = ActiveProject::create("Read Only Legacy", project_path.clone()).unwrap();
        let sequence_id = project.state.active_sequence_id.clone();
        drop(project);

        let state_dir = project_path.join(".openreelio/state");
        for name in ["ops.jsonl", "snapshot.json", "project.json"] {
            std::fs::rename(state_dir.join(name), project_path.join(name)).unwrap();
        }
        std::fs::remove_dir_all(project_path.join(".openreelio")).unwrap();

        // When: reading it without a session
        let state = ActiveProject::read_state_without_session(&project_path).unwrap();

        // Then: the state is the project's, and nothing on disk moved. Opening a
        // session would have migrated all three files and left a lock behind,
        // which is not something a read may do.
        assert_eq!(state.meta.name, "Read Only Legacy");
        assert_eq!(state.active_sequence_id, sequence_id);
        assert!(project_path.join("ops.jsonl").exists());
        assert!(project_path.join("snapshot.json").exists());
        assert!(project_path.join("project.json").exists());
        assert!(!project_path.join(".openreelio").exists());
    }

    #[test]
    fn should_read_a_current_layout_project_without_taking_the_ops_lock() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("read_only_current");
        let project = ActiveProject::create("Read Only Current", project_path.clone()).unwrap();
        drop(project);

        let state_dir = project_path.join(".openreelio/state");
        let lock = state_dir.join("ops.jsonl.lock");
        let _ = std::fs::remove_file(&lock);

        let state = ActiveProject::read_state_without_session(&project_path).unwrap();

        assert_eq!(state.meta.name, "Read Only Current");
        assert!(!state.sequences.is_empty());
        assert!(!lock.exists(), "a read must not create the ops-log lock");
    }

    #[test]
    fn test_active_project_open_prefers_newer_legacy_state_files_when_both_exist() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("legacy_conflict_project");

        let project = ActiveProject::create("Initial Name", project_path.clone()).unwrap();
        drop(project);

        let state_dir = project_path.join(".openreelio/state");
        std::fs::copy(state_dir.join("ops.jsonl"), project_path.join("ops.jsonl")).unwrap();
        std::fs::copy(
            state_dir.join("project.json"),
            project_path.join("project.json"),
        )
        .unwrap();
        std::fs::copy(
            state_dir.join("snapshot.json"),
            project_path.join("snapshot.json"),
        )
        .unwrap();

        let mut legacy_meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(project_path.join("project.json")).unwrap(),
        )
        .unwrap();
        legacy_meta["name"] = serde_json::Value::String("Legacy Preferred".to_string());
        legacy_meta["modifiedAt"] = serde_json::Value::String("2999-01-01T00:00:00Z".to_string());
        std::fs::write(
            project_path.join("project.json"),
            serde_json::to_vec_pretty(&legacy_meta).unwrap(),
        )
        .unwrap();

        let reopened = ActiveProject::open(project_path.clone()).unwrap();
        assert_eq!(reopened.path, project_path);

        let migrated_meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(state_dir.join("project.json")).unwrap())
                .unwrap();
        assert_eq!(migrated_meta["name"], "Legacy Preferred");
        assert_eq!(migrated_meta["modifiedAt"], "2999-01-01T00:00:00Z");

        assert!(!project_path.join("ops.jsonl").exists());
        assert!(!project_path.join("project.json").exists());
        assert!(!project_path.join("snapshot.json").exists());
    }

    #[test]
    fn test_active_project_open_discards_stale_legacy_state_files() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("legacy_stale_project");

        let project = ActiveProject::create("Initial Name", project_path.clone()).unwrap();
        drop(project);

        let state_dir = project_path.join(".openreelio/state");
        std::fs::copy(state_dir.join("ops.jsonl"), project_path.join("ops.jsonl")).unwrap();
        std::fs::copy(
            state_dir.join("project.json"),
            project_path.join("project.json"),
        )
        .unwrap();
        std::fs::copy(
            state_dir.join("snapshot.json"),
            project_path.join("snapshot.json"),
        )
        .unwrap();

        let mut hidden_meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(state_dir.join("project.json")).unwrap())
                .unwrap();
        hidden_meta["name"] = serde_json::Value::String("Hidden Preferred".to_string());
        hidden_meta["modifiedAt"] = serde_json::Value::String("2999-01-01T00:00:00Z".to_string());
        std::fs::write(
            state_dir.join("project.json"),
            serde_json::to_vec_pretty(&hidden_meta).unwrap(),
        )
        .unwrap();

        let reopened = ActiveProject::open(project_path.clone()).unwrap();
        assert_eq!(reopened.path, project_path);

        let persisted_meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(state_dir.join("project.json")).unwrap())
                .unwrap();
        assert_eq!(persisted_meta["name"], "Hidden Preferred");
        assert_eq!(persisted_meta["modifiedAt"], "2999-01-01T00:00:00Z");

        assert!(!project_path.join("ops.jsonl").exists());
        assert!(!project_path.join("project.json").exists());
        assert!(!project_path.join("snapshot.json").exists());
    }

    // =========================================================================
    // SourceMonitorState Tests (S23-001)
    // =========================================================================

    #[test]
    fn test_source_monitor_default_is_empty() {
        let state = SourceMonitorState::default();
        assert!(state.asset_id.is_none());
        assert!(state.in_point.is_none());
        assert!(state.out_point.is_none());
        assert_eq!(state.playhead_sec, 0.0);
        assert!(state.marked_duration().is_none());
    }

    #[test]
    fn test_source_monitor_set_asset_resets_state() {
        let mut state = SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(2.0),
            out_point: Some(8.0),
            playhead_sec: 5.0,
        };

        // Loading a new asset should reset In/Out and playhead
        state.set_asset(Some("asset_002".to_string()));

        assert_eq!(state.asset_id.as_deref(), Some("asset_002"));
        assert!(state.in_point.is_none());
        assert!(state.out_point.is_none());
        assert_eq!(state.playhead_sec, 0.0);
    }

    #[test]
    fn test_source_monitor_clear_resets_state() {
        let mut state = SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(2.0),
            out_point: Some(8.0),
            playhead_sec: 5.0,
        };

        state.clear();

        assert!(state.asset_id.is_none());
        assert!(state.in_point.is_none());
        assert!(state.out_point.is_none());
        assert_eq!(state.playhead_sec, 0.0);
    }

    #[test]
    fn test_source_monitor_marked_duration_both_points_set() {
        let state = SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(1.5),
            out_point: Some(10.0),
            playhead_sec: 0.0,
        };
        assert_eq!(state.marked_duration(), Some(8.5));
    }

    #[test]
    fn test_source_monitor_marked_duration_only_in() {
        let state = SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(1.5),
            out_point: None,
            playhead_sec: 0.0,
        };
        assert!(state.marked_duration().is_none());
    }

    #[test]
    fn test_source_monitor_marked_duration_only_out() {
        let state = SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: None,
            out_point: Some(10.0),
            playhead_sec: 0.0,
        };
        assert!(state.marked_duration().is_none());
    }

    #[test]
    fn test_source_monitor_clear_preserves_playhead() {
        let mut state = SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(2.0),
            out_point: Some(8.0),
            playhead_sec: 4.0,
        };
        state.clear_in_out();

        assert!(state.in_point.is_none());
        assert!(state.out_point.is_none());
        assert_eq!(state.playhead_sec, 4.0);
        assert!(state.marked_duration().is_none());
    }

    #[test]
    fn test_source_monitor_set_in_updates_playhead() {
        let mut state = SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: None,
            out_point: Some(8.0),
            playhead_sec: 0.0,
        };

        state.set_in_point(2.5);

        assert_eq!(state.in_point, Some(2.5));
        assert_eq!(state.playhead_sec, 2.5);
    }

    #[test]
    fn test_source_monitor_set_out_updates_playhead() {
        let mut state = SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(2.0),
            out_point: None,
            playhead_sec: 0.0,
        };

        state.set_out_point(8.5);

        assert_eq!(state.out_point, Some(8.5));
        assert_eq!(state.playhead_sec, 8.5);
    }

    #[test]
    fn test_source_monitor_set_playhead_preserves_marks() {
        let mut state = SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(1.0),
            out_point: Some(6.0),
            playhead_sec: 0.0,
        };

        state.set_playhead(4.25);

        assert_eq!(state.in_point, Some(1.0));
        assert_eq!(state.out_point, Some(6.0));
        assert_eq!(state.playhead_sec, 4.25);
    }

    // =========================================================================
    // External Edit Safety
    //
    // Feature: External edit safety
    //   As an editor who drives OpenReelio from both the GUI and openreelio-cli
    //   I want the app to notice when another process edited the same project
    //   So that my CLI edits are never silently overwritten
    // =========================================================================

    /// Executes a command the way the CLI does: parse the JSON payload, build
    /// the command, then run it through the project's executor.
    fn execute_cli_command(
        project: &mut ActiveProject,
        command_type: &str,
        payload: serde_json::Value,
    ) -> crate::core::commands::CommandResult {
        let parsed = crate::ipc::CommandPayload::parse(command_type.to_string(), payload)
            .unwrap_or_else(|error| panic!("failed to parse {command_type} payload: {error}"));
        let command = parsed.build_command(&project.path);
        project
            .executor
            .execute(command, &mut project.state)
            .unwrap_or_else(|error| panic!("failed to execute {command_type}: {error}"))
    }

    fn base_track_id(project: &ActiveProject, kind: crate::core::timeline::TrackKind) -> String {
        let sequence_id = project
            .state
            .active_sequence_id
            .clone()
            .expect("project should have an active sequence");
        project.state.sequences[&sequence_id]
            .tracks
            .iter()
            .find(|track| track.kind == kind)
            .unwrap_or_else(|| panic!("sequence should have a {kind:?} track"))
            .id
            .clone()
    }

    fn count_clips(project: &ActiveProject, track_id: &str) -> usize {
        project
            .state
            .sequences
            .values()
            .flat_map(|sequence| sequence.tracks.iter())
            .find(|track| track.id == track_id)
            .map(|track| track.clips.len())
            .unwrap_or(0)
    }

    /// A project built exactly the way `openreelio-cli` builds one.
    struct CliBuiltProject {
        project: ActiveProject,
        sequence_id: String,
        video_track_id: String,
        caption_track_id: String,
    }

    fn build_project_like_cli(project_path: PathBuf) -> CliBuiltProject {
        std::fs::create_dir_all(&project_path).unwrap();
        let media_path = project_path.join("footage.mp4");
        std::fs::write(&media_path, b"fake media bytes").unwrap();

        let mut project = ActiveProject::create("CLI Project", project_path).unwrap();
        let sequence_id = project.state.active_sequence_id.clone().unwrap();
        let video_track_id = base_track_id(&project, crate::core::timeline::TrackKind::Video);

        let import = execute_cli_command(
            &mut project,
            "importAsset",
            serde_json::json!({
                "name": "footage.mp4",
                "uri": media_path.to_string_lossy(),
            }),
        );
        let asset_id = import.created_ids[0].clone();

        execute_cli_command(
            &mut project,
            "insertClip",
            serde_json::json!({
                "sequenceId": sequence_id,
                "trackId": video_track_id,
                "assetId": asset_id,
                "timelineStart": 0.0,
                "sourceIn": 0.0,
                "sourceOut": 12.0,
            }),
        );

        let clip_id = project.state.sequences[&sequence_id]
            .tracks
            .iter()
            .find(|track| track.id == video_track_id)
            .unwrap()
            .clips[0]
            .id
            .clone();

        execute_cli_command(
            &mut project,
            "splitClip",
            serde_json::json!({
                "sequenceId": sequence_id,
                "trackId": video_track_id,
                "clipId": clip_id,
                "splitTime": 5.0,
            }),
        );

        execute_cli_command(
            &mut project,
            "trimClip",
            serde_json::json!({
                "sequenceId": sequence_id,
                "trackId": video_track_id,
                "clipId": clip_id,
                "newSourceOut": 4.0,
            }),
        );

        execute_cli_command(
            &mut project,
            "addEffect",
            serde_json::json!({
                "sequenceId": sequence_id,
                "trackId": video_track_id,
                "clipId": clip_id,
                "effectType": "brightness",
            }),
        );

        let caption_track = execute_cli_command(
            &mut project,
            "createTrack",
            serde_json::json!({
                "sequenceId": sequence_id,
                "kind": "caption",
                "name": "Captions 1",
            }),
        );
        let caption_track_id = caption_track.created_ids[0].clone();

        execute_cli_command(
            &mut project,
            "createCaption",
            serde_json::json!({
                "sequenceId": sequence_id,
                "trackId": caption_track_id,
                "text": "Hello from the CLI",
                "startSec": 1.0,
                "endSec": 3.0,
            }),
        );

        CliBuiltProject {
            project,
            sequence_id,
            video_track_id,
            caption_track_id,
        }
    }

    /// Scenario: a project built purely through CLI-style commands opens in the GUI.
    #[test]
    fn should_open_a_cli_built_project_with_identical_state() {
        // Given a project created and edited only through CommandPayload/executor
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("cli_built");
        let CliBuiltProject {
            mut project,
            sequence_id,
            video_track_id,
            caption_track_id,
        } = build_project_like_cli(project_path.clone());

        let expected_video_clips = count_clips(&project, &video_track_id);
        let expected_caption_clips = count_clips(&project, &caption_track_id);
        let expected_assets = project.state.assets.len();
        let expected_effects = project.state.effects.len();
        assert_eq!(expected_video_clips, 2, "split should produce two clips");
        assert_eq!(expected_caption_clips, 1);
        assert_eq!(expected_assets, 1);
        assert_eq!(expected_effects, 1);

        // And the CLI saved it the way `openreelio-cli` does
        project.save().unwrap();
        drop(project);

        // When the GUI opens the same directory
        let reopened = ActiveProject::open(project_path).unwrap();

        // Then the replayed state matches, with no operations lost
        assert_eq!(reopened.state.meta.name, "CLI Project");
        assert!(reopened.state.sequences.contains_key(&sequence_id));
        assert_eq!(
            count_clips(&reopened, &video_track_id),
            expected_video_clips
        );
        assert_eq!(
            count_clips(&reopened, &caption_track_id),
            expected_caption_clips
        );
        assert_eq!(reopened.state.assets.len(), expected_assets);
        assert_eq!(reopened.state.effects.len(), expected_effects);
        assert!(!reopened.state.is_dirty);
    }

    /// Scenario: the CLI never got to save; only the append-only log survives.
    #[test]
    fn should_open_a_cli_built_project_from_the_ops_log_without_a_save() {
        // Given a CLI session that appended operations but never saved
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("cli_unsaved");
        let built = build_project_like_cli(project_path.clone());
        let expected_video_clips = count_clips(&built.project, &built.video_track_id);
        let expected_caption_clips = count_clips(&built.project, &built.caption_track_id);
        let video_track_id = built.video_track_id.clone();
        let caption_track_id = built.caption_track_id.clone();
        drop(built);

        // When the GUI opens the same directory
        let reopened = ActiveProject::open(project_path).unwrap();

        // Then the state is rebuilt from the ops log alone
        assert_eq!(
            count_clips(&reopened, &video_track_id),
            expected_video_clips
        );
        assert_eq!(
            count_clips(&reopened, &caption_track_id),
            expected_caption_clips
        );
        assert_eq!(reopened.state.effects.len(), 1);
    }

    /// Scenario: a second process appends while this session holds the project.
    #[test]
    fn should_detect_external_ops_and_refuse_mutations_until_reload() {
        // Given a GUI session with one edit of its own
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("shared_project");
        std::fs::create_dir_all(&project_path).unwrap();
        let mut gui = ActiveProject::create("Shared Project", project_path.clone()).unwrap();
        let sequence_id = gui.state.active_sequence_id.clone().unwrap();
        let gui_track = execute_cli_command(
            &mut gui,
            "createTrack",
            serde_json::json!({
                "sequenceId": sequence_id,
                "kind": "video",
                "name": "GUI Track",
            }),
        );
        let gui_track_id = gui_track.created_ids[0].clone();
        gui.ensure_no_external_changes()
            .expect("this session's own appends are not external changes");

        // When another process (openreelio-cli) opens the same project and edits it
        let mut cli = ActiveProject::open(project_path.clone()).unwrap();
        let cli_track = execute_cli_command(
            &mut cli,
            "createTrack",
            serde_json::json!({
                "sequenceId": sequence_id,
                "kind": "audio",
                "name": "CLI Track",
            }),
        );
        let cli_track_id = cli_track.created_ids[0].clone();
        cli.save().unwrap();
        drop(cli);

        // Then every mutating entry point in the stale session refuses to run
        assert!(
            matches!(
                gui.ensure_no_external_changes(),
                Err(crate::core::CoreError::ExternalChangeDetected { .. })
            ),
            "the guard used by execute_command must report the external change"
        );
        assert!(matches!(
            gui.prepare_save(),
            Err(crate::core::CoreError::ExternalChangeDetected { .. })
        ));
        assert!(matches!(
            gui.undo_persisted(),
            Err(crate::core::CoreError::ExternalChangeDetected { .. })
        ));
        assert!(matches!(
            gui.redo_persisted(),
            Err(crate::core::CoreError::ExternalChangeDetected { .. })
        ));

        // And the error message carries the marker the frontend matches on
        let message = gui.ensure_no_external_changes().unwrap_err().to_ipc_error();
        assert!(
            message.contains(crate::core::EXTERNAL_CHANGE_DETECTED_CODE),
            "unexpected message: {message}"
        );

        // And reloading from disk recovers with both sessions' edits visible
        let reloaded = ActiveProject::open(project_path).unwrap();
        let track_ids: Vec<&str> = reloaded.state.sequences[&sequence_id]
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect();
        assert!(track_ids.contains(&gui_track_id.as_str()));
        assert!(track_ids.contains(&cli_track_id.as_str()));
        reloaded
            .ensure_no_external_changes()
            .expect("a freshly reloaded session is in sync with disk");
    }

    /// Scenario: a second process undoes, which appends nothing.
    ///
    /// `ops.jsonl` is append-only, so undo/redo/jump record their move in
    /// `history.json` instead. A session that watched only the log's byte length
    /// would see nothing here and keep editing on top of a history position the
    /// other process had already left, silently reverting it.
    #[test]
    fn should_detect_an_external_history_move_that_appends_nothing() {
        // Given a session that edited and saved
        let temp_dir = TempDir::new().unwrap();
        let (mut gui, fixture) = create_shared_project(temp_dir.path().join("shared_project"));
        let gui_track = execute_cli_command(
            &mut gui,
            "createTrack",
            serde_json::json!({
                "sequenceId": fixture.sequence_id,
                "kind": "video",
                "name": "GUI Track",
            }),
        );
        let gui_track_id = gui_track.created_ids[0].clone();
        gui.save().unwrap();
        let ops_log_len_before = std::fs::metadata(gui.ops_log.path()).unwrap().len();

        // When another process undoes it
        let mut other_process = ActiveProject::open(fixture.project_path.clone()).unwrap();
        let undone_op_id = other_process.undo_persisted().unwrap();
        drop(other_process);

        // Then the log is byte-identical and the operation counts still agree,
        // so only a history baseline can tell the difference
        assert_eq!(
            std::fs::metadata(gui.ops_log.path()).unwrap().len(),
            ops_log_len_before
        );
        assert_eq!(gui.on_disk_op_count().unwrap(), gui.expected_op_count());

        // And every mutating entry point refuses
        assert!(matches!(
            gui.ensure_no_external_changes(),
            Err(crate::core::CoreError::ExternalHistoryChangeDetected)
        ));
        assert!(matches!(
            try_execute_command(
                &mut gui,
                "createSequence",
                serde_json::json!({ "name": "Sequence 2", "format": "1080p" }),
            ),
            Err(crate::core::CoreError::ExternalHistoryChangeDetected)
        ));
        assert!(matches!(
            gui.prepare_save(),
            Err(crate::core::CoreError::ExternalHistoryChangeDetected)
        ));
        assert!(matches!(
            gui.undo_persisted(),
            Err(crate::core::CoreError::ExternalHistoryChangeDetected)
        ));
        assert!(matches!(
            gui.redo_persisted(),
            Err(crate::core::CoreError::ExternalHistoryChangeDetected)
        ));
        assert!(matches!(
            gui.jump_to_history_index_persisted(-1),
            Err(crate::core::CoreError::ExternalHistoryChangeDetected)
        ));

        // And the error carries the marker the frontend matches on
        let message = gui.ensure_no_external_changes().unwrap_err().to_ipc_error();
        assert!(
            message.contains(crate::core::EXTERNAL_CHANGE_DETECTED_CODE),
            "unexpected message: {message}"
        );

        // And reloading adopts the other process's undo instead of reverting it
        drop(gui);
        let reloaded = ActiveProject::open(fixture.project_path).unwrap();
        assert!(!reloaded.history.applied_op_ids.contains(&undone_op_id));
        assert!(!reloaded.state.sequences[&fixture.sequence_id]
            .tracks
            .iter()
            .any(|track| track.id == gui_track_id));
        reloaded
            .ensure_no_external_changes()
            .expect("a freshly reloaded session is in sync with disk");
    }

    /// Scenario: the app's own workspace-watcher appends must not look external.
    #[test]
    fn should_not_report_direct_ops_log_appends_by_this_session_as_external() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("watcher_project");
        let mut project = ActiveProject::create("Watcher Project", project_path).unwrap();

        // The workspace watcher writes through `project.ops_log` rather than the
        // executor; that path must also be attributed to this session.
        let operation = crate::core::project::Operation::new(
            crate::core::project::OpKind::AssetUpdate,
            serde_json::json!({ "assetId": "asset_001" }),
        );
        project.ops_log.append(&operation).unwrap();

        project
            .ensure_no_external_changes()
            .expect("direct ops log appends by this session are not external");
        project
            .prepare_save()
            .expect("save should still be allowed");
    }

    // -------------------------------------------------------------------------
    // Structural coverage
    //
    // The guard lives in `OpsLog::append`, the one place the product writes
    // ops.jsonl, rather than at the ~25 IPC commands that reach it. These tests
    // exercise a spread of those surfaces *without* calling
    // `ensure_no_external_changes` first, which is exactly what the real
    // commands do, so they fail if the guard ever regresses to a per-call-site
    // opt-in.
    // -------------------------------------------------------------------------

    /// Runs a command through the executor the way the IPC layer does, keeping
    /// the error instead of panicking.
    fn try_execute_command(
        project: &mut ActiveProject,
        command_type: &str,
        payload: serde_json::Value,
    ) -> crate::core::CoreResult<crate::core::commands::CommandResult> {
        let parsed = crate::ipc::CommandPayload::parse(command_type.to_string(), payload)
            .unwrap_or_else(|error| panic!("failed to parse {command_type} payload: {error}"));
        let command = parsed.build_command(&project.path);
        project.executor.execute(command, &mut project.state)
    }

    /// One mutation surface, reproduced the way its IPC command performs it.
    struct MutationPath {
        /// The IPC command this stands in for.
        surface: &'static str,
        /// Performs the mutation and reports only whether it was allowed.
        run: fn(&mut ActiveProject, &SharedProjectFixture) -> crate::core::CoreResult<()>,
    }

    /// Ids and paths the mutation surfaces need to build valid payloads.
    struct SharedProjectFixture {
        project_path: PathBuf,
        sequence_id: String,
        media_path: PathBuf,
    }

    /// A representative slice of the product's project-mutating surfaces.
    ///
    /// Between them they cover all four channels that reach the ops log:
    /// `executor.execute`, repeated `executor.execute` inside a plan,
    /// `executor.execute_without_history`, and a direct `ops_log.append`.
    fn mutation_paths() -> Vec<MutationPath> {
        vec![
            MutationPath {
                // ipc::commands::asset::import_asset
                surface: "import asset",
                run: |project, fixture| {
                    try_execute_command(
                        project,
                        "importAsset",
                        serde_json::json!({
                            "name": "late.mp4",
                            "uri": fixture.media_path.to_string_lossy(),
                        }),
                    )
                    .map(|_| ())
                },
            },
            MutationPath {
                // ipc::commands::agent::execute_agent_plan
                surface: "agent plan",
                run: |project, fixture| {
                    for name in ["Plan Track A", "Plan Track B"] {
                        try_execute_command(
                            project,
                            "createTrack",
                            serde_json::json!({
                                "sequenceId": fixture.sequence_id,
                                "kind": "video",
                                "name": name,
                            }),
                        )?;
                    }
                    Ok(())
                },
            },
            MutationPath {
                // ipc::commands::timeline::create_sequence
                surface: "create sequence",
                run: |project, _fixture| {
                    try_execute_command(
                        project,
                        "createSequence",
                        serde_json::json!({ "name": "Sequence 2", "format": "1080p" }),
                    )
                    .map(|_| ())
                },
            },
            MutationPath {
                // ipc::commands::asset::update_asset_proxy (background metadata)
                surface: "system update without history",
                run: |project, _fixture| {
                    project
                        .executor
                        .execute_without_history(
                            Box::new(
                                crate::core::commands::UpdateProjectSettingsCommand::new()
                                    .with_name("Renamed By System"),
                            ),
                            &mut project.state,
                        )
                        .map(|_| ())
                },
            },
            MutationPath {
                // ipc::commands::workspace::record_workspace_operation
                surface: "workspace auto-registration",
                run: |project, _fixture| {
                    project
                        .ops_log
                        .append(&crate::core::project::Operation::new(
                            crate::core::project::OpKind::AssetImport,
                            serde_json::json!({ "assetId": "workspace_asset" }),
                        ))
                },
            },
        ]
    }

    /// Creates a project plus a media file the import surface can reference.
    fn create_shared_project(project_path: PathBuf) -> (ActiveProject, SharedProjectFixture) {
        std::fs::create_dir_all(&project_path).unwrap();
        let media_path = project_path.join("late.mp4");
        std::fs::write(&media_path, b"fake media bytes").unwrap();

        let project = ActiveProject::create("Shared Project", project_path.clone()).unwrap();
        let sequence_id = project.state.active_sequence_id.clone().unwrap();

        (
            project,
            SharedProjectFixture {
                project_path,
                sequence_id,
                media_path,
            },
        )
    }

    /// Appends an operation from a second process holding the same directory.
    fn append_external_edit(fixture: &SharedProjectFixture) -> String {
        let mut other_process = ActiveProject::open(fixture.project_path.clone()).unwrap();
        let result = execute_cli_command(
            &mut other_process,
            "createTrack",
            serde_json::json!({
                "sequenceId": fixture.sequence_id,
                "kind": "audio",
                "name": "External Track",
            }),
        );
        other_process.save().unwrap();
        result.created_ids[0].clone()
    }

    /// Scenario: every mutation surface is refused, not just `execute_command`.
    #[test]
    fn should_refuse_every_mutation_surface_after_an_external_edit() {
        for path in mutation_paths() {
            // Given a session that has gone stale behind another process
            let temp_dir = TempDir::new().unwrap();
            let (mut project, fixture) =
                create_shared_project(temp_dir.path().join("shared_project"));
            append_external_edit(&fixture);

            let ops_before = project.on_disk_op_count().unwrap();
            let assets_before = project.state.assets.len();
            let sequences_before = project.state.sequences.len();
            let name_before = project.state.meta.name.clone();

            // When the surface mutates without checking for external edits first
            let outcome = (path.run)(&mut project, &fixture);

            // Then it is refused
            assert!(
                matches!(
                    outcome,
                    Err(crate::core::CoreError::ExternalChangeDetected { .. })
                ),
                "{} must be refused after an external edit, got {outcome:?}",
                path.surface
            );
            // And nothing was appended on top of the external operations
            assert_eq!(
                project.on_disk_op_count().unwrap(),
                ops_before,
                "{} must not append after an external edit",
                path.surface
            );
            // And the in-memory state was not left half-applied
            assert_eq!(
                project.state.assets.len(),
                assets_before,
                "{}",
                path.surface
            );
            assert_eq!(
                project.state.sequences.len(),
                sequences_before,
                "{}",
                path.surface
            );
            assert_eq!(project.state.meta.name, name_before, "{}", path.surface);
        }
    }

    /// Undoes from a second process holding the same directory, which rewrites
    /// `history.json` without appending to the log. Returns the undone op id.
    fn undo_externally(fixture: &SharedProjectFixture) -> String {
        let mut other_process = ActiveProject::open(fixture.project_path.clone()).unwrap();
        other_process.undo_persisted().unwrap()
    }

    /// Scenario: every mutation surface is refused after an external *history*
    /// move too, not just after an external append.
    #[test]
    fn should_refuse_every_mutation_surface_after_an_external_history_move() {
        for path in mutation_paths() {
            // Given a session that has edited and saved, so there is something
            // for another process to undo
            let temp_dir = TempDir::new().unwrap();
            let (mut project, fixture) =
                create_shared_project(temp_dir.path().join("shared_project"));
            try_execute_command(
                &mut project,
                "createTrack",
                serde_json::json!({
                    "sequenceId": fixture.sequence_id,
                    "kind": "video",
                    "name": "Undo Me",
                }),
            )
            .unwrap();
            project.save().unwrap();

            // And another process has undone it behind this session's back
            undo_externally(&fixture);

            let ops_before = project.on_disk_op_count().unwrap();
            let assets_before = project.state.assets.len();
            let sequences_before = project.state.sequences.len();
            let name_before = project.state.meta.name.clone();

            // When the surface mutates without checking for external edits first
            let outcome = (path.run)(&mut project, &fixture);

            // Then it is refused, even though the operation counts still agree
            assert!(
                matches!(
                    outcome,
                    Err(crate::core::CoreError::ExternalHistoryChangeDetected)
                ),
                "{} must be refused after an external history move, got {outcome:?}",
                path.surface
            );
            assert_eq!(
                project.on_disk_op_count().unwrap(),
                ops_before,
                "{} must not append on top of an external history move",
                path.surface
            );
            assert_eq!(
                project.state.assets.len(),
                assets_before,
                "{}",
                path.surface
            );
            assert_eq!(
                project.state.sequences.len(),
                sequences_before,
                "{}",
                path.surface
            );
            assert_eq!(project.state.meta.name, name_before, "{}", path.surface);
        }
    }

    /// Scenario: reloading re-baselines the session so editing resumes.
    #[test]
    fn should_resume_every_mutation_surface_after_reloading_from_disk() {
        for path in mutation_paths() {
            // Given a stale session that has already been refused once
            let temp_dir = TempDir::new().unwrap();
            let (mut project, fixture) =
                create_shared_project(temp_dir.path().join("shared_project"));
            let external_track_id = append_external_edit(&fixture);
            assert!((path.run)(&mut project, &fixture).is_err());

            // When the user reloads, the way `reload_project_from_disk` does
            drop(project);
            let mut reloaded = ActiveProject::open(fixture.project_path.clone()).unwrap();

            // Then the external edit is present
            assert!(
                reloaded.state.sequences[&fixture.sequence_id]
                    .tracks
                    .iter()
                    .any(|track| track.id == external_track_id),
                "{}: reload should surface the external edit",
                path.surface
            );
            // And the same surface now succeeds against the fresh watermark
            (path.run)(&mut reloaded, &fixture)
                .unwrap_or_else(|error| panic!("{} after reload: {error}", path.surface));
            reloaded
                .prepare_save()
                .unwrap_or_else(|error| panic!("{} save after reload: {error}", path.surface));
        }
    }

    // -------------------------------------------------------------------------
    // Headless writers
    //
    // `openreelio-cli` is not exempt from the guard: every invocation goes
    // through `ActiveProject::open`, which installs it. What makes headless
    // editing keep working is the shape of an invocation — open, mutate, save,
    // exit — so a *sequential* writer always baselines against the current tail
    // and appends onto it. Only a writer that overlaps in time with another one
    // is refused, which is the case that would otherwise write a snapshot built
    // from a state that never saw the other process's operations.
    // -------------------------------------------------------------------------

    /// Scenario: headless invocations run one after another, as they normally do.
    #[test]
    fn should_let_each_sequential_headless_session_append_after_the_previous_one() {
        // Given a project a long-lived GUI session already edited
        let temp_dir = TempDir::new().unwrap();
        let (mut gui, fixture) = create_shared_project(temp_dir.path().join("headless_project"));
        execute_cli_command(
            &mut gui,
            "createTrack",
            serde_json::json!({
                "sequenceId": fixture.sequence_id,
                "kind": "video",
                "name": "GUI Track",
            }),
        );
        gui.save().unwrap();

        // When openreelio-cli runs three times, each a fresh open/edit/save
        for index in 0..3 {
            let mut cli = ActiveProject::open(fixture.project_path.clone()).unwrap();
            try_execute_command(
                &mut cli,
                "createTrack",
                serde_json::json!({
                    "sequenceId": fixture.sequence_id,
                    "kind": "audio",
                    "name": format!("CLI Track {index}"),
                }),
            )
            .unwrap_or_else(|error| panic!("headless invocation {index} was blocked: {error}"));
            cli.save()
                .unwrap_or_else(|error| panic!("headless save {index} was blocked: {error}"));
        }

        // Then every headless edit landed
        let reloaded = ActiveProject::open(fixture.project_path).unwrap();
        let track_names: Vec<&str> = reloaded.state.sequences[&fixture.sequence_id]
            .tracks
            .iter()
            .map(|track| track.name.as_str())
            .collect();
        for index in 0..3 {
            assert!(
                track_names.contains(&format!("CLI Track {index}").as_str()),
                "missing headless edit {index} in {track_names:?}"
            );
        }

        // And the guard applied to them as much as to anyone: the session that
        // stayed open through all three is the one that now has to reload
        assert!(matches!(
            gui.ensure_no_external_changes(),
            Err(crate::core::CoreError::ExternalChangeDetected { .. })
        ));
    }

    /// Scenario: two writers hold the same project at the same time.
    #[test]
    fn should_reject_a_concurrent_headless_writer_until_it_reopens() {
        // Given two sessions that opened the project before either of them wrote
        let temp_dir = TempDir::new().unwrap();
        let (mut first, fixture) =
            create_shared_project(temp_dir.path().join("concurrent_project"));
        let mut second = ActiveProject::open(fixture.project_path.clone()).unwrap();

        // When the first one edits and saves
        try_execute_command(
            &mut first,
            "createTrack",
            serde_json::json!({
                "sequenceId": fixture.sequence_id,
                "kind": "video",
                "name": "First Writer",
            }),
        )
        .unwrap();
        first.save().unwrap();

        // Then the second one is refused rather than interleaved. Letting it
        // through would append onto a log it has not replayed and then save a
        // snapshot built from a state that never saw the first writer's
        // operation.
        let ops_before = second.on_disk_op_count().unwrap();
        assert!(matches!(
            try_execute_command(
                &mut second,
                "createTrack",
                serde_json::json!({
                    "sequenceId": fixture.sequence_id,
                    "kind": "audio",
                    "name": "Second Writer",
                }),
            ),
            Err(crate::core::CoreError::ExternalChangeDetected { .. })
        ));
        assert_eq!(second.on_disk_op_count().unwrap(), ops_before);

        // And reopening — which is what a headless invocation does anyway — puts
        // it back in sync, so the retry lands on top of the first writer's edit
        drop(second);
        let mut reopened = ActiveProject::open(fixture.project_path.clone()).unwrap();
        try_execute_command(
            &mut reopened,
            "createTrack",
            serde_json::json!({
                "sequenceId": fixture.sequence_id,
                "kind": "audio",
                "name": "Second Writer",
            }),
        )
        .unwrap();
        reopened.save().unwrap();
        drop(reopened);

        let reloaded = ActiveProject::open(fixture.project_path).unwrap();
        let track_names: Vec<&str> = reloaded.state.sequences[&fixture.sequence_id]
            .tracks
            .iter()
            .map(|track| track.name.as_str())
            .collect();
        assert!(track_names.contains(&"First Writer"));
        assert!(track_names.contains(&"Second Writer"));
    }
}

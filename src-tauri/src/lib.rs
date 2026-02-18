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

// NOTE: Unit tests in this repository intentionally avoid linking the Tauri runtime.
// On some Windows environments, dynamic dependencies of the webview stack can prevent
// the Rust test harness from starting.
//
// Core business logic is tested without Tauri; the Tauri app entrypoint is compiled
// only for non-test builds.
#[cfg(not(test))]
use std::sync::OnceLock;
#[cfg(not(test))]
use tauri::Manager;
#[cfg(not(test))]
use tokio::sync::Mutex;

use crate::core::{
    commands::CommandExecutor,
    project::{OpsLog, ProjectMeta, ProjectState, Snapshot},
};

#[cfg(not(test))]
use crate::core::{
    ai::AIGateway,
    jobs::WorkerPool,
    performance::memory::{CacheManager, MemoryPool},
    search::meilisearch::SearchService,
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
    /// Project state (in-memory)
    pub state: ProjectState,
    /// Command executor with undo/redo
    pub executor: CommandExecutor,
    /// Operations log path
    pub ops_log: OpsLog,
}

impl ActiveProject {
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

        // Start with empty state - default sequence will be added via Command
        let mut state = ProjectState::new_empty(name);

        // Create OpsLog instances - one for ActiveProject, one for executor
        // Both point to the same file but operate independently
        // This is safe because OpsLog performs atomic appends
        let ops_log = OpsLog::new(&ops_path);
        let mut executor = CommandExecutor::with_ops_log(OpsLog::new(&ops_path));

        // Create default sequence via Command to ensure ops log recording
        // This maintains Event Sourcing principle: all changes go through commands
        let default_sequence_cmd = CreateSequenceCommand::new("Sequence 1", "1080p");
        executor.execute(Box::new(default_sequence_cmd), &mut state)?;

        // Clear undo history so users can't accidentally undo the initial setup
        // The operation is still recorded in ops.jsonl for recovery purposes
        executor.clear_history();

        // Save initial snapshot (includes the default sequence from command)
        Snapshot::save(&snapshot_path, &state, state.last_op_id.as_deref())?;

        // Save project metadata
        crate::core::fs::atomic_write_json_pretty(&meta_path, &state.meta)?;

        Ok(Self {
            path,
            state_dir,
            meta_path,
            snapshot_path,
            state,
            executor,
            ops_log,
        })
    }

    /// Opens an existing project
    pub fn open(path: PathBuf) -> crate::core::CoreResult<Self> {
        let state_dir = Self::default_state_dir(&path);
        std::fs::create_dir_all(&state_dir)?;

        let mut ops_path = Self::state_ops_path(&state_dir);
        let mut snapshot_path = Self::state_snapshot_path(&state_dir);
        let mut meta_path = Self::state_meta_path(&state_dir);

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

        // Load state from snapshot + replay ops, or from ops log alone
        let ops_log = OpsLog::new(&ops_path);
        let state = if Snapshot::exists(&snapshot_path) {
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

        // Create executor with its own OpsLog instance (both point to same file)
        let executor = CommandExecutor::with_ops_log(OpsLog::new(&ops_path));

        Ok(Self {
            path,
            state_dir,
            meta_path,
            snapshot_path,
            state,
            executor,
            ops_log,
        })
    }

    /// Saves the project state
    ///
    /// After a successful save, the `is_dirty` flag is reset to `false`.
    /// This ensures the project can be closed or replaced without warnings.
    pub fn save(&mut self) -> crate::core::CoreResult<()> {
        // Save snapshot
        Snapshot::save(
            &self.snapshot_path,
            &self.state,
            self.state.last_op_id.as_deref(),
        )?;

        // Save project metadata
        crate::core::fs::atomic_write_json_pretty(&self.meta_path, &self.state.meta)?;

        // Reset dirty flag after successful save
        self.state.is_dirty = false;
        tracing::debug!("Project saved successfully, is_dirty reset to false");

        Ok(())
    }
}

/// Application state shared across all commands
#[cfg(not(test))]
pub struct AppState {
    /// Currently active project (if any)
    pub project: Mutex<Option<ActiveProject>>,
    /// Background job worker pool
    pub job_pool: Mutex<WorkerPool>,
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
}

#[cfg(not(test))]
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

#[cfg(not(test))]
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

#[cfg(not(test))]
impl AppState {
    /// Creates a new empty app state
    pub fn new() -> Self {
        Self {
            project: Mutex::new(None),
            job_pool: Mutex::new(WorkerPool::with_defaults()),
            memory_pool: Mutex::new(MemoryPool::new()),
            cache_manager: Mutex::new(CacheManager::new()),
            ai_gateway: Mutex::new(AIGateway::with_defaults()),
            search_service: Mutex::new(None),
            app_handle: OnceLock::new(),
            credential_vault: Mutex::new(None),
            playback_sync: Mutex::new(PlaybackSyncState::default()),
        }
    }

    /// Stores the app handle for later use (best-effort, idempotent).
    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        let _ = self.app_handle.set(handle);
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
}

#[cfg(not(test))]
impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Tauri Application Entry Point
// =============================================================================
#[cfg(not(test))]
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
                $crate::ipc::set_playhead_position,
                $crate::ipc::get_playhead_position,
                // Project commands
                $crate::ipc::create_project,
                $crate::ipc::open_project,
                $crate::ipc::open_or_init_project,
                $crate::ipc::close_project,
                $crate::ipc::save_project,
                $crate::ipc::get_project_info,
                $crate::ipc::get_project_state,
                // Asset commands
                $crate::ipc::import_asset,
                $crate::ipc::get_assets,
                $crate::ipc::remove_asset,
                $crate::ipc::generate_asset_thumbnail,
                $crate::ipc::generate_proxy_for_asset,
                $crate::ipc::update_asset_proxy,
                // Timeline commands
                $crate::ipc::get_sequences,
                $crate::ipc::create_sequence,
                $crate::ipc::get_sequence,
                // Edit commands
                $crate::ipc::execute_command,
                $crate::ipc::undo,
                $crate::ipc::redo,
                $crate::ipc::can_undo,
                $crate::ipc::can_redo,
                // Job commands
                $crate::ipc::get_jobs,
                $crate::ipc::submit_job,
                $crate::ipc::get_job,
                $crate::ipc::cancel_job,
                $crate::ipc::get_job_stats,
                // Render commands
                $crate::ipc::start_render,
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
                // FFmpeg commands
                $crate::core::ffmpeg::check_ffmpeg,
                $crate::core::ffmpeg::extract_frame,
                $crate::core::ffmpeg::generate_thumbnail,
                $crate::core::ffmpeg::probe_media,
                $crate::core::ffmpeg::generate_waveform,
                // Performance/Memory commands
                $crate::ipc::get_memory_stats,
                $crate::ipc::trigger_memory_cleanup,
                // Transcription commands
                $crate::ipc::is_transcription_available,
                $crate::ipc::transcribe_asset,
                $crate::ipc::submit_transcription_job,
                // Search commands
                $crate::ipc::search_assets,
                $crate::ipc::is_meilisearch_available,
                $crate::ipc::search_content,
                $crate::ipc::index_asset_for_search,
                $crate::ipc::index_transcripts_for_search,
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
                // Workspace commands
                $crate::ipc::scan_workspace,
                $crate::ipc::get_workspace_tree,
                $crate::ipc::register_workspace_file,
                $crate::ipc::register_workspace_files,
            ]
        };
    }

    /// Initialize and run the Tauri application
    #[cfg_attr(mobile, tauri::mobile_entry_point)]
    pub fn run() {
        // Create shared FFmpeg state
        let ffmpeg_state = create_ffmpeg_state();

        let builder = tauri::Builder::default()
            .manage(AppState::new())
            .manage(ffmpeg_state.clone())
            .plugin(tauri_plugin_dialog::init());

        // The updater requires valid signing keys and a release manifest endpoint.
        // In local MSI distribution mode we disable it by default to avoid noisy
        // startup errors and confusing UX.
        let builder = if std::env::var("OPENREELIO_ENABLE_UPDATER").ok().as_deref() == Some("1") {
            builder.plugin(tauri_plugin_updater::Builder::new().build())
        } else {
            builder
        };

        let result = builder.setup(move |app| {
            // Initialize logging (safe to call multiple times).
            init_logging(app.handle());

            tracing::info!("OpenReelio starting...");

            // Capture AppHandle for commands and configure base asset protocol scope.
            // The static scope in `tauri.conf.json` is deliberately minimal; we extend it at runtime
            // only for opened projects and imported assets.
            let app_state: tauri::State<'_, AppState> = app.state();
            app_state.set_app_handle(app.handle().clone());

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

            // Initialize FFmpeg
            let ffmpeg = ffmpeg_state.clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut state = ffmpeg.write().await;
                match state.initialize(Some(&handle)) {
                    Ok(()) => {
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

                // Spawn workers using the cloned Arc references
                tauri::async_runtime::spawn(async move {
                    // Wait for FFmpeg to initialize
                    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;

                    // Start worker tasks that consume from the queue
                    crate::core::jobs::start_workers_with_arcs(
                        queue_arc,
                        active_jobs_arc,
                        num_workers,
                        ffmpeg_for_workers,
                        app_handle_for_workers,
                        cache_dir,
                        shutdown_clone,
                    );

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
            ipc::set_playhead_position,
            ipc::get_playhead_position,
            // Project commands
            ipc::create_project,
            ipc::open_project,
            ipc::open_or_init_project,
            ipc::close_project,
            ipc::save_project,
            ipc::get_project_info,
            ipc::get_project_state,
            // Asset commands
            ipc::import_asset,
            ipc::get_assets,
            ipc::remove_asset,
            ipc::generate_asset_thumbnail,
            ipc::generate_proxy_for_asset,
            ipc::update_asset_proxy,
            // Timeline commands
            ipc::get_sequences,
            ipc::create_sequence,
            ipc::get_sequence,
            // Edit commands
            ipc::execute_command,
            ipc::undo,
            ipc::redo,
            ipc::can_undo,
            ipc::can_redo,
            // Job commands
            ipc::get_jobs,
            ipc::submit_job,
            ipc::get_job,
            ipc::cancel_job,
            ipc::get_job_stats,
            // Render commands
            ipc::start_render,
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
            // FFmpeg commands
            crate::core::ffmpeg::check_ffmpeg,
            crate::core::ffmpeg::extract_frame,
            crate::core::ffmpeg::generate_thumbnail,
            crate::core::ffmpeg::probe_media,
            crate::core::ffmpeg::generate_waveform,
            // Performance/Memory commands
            ipc::get_memory_stats,
            ipc::trigger_memory_cleanup,
            // Transcription commands
            ipc::is_transcription_available,
            ipc::transcribe_asset,
            ipc::submit_transcription_job,
            // Search commands
            ipc::search_assets,
            ipc::is_meilisearch_available,
            ipc::search_content,
            ipc::index_asset_for_search,
            ipc::index_transcripts_for_search,
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
            // Workspace commands
            ipc::scan_workspace,
            ipc::get_workspace_tree,
            ipc::register_workspace_file,
            ipc::register_workspace_files,
        ])
        .run(tauri::generate_context!());

        if let Err(e) = result {
            tracing::error!("Error while running tauri application: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(test))]
pub use tauri_app::run;

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
}

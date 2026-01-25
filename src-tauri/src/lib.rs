//! OpenReelio Core Library
//!
//! AI Agent-driven, prompt-based video editing IDE.
//! This library contains the core editing engine, command system,
//! and all business logic for the application.
//!
//! ## TypeScript Bindings
//!
//! All IPC types are automatically exported to TypeScript via tauri-specta.
//! Run `cargo build` in development mode to regenerate `src/bindings.ts`.

pub mod core;
pub mod ipc;

use std::path::PathBuf;

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
    /// Project state (in-memory)
    pub state: ProjectState,
    /// Command executor with undo/redo
    pub executor: CommandExecutor,
    /// Operations log path
    pub ops_log: OpsLog,
}

impl ActiveProject {
    /// Creates a new project with default sequence and tracks
    ///
    /// The default sequence is created via Command to ensure proper ops log recording.
    /// This maintains Event Sourcing integrity - all state changes are recorded.
    pub fn create(name: &str, path: PathBuf) -> crate::core::CoreResult<Self> {
        use crate::core::commands::CreateSequenceCommand;

        // Create project directory if it doesn't exist
        std::fs::create_dir_all(&path)?;
        // Ensure app-managed workspace exists (proxy/frames/cache, etc.).
        // This also makes it safe to allowlist the directory for the asset protocol.
        std::fs::create_dir_all(path.join(".openreelio"))?;

        let ops_path = path.join("ops.jsonl");

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
        let snapshot_path = Snapshot::default_path(&path);
        Snapshot::save(&snapshot_path, &state, state.last_op_id.as_deref())?;

        // Save project.json metadata
        let meta_path = path.join("project.json");
        crate::core::fs::atomic_write_json_pretty(&meta_path, &state.meta)?;

        Ok(Self {
            path,
            state,
            executor,
            ops_log,
        })
    }

    /// Opens an existing project
    pub fn open(path: PathBuf) -> crate::core::CoreResult<Self> {
        // Best-effort ensure app-managed workspace exists for older projects.
        let _ = std::fs::create_dir_all(path.join(".openreelio"));

        let ops_path = path.join("ops.jsonl");
        let snapshot_path = Snapshot::default_path(&path);
        let meta_path = path.join("project.json");

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
        let snapshot_path = Snapshot::default_path(&self.path);
        Snapshot::save(
            &snapshot_path,
            &self.state,
            self.state.last_op_id.as_deref(),
        )?;

        // Save project.json metadata
        let meta_path = self.path.join("project.json");
        crate::core::fs::atomic_write_json_pretty(&meta_path, &self.state.meta)?;

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
                greet,
                // Project commands
                $crate::ipc::create_project,
                $crate::ipc::open_project,
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
                $crate::ipc::test_ai_connection,
                $crate::ipc::generate_edit_script_with_ai,
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
                // Settings
                $crate::ipc::get_settings,
                $crate::ipc::set_settings,
                $crate::ipc::update_settings,
                $crate::ipc::reset_settings,
                // Updates
                $crate::ipc::check_for_updates,
                $crate::ipc::get_current_version,
                $crate::ipc::relaunch_app,
                $crate::ipc::download_and_install_update,
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

        builder.setup(move |app| {
            // Initialize logging (safe to call multiple times).
            init_logging(app.handle());

            tracing::info!("OpenReelio starting...");

            // Capture AppHandle for commands and configure base asset protocol scope.
            // The static scope in `tauri.conf.json` is deliberately minimal; we extend it at runtime
            // only for opened projects and imported assets.
            let app_state: tauri::State<'_, AppState> = app.state();
            app_state.set_app_handle(app.handle().clone());

            // Defense-in-depth: explicitly forbid access to the webview data directory.
            if let Ok(local_data) = app.path().app_local_data_dir() {
                app_state.forbid_asset_protocol_directory(&local_data, true);
            }

            // Allow app-managed cache/data directories.
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                app_state.allow_asset_protocol_directory(&cache_dir, true);
            }
            if let Ok(data_dir) = app.path().app_data_dir() {
                app_state.allow_asset_protocol_directory(&data_dir, true);
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
                let pool_guard =
                    tauri::async_runtime::block_on(async { app_state.job_pool.lock().await });
                (
                    Arc::clone(&pool_guard.queue),
                    Arc::clone(&pool_guard.active_jobs),
                    pool_guard.num_workers(),
                )
            };

            let (queue_arc, active_jobs_arc, num_workers) = job_queue;
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
            // Project commands
            ipc::create_project,
            ipc::open_project,
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
            ipc::test_ai_connection,
            ipc::generate_edit_script_with_ai,
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
            // Settings
            ipc::get_settings,
            ipc::set_settings,
            ipc::update_settings,
            ipc::reset_settings,
            // Updates
            ipc::check_for_updates,
            ipc::get_current_version,
            ipc::relaunch_app,
            ipc::download_and_install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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

        assert_eq!(project.state.meta.name, "Test Project");
        assert_eq!(project.path, project_path);
        assert!(project_path.join("project.json").exists());
        assert!(project_path.join("snapshot.json").exists());
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
        std::fs::write(project_path.join("snapshot.json"), "{not valid json").unwrap();

        // Open should still succeed by replaying ops.jsonl
        let opened = ActiveProject::open(project_path).unwrap();
        assert_eq!(opened.state.meta.name, "Test Project");
    }

    #[test]
    fn test_active_project_save() {
        let temp_dir = TempDir::new().unwrap();
        let project_path = temp_dir.path().join("test_project");

        let mut project = ActiveProject::create("Test Project", project_path.clone()).unwrap();
        project.state.meta.name = "Updated Name".to_string();
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

        // Mark as dirty (simulating a command execution)
        project.state.is_dirty = true;
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
}

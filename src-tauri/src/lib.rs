//! OpenReelio Core Library
//!
//! AI Agent-driven, prompt-based video editing IDE.
//! This library contains the core editing engine, command system,
//! and all business logic for the application.

pub mod core;
pub mod ipc;

use std::path::PathBuf;
use std::sync::Mutex;

use crate::core::{
    commands::CommandExecutor,
    project::{OpsLog, ProjectMeta, ProjectState, Snapshot},
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
    /// Creates a new project
    pub fn create(name: &str, path: PathBuf) -> crate::core::CoreResult<Self> {
        // Create project directory if it doesn't exist
        std::fs::create_dir_all(&path)?;

        let ops_path = path.join("ops.jsonl");
        let state = ProjectState::new(name);

        // Create single OpsLog instance for both storage and executor
        let ops_log = OpsLog::new(&ops_path);
        let executor = CommandExecutor::with_ops_log(OpsLog::new(&ops_path));

        // Save initial snapshot
        let snapshot_path = Snapshot::default_path(&path);
        Snapshot::save(&snapshot_path, &state, None)?;

        // Save project.json metadata
        let meta_path = path.join("project.json");
        let meta_file = std::fs::File::create(&meta_path)?;
        serde_json::to_writer_pretty(meta_file, &state.meta)?;

        Ok(Self {
            path,
            state,
            executor,
            ops_log,
        })
    }

    /// Opens an existing project
    pub fn open(path: PathBuf) -> crate::core::CoreResult<Self> {
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
            Snapshot::load_with_replay(&snapshot_path, &ops_log)?
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
    pub fn save(&self) -> crate::core::CoreResult<()> {
        // Save snapshot
        let snapshot_path = Snapshot::default_path(&self.path);
        Snapshot::save(
            &snapshot_path,
            &self.state,
            self.state.last_op_id.as_deref(),
        )?;

        // Save project.json metadata
        let meta_path = self.path.join("project.json");
        let meta_file = std::fs::File::create(&meta_path)?;
        serde_json::to_writer_pretty(meta_file, &self.state.meta)?;

        Ok(())
    }
}

/// Application state shared across all commands
pub struct AppState {
    /// Currently active project (if any)
    pub project: Mutex<Option<ActiveProject>>,
}

impl AppState {
    /// Creates a new empty app state
    pub fn new() -> Self {
        Self {
            project: Mutex::new(None),
        }
    }

    /// Checks if a project is currently open
    pub fn has_project(&self) -> bool {
        self.project.lock().map(|p| p.is_some()).unwrap_or(false)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Tauri Application Entry Point
// =============================================================================

/// Tauri command: Greet (placeholder for testing)
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to OpenReelio.", name)
}

/// Initialize and run the Tauri application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Initialize logging
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::from_default_env()
                        .add_directive(tracing::Level::INFO.into()),
                )
                .init();

            tracing::info!("OpenReelio starting...");

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
            ipc::cancel_job,
            // Render commands
            ipc::start_render,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_app_state_new() {
        let state = AppState::new();
        assert!(!state.has_project());
    }

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
}

//! IPC Command Helpers
//!
//! Shared utilities, macros, and error handling for Tauri IPC commands.
//! This module reduces boilerplate across command implementations.

use crate::core::CoreError;

/// Converts a CoreError into an IPC-friendly error string.
///
/// This trait extension provides consistent error formatting across all commands.
pub trait ToIpcError {
    fn to_ipc_error(self) -> String;
}

impl ToIpcError for CoreError {
    fn to_ipc_error(self) -> String {
        format!("{}", self)
    }
}

/// Macro to get a mutable reference to the active project from AppState.
///
/// This macro reduces the common boilerplate pattern:
/// ```ignore
/// let mut guard = state.project.lock().await;
/// let project = guard
///     .as_mut()
///     .ok_or_else(|| "No project is currently open".to_string())?;
/// ```
///
/// # Usage
/// ```ignore
/// #[tauri::command]
/// pub async fn my_command(state: State<'_, AppState>) -> Result<(), String> {
///     let project = get_active_project!(state)?;
///     // ... use project
///     Ok(())
/// }
/// ```
///
/// # Returns
/// A `Result<MutexGuard<Option<ActiveProject>>, String>` where the inner Option
/// is guaranteed to be Some. Use `.as_mut().unwrap()` after the macro call.
#[macro_export]
macro_rules! get_active_project_guard {
    ($state:expr) => {{
        let guard = $state.project.lock().await;
        if guard.is_none() {
            Err("No project is currently open".to_string())
        } else {
            Ok(guard)
        }
    }};
}

/// Convenience function to check if a project is currently loaded.
///
/// # Arguments
/// * `state` - Reference to the AppState
///
/// # Returns
/// `true` if a project is loaded, `false` otherwise
pub async fn is_project_loaded(state: &crate::AppState) -> bool {
    let guard = state.project.lock().await;
    guard.is_some()
}

/// Standard error messages for consistent user feedback.
pub mod errors {
    pub const NO_PROJECT_OPEN: &str = "No project is currently open";
    pub const UNSAVED_CHANGES: &str =
        "A project is already open with unsaved changes. Save it before creating a new project.";
    pub const PROJECT_PATH_EMPTY: &str = "Project path is empty";
    pub const PROJECT_NAME_EMPTY: &str = "Project name is empty";
    pub const PROJECT_NAME_TOO_LONG: &str = "Project name is too long (max 100 characters)";
    pub const PROJECT_PATH_NOT_ABSOLUTE: &str = "Project path must be absolute";
}

pub use get_active_project_guard;

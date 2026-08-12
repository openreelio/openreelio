//! FFmpeg shared state
//!
//! This module holds the reusable FFmpeg runner state that is shared across the app.
//! It is intentionally kept independent of IPC/Tauri command entry points so that
//! core logic (e.g. worker pool) can compile in unit tests without pulling in
//! Tauri command macros.

use std::sync::Arc;

use tokio::sync::RwLock;

#[cfg(test)]
use super::detect_system_ffmpeg;
#[cfg(any(test, feature = "gui"))]
use super::FFmpegError;
use super::{FFmpegInfo, FFmpegRunner};

/// Global FFmpeg runner state.
///
/// This is initialized once on app startup and reused for all operations.
pub struct FFmpegState {
    runner: Option<FFmpegRunner>,
    info: Option<FFmpegInfo>,
}

impl FFmpegState {
    pub fn new() -> Self {
        Self {
            runner: None,
            info: None,
        }
    }

    /// Initialize FFmpeg by detecting installation.
    ///
    /// Resolution order: bundled resources → managed install → dev-mode
    /// binaries → system PATH.
    ///
    /// This runs blocking process probes; async callers must use
    /// [`initialize_shared_ffmpeg`] instead so the async runtime never blocks.
    #[cfg(all(not(test), feature = "gui"))]
    pub fn initialize(&mut self, app_handle: Option<&tauri::AppHandle>) -> Result<(), FFmpegError> {
        let info = detect_ffmpeg(app_handle)?;
        self.apply_info(info);
        Ok(())
    }

    /// Initialize FFmpeg for unit tests.
    ///
    /// Tests should not depend on Tauri runtime state.
    #[cfg(test)]
    pub fn initialize(&mut self) -> Result<(), FFmpegError> {
        let info = detect_system_ffmpeg()?;
        self.apply_info(info);
        Ok(())
    }

    /// Store detected info and publish the paths to the global resolver.
    #[cfg(any(test, feature = "gui"))]
    fn apply_info(&mut self, info: FFmpegInfo) {
        super::set_resolved_paths(info.ffmpeg_path.clone(), info.ffprobe_path.clone());
        self.info = Some(info.clone());
        self.runner = Some(FFmpegRunner::new(info));
    }

    /// Get the FFmpeg runner.
    pub fn runner(&self) -> Option<&FFmpegRunner> {
        self.runner.as_ref()
    }

    /// Get FFmpeg info.
    pub fn info(&self) -> Option<&FFmpegInfo> {
        self.info.as_ref()
    }

    /// Check if FFmpeg is available.
    pub fn is_available(&self) -> bool {
        self.runner.is_some()
    }
}

impl Default for FFmpegState {
    fn default() -> Self {
        Self::new()
    }
}

/// Detects an FFmpeg installation without touching any shared state.
///
/// Resolution order: bundled resources → managed install → dev-mode
/// binaries → system PATH. This spawns blocking `ffmpeg -version` process
/// probes, so async callers must run it inside `spawn_blocking` (see
/// [`initialize_shared_ffmpeg`]).
#[cfg(all(not(test), feature = "gui"))]
pub fn detect_ffmpeg(app_handle: Option<&tauri::AppHandle>) -> Result<FFmpegInfo, FFmpegError> {
    use tauri::Manager;

    let resource_roots = app_handle
        .and_then(|handle| handle.path().resource_dir().ok())
        .into_iter()
        .collect::<Vec<_>>();

    super::resolve_ffmpeg(&super::FFmpegResolveOptions {
        resource_roots,
        // Path overrides stay CLI-only: a GUI process must not silently inherit
        // an FFmpeg override from whatever shell or launcher started it.
        use_env: false,
        ..Default::default()
    })
}

/// Shared FFmpeg state for the async runtime.
pub type SharedFFmpegState = Arc<RwLock<FFmpegState>>;

/// Initializes the shared FFmpeg state without blocking the async runtime.
///
/// Detection (which spawns `ffmpeg -version` process probes) runs on the
/// blocking thread pool while no lock is held; the write lock is taken only
/// to apply the detected info and publish the resolved paths. If concurrent
/// initializations race, the last writer wins, which is acceptable because
/// they detect the same installation.
#[cfg(all(not(test), feature = "gui"))]
pub async fn initialize_shared_ffmpeg(
    state: &SharedFFmpegState,
    app_handle: Option<tauri::AppHandle>,
) -> Result<(), FFmpegError> {
    let info = tokio::task::spawn_blocking(move || detect_ffmpeg(app_handle.as_ref()))
        .await
        .map_err(|error| {
            FFmpegError::ExecutionFailed(format!("FFmpeg detection task failed: {error}"))
        })??;

    let mut guard = state.write().await;
    guard.apply_info(info);
    Ok(())
}

/// Create a new shared FFmpeg state.
pub fn create_ffmpeg_state() -> SharedFFmpegState {
    Arc::new(RwLock::new(FFmpegState::new()))
}

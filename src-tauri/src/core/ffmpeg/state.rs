//! FFmpeg shared state
//!
//! This module holds the reusable FFmpeg runner state that is shared across the app.
//! It is intentionally kept independent of IPC/Tauri command entry points so that
//! core logic (e.g. worker pool) can compile in unit tests without pulling in
//! Tauri command macros.

use std::sync::Arc;

use tokio::sync::RwLock;

#[cfg(any(test, feature = "gui"))]
use super::{detect_system_ffmpeg, FFmpegError};
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
    #[cfg(all(not(test), feature = "gui"))]
    pub fn initialize(&mut self, app_handle: Option<&tauri::AppHandle>) -> Result<(), FFmpegError> {
        // Try bundled resources first (if app_handle provided)
        if let Some(handle) = app_handle {
            if let Ok(info) = super::detect_bundled_resources(handle) {
                self.apply_info(info);
                return Ok(());
            }
        }

        // Managed install (in-app FFmpeg installer)
        if let Ok(info) = super::detect_managed_ffmpeg() {
            self.apply_info(info);
            return Ok(());
        }

        // Dev-mode binaries (src-tauri/binaries during `npm run tauri dev`)
        if let Ok(info) = super::detection::detect_dev_mode_binaries() {
            self.apply_info(info);
            return Ok(());
        }

        // Fall back to system FFmpeg
        let info = detect_system_ffmpeg()?;
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

/// Shared FFmpeg state for the async runtime.
pub type SharedFFmpegState = Arc<RwLock<FFmpegState>>;

/// Create a new shared FFmpeg state.
pub fn create_ffmpeg_state() -> SharedFFmpegState {
    Arc::new(RwLock::new(FFmpegState::new()))
}

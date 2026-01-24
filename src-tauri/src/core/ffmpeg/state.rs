//! FFmpeg shared state
//!
//! This module holds the reusable FFmpeg runner state that is shared across the app.
//! It is intentionally kept independent of IPC/Tauri command entry points so that
//! core logic (e.g. worker pool) can compile in unit tests without pulling in
//! Tauri command macros.

use std::sync::Arc;

use tokio::sync::RwLock;

use super::{detect_system_ffmpeg, FFmpegError, FFmpegInfo, FFmpegRunner};

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
    /// In non-test builds, this optionally attempts bundled FFmpeg detection first.
    #[cfg(not(test))]
    pub fn initialize(&mut self, app_handle: Option<&tauri::AppHandle>) -> Result<(), FFmpegError> {
        // Try bundled first (if app_handle provided)
        if let Some(handle) = app_handle {
            if let Ok(info) = super::detect_bundled_ffmpeg(handle) {
                self.info = Some(info.clone());
                self.runner = Some(FFmpegRunner::new(info));
                return Ok(());
            }
        }

        // Fall back to system FFmpeg
        let info = detect_system_ffmpeg()?;
        self.info = Some(info.clone());
        self.runner = Some(FFmpegRunner::new(info));
        Ok(())
    }

    /// Initialize FFmpeg for unit tests.
    ///
    /// Tests should not depend on Tauri runtime state.
    #[cfg(test)]
    pub fn initialize(&mut self) -> Result<(), FFmpegError> {
        let info = detect_system_ffmpeg()?;
        self.info = Some(info.clone());
        self.runner = Some(FFmpegRunner::new(info));
        Ok(())
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

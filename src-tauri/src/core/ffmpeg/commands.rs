//! FFmpeg IPC Commands
//!
//! Tauri commands for FFmpeg operations exposed to the frontend.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::{detect_system_ffmpeg, FFmpegError, FFmpegInfo, FFmpegRunner, MediaInfo};

/// Global FFmpeg runner state
/// This is initialized once on app startup and reused for all operations
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

    /// Initialize FFmpeg by detecting installation
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

    /// Get the FFmpeg runner
    pub fn runner(&self) -> Option<&FFmpegRunner> {
        self.runner.as_ref()
    }

    /// Get FFmpeg info
    pub fn info(&self) -> Option<&FFmpegInfo> {
        self.info.as_ref()
    }

    /// Check if FFmpeg is available
    pub fn is_available(&self) -> bool {
        self.runner.is_some()
    }
}

impl Default for FFmpegState {
    fn default() -> Self {
        Self::new()
    }
}

/// Shared FFmpeg state for Tauri
pub type SharedFFmpegState = Arc<RwLock<FFmpegState>>;

/// Create a new shared FFmpeg state
pub fn create_ffmpeg_state() -> SharedFFmpegState {
    Arc::new(RwLock::new(FFmpegState::new()))
}

/// Response for check_ffmpeg command
#[derive(Debug, Clone, serde::Serialize)]
pub struct FFmpegStatus {
    pub available: bool,
    pub version: Option<String>,
    pub is_bundled: bool,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
}

/// Check if FFmpeg is available and return its status
#[tauri::command]
pub async fn check_ffmpeg(
    ffmpeg_state: tauri::State<'_, SharedFFmpegState>,
) -> Result<FFmpegStatus, String> {
    let state = ffmpeg_state.read().await;

    if let Some(info) = state.info() {
        Ok(FFmpegStatus {
            available: true,
            version: Some(info.version.clone()),
            is_bundled: info.is_bundled,
            ffmpeg_path: Some(info.ffmpeg_path.to_string_lossy().to_string()),
            ffprobe_path: Some(info.ffprobe_path.to_string_lossy().to_string()),
        })
    } else {
        Ok(FFmpegStatus {
            available: false,
            version: None,
            is_bundled: false,
            ffmpeg_path: None,
            ffprobe_path: None,
        })
    }
}

/// Extract a single frame from a video
#[tauri::command]
pub async fn extract_frame(
    input_path: String,
    time_sec: f64,
    output_path: String,
    ffmpeg_state: tauri::State<'_, SharedFFmpegState>,
) -> Result<(), String> {
    let state = ffmpeg_state.read().await;

    let runner = state
        .runner()
        .ok_or_else(|| "FFmpeg not available".to_string())?;

    runner
        .extract_frame(
            &PathBuf::from(&input_path),
            time_sec,
            &PathBuf::from(&output_path),
        )
        .await
        .map_err(|e| e.to_string())
}

/// Generate a thumbnail for a video file
#[tauri::command]
pub async fn generate_thumbnail(
    input_path: String,
    output_path: String,
    width: Option<u32>,
    height: Option<u32>,
    ffmpeg_state: tauri::State<'_, SharedFFmpegState>,
) -> Result<(), String> {
    let state = ffmpeg_state.read().await;

    let runner = state
        .runner()
        .ok_or_else(|| "FFmpeg not available".to_string())?;

    let size = match (width, height) {
        (Some(w), Some(h)) => Some((w, h)),
        _ => None,
    };

    runner
        .generate_thumbnail(&PathBuf::from(&input_path), &PathBuf::from(&output_path), size)
        .await
        .map_err(|e| e.to_string())
}

/// Probe media file to get information
#[tauri::command]
pub async fn probe_media(
    input_path: String,
    ffmpeg_state: tauri::State<'_, SharedFFmpegState>,
) -> Result<MediaInfo, String> {
    let state = ffmpeg_state.read().await;

    let runner = state
        .runner()
        .ok_or_else(|| "FFmpeg not available".to_string())?;

    runner
        .probe(&PathBuf::from(&input_path))
        .await
        .map_err(|e| e.to_string())
}

/// Generate audio waveform image
#[tauri::command]
pub async fn generate_waveform(
    input_path: String,
    output_path: String,
    width: u32,
    height: u32,
    ffmpeg_state: tauri::State<'_, SharedFFmpegState>,
) -> Result<(), String> {
    let state = ffmpeg_state.read().await;

    let runner = state
        .runner()
        .ok_or_else(|| "FFmpeg not available".to_string())?;

    runner
        .generate_waveform(
            &PathBuf::from(&input_path),
            &PathBuf::from(&output_path),
            width,
            height,
        )
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ffmpeg_state_default() {
        let state = FFmpegState::default();
        assert!(!state.is_available());
        assert!(state.runner().is_none());
        assert!(state.info().is_none());
    }

    #[test]
    fn test_ffmpeg_status_serialization() {
        let status = FFmpegStatus {
            available: true,
            version: Some("6.0".to_string()),
            is_bundled: false,
            ffmpeg_path: Some("/usr/bin/ffmpeg".to_string()),
            ffprobe_path: Some("/usr/bin/ffprobe".to_string()),
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("available"));
        assert!(json.contains("6.0"));
    }
}

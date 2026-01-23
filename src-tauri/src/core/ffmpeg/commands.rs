//! FFmpeg IPC Commands
//!
//! Tauri commands for FFmpeg operations exposed to the frontend.
//! All types are exported to TypeScript via tauri-specta.

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

use specta::Type;
use tauri::Manager;
use tauri::State;

use super::{detect_system_ffmpeg, FFmpegError, FFmpegInfo, FFmpegRunner, MediaInfo};
use crate::core::fs::{validate_local_input_path, validate_scoped_output_path};
use crate::AppState;

async fn build_allowed_output_roots(
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
) -> Result<Vec<PathBuf>, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?;
    let _ = std::fs::create_dir_all(&cache_dir);

    let project_openreelio_dir = {
        let guard = state.project.lock().await;
        guard.as_ref().map(|p| p.path.join(".openreelio"))
    };

    let mut roots = vec![cache_dir];
    if let Some(dir) = project_openreelio_dir {
        let _ = std::fs::create_dir_all(&dir);
        roots.push(dir);
    }

    Ok(roots)
}

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

/// FFmpeg availability and version information.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FFmpegStatus {
    /// Whether FFmpeg is available
    pub available: bool,
    /// FFmpeg version string (if available)
    pub version: Option<String>,
    /// Whether using bundled FFmpeg (vs system)
    pub is_bundled: bool,
    /// Path to ffmpeg executable
    pub ffmpeg_path: Option<String>,
    /// Path to ffprobe executable
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
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let input_path = validate_local_input_path(&input_path, "inputPath")?;

    let allowed_roots = build_allowed_output_roots(&state, &app).await?;
    let allowed_root_refs: Vec<&std::path::Path> =
        allowed_roots.iter().map(|p| p.as_path()).collect();
    let output_path = validate_scoped_output_path(&output_path, "outputPath", &allowed_root_refs)?;

    let state = ffmpeg_state.read().await;

    let runner = state
        .runner()
        .ok_or_else(|| "FFmpeg not available".to_string())?;

    runner
        .extract_frame(&input_path, time_sec, &output_path)
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
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let input_path = validate_local_input_path(&input_path, "inputPath")?;

    let allowed_roots = build_allowed_output_roots(&state, &app).await?;
    let allowed_root_refs: Vec<&std::path::Path> =
        allowed_roots.iter().map(|p| p.as_path()).collect();
    let output_path = validate_scoped_output_path(&output_path, "outputPath", &allowed_root_refs)?;

    let state = ffmpeg_state.read().await;

    let runner = state
        .runner()
        .ok_or_else(|| "FFmpeg not available".to_string())?;

    let size = match (width, height) {
        (Some(w), Some(h)) => Some((w, h)),
        _ => None,
    };

    runner
        .generate_thumbnail(&input_path, &output_path, size)
        .await
        .map_err(|e| e.to_string())
}

/// Probe media file to get information
#[tauri::command]
pub async fn probe_media(
    input_path: String,
    ffmpeg_state: tauri::State<'_, SharedFFmpegState>,
) -> Result<MediaInfo, String> {
    let input_path = validate_local_input_path(&input_path, "inputPath")?;
    let state = ffmpeg_state.read().await;

    let runner = state
        .runner()
        .ok_or_else(|| "FFmpeg not available".to_string())?;

    runner.probe(&input_path).await.map_err(|e| e.to_string())
}

/// Generate audio waveform image
#[tauri::command]
pub async fn generate_waveform(
    input_path: String,
    output_path: String,
    width: u32,
    height: u32,
    ffmpeg_state: tauri::State<'_, SharedFFmpegState>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let input_path = validate_local_input_path(&input_path, "inputPath")?;

    let allowed_roots = build_allowed_output_roots(&state, &app).await?;
    let allowed_root_refs: Vec<&std::path::Path> =
        allowed_roots.iter().map(|p| p.as_path()).collect();
    let output_path = validate_scoped_output_path(&output_path, "outputPath", &allowed_root_refs)?;

    let state = ffmpeg_state.read().await;

    let runner = state
        .runner()
        .ok_or_else(|| "FFmpeg not available".to_string())?;

    runner
        .generate_waveform(&input_path, &output_path, width, height)
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

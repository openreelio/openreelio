//! FFmpeg IPC Commands
//!
//! Tauri commands for FFmpeg operations exposed to the frontend.
//! All types are exported to TypeScript via tauri-specta.

use std::path::PathBuf;

use specta::Type;
use tauri::Manager;
use tauri::State;

use super::{MediaInfo, SharedFFmpegState};
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

// NOTE: FFmpegState/SharedFFmpegState live in `core::ffmpeg::state` so that core modules
// (like the job worker) can compile and run unit tests without pulling in Tauri command macros.

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
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
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

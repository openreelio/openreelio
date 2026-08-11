//! FFmpeg IPC Commands
//!
//! Tauri commands for FFmpeg operations exposed to the frontend.
//! All types are exported to TypeScript via tauri-specta.

use std::path::PathBuf;

use specta::Type;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

use super::{FFmpegState, MediaInfo, SharedFFmpegState};
use crate::core::ffmpeg::installer;
use crate::core::fs::{validate_local_input_path, validate_scoped_output_path};
use crate::AppState;

/// Tauri event name for in-app FFmpeg install progress.
pub const FFMPEG_INSTALL_PROGRESS_EVENT: &str = "ffmpeg-install-progress";

/// Lock id inside [`AppState::runtime_install_locks`] for the FFmpeg installer.
const FFMPEG_INSTALL_LOCK_ID: &str = "ffmpeg";

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
    /// Where the binaries came from (`bundled`/`managed`/`dev`/`system`)
    pub source: Option<String>,
}

/// Builds the IPC status payload from the shared FFmpeg state.
fn build_ffmpeg_status(state: &FFmpegState) -> FFmpegStatus {
    if let Some(info) = state.info() {
        FFmpegStatus {
            available: true,
            version: Some(info.version.clone()),
            is_bundled: info.is_bundled,
            ffmpeg_path: Some(info.ffmpeg_path.to_string_lossy().to_string()),
            ffprobe_path: Some(info.ffprobe_path.to_string_lossy().to_string()),
            source: Some(info.source.as_str().to_string()),
        }
    } else {
        FFmpegStatus {
            available: false,
            version: None,
            is_bundled: false,
            ffmpeg_path: None,
            ffprobe_path: None,
            source: None,
        }
    }
}

/// Check if FFmpeg is available and return its status
///
/// When the shared state reports FFmpeg as unavailable, this re-attempts
/// initialization so a freshly installed (or slow-to-initialize) FFmpeg is
/// picked up without restarting the app.
#[tauri::command]
#[specta::specta]
pub async fn check_ffmpeg(
    app: tauri::AppHandle,
    ffmpeg_state: tauri::State<'_, SharedFFmpegState>,
) -> Result<FFmpegStatus, String> {
    {
        let state = ffmpeg_state.read().await;
        if state.is_available() {
            return Ok(build_ffmpeg_status(&state));
        }
    }

    // Not available yet: retry initialization (lazy re-init, mirrors the
    // transcription command path). Detection runs on the blocking pool without
    // holding the state lock. Failure is not an error here — the status simply
    // reports unavailable.
    let _ = super::initialize_shared_ffmpeg(ffmpeg_state.inner(), Some(app)).await;
    let state = ffmpeg_state.read().await;
    Ok(build_ffmpeg_status(&state))
}

/// Progress payload emitted on [`FFMPEG_INSTALL_PROGRESS_EVENT`].
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FFmpegInstallProgressPayload {
    /// Install stage (`downloading|verifying|extracting|installing|done`).
    stage: String,
    /// Logical binary/archive name the stage applies to.
    binary: String,
    /// Bytes downloaded so far for the current archive.
    downloaded_bytes: u64,
    /// Total bytes for the current archive, when known.
    total_bytes: Option<u64>,
}

/// RAII guard ensuring only one FFmpeg install runs at a time.
///
/// Mirrors `RuntimeInstallGuard` in `ipc::commands::external_agent`, sharing
/// [`AppState::runtime_install_locks`] so `Drop` releases the lock on every
/// exit path.
struct FFmpegInstallGuard<'a> {
    state: &'a AppState,
}

impl<'a> FFmpegInstallGuard<'a> {
    fn acquire(state: &'a AppState) -> Result<Self, String> {
        let mut locks = state
            .runtime_install_locks
            .lock()
            .map_err(|_| "FFmpeg install lock is poisoned".to_string())?;
        if !locks.insert(FFMPEG_INSTALL_LOCK_ID) {
            return Err(
                "An FFmpeg installation is already in progress. Wait for it to finish.".to_string(),
            );
        }
        Ok(Self { state })
    }
}

impl Drop for FFmpegInstallGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut locks) = self.state.runtime_install_locks.lock() {
            locks.remove(FFMPEG_INSTALL_LOCK_ID);
        }
    }
}

/// Download and install FFmpeg/FFprobe into the managed install directory.
///
/// Emits [`FFMPEG_INSTALL_PROGRESS_EVENT`] while running, then re-initializes
/// the shared FFmpeg state (publishing resolved paths) and returns the fresh
/// status. Concurrent installs are rejected.
#[tauri::command]
#[specta::specta]
pub async fn install_ffmpeg(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    ffmpeg_state: tauri::State<'_, SharedFFmpegState>,
) -> Result<FFmpegStatus, String> {
    let _guard = FFmpegInstallGuard::acquire(&state)?;

    let progress_app = app.clone();
    let install = tokio::task::spawn_blocking(move || {
        installer::install_managed_ffmpeg(move |progress| {
            let payload = FFmpegInstallProgressPayload {
                stage: progress.stage.as_str().to_string(),
                binary: progress.binary,
                downloaded_bytes: progress.downloaded_bytes,
                total_bytes: progress.total_bytes,
            };
            if let Err(error) = progress_app.emit(FFMPEG_INSTALL_PROGRESS_EVENT, payload) {
                tracing::debug!("Failed to emit FFmpeg install progress: {error}");
            }
        })
    })
    .await
    .map_err(|error| format!("FFmpeg install task failed: {error}"))??;

    if !install.verified {
        tracing::warn!(
            "FFmpeg was installed without checksum verification (no checksum source in manifest)"
        );
    }
    tracing::info!(
        ffmpeg = %install.ffmpeg_path.display(),
        ffprobe = %install.ffprobe_path.display(),
        "Managed FFmpeg install completed"
    );

    // Re-run state initialization so the fresh install is detected and the
    // globally resolved paths are published (`set_resolved_paths` runs when
    // the detected info is applied). Detection runs on the blocking pool
    // without holding the state lock.
    super::initialize_shared_ffmpeg(ffmpeg_state.inner(), Some(app))
        .await
        .map_err(|error| format!("FFmpeg was installed but initialization failed: {error}"))?;
    let ffmpeg = ffmpeg_state.read().await;
    Ok(build_ffmpeg_status(&ffmpeg))
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
            source: Some("system".to_string()),
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("available"));
        assert!(json.contains("6.0"));
    }
}

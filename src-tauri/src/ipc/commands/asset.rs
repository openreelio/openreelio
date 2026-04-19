//! Asset management commands
//!
//! Tauri IPC commands for importing, removing, and managing assets
//! including thumbnails, proxies, and waveforms.

use std::path::{Path, PathBuf};

use specta::Type;
use tauri::State;

use crate::core::{
    assets::{Asset, AssetKind, AudioInfo, ProxyStatus, VideoInfo},
    commands::{ImportAssetCommand, RemoveAssetCommand, UpdateAssetCommand},
    ffmpeg::{FFmpegProgress, SharedFFmpegState},
    fs::validate_path_id_component,
    jobs::{Job, JobType, Priority},
    CoreError, Ratio,
};
use crate::AppState;

// =============================================================================
// Helper Functions
// =============================================================================

/// Converts a floating-point FPS value to a Ratio (numerator, denominator).
/// Handles common video frame rates including NTSC (23.976, 29.97, 59.94).
/// Returns (0, 1) for invalid input (NaN, Infinity, zero, negative).
fn fps_to_ratio(fps: f64) -> (i32, i32) {
    // Guard against invalid FPS values from malformed media or FFprobe errors
    if !fps.is_finite() || fps <= 0.0 {
        return (0, 1);
    }

    // Handle common NTSC frame rates
    const NTSC_TOLERANCE: f64 = 0.01;

    if (fps - 23.976).abs() < NTSC_TOLERANCE {
        return (24000, 1001);
    }
    if (fps - 29.97).abs() < NTSC_TOLERANCE {
        return (30000, 1001);
    }
    if (fps - 59.94).abs() < NTSC_TOLERANCE {
        return (60000, 1001);
    }

    // For standard frame rates (24, 25, 30, 50, 60, etc.)
    let rounded = fps.round();
    if (fps - rounded).abs() < 0.001 {
        return (rounded as i32, 1);
    }

    // For other fractional frame rates, use a reasonable approximation
    // Multiply by 1000 and use 1000 as denominator
    let num = (fps * 1000.0).round() as i32;
    (num, 1000)
}

fn resolve_asset_uri(project_root: &Path, uri: &str) -> (String, Option<String>) {
    let is_relative = uri.starts_with("./")
        || uri.starts_with("../")
        || (!uri.starts_with('/') && !uri.contains(":\\") && !uri.contains(":/"));

    if is_relative {
        let abs_path =
            crate::core::workspace::path_resolver::resolve_to_absolute(project_root, uri);
        let rel = crate::core::workspace::path_resolver::to_relative(project_root, &abs_path)
            .unwrap_or_else(|| uri.to_string());
        return (abs_path.to_string_lossy().to_string(), Some(rel));
    }

    let abs_path = PathBuf::from(uri);
    if crate::core::workspace::path_resolver::is_inside_project(project_root, &abs_path) {
        let rel = crate::core::workspace::path_resolver::to_relative(project_root, &abs_path)
            .unwrap_or_else(|| uri.to_string());
        (uri.to_string(), Some(rel))
    } else {
        (uri.to_string(), None)
    }
}

fn build_audio_info(audio_stream: &crate::core::ffmpeg::AudioStreamInfo) -> AudioInfo {
    AudioInfo {
        sample_rate: audio_stream.sample_rate,
        channels: audio_stream.channels,
        codec: audio_stream.codec.clone(),
        bitrate: audio_stream.bitrate,
    }
}

fn build_import_command(
    name: &str,
    resolved_uri: &str,
    media_info: Option<&crate::core::ffmpeg::MediaInfo>,
) -> ImportAssetCommand {
    let mut command = ImportAssetCommand::new(name, resolved_uri);
    let extension = std::path::Path::new(resolved_uri)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    let is_ambiguous_ogg = extension == "ogg";

    if let Some(info) = media_info {
        let has_video = info.video.is_some();
        let has_audio = info.audio.is_some();

        command = match command.asset.kind {
            AssetKind::Image => ImportAssetCommand::image(name, resolved_uri, 1920, 1080),
            AssetKind::Audio => {
                if is_ambiguous_ogg && has_video {
                    ImportAssetCommand::video(
                        name,
                        resolved_uri,
                        build_video_info(info.video.as_ref().expect("video stream checked above")),
                    )
                } else if let Some(audio_stream) = info.audio.as_ref() {
                    ImportAssetCommand::audio(name, resolved_uri, build_audio_info(audio_stream))
                } else {
                    ImportAssetCommand::audio(name, resolved_uri, AudioInfo::default())
                }
            }
            AssetKind::Video => {
                if !has_video && has_audio {
                    if let Some(audio_stream) = info.audio.as_ref() {
                        ImportAssetCommand::audio(
                            name,
                            resolved_uri,
                            build_audio_info(audio_stream),
                        )
                    } else {
                        ImportAssetCommand::new(name, resolved_uri)
                    }
                } else if let Some(video_stream) = info.video.as_ref() {
                    ImportAssetCommand::video(name, resolved_uri, build_video_info(video_stream))
                } else {
                    ImportAssetCommand::new(name, resolved_uri)
                }
            }
            _ => ImportAssetCommand::new(name, resolved_uri),
        };

        command = command
            .with_duration(info.duration_sec)
            .with_file_size(info.size_bytes);

        if matches!(command.asset.kind, AssetKind::Video) {
            if let Some(video_stream) = info.video.as_ref() {
                command = command.with_video_info(build_video_info(video_stream));
            }
        }

        if matches!(command.asset.kind, AssetKind::Audio | AssetKind::Video) {
            if let Some(audio_stream) = info.audio.as_ref() {
                command = command.with_audio_info(build_audio_info(audio_stream));
            }
        }
    }

    command
}

fn build_video_info(video_stream: &crate::core::ffmpeg::VideoStreamInfo) -> VideoInfo {
    let (fps_num, fps_den) = fps_to_ratio(video_stream.fps);
    VideoInfo {
        width: video_stream.width,
        height: video_stream.height,
        fps: Ratio::new(fps_num, fps_den),
        codec: video_stream.codec.clone(),
        bitrate: video_stream.bitrate,
        has_alpha: false,
        is_hdr: video_stream.is_hdr,
        color_transfer: video_stream.color_transfer.clone(),
    }
}

// =============================================================================
// DTOs
// =============================================================================

/// Result of importing an asset into the project.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportResult {
    /// Generated asset ID (ULID)
    pub asset_id: String,
    /// Asset display name (from filename)
    pub name: String,
    /// Operation ID for undo/redo tracking
    pub op_id: String,
    /// Background job ID for proxy/thumbnail generation (if any)
    pub job_id: Option<String>,
}

// =============================================================================
// Commands
// =============================================================================

/// Imports an asset into the project
///
/// Automatically queues proxy generation job for video assets > 720p.
/// Returns the job_id if a proxy job was queued.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, ffmpeg_state), fields(uri = %uri))]
pub async fn import_asset(
    uri: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<AssetImportResult, String> {
    use crate::core::assets::requires_proxy;
    use crate::core::fs::validate_local_input_path;
    let project_root = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
        project.path.clone()
    };

    let (resolved_uri, relative_path) = resolve_asset_uri(&project_root, &uri);
    let path = validate_local_input_path(&resolved_uri, "Asset path")?;
    let proxy_input_path = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    // Extract metadata using FFprobe outside the project mutex to avoid blocking other IPC calls.
    let media_info = {
        let ffmpeg_guard = ffmpeg_state.read().await;
        if let Some(runner) = ffmpeg_guard.runner() {
            match runner.probe(&path).await {
                Ok(media_info) => {
                    tracing::debug!(
                        "Extracted metadata for {}: duration={:.2}s, size={}",
                        name,
                        media_info.duration_sec,
                        media_info.size_bytes
                    );
                    Some(media_info)
                }
                Err(e) => {
                    tracing::warn!(
                        "Failed to extract metadata for {}: {}. Using defaults.",
                        name,
                        e
                    );
                    None
                }
            }
        } else {
            tracing::warn!(
                "FFmpeg not available for metadata extraction of {}. Using defaults.",
                name
            );
            None
        }
    };

    let mut command = build_import_command(&name, &resolved_uri, media_info.as_ref());
    if let Some(ref rel_path) = relative_path {
        command = command.with_project_root(project_root.clone());
        command.asset.relative_path = Some(rel_path.clone());
        command.asset.workspace_managed = true;
    }

    let asset_id = command.asset_id().to_string();

    // Execute the import command in a short critical section.
    let (op_id, needs_proxy) = {
        let mut guard = state.project.lock().await;
        let project = guard
            .as_mut()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let result = project
            .executor
            .execute(Box::new(command), &mut project.state)
            .map_err(|e| e.to_ipc_error())?;

        let needs_proxy = project
            .state
            .assets
            .get(&asset_id)
            .map(|asset| requires_proxy(&asset.kind, asset.video.as_ref()))
            .unwrap_or(false);

        (result.op_id, needs_proxy)
    };

    state.allow_asset_protocol_file(&path);

    // Phase 2: Queue proxy job if needed (separate lock scope)
    let job_id = if needs_proxy {
        let proxy_job = Job::new(
            JobType::ProxyGeneration,
            serde_json::json!({
                "assetId": asset_id,
                "inputPath": proxy_input_path,
            }),
        )
        .with_priority(Priority::Normal);

        let submitted_job_id = proxy_job.id.clone();

        // Submit to worker pool (holds job_pool lock briefly)
        let submit_result = {
            let pool = state.job_pool.lock().await;
            pool.submit(proxy_job)
        };

        match submit_result {
            Ok(_) => {
                tracing::info!(
                    "Queued proxy generation job for asset {} ({})",
                    asset_id,
                    name
                );

                // Phase 3: Update asset status (re-acquire project lock briefly)
                {
                    let mut guard = state.project.lock().await;
                    if let Some(project) = guard.as_mut() {
                        let cmd = UpdateAssetCommand::new(&asset_id)
                            .with_proxy_status(ProxyStatus::Pending);
                        if let Err(e) = project
                            .executor
                            .execute_without_history(Box::new(cmd), &mut project.state)
                        {
                            tracing::warn!(
                                "Failed to persist asset {} proxy status update: {}",
                                asset_id,
                                e
                            );
                        }
                    }
                }

                Some(submitted_job_id)
            }
            Err(e) => {
                tracing::warn!("Failed to queue proxy job for asset {}: {}", asset_id, e);
                None
            }
        }
    } else {
        None
    };

    Ok(AssetImportResult {
        asset_id,
        name,
        op_id,
        job_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_media_info(
        video: Option<crate::core::ffmpeg::VideoStreamInfo>,
        audio: Option<crate::core::ffmpeg::AudioStreamInfo>,
    ) -> crate::core::ffmpeg::MediaInfo {
        crate::core::ffmpeg::MediaInfo {
            duration_sec: 12.0,
            video,
            audio,
            format: "mock".to_string(),
            size_bytes: 1024,
        }
    }

    #[test]
    fn test_build_video_info_preserves_hdr_metadata() {
        let video_stream = crate::core::ffmpeg::VideoStreamInfo {
            width: 3840,
            height: 2160,
            fps: 23.976,
            codec: "hevc".to_string(),
            pixel_format: "yuv420p10le".to_string(),
            bitrate: Some(25_000_000),
            is_hdr: true,
            color_transfer: Some("smpte2084".to_string()),
        };

        let video_info = build_video_info(&video_stream);
        assert!(video_info.is_hdr);
        assert_eq!(video_info.color_transfer.as_deref(), Some("smpte2084"));
        assert_eq!(video_info.fps.num, 24000);
        assert_eq!(video_info.fps.den, 1001);
    }

    #[test]
    fn test_resolve_asset_uri_tracks_workspace_relative_paths() {
        let project_root = Path::new("/tmp/openreelio-project");
        let (resolved_uri, relative_path) = resolve_asset_uri(project_root, "media/clip.mp4");

        assert!(PathBuf::from(&resolved_uri).ends_with(Path::new("media/clip.mp4")));
        assert_eq!(relative_path.as_deref(), Some("media/clip.mp4"));
    }

    #[test]
    fn test_build_import_command_keeps_image_kind_when_ffprobe_reports_video_stream() {
        let media_info = mock_media_info(
            Some(crate::core::ffmpeg::VideoStreamInfo {
                width: 1920,
                height: 1080,
                fps: 1.0,
                codec: "mjpeg".to_string(),
                pixel_format: "yuvj420p".to_string(),
                bitrate: None,
                is_hdr: false,
                color_transfer: None,
            }),
            None,
        );

        let command = build_import_command("cover.jpg", "/tmp/cover.jpg", Some(&media_info));
        assert_eq!(command.asset.kind, AssetKind::Image);
    }

    #[test]
    fn test_build_import_command_keeps_audio_kind_when_cover_art_is_present() {
        let media_info = mock_media_info(
            Some(crate::core::ffmpeg::VideoStreamInfo {
                width: 600,
                height: 600,
                fps: 1.0,
                codec: "mjpeg".to_string(),
                pixel_format: "yuvj420p".to_string(),
                bitrate: None,
                is_hdr: false,
                color_transfer: None,
            }),
            Some(crate::core::ffmpeg::AudioStreamInfo {
                sample_rate: 44100,
                channels: 2,
                codec: "aac".to_string(),
                bitrate: Some(192_000),
            }),
        );

        let command = build_import_command("podcast.m4a", "/tmp/podcast.m4a", Some(&media_info));
        assert_eq!(command.asset.kind, AssetKind::Audio);
    }

    #[test]
    fn test_build_import_command_promotes_ambiguous_ogg_with_video_stream_to_video() {
        let media_info = mock_media_info(
            Some(crate::core::ffmpeg::VideoStreamInfo {
                width: 1280,
                height: 720,
                fps: 30.0,
                codec: "theora".to_string(),
                pixel_format: "yuv420p".to_string(),
                bitrate: Some(2_000_000),
                is_hdr: false,
                color_transfer: None,
            }),
            Some(crate::core::ffmpeg::AudioStreamInfo {
                sample_rate: 48000,
                channels: 2,
                codec: "opus".to_string(),
                bitrate: Some(192_000),
            }),
        );

        let command = build_import_command("clip.ogg", "/tmp/clip.ogg", Some(&media_info));
        assert_eq!(command.asset.kind, AssetKind::Video);
    }

    #[test]
    fn test_build_import_command_promotes_unknown_extension_audio_when_no_video_stream_exists() {
        let media_info = mock_media_info(
            None,
            Some(crate::core::ffmpeg::AudioStreamInfo {
                sample_rate: 48000,
                channels: 1,
                codec: "pcm_s16le".to_string(),
                bitrate: None,
            }),
        );

        let command = build_import_command("voice.track", "/tmp/voice.track", Some(&media_info));
        assert_eq!(command.asset.kind, AssetKind::Audio);
    }
}

/// Gets all assets in the project
#[tauri::command]
#[specta::specta]
pub async fn get_assets(state: State<'_, AppState>) -> Result<Vec<Asset>, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    Ok(project.state.assets.values().cloned().collect())
}

/// Generates thumbnail for an asset and updates the asset's thumbnail URL
#[tauri::command]
#[specta::specta]
pub async fn generate_asset_thumbnail(
    asset_id: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
) -> Result<Option<String>, String> {
    use crate::core::assets::thumbnail::{asset_kind_from_path, ThumbnailService};
    use std::path::Path;

    validate_path_id_component(&asset_id, "assetId")?;

    // Get asset info from state
    let (asset_path, asset_kind, project_path) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        let path = Path::new(&asset.uri);
        let kind = asset_kind_from_path(path);

        (asset.uri.clone(), kind, project.path.clone())
    };

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard
        .runner()
        .ok_or_else(|| "FFmpeg not initialized".to_string())?;

    // Create thumbnail service
    let thumbnail_service = ThumbnailService::new(project_path, ffmpeg.clone());
    let asset_path = Path::new(&asset_path);

    // Generate thumbnail
    let result = thumbnail_service
        .generate_for_asset(&asset_id, asset_path, &asset_kind)
        .await;

    match result {
        Ok(thumb_path) => {
            let thumb_url = thumbnail_service.thumbnail_url(&asset_id);

            // Update asset's thumbnail URL in state
            if let Some(url) = &thumb_url {
                let mut guard = state.project.lock().await;

                if let Some(project) = guard.as_mut() {
                    let cmd = UpdateAssetCommand::new(&asset_id)
                        .with_thumbnail_url(Some(url.to_string()));
                    if let Err(e) = project
                        .executor
                        .execute_without_history(Box::new(cmd), &mut project.state)
                    {
                        tracing::warn!(
                            "Failed to persist thumbnail URL for asset {}: {}",
                            asset_id,
                            e
                        );
                    }
                }
            }

            tracing::info!(
                "Generated thumbnail for asset {}: {:?}",
                asset_id,
                thumb_path
            );
            Ok(thumb_url)
        }
        Err(e) => {
            tracing::warn!("Failed to generate thumbnail for {}: {}", asset_id, e);
            Ok(None)
        }
    }
}

/// Generates a proxy video for an asset for smooth preview playback
#[tauri::command]
#[specta::specta]
pub async fn generate_proxy_for_asset(
    asset_id: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri::Emitter;

    validate_path_id_component(&asset_id, "assetId")?;

    // Get asset info from state
    let (asset_path, project_path) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        (asset.uri.clone(), project.path.clone())
    };

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard
        .runner()
        .ok_or_else(|| "FFmpeg not initialized".to_string())?;

    // Create proxy directory
    let proxy_dir = project_path.join(".openreelio").join("proxy");
    tokio::fs::create_dir_all(&proxy_dir)
        .await
        .map_err(|e| format!("Failed to create proxy directory: {}", e))?;

    // Output path for proxy
    let proxy_path = proxy_dir.join(format!("{}.mp4", asset_id));
    let input_path = std::path::Path::new(&asset_path);

    // Create progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<FFmpegProgress>(100);
    let asset_id_clone = asset_id.clone();
    let app_handle_clone = app_handle.clone();

    // Emit canonical proxy-start event (frontend listens to `asset:proxy-*`).
    // This command is a legacy/manual path (not the job-worker proxy pipeline).
    let _ = app_handle.emit(
        "asset:proxy-generating",
        serde_json::json!({
            "assetId": asset_id.clone(),
            "jobId": "manual-ffmpeg"
        }),
    );

    // Spawn legacy progress forwarding task
    tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            let _ = app_handle_clone.emit(
                "proxy-progress",
                serde_json::json!({
                    "assetId": asset_id_clone,
                    "percent": progress.percent,
                    "frame": progress.frame,
                    "totalFrames": progress.total_frames,
                    "fps": progress.fps,
                    "etaSeconds": progress.eta_seconds,
                }),
            );
        }
    });

    // Generate proxy
    match ffmpeg
        .generate_proxy(input_path, &proxy_path, Some(progress_tx))
        .await
    {
        Ok(()) => {
            // Return raw file path; frontend converts to asset protocol via convertFileSrc().
            let proxy_url = proxy_path.to_string_lossy().to_string();

            // Update asset's proxy URL in state
            {
                let mut guard = state.project.lock().await;

                if let Some(project) = guard.as_mut() {
                    let cmd = UpdateAssetCommand::new(&asset_id)
                        .with_proxy_status(crate::core::assets::ProxyStatus::Ready)
                        .with_proxy_url(Some(proxy_url.clone()));
                    if let Err(e) = project
                        .executor
                        .execute_without_history(Box::new(cmd), &mut project.state)
                    {
                        tracing::warn!("Failed to persist proxy URL for asset {}: {}", asset_id, e);
                    }
                }
            }

            tracing::info!("Generated proxy for asset {}: {:?}", asset_id, proxy_path);

            // Emit canonical completion event
            let _ = app_handle.emit(
                "asset:proxy-ready",
                serde_json::json!({
                    "assetId": asset_id.clone(),
                    "proxyPath": proxy_path.display().to_string(),
                    "proxyUrl": proxy_url.clone(),
                }),
            );

            // Emit legacy completion event
            let _ = app_handle.emit(
                "proxy-complete",
                serde_json::json!({
                    "assetId": asset_id.clone(),
                    "proxyUrl": proxy_url.clone(),
                }),
            );

            Ok(Some(proxy_url))
        }
        Err(e) => {
            tracing::warn!("Failed to generate proxy for {}: {}", asset_id, e);

            // Emit canonical error event
            let _ = app_handle.emit(
                "asset:proxy-failed",
                serde_json::json!({
                    "assetId": asset_id.clone(),
                    "error": e.to_string(),
                }),
            );

            // Emit legacy error event
            let _ = app_handle.emit(
                "proxy-error",
                serde_json::json!({
                    "assetId": asset_id.clone(),
                    "error": e.to_string(),
                }),
            );

            Err(format!("Proxy generation failed: {}", e))
        }
    }
}

/// Updates the proxy status and URL for an asset
///
/// Called by the frontend when receiving `asset:proxy-ready` or `asset:proxy-failed` events.
#[tauri::command]
#[specta::specta]
pub async fn update_asset_proxy(
    asset_id: String,
    proxy_url: Option<String>,
    proxy_status: ProxyStatus,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_path_id_component(&asset_id, "assetId")?;

    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let mut cmd = UpdateAssetCommand::new(&asset_id).with_proxy_status(proxy_status.clone());
    if let Some(url) = proxy_url {
        cmd = cmd.with_proxy_url(Some(url));
    }

    project
        .executor
        .execute_without_history(Box::new(cmd), &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    tracing::info!(
        "Updated asset {} proxy status to {:?}",
        asset_id,
        proxy_status
    );

    Ok(())
}

/// Gets waveform peak data for an asset.
///
/// Returns normalized peak values (0.0 - 1.0) for audio visualization.
/// Returns None if waveform has not been generated yet.
#[tauri::command]
#[specta::specta]
pub async fn get_waveform_data(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Option<crate::core::ffmpeg::WaveformData>, String> {
    validate_path_id_component(&asset_id, "assetId")?;

    // Get project path and verify asset exists.
    let project_path = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        if !project.state.assets.contains_key(&asset_id) {
            return Ok(None);
        }

        project.path.clone()
    };

    // Check cache directory for waveform JSON
    let waveform_path = project_path
        .join(".openreelio")
        .join("cache")
        .join("waveforms")
        .join(format!("{}.json", asset_id));

    if !waveform_path.exists() {
        return Ok(None);
    }

    // Read and parse waveform JSON
    let json = tokio::fs::read_to_string(&waveform_path)
        .await
        .map_err(|e| format!("Failed to read waveform file: {}", e))?;

    let waveform: crate::core::ffmpeg::WaveformData =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse waveform JSON: {}", e))?;

    Ok(Some(waveform))
}

/// Generates waveform peak data for an asset.
///
/// Extracts audio peaks from the asset and saves as JSON.
/// Emits `waveform-complete` event on success, `waveform-error` on failure.
#[tauri::command]
#[specta::specta]
pub async fn generate_waveform_for_asset(
    asset_id: String,
    samples_per_second: Option<u32>,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<Option<crate::core::ffmpeg::WaveformData>, String> {
    use tauri::Emitter;

    validate_path_id_component(&asset_id, "assetId")?;

    // Get asset info from state
    let (asset_path, project_path) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        (asset.uri.clone(), project.path.clone())
    };

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard
        .runner()
        .ok_or_else(|| "FFmpeg not initialized".to_string())?;

    // Create waveform cache directory
    let cache_dir = project_path
        .join(".openreelio")
        .join("cache")
        .join("waveforms");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("Failed to create waveform cache directory: {}", e))?;

    // Output path for waveform JSON
    let waveform_path = cache_dir.join(format!("{}.json", asset_id));
    let input_path = std::path::Path::new(&asset_path);
    let sps = samples_per_second.unwrap_or(100);

    // Emit generating event
    let _ = app_handle.emit(
        "waveform-generating",
        serde_json::json!({
            "assetId": asset_id,
        }),
    );

    // Generate waveform
    match ffmpeg
        .generate_waveform_json(input_path, &waveform_path, sps)
        .await
    {
        Ok(waveform) => {
            tracing::info!(
                "Generated waveform for asset {}: {:?}",
                asset_id,
                waveform_path
            );

            // Emit completion event
            let _ = app_handle.emit(
                "waveform-complete",
                serde_json::json!({
                    "assetId": asset_id,
                    "samplesPerSecond": waveform.samples_per_second,
                    "peakCount": waveform.peaks.len(),
                    "durationSec": waveform.duration_sec,
                }),
            );

            Ok(Some(waveform))
        }
        Err(e) => {
            tracing::warn!("Failed to generate waveform for {}: {}", asset_id, e);

            // Emit error event
            let _ = app_handle.emit(
                "waveform-error",
                serde_json::json!({
                    "assetId": asset_id,
                    "error": e.to_string(),
                }),
            );

            Err(format!("Waveform generation failed: {}", e))
        }
    }
}

/// Ensures a browser-decodable audio preview file exists for an asset.
///
/// Generates an MP3 cache file on demand for audio/video assets whose original
/// container or codec may not decode reliably in the embedded webview.
#[tauri::command]
#[specta::specta]
pub async fn ensure_audio_preview_for_asset(
    asset_id: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
) -> Result<Option<String>, String> {
    validate_path_id_component(&asset_id, "assetId")?;

    let (asset_path, project_path, asset_kind) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        (asset.uri.clone(), project.path.clone(), asset.kind.clone())
    };

    if !matches!(asset_kind, AssetKind::Audio | AssetKind::Video) {
        return Ok(None);
    }

    let input_path = PathBuf::from(&asset_path);
    let preview_dir = project_path
        .join(".openreelio")
        .join("cache")
        .join("audio_previews");
    tokio::fs::create_dir_all(&preview_dir)
        .await
        .map_err(|e| format!("Failed to create audio preview cache directory: {}", e))?;

    let preview_path = preview_dir.join(format!("{}.mp3", asset_id));

    let input_metadata = tokio::fs::metadata(&input_path)
        .await
        .map_err(|e| format!("Failed to stat asset for audio preview: {}", e))?;

    let preview_is_fresh = match tokio::fs::metadata(&preview_path).await {
        Ok(metadata) if metadata.len() > 0 => {
            let preview_modified = metadata.modified().ok();
            let input_modified = input_metadata.modified().ok();
            preview_modified
                .zip(input_modified)
                .map(|(preview, input)| preview >= input)
                == Some(true)
        }
        _ => false,
    };

    if !preview_is_fresh {
        let ffmpeg_guard = ffmpeg_state.read().await;
        let ffmpeg = ffmpeg_guard
            .runner()
            .ok_or_else(|| "FFmpeg not initialized".to_string())?;
        let temp_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let temp_preview_path = preview_dir.join(format!("{}.{}.tmp.mp3", asset_id, temp_suffix));
        let input_path_string = input_path.to_string_lossy().to_string();
        let temp_preview_path_string = temp_preview_path.to_string_lossy().to_string();

        let mut cmd = tokio::process::Command::new(&ffmpeg.info().ffmpeg_path);
        crate::core::process::configure_tokio_command(&mut cmd);
        cmd.args([
            "-v",
            "error",
            "-i",
            &input_path_string,
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            "-y",
            &temp_preview_path_string,
        ]);

        let output = cmd
            .output()
            .await
            .map_err(|e| format!("Failed to generate audio preview: {}", e))?;

        if !output.status.success() {
            let _ = tokio::fs::remove_file(&temp_preview_path).await;
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Audio preview generation failed: {}",
                stderr.trim()
            ));
        }

        let _ = tokio::fs::remove_file(&preview_path).await;
        tokio::fs::rename(&temp_preview_path, &preview_path)
            .await
            .map_err(|e| format!("Failed to finalize audio preview: {}", e))?;
    }

    state.allow_asset_protocol_file(&preview_path);
    Ok(Some(preview_path.to_string_lossy().to_string()))
}

/// Removes an asset from the project
#[tauri::command]
#[specta::specta]
pub async fn remove_asset(asset_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let project_path = project.path.clone();

    let command = RemoveAssetCommand::new(&asset_id);
    project
        .executor
        .execute(Box::new(command), &mut project.state)
        .map_err(|e| e.to_ipc_error())?;

    // Keep workspace registration index in sync. This prevents stale `assetId`
    // references in the Files tab after asset deletion.
    if let Ok(service) = crate::core::workspace::service::WorkspaceService::open(project_path) {
        if let Err(e) = service.index().unmark_registered_by_asset_id(&asset_id) {
            tracing::warn!(
                asset_id = %asset_id,
                error = %e,
                "Failed to clear workspace registration after asset removal"
            );
        }
    }

    Ok(())
}

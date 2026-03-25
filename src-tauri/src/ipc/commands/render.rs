//! Render/export commands
//!
//! Tauri IPC commands for starting final render exports,
//! batch rendering, range-based rendering, and render cancellation.

use specta::Type;
use tauri::State;

use crate::core::{
    fs::{default_export_allowed_roots, validate_scoped_output_path},
    render::{
        cancel_render_job, register_render_job, unregister_render_job, AudioExportFormat,
        ExportError, ExportPreset, ImageFormat,
    },
    CoreError,
};
use crate::AppState;

// =============================================================================
// DTOs
// =============================================================================

/// Result of starting a render export job.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderStartResult {
    /// Job ID for tracking render progress
    pub job_id: String,
    /// Output file path
    pub output_path: String,
    /// Initial status ("started")
    pub status: String,
}

/// A single item in a batch render request (IPC DTO).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenderItemDto {
    /// Export preset identifier (e.g., "youtube_1080p")
    pub preset: String,
    /// Output file path for this render
    pub output_path: String,
    /// Optional In point in seconds for range export
    pub in_point: Option<f64>,
    /// Optional Out point in seconds for range export
    pub out_point: Option<f64>,
}

/// Result returned when a batch render is started.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenderStartResult {
    /// Unique identifier for the entire batch
    pub batch_id: String,
    /// Job IDs for each item (same order as input items)
    pub job_ids: Vec<String>,
    /// Total number of items in the batch
    pub total_items: u32,
    /// Initial status ("started")
    pub status: String,
}

/// Result of a render cancellation request.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CancelRenderResult {
    /// The job ID that was cancelled
    pub job_id: String,
    /// Whether the job was found and cancelled
    pub cancelled: bool,
}

/// Result of a single-frame export.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FrameExportResultDto {
    /// Output file path
    pub output_path: String,
    /// File size in bytes
    pub file_size: u64,
    /// Image format used ("png", "jpeg", "tiff")
    pub format: String,
    /// Width of the exported image in pixels
    pub width: u32,
    /// Height of the exported image in pixels
    pub height: u32,
}

// =============================================================================
// Helpers
// =============================================================================

/// Parse a preset string into an ExportPreset enum.
fn parse_export_preset(preset: &str) -> ExportPreset {
    match preset.to_lowercase().as_str() {
        "youtube_1080p" | "youtube1080p" => ExportPreset::Youtube1080p,
        "youtube_4k" | "youtube4k" => ExportPreset::Youtube4k,
        "youtube_shorts" | "youtubeshorts" => ExportPreset::YoutubeShorts,
        "twitter" => ExportPreset::Twitter,
        "instagram" => ExportPreset::Instagram,
        "webm" | "webm_vp9" => ExportPreset::WebmVp9,
        "prores" => ExportPreset::ProRes,
        other => {
            tracing::warn!(
                "Unknown export preset '{}', defaulting to youtube_1080p",
                other
            );
            ExportPreset::Youtube1080p
        }
    }
}

// =============================================================================
// Commands
// =============================================================================

/// Starts final render export
///
/// This command validates the export settings before starting the render,
/// and reports real-time progress via Tauri events.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, ffmpeg_state, app_handle), fields(sequence_id = %sequence_id, preset = %preset, output_path = %output_path))]
pub async fn start_render(
    sequence_id: String,
    output_path: String,
    preset: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<RenderStartResult, String> {
    use crate::core::render::{
        validate_export_settings, ExportEngine, ExportProgress, ExportSettings,
    };
    use tauri::Emitter;

    // Get sequence/assets/effects + project path from project state
    let (sequence, assets, effects, project_path) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?
            .clone();

        let assets: std::collections::HashMap<String, crate::core::assets::Asset> = project
            .state
            .assets
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let effects: std::collections::HashMap<String, crate::core::effects::Effect> = project
            .state
            .effects
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        (sequence, assets, effects, project.path.clone())
    };

    // Validate output path within allowed roots (defense-in-depth for compromised renderer).
    let roots = default_export_allowed_roots(&project_path);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    let validated_output_path =
        validate_scoped_output_path(&output_path, "Output path", &root_refs)?;
    tracing::debug!(
        "Validated output path: {} (allowedRoots={})",
        validated_output_path.display(),
        root_refs
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    // Parse preset
    let export_preset = parse_export_preset(&preset);

    // Create export settings using validated path
    let mut settings = ExportSettings::from_preset(export_preset, validated_output_path.clone());

    // Resolve hardware encoder (Auto mode: use best available GPU, fallback to CPU)
    let available_encoders =
        crate::core::render::detect_available_encoders(&ffmpeg.info().ffmpeg_path);
    settings.resolved_encoder_name = Some(crate::core::render::resolve_video_encoder(
        &settings.video_codec,
        &settings.hardware_accel,
        &available_encoders,
    ));
    tracing::info!(
        "Resolved video encoder: {} (hardware_accel={:?})",
        settings
            .resolved_encoder_name
            .as_deref()
            .unwrap_or("unknown"),
        settings.hardware_accel
    );

    // Validate export settings before starting
    let validation = validate_export_settings(&sequence, &assets, &effects, &settings);
    if !validation.is_valid {
        let error_msg = validation.errors.join("; ");
        return Err(format!("Export validation failed: {}", error_msg));
    }

    // Log warnings but continue
    for warning in &validation.warnings {
        tracing::warn!("Export warning: {}", warning);
    }

    // Create export engine
    let engine = ExportEngine::new(ffmpeg.clone());
    let job_id = ulid::Ulid::new().to_string();
    let job_id_clone = job_id.clone();
    let job_id_for_return = job_id.clone();

    // Register cancel token for this job
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    register_render_job(&job_id, cancel_tx).await;

    // Create progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<ExportProgress>(100);
    let app_handle_clone = app_handle.clone();

    // Spawn progress forwarding task
    tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            let _ = app_handle_clone.emit(
                "render-progress",
                serde_json::json!({
                    "jobId": job_id_clone,
                    "frame": progress.frame,
                    "totalFrames": progress.total_frames,
                    "percent": progress.percent,
                    "fps": progress.fps,
                    "etaSeconds": progress.eta_seconds,
                    "message": progress.message,
                }),
            );
        }
    });

    // Spawn export task in background to not block IPC
    let sequence_clone = sequence.clone();
    let assets_clone = assets.clone();
    let settings_clone = settings.clone();
    let app_handle_for_task = app_handle.clone();
    let job_id_for_task = job_id.clone();

    tokio::spawn(async move {
        match engine
            .export_sequence_with_effects(
                &sequence_clone,
                &assets_clone,
                &effects,
                &settings_clone,
                Some(progress_tx),
                Some(cancel_rx),
            )
            .await
        {
            Ok(result) => {
                unregister_render_job(&job_id_for_task).await;
                tracing::info!(
                    "Export completed: {} ({:.1}s, {} bytes)",
                    result.output_path.display(),
                    result.encoding_time_sec,
                    result.file_size
                );

                let _ = app_handle_for_task.emit(
                    "render-complete",
                    serde_json::json!({
                        "jobId": job_id_for_task,
                        "outputPath": result.output_path.to_string_lossy().to_string(),
                        "durationSec": result.duration_sec,
                        "fileSize": result.file_size,
                        "encodingTimeSec": result.encoding_time_sec,
                    }),
                );
            }
            Err(e) => {
                unregister_render_job(&job_id_for_task).await;
                tracing::error!("Export failed: {}", e);

                let _ = app_handle_for_task.emit(
                    "render-error",
                    serde_json::json!({
                        "jobId": job_id_for_task,
                        "error": e.to_string(),
                    }),
                );
            }
        }
    });

    // Return immediately with job ID - completion will be via events
    Ok(RenderStartResult {
        job_id: job_id_for_return,
        output_path,
        status: "started".to_string(),
    })
}

// =============================================================================
// Render Range Command
// =============================================================================

/// Starts a render export of a specific time range within the sequence.
///
/// Uses `in_point` and `out_point` (in seconds) to restrict the export
/// to a portion of the timeline. Reports progress via Tauri events.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(skip(state, ffmpeg_state, app_handle), fields(sequence_id = %sequence_id, preset = %preset))]
pub async fn render_range(
    sequence_id: String,
    output_path: String,
    preset: String,
    in_point: f64,
    out_point: f64,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<RenderStartResult, String> {
    use crate::core::render::{
        validate_export_settings, ExportEngine, ExportProgress, ExportSettings,
    };
    use tauri::Emitter;

    // Validate range
    if in_point >= out_point {
        return Err("In point must be before Out point".to_string());
    }
    if in_point < 0.0 {
        return Err("In point must be non-negative".to_string());
    }

    // Get sequence/assets/effects + project path
    let (sequence, assets, effects, project_path) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?
            .clone();

        let assets: std::collections::HashMap<String, crate::core::assets::Asset> = project
            .state
            .assets
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let effects: std::collections::HashMap<String, crate::core::effects::Effect> = project
            .state
            .effects
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        (sequence, assets, effects, project.path.clone())
    };

    // Validate output path
    let roots = default_export_allowed_roots(&project_path);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    let validated_output_path =
        validate_scoped_output_path(&output_path, "Output path", &root_refs)?;

    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    // Build settings with range
    let export_preset = parse_export_preset(&preset);
    let mut settings = ExportSettings::from_preset(export_preset, validated_output_path);
    settings.start_time = Some(in_point);
    settings.end_time = Some(out_point);

    // Resolve hardware encoder
    let available_encoders =
        crate::core::render::detect_available_encoders(&ffmpeg.info().ffmpeg_path);
    settings.resolved_encoder_name = Some(crate::core::render::resolve_video_encoder(
        &settings.video_codec,
        &settings.hardware_accel,
        &available_encoders,
    ));

    let validation = validate_export_settings(&sequence, &assets, &effects, &settings);
    if !validation.is_valid {
        return Err(format!(
            "Export validation failed: {}",
            validation.errors.join("; ")
        ));
    }

    let engine = ExportEngine::new(ffmpeg.clone());
    let job_id = ulid::Ulid::new().to_string();
    let job_id_for_return = job_id.clone();

    // Register cancel token
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    register_render_job(&job_id, cancel_tx).await;

    // Progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<ExportProgress>(100);
    let app_handle_progress = app_handle.clone();
    let job_id_progress = job_id.clone();

    tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            let _ = app_handle_progress.emit(
                "render-progress",
                serde_json::json!({
                    "jobId": job_id_progress,
                    "frame": progress.frame,
                    "totalFrames": progress.total_frames,
                    "percent": progress.percent,
                    "fps": progress.fps,
                    "etaSeconds": progress.eta_seconds,
                    "message": progress.message,
                }),
            );
        }
    });

    let app_handle_task = app_handle.clone();
    let job_id_task = job_id.clone();

    tokio::spawn(async move {
        match engine
            .export_sequence_with_effects(
                &sequence,
                &assets,
                &effects,
                &settings,
                Some(progress_tx),
                Some(cancel_rx),
            )
            .await
        {
            Ok(result) => {
                unregister_render_job(&job_id_task).await;
                let _ = app_handle_task.emit(
                    "render-complete",
                    serde_json::json!({
                        "jobId": job_id_task,
                        "outputPath": result.output_path.to_string_lossy().to_string(),
                        "durationSec": result.duration_sec,
                        "fileSize": result.file_size,
                        "encodingTimeSec": result.encoding_time_sec,
                    }),
                );
            }
            Err(e) => {
                unregister_render_job(&job_id_task).await;
                let _ = app_handle_task.emit(
                    "render-error",
                    serde_json::json!({
                        "jobId": job_id_task,
                        "error": e.to_string(),
                    }),
                );
            }
        }
    });

    Ok(RenderStartResult {
        job_id: job_id_for_return,
        output_path,
        status: "started".to_string(),
    })
}

// =============================================================================
// Batch Render Command
// =============================================================================

/// Starts a batch render that processes multiple export items sequentially.
///
/// Each item can have its own preset, output path, and optional range.
/// Progress and completion events are emitted per-item and for the overall batch.
///
/// # Events emitted
/// - `batch-render-progress`: Per-item progress with batch-level context
/// - `batch-item-complete`: Fired when a single item finishes (success/fail/cancel)
/// - `batch-render-complete`: Fired when all items in the batch are done
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, ffmpeg_state, app_handle), fields(sequence_id = %sequence_id, item_count = items.len()))]
pub async fn batch_render(
    sequence_id: String,
    items: Vec<BatchRenderItemDto>,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<BatchRenderStartResult, String> {
    use crate::core::render::{
        validate_export_settings, ExportEngine, ExportProgress, ExportSettings,
    };
    use tauri::Emitter;

    if items.is_empty() {
        return Err("Batch render requires at least one item".to_string());
    }

    // Get project state (shared across all batch items)
    let (sequence, assets, effects, project_path) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?
            .clone();

        let assets: std::collections::HashMap<String, crate::core::assets::Asset> = project
            .state
            .assets
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let effects: std::collections::HashMap<String, crate::core::effects::Effect> = project
            .state
            .effects
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        (sequence, assets, effects, project.path.clone())
    };

    // Validate all output paths upfront before starting any renders
    let roots = default_export_allowed_roots(&project_path);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();

    let mut validated_items: Vec<(ExportSettings, String)> = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let validated_path = validate_scoped_output_path(
            &item.output_path,
            &format!("Batch item {} output path", i),
            &root_refs,
        )?;

        let export_preset = parse_export_preset(&item.preset);
        let mut settings = ExportSettings::from_preset(export_preset, validated_path);
        settings.start_time = item.in_point;
        settings.end_time = item.out_point;

        // Validate range if provided
        if let (Some(in_pt), Some(out_pt)) = (item.in_point, item.out_point) {
            if in_pt >= out_pt {
                return Err(format!(
                    "Batch item {}: In point must be before Out point",
                    i
                ));
            }
        }

        let validation = validate_export_settings(&sequence, &assets, &effects, &settings);
        if !validation.is_valid {
            return Err(format!(
                "Batch item {} validation failed: {}",
                i,
                validation.errors.join("; ")
            ));
        }

        validated_items.push((settings, item.output_path.clone()));
    }

    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    // Resolve hardware encoder for all batch items
    let available_encoders =
        crate::core::render::detect_available_encoders(&ffmpeg.info().ffmpeg_path);
    for (settings, _) in &mut validated_items {
        settings.resolved_encoder_name = Some(crate::core::render::resolve_video_encoder(
            &settings.video_codec,
            &settings.hardware_accel,
            &available_encoders,
        ));
    }

    // Generate batch ID and per-item job IDs
    let batch_id = ulid::Ulid::new().to_string();
    let total_items = validated_items.len() as u32;
    let job_ids: Vec<String> = (0..total_items)
        .map(|_| ulid::Ulid::new().to_string())
        .collect();

    let result = BatchRenderStartResult {
        batch_id: batch_id.clone(),
        job_ids: job_ids.clone(),
        total_items,
        status: "started".to_string(),
    };

    // Spawn the sequential batch processing task
    let engine = ExportEngine::new(ffmpeg.clone());

    tokio::spawn(async move {
        let mut completed_results: Vec<serde_json::Value> = Vec::new();

        for (idx, ((settings, output_path_str), job_id)) in
            validated_items.into_iter().zip(job_ids.iter()).enumerate()
        {
            let item_index = idx as u32;

            // Register cancel token for this item
            let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
            register_render_job(job_id, cancel_tx).await;

            // Progress channel for this item
            let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<ExportProgress>(100);
            let app_handle_progress = app_handle.clone();
            let batch_id_progress = batch_id.clone();
            let job_id_progress = job_id.clone();
            let total = total_items;

            // Forward per-item progress as batch-render-progress events
            let progress_task = tokio::spawn(async move {
                while let Some(progress) = progress_rx.recv().await {
                    // Calculate overall batch progress:
                    // completed items + fraction of current item
                    let batch_percent =
                        ((item_index as f32) + (progress.percent / 100.0)) / (total as f32) * 100.0;

                    let _ = app_handle_progress.emit(
                        "batch-render-progress",
                        serde_json::json!({
                            "batchId": batch_id_progress,
                            "jobId": job_id_progress,
                            "currentItem": item_index,
                            "totalItems": total,
                            "itemPercent": progress.percent,
                            "batchPercent": batch_percent,
                            "fps": progress.fps,
                            "etaSeconds": progress.eta_seconds,
                            "message": progress.message,
                        }),
                    );
                }
            });

            // Execute render
            let render_result = engine
                .export_sequence_with_effects(
                    &sequence,
                    &assets,
                    &effects,
                    &settings,
                    Some(progress_tx),
                    Some(cancel_rx),
                )
                .await;

            // Wait for progress task to drain
            let _ = progress_task.await;
            unregister_render_job(job_id).await;

            // Emit per-item completion
            let item_result = match render_result {
                Ok(ref export_result) => {
                    serde_json::json!({
                        "batchId": batch_id,
                        "jobId": job_id,
                        "itemIndex": item_index,
                        "totalItems": total_items,
                        "status": "completed",
                        "outputPath": export_result.output_path.to_string_lossy().to_string(),
                        "durationSec": export_result.duration_sec,
                        "fileSize": export_result.file_size,
                        "encodingTimeSec": export_result.encoding_time_sec,
                    })
                }
                Err(ref e) => {
                    let status = if matches!(e, ExportError::Cancelled) {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    serde_json::json!({
                        "batchId": batch_id,
                        "jobId": job_id,
                        "itemIndex": item_index,
                        "totalItems": total_items,
                        "status": status,
                        "outputPath": output_path_str,
                        "error": e.to_string(),
                    })
                }
            };

            let _ = app_handle.emit("batch-item-complete", &item_result);
            completed_results.push(item_result);
        }

        // Emit batch completion
        let _ = app_handle.emit(
            "batch-render-complete",
            serde_json::json!({
                "batchId": batch_id,
                "totalItems": total_items,
                "results": completed_results,
            }),
        );
    });

    Ok(result)
}

// =============================================================================
// Cancel Render Command
// =============================================================================

/// Cancels a render job by its job ID.
///
/// Works for both single renders and individual items within a batch.
/// If the job is currently encoding, the FFmpeg process is killed.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(fields(job_id = %job_id))]
pub async fn cancel_render(job_id: String) -> Result<CancelRenderResult, String> {
    let cancelled = cancel_render_job(&job_id).await;

    if cancelled {
        tracing::info!("Render job cancelled: {}", job_id);
    } else {
        tracing::warn!("Render job not found for cancellation: {}", job_id);
    }

    Ok(CancelRenderResult { job_id, cancelled })
}

// =============================================================================
// Export Frame Command
// =============================================================================

/// Exports a single frame from a sequence at the specified time position.
///
/// Captures the topmost visible video clip at the given time and saves it
/// as a still image (PNG, JPEG, or TIFF).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, ffmpeg_state), fields(sequence_id = %sequence_id, time_sec = %time_sec))]
pub async fn export_frame(
    sequence_id: String,
    time_sec: f64,
    format: String,
    output_path: String,
    quality: Option<u8>,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
) -> Result<FrameExportResultDto, String> {
    use crate::core::render::{ExportEngine, FrameExportSettings};

    // Parse format
    let image_format = match format.to_lowercase().as_str() {
        "png" => ImageFormat::Png,
        "jpeg" | "jpg" => ImageFormat::Jpeg,
        "tiff" | "tif" => ImageFormat::Tiff,
        _ => return Err(format!("Unsupported image format: {}", format)),
    };

    // Get sequence, assets, and project path from project state (single lock)
    let (sequence, assets, project_path) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?
            .clone();

        let assets: std::collections::HashMap<String, crate::core::assets::Asset> = project
            .state
            .assets
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let project_path = project.path.clone();

        (sequence, assets, project_path)
    };
    let roots = default_export_allowed_roots(&project_path);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    let validated_output_path =
        validate_scoped_output_path(&output_path, "Output path", &root_refs)?;

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    let engine = ExportEngine::new(ffmpeg.clone());
    let settings = FrameExportSettings {
        time_sec,
        format: image_format,
        output_path: validated_output_path,
        quality,
    };

    let result = engine
        .export_frame(&sequence, &assets, &settings)
        .await
        .map_err(|e| e.to_string())?;

    Ok(FrameExportResultDto {
        output_path: result.output_path.to_string_lossy().to_string(),
        file_size: result.file_size,
        format: result.format.extension().to_string(),
        width: result.width,
        height: result.height,
    })
}

// =============================================================================
// Export Audio Only Command
// =============================================================================

/// Exports audio only from a sequence (no video).
///
/// Renders all audio tracks mixed down to a single audio file.
/// Supports WAV, MP3, and FLAC output formats. Reports progress via
/// Tauri events using the same `render-progress` event pattern.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(skip(state, ffmpeg_state, app_handle), fields(sequence_id = %sequence_id, format = %format))]
pub async fn export_audio_only(
    sequence_id: String,
    format: String,
    output_path: String,
    bitrate: Option<String>,
    sample_rate: Option<u32>,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<RenderStartResult, String> {
    use crate::core::render::{AudioExportSettings, ExportEngine, ExportProgress};
    use tauri::Emitter;

    // Parse format
    let audio_format = match format.to_lowercase().as_str() {
        "wav" => AudioExportFormat::Wav,
        "mp3" => AudioExportFormat::Mp3,
        "flac" => AudioExportFormat::Flac,
        _ => return Err(format!("Unsupported audio format: {}", format)),
    };

    // Get sequence/assets/effects + project path
    let (sequence, assets, effects, project_path) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?
            .clone();

        let assets: std::collections::HashMap<String, crate::core::assets::Asset> = project
            .state
            .assets
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let effects: std::collections::HashMap<String, crate::core::effects::Effect> = project
            .state
            .effects
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        (sequence, assets, effects, project.path.clone())
    };

    // Validate output path
    let roots = default_export_allowed_roots(&project_path);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    let validated_output_path =
        validate_scoped_output_path(&output_path, "Output path", &root_refs)?;

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    let engine = ExportEngine::new(ffmpeg.clone());
    let audio_settings = AudioExportSettings {
        format: audio_format,
        output_path: validated_output_path,
        bitrate,
        sample_rate,
        start_time: None,
        end_time: None,
    };

    let job_id = ulid::Ulid::new().to_string();
    let job_id_for_return = job_id.clone();

    // Register cancel token
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    register_render_job(&job_id, cancel_tx).await;

    // Progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<ExportProgress>(100);
    let app_handle_progress = app_handle.clone();
    let job_id_progress = job_id.clone();

    tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            let _ = app_handle_progress.emit(
                "render-progress",
                serde_json::json!({
                    "jobId": job_id_progress,
                    "frame": progress.frame,
                    "totalFrames": progress.total_frames,
                    "percent": progress.percent,
                    "fps": progress.fps,
                    "etaSeconds": progress.eta_seconds,
                    "message": progress.message,
                }),
            );
        }
    });

    let app_handle_task = app_handle.clone();
    let job_id_task = job_id.clone();

    tokio::spawn(async move {
        match engine
            .export_audio_only(
                &sequence,
                &assets,
                &effects,
                &audio_settings,
                Some(progress_tx),
                Some(cancel_rx),
            )
            .await
        {
            Ok(result) => {
                unregister_render_job(&job_id_task).await;
                tracing::info!(
                    "Audio export completed: {} ({:.1}s, {} bytes)",
                    result.output_path.display(),
                    result.encoding_time_sec,
                    result.file_size
                );

                let _ = app_handle_task.emit(
                    "render-complete",
                    serde_json::json!({
                        "jobId": job_id_task,
                        "outputPath": result.output_path.to_string_lossy().to_string(),
                        "durationSec": result.duration_sec,
                        "fileSize": result.file_size,
                        "encodingTimeSec": result.encoding_time_sec,
                    }),
                );
            }
            Err(e) => {
                unregister_render_job(&job_id_task).await;
                tracing::error!("Audio export failed: {}", e);

                let _ = app_handle_task.emit(
                    "render-error",
                    serde_json::json!({
                        "jobId": job_id_task,
                        "error": e.to_string(),
                    }),
                );
            }
        }
    });

    Ok(RenderStartResult {
        job_id: job_id_for_return,
        output_path,
        status: "started".to_string(),
    })
}

// =============================================================================
// Hardware Encoder Detection
// =============================================================================

/// Detect available hardware video encoders (NVENC, QSV, AMF, VideoToolbox).
///
/// Probes the FFmpeg installation for GPU-accelerated encoders.
/// Returns information about which hardware backends are available.
#[tauri::command]
#[specta::specta]
pub async fn get_available_encoders(
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
) -> Result<crate::core::render::AvailableEncoders, String> {
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    let info = ffmpeg.info();
    Ok(crate::core::render::detect_available_encoders(
        &info.ffmpeg_path,
    ))
}

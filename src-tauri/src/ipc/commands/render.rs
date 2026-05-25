//! Render/export commands
//!
//! Tauri IPC commands for starting final render exports,
//! batch rendering, range-based rendering, and render cancellation.

use specta::Type;
use tauri::State;

use crate::core::{
    fs::{default_export_allowed_roots, validate_local_input_path, validate_scoped_output_path},
    render::{
        cancel_render_job, register_render_job, unregister_render_job, AudioExportFormat,
        ExportError, ExportPreset, ImageFormat, VideoExportRequest,
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
    /// Optional structured export settings. If omitted, `preset` is used for
    /// legacy compatibility.
    #[serde(default)]
    pub settings: Option<VideoExportRequest>,
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

/// Render lifecycle category.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RenderLifecycleKind {
    Export,
    RangeExport,
    AudioExport,
    PreviewCache,
}

/// Render lifecycle state shared by export, preview cache, and cancellation paths.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RenderLifecycleState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    AlreadyCached,
}

/// Unified render lifecycle event payload.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderLifecycleEvent {
    pub job_id: String,
    pub sequence_id: Option<String>,
    pub kind: RenderLifecycleKind,
    pub state: RenderLifecycleState,
    pub progress: Option<f64>,
    pub message: Option<String>,
    pub output_path: Option<String>,
    pub plan_hash: Option<String>,
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
fn parse_export_preset(preset: &str) -> Result<ExportPreset, String> {
    ExportPreset::from_legacy_id(preset).map_err(|e| e.to_string())
}

fn build_export_settings(
    output_path: std::path::PathBuf,
    preset: &str,
    request: Option<&VideoExportRequest>,
    start_time: Option<f64>,
    end_time: Option<f64>,
) -> Result<crate::core::render::ExportSettings, String> {
    match request {
        Some(request) => crate::core::render::ExportSettings::from_video_request(
            request,
            output_path,
            start_time,
            end_time,
        )
        .map_err(|e| e.to_string()),
        None => {
            let export_preset = parse_export_preset(preset)?;
            let mut settings =
                crate::core::render::ExportSettings::from_preset(export_preset, output_path);
            settings.start_time = start_time;
            settings.end_time = end_time;
            Ok(settings)
        }
    }
}

fn validate_batch_item_range(
    index: usize,
    in_point: Option<f64>,
    out_point: Option<f64>,
) -> Result<(), String> {
    if let Some(in_pt) = in_point {
        if in_pt < 0.0 {
            return Err(format!(
                "Batch item {}: In point must be non-negative",
                index
            ));
        }
    }

    if let (Some(in_pt), Some(out_pt)) = (in_point, out_point) {
        if in_pt >= out_pt {
            return Err(format!(
                "Batch item {}: In point must be before Out point",
                index
            ));
        }
    }

    Ok(())
}

fn emit_render_lifecycle(app: &tauri::AppHandle, event: RenderLifecycleEvent) {
    use tauri::Emitter;

    let _ = app.emit("render-lifecycle", event);
}

fn emit_render_progress_events(
    app: &tauri::AppHandle,
    job_id: &str,
    sequence_id: &str,
    kind: RenderLifecycleKind,
    progress: &crate::core::render::ExportProgress,
) {
    use tauri::Emitter;

    let progress_message = progress.message.clone();
    let _ = app.emit(
        "render-progress",
        serde_json::json!({
            "jobId": job_id,
            "frame": progress.frame,
            "totalFrames": progress.total_frames,
            "percent": progress.percent,
            "fps": progress.fps,
            "etaSeconds": progress.eta_seconds,
            "message": progress_message,
        }),
    );

    emit_render_lifecycle(
        app,
        RenderLifecycleEvent {
            job_id: job_id.to_string(),
            sequence_id: Some(sequence_id.to_string()),
            kind,
            state: RenderLifecycleState::Running,
            progress: Some(f64::from(progress.percent)),
            message: Some(progress.message.clone()),
            output_path: None,
            plan_hash: None,
        },
    );
}

fn lifecycle_state_for_export_error(error: &ExportError) -> RenderLifecycleState {
    if matches!(error, ExportError::Cancelled) {
        RenderLifecycleState::Cancelled
    } else {
        RenderLifecycleState::Failed
    }
}

/// Cached FFmpeg hardware probe results (decoders + encoders).
///
/// FFmpeg encoder/decoder availability does not change within a session,
/// so we probe once and reuse. This avoids spawning FFmpeg subprocesses
/// on every export or batch item.
struct HardwareProbeResults {
    encoders: crate::core::render::AvailableEncoders,
    devices: Vec<crate::core::performance::gpu::GpuDevice>,
}

/// Probe FFmpeg for hardware encoder/decoder availability.
///
/// Runs the blocking FFmpeg subprocesses on a dedicated blocking thread
/// to avoid stalling the tokio async runtime.
async fn probe_hardware(ffmpeg_path: &std::path::Path) -> Result<HardwareProbeResults, String> {
    use crate::core::performance::gpu::build_gpu_devices_from_probes;

    let ffmpeg_owned = ffmpeg_path.to_path_buf();
    let (decoders, encoders) = tokio::task::spawn_blocking(move || {
        let d = crate::core::render::detect_available_decoders(&ffmpeg_owned);
        let e = crate::core::render::detect_available_encoders(&ffmpeg_owned);
        (d, e)
    })
    .await
    .map_err(|e| format!("FFmpeg probe task failed: {e}"))?;

    let devices = build_gpu_devices_from_probes(&decoders, &encoders);
    Ok(HardwareProbeResults { encoders, devices })
}

fn apply_hardware_preferences(
    app: &tauri::AppHandle,
    probe: &HardwareProbeResults,
    export_settings: &mut crate::core::render::ExportSettings,
) -> Result<(), String> {
    use crate::core::performance::gpu::resolve_hardware_accel_mode;
    use crate::core::settings::SettingsManager;

    let app_data_dir = super::system::get_app_data_dir(app)?;
    let manager = SettingsManager::new(app_data_dir);
    let app_settings = manager.load();

    export_settings.hardware_accel = resolve_hardware_accel_mode(
        app_settings.performance.hardware_acceleration,
        app_settings.performance.gpu_device_id.as_deref(),
        &probe.devices,
    );
    export_settings.resolved_encoder_name = Some(crate::core::render::resolve_video_encoder(
        &export_settings.video_codec,
        &export_settings.hardware_accel,
        &probe.encoders,
    ));

    tracing::info!(
        "Resolved video encoder: {} (hardware_accel={:?}, preferred_gpu={:?})",
        export_settings
            .resolved_encoder_name
            .as_deref()
            .unwrap_or("unknown"),
        export_settings.hardware_accel,
        app_settings.performance.gpu_device_id
    );

    Ok(())
}

/// Convenience wrapper: probe hardware and apply preferences in one step.
async fn resolve_export_hardware_preferences(
    app: &tauri::AppHandle,
    ffmpeg_path: &std::path::Path,
    export_settings: &mut crate::core::render::ExportSettings,
) -> Result<(), String> {
    let probe = probe_hardware(ffmpeg_path).await?;
    apply_hardware_preferences(app, &probe, export_settings)
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
    settings: Option<VideoExportRequest>,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<RenderStartResult, String> {
    use crate::core::render::{validate_export_settings, ExportEngine, ExportProgress};
    use tauri::Emitter;

    // Get sequence/assets/effects + project path from project state
    let (sequence, assets, effects, render_graph, project_path) = {
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

        let render_graph = crate::core::render::build_render_graph(&project.state, &sequence_id)
            .map_err(|e| e.to_ipc_error())?;

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

        (
            sequence,
            assets,
            effects,
            render_graph,
            project.path.clone(),
        )
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

    // Create export settings using validated path
    let mut settings = build_export_settings(
        validated_output_path.clone(),
        &preset,
        settings.as_ref(),
        None,
        None,
    )?;

    resolve_export_hardware_preferences(&app_handle, &ffmpeg.info().ffmpeg_path, &mut settings)
        .await?;

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

    let render_plan =
        crate::core::render::build_render_plan(&render_graph, &assets, &effects, &settings);
    if !render_plan.validation.is_valid {
        let error_msg = render_plan.validation.errors.join("; ");
        return Err(format!("Render plan validation failed: {}", error_msg));
    }
    for warning in &render_plan.validation.warnings {
        tracing::warn!("Render plan warning: {}", warning);
    }
    let plan_hash = render_plan.plan_hash.clone();

    // Create export engine
    let engine = ExportEngine::new(ffmpeg.clone());
    let job_id = ulid::Ulid::new().to_string();
    let job_id_clone = job_id.clone();
    let job_id_for_return = job_id.clone();

    // Register cancel token for this job
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    register_render_job(&job_id, cancel_tx).await;

    emit_render_lifecycle(
        &app_handle,
        RenderLifecycleEvent {
            job_id: job_id.clone(),
            sequence_id: Some(sequence_id.clone()),
            kind: RenderLifecycleKind::Export,
            state: RenderLifecycleState::Queued,
            progress: Some(0.0),
            message: Some("Export queued".to_string()),
            output_path: Some(settings.output_path.to_string_lossy().to_string()),
            plan_hash: Some(plan_hash.clone()),
        },
    );

    // Create progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<ExportProgress>(100);
    let app_handle_clone = app_handle.clone();
    let sequence_id_progress = sequence_id.clone();

    // Spawn progress forwarding task
    tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            emit_render_progress_events(
                &app_handle_clone,
                &job_id_clone,
                &sequence_id_progress,
                RenderLifecycleKind::Export,
                &progress,
            );
        }
    });

    // Spawn export task in background to not block IPC
    let sequence_clone = sequence.clone();
    let assets_clone = assets.clone();
    let settings_clone = settings.clone();
    let app_handle_for_task = app_handle.clone();
    let job_id_for_task = job_id.clone();
    let plan_hash_for_task = plan_hash.clone();
    let render_plan_for_task = render_plan.clone();

    tokio::spawn(async move {
        match engine
            .export_sequence_with_effects_for_plan(
                &sequence_clone,
                &assets_clone,
                &effects,
                &settings_clone,
                &render_plan_for_task,
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
                        "jobId": job_id_for_task.clone(),
                        "outputPath": result.output_path.to_string_lossy().to_string(),
                        "durationSec": result.duration_sec,
                        "fileSize": result.file_size,
                        "encodingTimeSec": result.encoding_time_sec,
                    }),
                );
                emit_render_lifecycle(
                    &app_handle_for_task,
                    RenderLifecycleEvent {
                        job_id: job_id_for_task,
                        sequence_id: Some(sequence_clone.id.clone()),
                        kind: RenderLifecycleKind::Export,
                        state: RenderLifecycleState::Completed,
                        progress: Some(100.0),
                        message: Some("Export completed".to_string()),
                        output_path: Some(result.output_path.to_string_lossy().to_string()),
                        plan_hash: Some(plan_hash_for_task.clone()),
                    },
                );
            }
            Err(e) => {
                unregister_render_job(&job_id_for_task).await;
                tracing::error!("Export failed: {}", e);
                let lifecycle_state = lifecycle_state_for_export_error(&e);
                let error_message = e.to_string();

                let _ = app_handle_for_task.emit(
                    "render-error",
                    serde_json::json!({
                        "jobId": job_id_for_task.clone(),
                        "error": error_message.clone(),
                    }),
                );
                emit_render_lifecycle(
                    &app_handle_for_task,
                    RenderLifecycleEvent {
                        job_id: job_id_for_task,
                        sequence_id: Some(sequence_clone.id.clone()),
                        kind: RenderLifecycleKind::Export,
                        state: lifecycle_state,
                        progress: None,
                        message: Some(error_message),
                        output_path: Some(settings_clone.output_path.to_string_lossy().to_string()),
                        plan_hash: Some(plan_hash_for_task.clone()),
                    },
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
    settings: Option<VideoExportRequest>,
    in_point: f64,
    out_point: f64,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<RenderStartResult, String> {
    use crate::core::render::{validate_export_settings, ExportEngine, ExportProgress};
    use tauri::Emitter;

    // Validate range
    if in_point >= out_point {
        return Err("In point must be before Out point".to_string());
    }
    if in_point < 0.0 {
        return Err("In point must be non-negative".to_string());
    }

    // Get sequence/assets/effects + project path
    let (sequence, assets, effects, render_graph, project_path) = {
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

        let render_graph = crate::core::render::build_render_graph(&project.state, &sequence_id)
            .map_err(|e| e.to_ipc_error())?;

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

        (
            sequence,
            assets,
            effects,
            render_graph,
            project.path.clone(),
        )
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
    let mut settings = build_export_settings(
        validated_output_path,
        &preset,
        settings.as_ref(),
        Some(in_point),
        Some(out_point),
    )?;

    resolve_export_hardware_preferences(&app_handle, &ffmpeg.info().ffmpeg_path, &mut settings)
        .await?;

    let validation = validate_export_settings(&sequence, &assets, &effects, &settings);
    if !validation.is_valid {
        return Err(format!(
            "Export validation failed: {}",
            validation.errors.join("; ")
        ));
    }

    let render_plan =
        crate::core::render::build_render_plan(&render_graph, &assets, &effects, &settings);
    if !render_plan.validation.is_valid {
        return Err(format!(
            "Render plan validation failed: {}",
            render_plan.validation.errors.join("; ")
        ));
    }
    for warning in &render_plan.validation.warnings {
        tracing::warn!("Render plan warning: {}", warning);
    }
    let plan_hash = render_plan.plan_hash.clone();

    let engine = ExportEngine::new(ffmpeg.clone());
    let job_id = ulid::Ulid::new().to_string();
    let job_id_for_return = job_id.clone();

    // Register cancel token
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    register_render_job(&job_id, cancel_tx).await;

    emit_render_lifecycle(
        &app_handle,
        RenderLifecycleEvent {
            job_id: job_id.clone(),
            sequence_id: Some(sequence_id.clone()),
            kind: RenderLifecycleKind::RangeExport,
            state: RenderLifecycleState::Queued,
            progress: Some(0.0),
            message: Some("Range export queued".to_string()),
            output_path: Some(settings.output_path.to_string_lossy().to_string()),
            plan_hash: Some(plan_hash.clone()),
        },
    );

    // Progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<ExportProgress>(100);
    let app_handle_progress = app_handle.clone();
    let job_id_progress = job_id.clone();
    let sequence_id_progress = sequence_id.clone();

    tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            emit_render_progress_events(
                &app_handle_progress,
                &job_id_progress,
                &sequence_id_progress,
                RenderLifecycleKind::RangeExport,
                &progress,
            );
        }
    });

    let app_handle_task = app_handle.clone();
    let job_id_task = job_id.clone();
    let sequence_id_task = sequence_id.clone();
    let output_path_task = settings.output_path.clone();
    let plan_hash_task = plan_hash.clone();
    let render_plan_task = render_plan.clone();

    tokio::spawn(async move {
        match engine
            .export_sequence_with_effects_for_plan(
                &sequence,
                &assets,
                &effects,
                &settings,
                &render_plan_task,
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
                        "jobId": job_id_task.clone(),
                        "outputPath": result.output_path.to_string_lossy().to_string(),
                        "durationSec": result.duration_sec,
                        "fileSize": result.file_size,
                        "encodingTimeSec": result.encoding_time_sec,
                    }),
                );
                emit_render_lifecycle(
                    &app_handle_task,
                    RenderLifecycleEvent {
                        job_id: job_id_task,
                        sequence_id: Some(sequence_id_task),
                        kind: RenderLifecycleKind::RangeExport,
                        state: RenderLifecycleState::Completed,
                        progress: Some(100.0),
                        message: Some("Range export completed".to_string()),
                        output_path: Some(result.output_path.to_string_lossy().to_string()),
                        plan_hash: Some(plan_hash_task.clone()),
                    },
                );
            }
            Err(e) => {
                unregister_render_job(&job_id_task).await;
                let lifecycle_state = lifecycle_state_for_export_error(&e);
                let error_message = e.to_string();
                let _ = app_handle_task.emit(
                    "render-error",
                    serde_json::json!({
                        "jobId": job_id_task.clone(),
                        "error": error_message.clone(),
                    }),
                );
                emit_render_lifecycle(
                    &app_handle_task,
                    RenderLifecycleEvent {
                        job_id: job_id_task,
                        sequence_id: Some(sequence_id_task),
                        kind: RenderLifecycleKind::RangeExport,
                        state: lifecycle_state,
                        progress: None,
                        message: Some(error_message),
                        output_path: Some(output_path_task.to_string_lossy().to_string()),
                        plan_hash: Some(plan_hash_task.clone()),
                    },
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
    let (sequence, assets, effects, render_graph, project_path) = {
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

        let render_graph = crate::core::render::build_render_graph(&project.state, &sequence_id)
            .map_err(|e| e.to_ipc_error())?;

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

        (
            sequence,
            assets,
            effects,
            render_graph,
            project.path.clone(),
        )
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

        validate_batch_item_range(i, item.in_point, item.out_point)?;

        let settings = build_export_settings(
            validated_path,
            &item.preset,
            item.settings.as_ref(),
            item.in_point,
            item.out_point,
        )?;

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

    // Probe hardware once for the entire batch instead of per-item
    let hw_probe = probe_hardware(&ffmpeg.info().ffmpeg_path).await?;
    for (settings, _) in &mut validated_items {
        apply_hardware_preferences(&app_handle, &hw_probe, settings)?;
    }

    let mut render_plans: Vec<crate::core::render::RenderPlan> =
        Vec::with_capacity(validated_items.len());
    for (i, (settings, _)) in validated_items.iter().enumerate() {
        let render_plan =
            crate::core::render::build_render_plan(&render_graph, &assets, &effects, settings);
        if !render_plan.validation.is_valid {
            return Err(format!(
                "Batch item {} render plan validation failed: {}",
                i,
                render_plan.validation.errors.join("; ")
            ));
        }
        for warning in &render_plan.validation.warnings {
            tracing::warn!("Batch item {} render plan warning: {}", i, warning);
        }
        render_plans.push(render_plan);
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

        for (idx, (((settings, output_path_str), job_id), render_plan)) in validated_items
            .into_iter()
            .zip(job_ids.iter())
            .zip(render_plans.into_iter())
            .enumerate()
        {
            let item_index = idx as u32;
            let plan_hash = render_plan.plan_hash.clone();

            // Register cancel token for this item
            let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
            register_render_job(job_id, cancel_tx).await;
            emit_render_lifecycle(
                &app_handle,
                RenderLifecycleEvent {
                    job_id: job_id.clone(),
                    sequence_id: Some(sequence.id.clone()),
                    kind: RenderLifecycleKind::Export,
                    state: RenderLifecycleState::Queued,
                    progress: Some(0.0),
                    message: Some(format!("Batch item {} queued", item_index)),
                    output_path: Some(settings.output_path.to_string_lossy().to_string()),
                    plan_hash: Some(plan_hash.clone()),
                },
            );

            // Progress channel for this item
            let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<ExportProgress>(100);
            let app_handle_progress = app_handle.clone();
            let batch_id_progress = batch_id.clone();
            let job_id_progress = job_id.clone();
            let sequence_id_progress = sequence.id.clone();
            let plan_hash_progress = plan_hash.clone();
            let total = total_items;

            // Forward per-item progress as batch-render-progress events
            let progress_task = tokio::spawn(async move {
                while let Some(progress) = progress_rx.recv().await {
                    let progress_message = progress.message.clone();
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
                            "message": progress_message.clone(),
                        }),
                    );
                    emit_render_lifecycle(
                        &app_handle_progress,
                        RenderLifecycleEvent {
                            job_id: job_id_progress.clone(),
                            sequence_id: Some(sequence_id_progress.clone()),
                            kind: RenderLifecycleKind::Export,
                            state: RenderLifecycleState::Running,
                            progress: Some(f64::from(progress.percent)),
                            message: Some(progress_message),
                            output_path: None,
                            plan_hash: Some(plan_hash_progress.clone()),
                        },
                    );
                }
            });

            // Execute render
            let render_result = engine
                .export_sequence_with_effects_for_plan(
                    &sequence,
                    &assets,
                    &effects,
                    &settings,
                    &render_plan,
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
                    emit_render_lifecycle(
                        &app_handle,
                        RenderLifecycleEvent {
                            job_id: job_id.clone(),
                            sequence_id: Some(sequence.id.clone()),
                            kind: RenderLifecycleKind::Export,
                            state: RenderLifecycleState::Completed,
                            progress: Some(100.0),
                            message: Some(format!("Batch item {} completed", item_index)),
                            output_path: Some(
                                export_result.output_path.to_string_lossy().to_string(),
                            ),
                            plan_hash: Some(plan_hash.clone()),
                        },
                    );
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
                    emit_render_lifecycle(
                        &app_handle,
                        RenderLifecycleEvent {
                            job_id: job_id.clone(),
                            sequence_id: Some(sequence.id.clone()),
                            kind: RenderLifecycleKind::Export,
                            state: lifecycle_state_for_export_error(e),
                            progress: None,
                            message: Some(e.to_string()),
                            output_path: Some(output_path_str.clone()),
                            plan_hash: Some(plan_hash.clone()),
                        },
                    );
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
/// Supports WAV, MP3, M4A, FLAC, and OGG output formats. Reports progress via
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
    start_time: Option<f64>,
    end_time: Option<f64>,
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
        "m4a" => AudioExportFormat::M4a,
        "flac" => AudioExportFormat::Flac,
        "ogg" => AudioExportFormat::Ogg,
        _ => return Err(format!("Unsupported audio format: {}", format)),
    };

    // Get sequence/assets/effects + project path
    let (sequence, assets, effects, render_graph, project_path) = {
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

        let render_graph = crate::core::render::build_render_graph(&project.state, &sequence_id)
            .map_err(|e| e.to_ipc_error())?;

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

        (
            sequence,
            assets,
            effects,
            render_graph,
            project.path.clone(),
        )
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
        start_time,
        end_time,
    };

    let audio_export_settings = audio_settings.to_export_settings();
    let render_plan = crate::core::render::build_render_plan(
        &render_graph,
        &assets,
        &effects,
        &audio_export_settings,
    );
    if !render_plan.validation.is_valid {
        return Err(format!(
            "Render plan validation failed: {}",
            render_plan.validation.errors.join("; ")
        ));
    }
    for warning in &render_plan.validation.warnings {
        tracing::warn!("Render plan warning: {}", warning);
    }
    let plan_hash = render_plan.plan_hash.clone();

    let job_id = ulid::Ulid::new().to_string();
    let job_id_for_return = job_id.clone();

    // Register cancel token
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    register_render_job(&job_id, cancel_tx).await;

    emit_render_lifecycle(
        &app_handle,
        RenderLifecycleEvent {
            job_id: job_id.clone(),
            sequence_id: Some(sequence_id.clone()),
            kind: RenderLifecycleKind::AudioExport,
            state: RenderLifecycleState::Queued,
            progress: Some(0.0),
            message: Some("Audio export queued".to_string()),
            output_path: Some(audio_settings.output_path.to_string_lossy().to_string()),
            plan_hash: Some(plan_hash.clone()),
        },
    );

    // Progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<ExportProgress>(100);
    let app_handle_progress = app_handle.clone();
    let job_id_progress = job_id.clone();
    let sequence_id_progress = sequence_id.clone();

    tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            emit_render_progress_events(
                &app_handle_progress,
                &job_id_progress,
                &sequence_id_progress,
                RenderLifecycleKind::AudioExport,
                &progress,
            );
        }
    });

    let app_handle_task = app_handle.clone();
    let job_id_task = job_id.clone();
    let sequence_id_task = sequence_id.clone();
    let output_path_task = audio_settings.output_path.clone();
    let plan_hash_task = plan_hash.clone();
    let render_plan_task = render_plan.clone();

    tokio::spawn(async move {
        match engine
            .export_audio_only_for_plan(
                &sequence,
                &assets,
                &effects,
                &audio_settings,
                &render_plan_task,
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
                        "jobId": job_id_task.clone(),
                        "outputPath": result.output_path.to_string_lossy().to_string(),
                        "durationSec": result.duration_sec,
                        "fileSize": result.file_size,
                        "encodingTimeSec": result.encoding_time_sec,
                    }),
                );
                emit_render_lifecycle(
                    &app_handle_task,
                    RenderLifecycleEvent {
                        job_id: job_id_task,
                        sequence_id: Some(sequence_id_task),
                        kind: RenderLifecycleKind::AudioExport,
                        state: RenderLifecycleState::Completed,
                        progress: Some(100.0),
                        message: Some("Audio export completed".to_string()),
                        output_path: Some(result.output_path.to_string_lossy().to_string()),
                        plan_hash: Some(plan_hash_task.clone()),
                    },
                );
            }
            Err(e) => {
                unregister_render_job(&job_id_task).await;
                tracing::error!("Audio export failed: {}", e);
                let lifecycle_state = lifecycle_state_for_export_error(&e);
                let error_message = e.to_string();

                let _ = app_handle_task.emit(
                    "render-error",
                    serde_json::json!({
                        "jobId": job_id_task.clone(),
                        "error": error_message.clone(),
                    }),
                );
                emit_render_lifecycle(
                    &app_handle_task,
                    RenderLifecycleEvent {
                        job_id: job_id_task,
                        sequence_id: Some(sequence_id_task),
                        kind: RenderLifecycleKind::AudioExport,
                        state: lifecycle_state,
                        progress: None,
                        message: Some(error_message),
                        output_path: Some(output_path_task.to_string_lossy().to_string()),
                        plan_hash: Some(plan_hash_task.clone()),
                    },
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

// =============================================================================
// Video Stabilization
// =============================================================================

/// Arguments for the stabilize_clip command.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StabilizeClipArgs {
    pub sequence_id: String,
    pub track_id: String,
    pub clip_id: String,
    pub smoothing: f64,
    pub crop_mode: String,
    pub zoom: f64,
}

/// Result of stabilization analysis.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StabilizeResult {
    /// Path to the generated transforms file
    pub transforms_path: String,
}

/// Run video stabilization analysis on a clip.
///
/// This performs the analysis pass only:
/// 1. `vidstabdetect` — analyzes motion and writes transforms to a .trf file
///
/// Persisting the returned `transforms_path` onto the selected Stabilize effect
/// must still happen through the normal effect command pipeline so the project
/// remains event-sourced and undoable.
///
/// Progress is reported via `stabilize-progress` Tauri events.
#[tauri::command]
#[specta::specta]
pub async fn stabilize_clip(
    args: StabilizeClipArgs,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<StabilizeResult, String> {
    use tauri::Emitter;

    let StabilizeClipArgs {
        sequence_id,
        track_id,
        clip_id,
        smoothing: _,
        crop_mode,
        zoom: _,
    } = args;

    // Validate crop_mode
    let valid_modes = ["none", "crop", "dynamic"];
    if !valid_modes.contains(&crop_mode.as_str()) {
        return Err(format!(
            "Invalid crop_mode '{}'. Must be one of: none, crop, dynamic",
            crop_mode
        ));
    }

    // Get clip source path and project path
    let (source_path, project_path): (String, std::path::PathBuf) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?;

        let track = sequence
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .ok_or_else(|| format!("Track not found: {}", track_id))?;

        let clip = track
            .clips
            .iter()
            .find(|c| c.id == clip_id)
            .ok_or_else(|| format!("Clip not found: {}", clip_id))?;

        let asset = project
            .state
            .assets
            .get(&clip.asset_id)
            .ok_or_else(|| format!("Asset not found: {}", clip.asset_id))?;

        (asset.uri.clone(), project.path.clone())
    };

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    // Create output directory for transforms file
    let stab_dir = project_path.join(".openreelio").join("stabilize");
    tokio::fs::create_dir_all(&stab_dir)
        .await
        .map_err(|e| format!("Failed to create stabilization directory: {}", e))?;

    let transforms_path = stab_dir.join(format!("{}.trf", clip_id));

    // Emit initial progress
    let _ = app_handle.emit(
        "stabilize-progress",
        serde_json::json!({
            "clipId": clip_id,
            "progress": 0,
            "phase": "analyzing"
        }),
    );

    // Pass 1: vidstabdetect — analyze motion and generate transforms file
    let mut cmd = tokio::process::Command::new(&ffmpeg.info().ffmpeg_path);
    crate::core::process::configure_tokio_command(&mut cmd);

    // FFmpeg filter escaping: backslashes to forward slashes, then escape
    // special characters (\, :, ') per FFmpeg's libavfilter quoting rules.
    let escaped_path = transforms_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'");
    let detect_filter = format!(
        "vidstabdetect=shakiness=10:accuracy=15:result='{}'",
        escaped_path
    );

    let output = cmd
        .args([
            "-hide_banner",
            "-loglevel",
            "warning",
            "-nostdin",
            "-i",
            &source_path,
            "-vf",
            &detect_filter,
            "-f",
            "null",
            "-y",
            "-",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run vidstabdetect: {}", e))?;

    // Emit completion of analysis
    let _ = app_handle.emit(
        "stabilize-progress",
        serde_json::json!({
            "clipId": clip_id,
            "progress": 90,
            "phase": "applying"
        }),
    );

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Stabilization analysis failed: {}", stderr));
    }

    // Verify transforms file was created
    if !transforms_path.exists() {
        return Err(
            "Stabilization analysis completed but no transforms file was generated".to_string(),
        );
    }

    // Emit completion
    let _ = app_handle.emit(
        "stabilize-progress",
        serde_json::json!({
            "clipId": clip_id,
            "progress": 100,
            "phase": "complete"
        }),
    );

    Ok(StabilizeResult {
        transforms_path: transforms_path.to_string_lossy().to_string(),
    })
}

// =============================================================================
// AI Smart Reframe
// =============================================================================

/// Arguments for the smart_reframe command.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SmartReframeArgs {
    pub sequence_id: String,
    pub track_id: String,
    pub clip_id: String,
    /// Target aspect ratio (e.g., "9:16", "1:1", "4:5", "4:3")
    pub target_aspect: String,
    /// Crop motion smoothing (1-100, default: 30)
    pub smoothing: f64,
    /// Additional zoom percentage (0-50, default: 0)
    pub zoom: f64,
}

/// Result of smart reframe analysis.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SmartReframeResult {
    /// JSON-encoded analysis data with crop keyframes
    pub analysis_data: String,
    /// Computed crop dimensions
    pub crop_width: u32,
    pub crop_height: u32,
}

/// Parse an aspect ratio string ("W:H") into (width, height) integers.
fn parse_aspect_ratio(aspect: &str) -> Result<(u32, u32), String> {
    let parts: Vec<&str> = aspect.split(':').collect();
    if parts.len() != 2 {
        return Err(format!(
            "Invalid aspect ratio '{}'. Expected format 'W:H' (e.g., '9:16')",
            aspect
        ));
    }
    let w: u32 = parts[0]
        .parse()
        .map_err(|_| format!("Invalid aspect width '{}'", parts[0]))?;
    let h: u32 = parts[1]
        .parse()
        .map_err(|_| format!("Invalid aspect height '{}'", parts[1]))?;
    if w == 0 || h == 0 {
        return Err("Aspect ratio dimensions must be non-zero".to_string());
    }
    Ok((w, h))
}

/// Calculate crop dimensions to fit the target aspect ratio within source dimensions.
/// Returns (crop_width, crop_height) that maintain the target aspect ratio while
/// being as large as possible within the source frame.
fn calculate_crop_dimensions(
    source_w: u32,
    source_h: u32,
    target_w: u32,
    target_h: u32,
) -> (u32, u32) {
    let target_ratio = target_w as f64 / target_h as f64;
    let source_ratio = source_w as f64 / source_h as f64;

    if source_ratio > target_ratio {
        // Source is wider than target — crop width, keep height
        let crop_h = source_h;
        let crop_w = ((source_h as f64) * target_ratio).round() as u32;
        // Ensure even dimensions for codec compatibility
        (crop_w & !1, crop_h & !1)
    } else {
        // Source is taller than target — crop height, keep width
        let crop_w = source_w;
        let crop_h = ((source_w as f64) / target_ratio).round() as u32;
        (crop_w & !1, crop_h & !1)
    }
}

/// Run AI smart reframe analysis on a clip.
///
/// Analyzes the video to determine optimal crop positions for the target
/// aspect ratio. Uses scene detection to identify scene boundaries and
/// generates smooth crop keyframes.
///
/// Progress is reported via `reframe-progress` Tauri events.
#[tauri::command]
#[specta::specta]
pub async fn smart_reframe(
    args: SmartReframeArgs,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<SmartReframeResult, String> {
    use tauri::Emitter;

    let SmartReframeArgs {
        sequence_id,
        track_id,
        clip_id,
        target_aspect,
        smoothing,
        zoom: _,
    } = args;

    // Validate target aspect ratio
    let (target_w, target_h) = parse_aspect_ratio(&target_aspect)?;

    // Get clip source path
    let source_path: String = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?;

        let track = sequence
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .ok_or_else(|| format!("Track not found: {}", track_id))?;

        let clip = track
            .clips
            .iter()
            .find(|c| c.id == clip_id)
            .ok_or_else(|| format!("Clip not found: {}", clip_id))?;

        let asset = project
            .state
            .assets
            .get(&clip.asset_id)
            .ok_or_else(|| format!("Asset not found: {}", clip.asset_id))?;

        asset.uri.clone()
    };

    // Get FFmpeg runner (for ffprobe access)
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    // Emit initial progress
    let _ = app_handle.emit(
        "reframe-progress",
        serde_json::json!({
            "clipId": clip_id,
            "progress": 0,
            "phase": "probing"
        }),
    );

    // Step 1: Probe source dimensions via ffprobe
    let mut probe_cmd = tokio::process::Command::new(&ffmpeg.info().ffprobe_path);
    crate::core::process::configure_tokio_command(&mut probe_cmd);

    let probe_output = probe_cmd
        .args([
            "-v",
            "quiet",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            &source_path,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if !probe_output.status.success() {
        let stderr = String::from_utf8_lossy(&probe_output.stderr);
        return Err(format!("ffprobe failed: {}", stderr));
    }

    let probe_json: serde_json::Value = serde_json::from_slice(&probe_output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    let source_w = probe_json["streams"][0]["width"]
        .as_u64()
        .ok_or("Could not determine video width")? as u32;
    let source_h = probe_json["streams"][0]["height"]
        .as_u64()
        .ok_or("Could not determine video height")? as u32;
    let duration = probe_json["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or_else(|| {
            tracing::warn!(
                "Could not determine video duration; keyframe generation may be incomplete"
            );
            0.0
        });

    // Step 2: Calculate crop dimensions
    let (crop_w, crop_h) = calculate_crop_dimensions(source_w, source_h, target_w, target_h);

    let _ = app_handle.emit(
        "reframe-progress",
        serde_json::json!({
            "clipId": clip_id,
            "progress": 20,
            "phase": "detecting_scenes"
        }),
    );

    // Step 3: Scene detection via FFmpeg
    let mut scene_cmd = tokio::process::Command::new(&ffmpeg.info().ffmpeg_path);
    crate::core::process::configure_tokio_command(&mut scene_cmd);

    let scene_output = scene_cmd
        .args([
            "-hide_banner",
            "-loglevel",
            "quiet",
            "-nostdin",
            "-i",
            &source_path,
            "-vf",
            "select='gt(scene,0.3)',showinfo",
            "-f",
            "null",
            "-y",
            "-",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to run scene detection: {}", e))?;

    // Check scene detection exit status — non-zero means FFmpeg encountered an
    // error (e.g., unsupported codec or corrupt file).  We treat this as a
    // non-fatal condition and fall back to a single center keyframe.
    if !scene_output.status.success() {
        tracing::warn!(
            "Scene detection exited with status {}; falling back to center crop",
            scene_output.status
        );
    }

    // Parse scene change timestamps from showinfo output
    let scene_stderr = String::from_utf8_lossy(&scene_output.stderr);
    let mut scene_times: Vec<f64> = Vec::new();
    for line in scene_stderr.lines() {
        if let Some(pts_idx) = line.find("pts_time:") {
            let rest = &line[pts_idx + 9..];
            if let Some(end) = rest.find(|c: char| c.is_whitespace()) {
                if let Ok(t) = rest[..end].parse::<f64>() {
                    scene_times.push(t);
                }
            } else if let Ok(t) = rest.trim().parse::<f64>() {
                scene_times.push(t);
            }
        }
    }

    // Ensure chronological order — FFmpeg showinfo is expected to emit in
    // order, but we sort defensively to handle edge cases.
    scene_times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let _ = app_handle.emit(
        "reframe-progress",
        serde_json::json!({
            "clipId": clip_id,
            "progress": 60,
            "phase": "computing_keyframes"
        }),
    );

    // Step 4: Generate crop keyframes
    // TODO: Currently all keyframes use the static center position because
    // subject tracking / ROI detection is not yet implemented.  Once a
    // detection backend (e.g., face detection via OpenCV or a vision model)
    // is available, each scene segment should receive a per-scene (x, y)
    // offset based on the detected subject region.
    let center_x = ((source_w as i64) - (crop_w as i64)) / 2;
    let center_y = ((source_h as i64) - (crop_h as i64)) / 2;
    let center_x = center_x.max(0);
    let center_y = center_y.max(0);

    let mut keyframes: Vec<serde_json::Value> = Vec::new();

    if scene_times.is_empty() {
        // No scene changes detected — single center keyframe
        keyframes.push(serde_json::json!({"t": 0.0, "x": center_x, "y": center_y}));
    } else {
        // Add keyframe at start
        keyframes.push(serde_json::json!({"t": 0.0, "x": center_x, "y": center_y}));

        // For each scene change, add a keyframe at the center position
        // With smoothing applied, crop transitions will be smooth
        let smooth_factor = smoothing.clamp(1.0, 100.0) / 100.0;
        let transition_time = 0.5 * smooth_factor; // Transition duration in seconds

        for scene_t in &scene_times {
            if *scene_t <= 0.0 || *scene_t >= duration {
                continue;
            }
            // Pre-transition keyframe (hold current position)
            let pre_t = (scene_t - transition_time).max(0.0);
            if pre_t > 0.0 {
                keyframes.push(serde_json::json!({"t": pre_t, "x": center_x, "y": center_y}));
            }
            // Post-transition keyframe
            keyframes.push(serde_json::json!({"t": *scene_t, "x": center_x, "y": center_y}));
        }

        // Add keyframe at end
        if duration > 0.0 {
            keyframes.push(serde_json::json!({"t": duration, "x": center_x, "y": center_y}));
        }
    }

    // Deduplicate keyframes at the same timestamp
    keyframes.dedup_by(|a, b| {
        let ta = a["t"].as_f64().unwrap_or(-1.0);
        let tb = b["t"].as_f64().unwrap_or(-2.0);
        (ta - tb).abs() < 0.01
    });

    // Build analysis data JSON
    let analysis_data = serde_json::json!({
        "crop_w": crop_w,
        "crop_h": crop_h,
        "source_w": source_w,
        "source_h": source_h,
        "target_aspect": target_aspect,
        "scene_count": scene_times.len(),
        "keyframes": keyframes,
    });

    let analysis_json = analysis_data.to_string();

    // Emit completion
    let _ = app_handle.emit(
        "reframe-progress",
        serde_json::json!({
            "clipId": clip_id,
            "progress": 100,
            "phase": "complete"
        }),
    );

    Ok(SmartReframeResult {
        analysis_data: analysis_json,
        crop_width: crop_w,
        crop_height: crop_h,
    })
}

// =============================================================================
// GPU Acceleration
// =============================================================================

/// GPU device information returned to the frontend
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GpuDeviceDto {
    /// Unique device ID
    pub id: String,
    /// Device name (e.g., "NVIDIA GPU")
    pub name: String,
    /// Vendor name
    pub vendor: String,
    /// Whether both encode and decode are supported
    pub has_encode: bool,
    pub has_decode: bool,
    /// Whether this is the primary/active device
    pub is_primary: bool,
}

/// GPU acceleration status
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GpuAccelerationStatus {
    /// Whether GPU acceleration is enabled in settings
    pub enabled: bool,
    /// Detected GPU devices
    pub devices: Vec<GpuDeviceDto>,
    /// Active device ID (if any)
    pub active_device_id: Option<String>,
    /// Available hardware decoders
    pub available_decoders: crate::core::render::AvailableDecoders,
    /// Available hardware encoders
    pub available_encoders: crate::core::render::AvailableEncoders,
}

/// Detect GPU devices and return acceleration status.
///
/// Probes FFmpeg for hardware decoders (`-hwaccels`) and encoders (`-encoders`),
/// builds a list of GPU devices, and returns the current acceleration state.
#[tauri::command]
#[specta::specta]
pub async fn detect_gpu_devices(
    app: tauri::AppHandle,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
) -> Result<GpuAccelerationStatus, String> {
    use crate::core::performance::gpu::GpuCapability;
    use crate::core::settings::SettingsManager;

    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    let info = ffmpeg.info();

    // Probe FFmpeg for decoders and encoders (blocking subprocess calls)
    let ffmpeg_path = info.ffmpeg_path.clone();
    let (available_decoders, available_encoders) = tokio::task::spawn_blocking(move || {
        let decoders = crate::core::render::detect_available_decoders(&ffmpeg_path);
        let encoders = crate::core::render::detect_available_encoders(&ffmpeg_path);
        (decoders, encoders)
    })
    .await
    .map_err(|e| format!("GPU detection task failed: {}", e))?;

    // Build GPU device list
    let devices = crate::core::performance::gpu::build_gpu_devices_from_probes(
        &available_decoders,
        &available_encoders,
    );

    // Read settings for enabled status
    let app_data_dir = super::system::get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);
    let settings = manager.load();
    let enabled = settings.performance.hardware_acceleration;
    let preferred_id = settings.performance.gpu_device_id.clone();

    // Determine active device
    let active_device_id = crate::core::performance::gpu::resolve_active_gpu_device_id(
        enabled,
        preferred_id.as_deref(),
        &devices,
    );

    let device_dtos: Vec<GpuDeviceDto> = devices
        .iter()
        .map(|d| GpuDeviceDto {
            id: d.id.clone(),
            name: d.name.clone(),
            vendor: d.vendor.to_string(),
            has_encode: d.supports(GpuCapability::HardwareEncode),
            has_decode: d.supports(GpuCapability::HardwareDecode),
            is_primary: d.is_primary,
        })
        .collect();

    Ok(GpuAccelerationStatus {
        enabled,
        devices: device_dtos,
        active_device_id,
        available_decoders,
        available_encoders,
    })
}

/// Get available hardware decoders.
///
/// Probes FFmpeg for supported hardware acceleration backends.
#[tauri::command]
#[specta::specta]
pub async fn get_available_decoders(
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
) -> Result<crate::core::render::AvailableDecoders, String> {
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    let info = ffmpeg.info();
    let ffmpeg_path = info.ffmpeg_path.clone();
    tokio::task::spawn_blocking(move || {
        crate::core::render::detect_available_decoders(&ffmpeg_path)
    })
    .await
    .map_err(|e| format!("Decoder detection task failed: {}", e))
}

// =============================================================================
// Render Cache Commands
// =============================================================================

/// Get render cache status for the active sequence.
///
/// Returns per-segment cache state for the timeline indicator bar.
#[tauri::command]
#[specta::specta]
pub async fn get_cache_status(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<crate::core::render::RenderCacheStatus, String> {
    use crate::core::render::cache::{load_manifest, RenderCacheManifest, RenderCacheStatus};

    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let seq_id = project
        .state
        .active_sequence_id
        .as_ref()
        .ok_or_else(|| "No active sequence".to_string())?;

    let sequence = project
        .state
        .sequences
        .get(seq_id)
        .ok_or_else(|| format!("Sequence not found: {seq_id}"))?;

    let effects: std::collections::HashMap<String, crate::core::effects::Effect> = project
        .state
        .effects
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let config = resolve_cache_config(&app);

    let mut manifest = load_manifest(&project.path, seq_id)
        .map_err(|e| format!("Failed to load cache manifest: {e}"))?
        .unwrap_or_else(|| {
            RenderCacheManifest::new(
                seq_id,
                sequence.duration(),
                config.segment_duration_sec,
                sequence,
                &effects,
            )
        });

    reconcile_cache_manifest(&mut manifest, &project.path, sequence, &effects, &config)?;

    Ok(RenderCacheStatus::from_manifest(&manifest, &config))
}

/// Clear render cache for the active sequence.
///
/// Removes all cached segment files and the manifest.
#[tauri::command]
#[specta::specta]
pub async fn clear_render_cache(state: State<'_, AppState>) -> Result<ClearCacheResult, String> {
    use crate::core::render::cache::clear_sequence_cache;

    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let seq_id = project
        .state
        .active_sequence_id
        .as_ref()
        .ok_or_else(|| "No active sequence".to_string())?;

    clear_sequence_cache(&project.path, seq_id)
        .map_err(|e| format!("Failed to clear render cache: {e}"))?;

    Ok(ClearCacheResult {
        sequence_id: seq_id.clone(),
        cleared: true,
    })
}

/// Result of clearing render cache
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClearCacheResult {
    /// Sequence whose cache was cleared
    pub sequence_id: String,
    /// Whether the operation succeeded
    pub cleared: bool,
}

/// Resolves render cache configuration from app settings.
fn resolve_cache_config(app: &tauri::AppHandle) -> crate::core::render::RenderCacheConfig {
    use crate::core::render::cache::RenderCacheConfig;
    use crate::core::settings::SettingsManager;

    let app_data_dir = match super::system::get_app_data_dir(app) {
        Ok(dir) => dir,
        Err(e) => {
            tracing::warn!("Failed to resolve app data dir for cache config, using defaults: {e}");
            return RenderCacheConfig::default();
        }
    };
    let manager = SettingsManager::new(app_data_dir);
    let settings = manager.load();
    RenderCacheConfig::from_cache_size_mb(settings.performance.cache_size_mb)
}

fn cleanup_orphaned_cache_files(
    project_path: &std::path::Path,
    sequence_id: &str,
    files: &[String],
) {
    if files.is_empty() {
        return;
    }

    let seq_dir = crate::core::render::sequence_cache_dir(project_path, sequence_id);
    for file in files {
        let file_path = seq_dir.join(file);
        if let Err(error) = std::fs::remove_file(&file_path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    "Failed to remove orphaned render cache file {}: {}",
                    file_path.display(),
                    error
                );
            }
        }
    }
}

fn reconcile_cache_manifest(
    manifest: &mut crate::core::render::RenderCacheManifest,
    project_path: &std::path::Path,
    sequence: &crate::core::timeline::Sequence,
    effects: &std::collections::HashMap<String, crate::core::effects::Effect>,
    config: &crate::core::render::RenderCacheConfig,
) -> Result<(), String> {
    let sync = manifest.reconcile_with_sequence(
        sequence.duration(),
        config.segment_duration_sec,
        sequence,
        effects,
    );

    cleanup_orphaned_cache_files(project_path, &manifest.sequence_id, &sync.orphaned_files);

    if sync.changed {
        crate::core::render::save_manifest(project_path, manifest)
            .map_err(|error| format!("Failed to save cache manifest: {error}"))?;
    }

    Ok(())
}

/// Abort handle and identity for the active cache render task.
///
/// Starting a new cache render aborts any in-flight background task so that
/// only one cache render is active at a time.
struct ActiveCacheRender {
    job_id: String,
    sequence_id: String,
    abort_handle: tokio::task::AbortHandle,
}

static ACTIVE_CACHE_RENDER: std::sync::LazyLock<std::sync::Mutex<Option<ActiveCacheRender>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// Render preview cache for the active sequence.
///
/// Triggers background rendering of uncached segments. Returns the cache
/// status immediately; rendering progress is reported via Tauri events.
/// If a previous cache render is still running it is cancelled first.
#[tauri::command]
#[specta::specta]
pub async fn render_preview_cache(
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<RenderCacheJobResult, String> {
    use crate::core::render::cache::{
        cleanup_stale_files, enforce_cache_limit, load_manifest, save_manifest, RenderCacheManifest,
    };
    use crate::core::render::ExportEngine;
    use tauri::Emitter;

    let config = resolve_cache_config(&app_handle);

    // Gather project data
    let (sequence, assets, effects, render_graph, project_path, seq_id) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let seq_id = project
            .state
            .active_sequence_id
            .as_ref()
            .ok_or_else(|| "No active sequence".to_string())?
            .clone();

        let sequence = project
            .state
            .sequences
            .get(&seq_id)
            .ok_or_else(|| format!("Sequence not found: {seq_id}"))?
            .clone();

        let render_graph = crate::core::render::build_render_graph(&project.state, &seq_id)
            .map_err(|error| format!("Failed to build render graph: {error}"))?;

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

        (
            sequence,
            assets,
            effects,
            render_graph,
            project.path.clone(),
            seq_id,
        )
    };

    // Load or create manifest
    let cache_job_id = ulid::Ulid::new().to_string();
    let mut manifest = load_manifest(&project_path, &seq_id)
        .map_err(|e| format!("Failed to load cache manifest: {e}"))?
        .unwrap_or_else(|| {
            RenderCacheManifest::new(
                &seq_id,
                sequence.duration(),
                config.segment_duration_sec,
                &sequence,
                &effects,
            )
        });

    reconcile_cache_manifest(&mut manifest, &project_path, &sequence, &effects, &config)?;
    if crate::core::render::refresh_manifest_plan_fingerprints(
        &mut manifest,
        &project_path,
        &render_graph,
        &assets,
        &effects,
    )? {
        save_manifest(&project_path, &manifest)
            .map_err(|error| format!("Failed to save cache manifest: {error}"))?;
    }
    cleanup_stale_files(&project_path, &mut manifest);

    // Find segments that need rendering
    let pending_indices: Vec<u32> = manifest
        .segments
        .iter()
        .filter(|s| s.needs_render())
        .map(|s| s.index)
        .collect();

    let total_pending = pending_indices.len() as u32;

    if total_pending == 0 {
        emit_render_lifecycle(
            &app_handle,
            RenderLifecycleEvent {
                job_id: cache_job_id.clone(),
                sequence_id: Some(seq_id.clone()),
                kind: RenderLifecycleKind::PreviewCache,
                state: RenderLifecycleState::AlreadyCached,
                progress: Some(100.0),
                message: Some("Preview cache is already current".to_string()),
                output_path: None,
                plan_hash: None,
            },
        );

        return Ok(RenderCacheJobResult {
            job_id: cache_job_id,
            sequence_id: seq_id,
            total_segments: manifest.segments.len() as u32,
            segments_to_render: 0,
            status: RenderCacheJobStatus::AlreadyCached,
        });
    }

    // Save initial manifest state
    save_manifest(&project_path, &manifest)
        .map_err(|error| format!("Failed to save cache manifest: {error}"))?;

    // Collect segment time ranges before spawning (avoids borrow issues)
    let segment_ranges: Vec<(u32, f64, f64)> = pending_indices
        .iter()
        .filter_map(|idx| {
            manifest
                .segments
                .iter()
                .find(|s| s.index == *idx)
                .map(|s| (s.index, s.start_sec, s.end_sec))
        })
        .collect();

    let total_segments = manifest.segments.len() as u32;

    emit_render_lifecycle(
        &app_handle,
        RenderLifecycleEvent {
            job_id: cache_job_id.clone(),
            sequence_id: Some(seq_id.clone()),
            kind: RenderLifecycleKind::PreviewCache,
            state: RenderLifecycleState::Queued,
            progress: Some(0.0),
            message: Some("Preview cache render queued".to_string()),
            output_path: None,
            plan_hash: None,
        },
    );

    // Clone FFmpegRunner before spawning (State<'_> cannot be moved into spawn)
    let ffmpeg_runner = {
        let ffmpeg_guard = ffmpeg_state.read().await;
        ffmpeg_guard
            .runner()
            .ok_or("FFmpeg not initialized")?
            .clone()
    };

    let job_seq_id = seq_id.clone();
    let cache_config = config.clone();

    // Cancel any in-flight cache render before starting a new one.
    if let Ok(mut handle) = ACTIVE_CACHE_RENDER.lock() {
        if let Some(previous) = handle.take() {
            previous.abort_handle.abort();
            tracing::info!("Aborted previous cache render task");
            emit_render_lifecycle(
                &app_handle,
                RenderLifecycleEvent {
                    job_id: previous.job_id,
                    sequence_id: Some(previous.sequence_id),
                    kind: RenderLifecycleKind::PreviewCache,
                    state: RenderLifecycleState::Cancelled,
                    progress: None,
                    message: Some("Preview cache render was replaced by a newer job".to_string()),
                    output_path: None,
                    plan_hash: None,
                },
            );
        }
    }

    let cache_job_id_for_task = cache_job_id.clone();
    let join_handle = tokio::spawn(async move {
        use tauri::Manager;

        let engine = ExportEngine::new(ffmpeg_runner);
        let mut completed_normally = true;

        emit_render_lifecycle(
            &app_handle,
            RenderLifecycleEvent {
                job_id: cache_job_id_for_task.clone(),
                sequence_id: Some(job_seq_id.clone()),
                kind: RenderLifecycleKind::PreviewCache,
                state: RenderLifecycleState::Running,
                progress: Some(0.0),
                message: Some("Preview cache render started".to_string()),
                output_path: None,
                plan_hash: None,
            },
        );

        for (completed, (idx, start_sec, end_sec)) in segment_ranges.iter().enumerate() {
            // Re-load manifest to get latest state
            let mut current_manifest = match load_manifest(&project_path, &job_seq_id) {
                Ok(Some(m)) => m,
                Ok(None) => {
                    let message = format!(
                        "Cache manifest disappeared while rendering sequence {}",
                        job_seq_id
                    );
                    let _ = app_handle.emit("render-cache-error", message.clone());
                    emit_render_lifecycle(
                        &app_handle,
                        RenderLifecycleEvent {
                            job_id: cache_job_id_for_task.clone(),
                            sequence_id: Some(job_seq_id.clone()),
                            kind: RenderLifecycleKind::PreviewCache,
                            state: RenderLifecycleState::Failed,
                            progress: None,
                            message: Some(message),
                            output_path: None,
                            plan_hash: None,
                        },
                    );
                    completed_normally = false;
                    break;
                }
                Err(error) => {
                    let message = format!("Failed to reload cache manifest: {error}");
                    let _ = app_handle.emit("render-cache-error", message.clone());
                    emit_render_lifecycle(
                        &app_handle,
                        RenderLifecycleEvent {
                            job_id: cache_job_id_for_task.clone(),
                            sequence_id: Some(job_seq_id.clone()),
                            kind: RenderLifecycleKind::PreviewCache,
                            state: RenderLifecycleState::Failed,
                            progress: None,
                            message: Some(message),
                            output_path: None,
                            plan_hash: None,
                        },
                    );
                    completed_normally = false;
                    break;
                }
            };

            // Re-acquire fresh project state for each segment to avoid rendering
            // with stale data if the user edits the timeline during cache rendering.
            let (fresh_sequence, fresh_assets, fresh_effects, fresh_render_graph) = {
                let app_state = app_handle.state::<crate::AppState>();
                let guard = app_state.project.lock().await;
                match guard.as_ref() {
                    Some(project) => {
                        let seq = match project.state.sequences.get(&job_seq_id) {
                            Some(s) => s.clone(),
                            None => {
                                let message =
                                    format!("Sequence {} removed during cache render", job_seq_id);
                                tracing::warn!("{message}");
                                let _ = app_handle.emit("render-cache-error", message.clone());
                                emit_render_lifecycle(
                                    &app_handle,
                                    RenderLifecycleEvent {
                                        job_id: cache_job_id_for_task.clone(),
                                        sequence_id: Some(job_seq_id.clone()),
                                        kind: RenderLifecycleKind::PreviewCache,
                                        state: RenderLifecycleState::Failed,
                                        progress: None,
                                        message: Some(message),
                                        output_path: None,
                                        plan_hash: None,
                                    },
                                );
                                completed_normally = false;
                                break;
                            }
                        };
                        let graph = match crate::core::render::build_render_graph(
                            &project.state,
                            &job_seq_id,
                        ) {
                            Ok(graph) => graph,
                            Err(error) => {
                                let message =
                                    format!("Failed to build preview cache render graph: {error}");
                                tracing::warn!("{message}");
                                let _ = app_handle.emit("render-cache-error", message.clone());
                                emit_render_lifecycle(
                                    &app_handle,
                                    RenderLifecycleEvent {
                                        job_id: cache_job_id_for_task.clone(),
                                        sequence_id: Some(job_seq_id.clone()),
                                        kind: RenderLifecycleKind::PreviewCache,
                                        state: RenderLifecycleState::Failed,
                                        progress: None,
                                        message: Some(message),
                                        output_path: None,
                                        plan_hash: None,
                                    },
                                );
                                completed_normally = false;
                                break;
                            }
                        };
                        let a: std::collections::HashMap<String, crate::core::assets::Asset> =
                            project
                                .state
                                .assets
                                .iter()
                                .map(|(k, v)| (k.clone(), v.clone()))
                                .collect();
                        let e: std::collections::HashMap<String, crate::core::effects::Effect> =
                            project
                                .state
                                .effects
                                .iter()
                                .map(|(k, v)| (k.clone(), v.clone()))
                                .collect();
                        (seq, a, e, graph)
                    }
                    None => {
                        let message = "Project closed during cache render".to_string();
                        tracing::warn!("{message}");
                        let _ = app_handle.emit("render-cache-error", message.clone());
                        emit_render_lifecycle(
                            &app_handle,
                            RenderLifecycleEvent {
                                job_id: cache_job_id_for_task.clone(),
                                sequence_id: Some(job_seq_id.clone()),
                                kind: RenderLifecycleKind::PreviewCache,
                                state: RenderLifecycleState::Failed,
                                progress: None,
                                message: Some(message),
                                output_path: None,
                                plan_hash: None,
                            },
                        );
                        completed_normally = false;
                        break;
                    }
                }
            };

            // Mark rendering
            if let Some(segment) = current_manifest
                .segments
                .iter_mut()
                .find(|s| s.index == *idx)
            {
                segment.state = crate::core::render::CacheSegmentState::Rendering;
            }
            let _ = save_manifest(&project_path, &current_manifest);

            // Build segment export settings
            let seg_output =
                crate::core::render::segment_cache_file(&project_path, &job_seq_id, *idx);

            if let Some(parent) = seg_output.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    tracing::warn!("Failed to create cache directory {}: {e}", parent.display());
                }
            }

            let seg_settings = crate::core::render::ExportSettings::preview(
                seg_output.clone(),
                Some(*start_sec),
                Some(*end_sec),
            );

            let validation = crate::core::render::validate_export_settings(
                &fresh_sequence,
                &fresh_assets,
                &fresh_effects,
                &seg_settings,
            );
            if !validation.is_valid {
                let error = format!(
                    "Preview cache segment {} validation failed: {}",
                    idx,
                    validation.errors.join("; ")
                );
                tracing::warn!("{error}");
                let _ = app_handle.emit("render-cache-error", error.clone());
                emit_render_lifecycle(
                    &app_handle,
                    RenderLifecycleEvent {
                        job_id: cache_job_id_for_task.clone(),
                        sequence_id: Some(job_seq_id.clone()),
                        kind: RenderLifecycleKind::PreviewCache,
                        state: RenderLifecycleState::Failed,
                        progress: None,
                        message: Some(error),
                        output_path: None,
                        plan_hash: None,
                    },
                );
                completed_normally = false;
                break;
            }

            let render_plan = crate::core::render::build_render_plan(
                &fresh_render_graph,
                &fresh_assets,
                &fresh_effects,
                &seg_settings,
            );
            if !render_plan.validation.is_valid {
                let error = format!(
                    "Preview cache segment {} render plan validation failed: {}",
                    idx,
                    render_plan.validation.errors.join("; ")
                );
                tracing::warn!("{error}");
                let _ = app_handle.emit("render-cache-error", error.clone());
                emit_render_lifecycle(
                    &app_handle,
                    RenderLifecycleEvent {
                        job_id: cache_job_id_for_task.clone(),
                        sequence_id: Some(job_seq_id.clone()),
                        kind: RenderLifecycleKind::PreviewCache,
                        state: RenderLifecycleState::Failed,
                        progress: None,
                        message: Some(error),
                        output_path: None,
                        plan_hash: Some(render_plan.plan_hash.clone()),
                    },
                );
                completed_normally = false;
                break;
            }
            let segment_plan_hash = render_plan.plan_hash.clone();

            // Render with fresh data
            let result = engine
                .export_sequence_with_effects_for_plan(
                    &fresh_sequence,
                    &fresh_assets,
                    &fresh_effects,
                    &seg_settings,
                    &render_plan,
                    None,
                    None,
                )
                .await;

            // Update manifest
            let mut updated_manifest = match load_manifest(&project_path, &job_seq_id) {
                Ok(Some(m)) => m,
                Ok(None) => {
                    let message = format!(
                        "Cache manifest disappeared while finalizing sequence {}",
                        job_seq_id
                    );
                    let _ = app_handle.emit("render-cache-error", message.clone());
                    emit_render_lifecycle(
                        &app_handle,
                        RenderLifecycleEvent {
                            job_id: cache_job_id_for_task.clone(),
                            sequence_id: Some(job_seq_id.clone()),
                            kind: RenderLifecycleKind::PreviewCache,
                            state: RenderLifecycleState::Failed,
                            progress: None,
                            message: Some(message),
                            output_path: None,
                            plan_hash: None,
                        },
                    );
                    completed_normally = false;
                    break;
                }
                Err(error) => {
                    let message = format!("Failed to reload cache manifest: {error}");
                    let _ = app_handle.emit("render-cache-error", message.clone());
                    emit_render_lifecycle(
                        &app_handle,
                        RenderLifecycleEvent {
                            job_id: cache_job_id_for_task.clone(),
                            sequence_id: Some(job_seq_id.clone()),
                            kind: RenderLifecycleKind::PreviewCache,
                            state: RenderLifecycleState::Failed,
                            progress: None,
                            message: Some(message),
                            output_path: None,
                            plan_hash: None,
                        },
                    );
                    completed_normally = false;
                    break;
                }
            };

            match result {
                Ok(export_result) => {
                    updated_manifest.mark_segment_cached(
                        *idx,
                        seg_output
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string(),
                        export_result.file_size,
                    );
                    enforce_cache_limit(
                        &project_path,
                        &mut updated_manifest,
                        cache_config.max_cache_bytes,
                    );
                }
                Err(error) => {
                    if let Some(seg) = updated_manifest
                        .segments
                        .iter_mut()
                        .find(|s| s.index == *idx)
                    {
                        seg.state = crate::core::render::CacheSegmentState::Error;
                        seg.cached_file = None;
                        seg.file_size_bytes = 0;
                    }
                    let error_message =
                        format!("Failed to render cache segment {}: {}", idx, error);
                    let _ = app_handle.emit("render-cache-error", error_message.clone());
                    emit_render_lifecycle(
                        &app_handle,
                        RenderLifecycleEvent {
                            job_id: cache_job_id_for_task.clone(),
                            sequence_id: Some(job_seq_id.clone()),
                            kind: RenderLifecycleKind::PreviewCache,
                            state: RenderLifecycleState::Failed,
                            progress: None,
                            message: Some(error_message),
                            output_path: None,
                            plan_hash: Some(segment_plan_hash.clone()),
                        },
                    );
                    completed_normally = false;
                }
            }

            let _ = save_manifest(&project_path, &updated_manifest);

            // Emit progress
            let _ = app_handle.emit(
                "render-cache-progress",
                serde_json::json!({
                    "jobId": cache_job_id_for_task.clone(),
                    "sequenceId": job_seq_id.clone(),
                    "completedSegments": completed + 1,
                    "totalSegments": total_pending,
                    "percent": ((completed + 1) as f64 / total_pending as f64) * 100.0,
                }),
            );
            emit_render_lifecycle(
                &app_handle,
                RenderLifecycleEvent {
                    job_id: cache_job_id_for_task.clone(),
                    sequence_id: Some(job_seq_id.clone()),
                    kind: RenderLifecycleKind::PreviewCache,
                    state: RenderLifecycleState::Running,
                    progress: Some(((completed + 1) as f64 / total_pending as f64) * 100.0),
                    message: Some(format!("Rendered preview cache segment {}", idx)),
                    output_path: None,
                    plan_hash: Some(segment_plan_hash),
                },
            );
        }

        // Only emit completion when all segments rendered successfully.
        // Error paths set completed_normally = false and already emitted
        // render-cache-error, so the UI won't misinterpret a failure as success.
        if completed_normally {
            let _ = app_handle.emit(
                "render-cache-complete",
                serde_json::json!({
                    "jobId": cache_job_id_for_task.clone(),
                    "sequenceId": job_seq_id.clone(),
                }),
            );
            emit_render_lifecycle(
                &app_handle,
                RenderLifecycleEvent {
                    job_id: cache_job_id_for_task.clone(),
                    sequence_id: Some(job_seq_id.clone()),
                    kind: RenderLifecycleKind::PreviewCache,
                    state: RenderLifecycleState::Completed,
                    progress: Some(100.0),
                    message: Some("Preview cache render completed".to_string()),
                    output_path: None,
                    plan_hash: None,
                },
            );
        }

        if let Ok(mut handle) = ACTIVE_CACHE_RENDER.lock() {
            if handle
                .as_ref()
                .is_some_and(|active| active.job_id == cache_job_id_for_task)
            {
                *handle = None;
            }
        }
    });

    // Store the abort handle so the next render call can cancel this one.
    if let Ok(mut handle) = ACTIVE_CACHE_RENDER.lock() {
        *handle = Some(ActiveCacheRender {
            job_id: cache_job_id.clone(),
            sequence_id: seq_id.clone(),
            abort_handle: join_handle.abort_handle(),
        });
    }

    Ok(RenderCacheJobResult {
        job_id: cache_job_id,
        sequence_id: seq_id,
        total_segments,
        segments_to_render: total_pending,
        status: RenderCacheJobStatus::Started,
    })
}

/// Status of a render cache job
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RenderCacheJobStatus {
    /// Cache rendering has been started in the background
    Started,
    /// All segments are already cached; no rendering needed
    AlreadyCached,
}

/// Result of starting a render cache job
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderCacheJobResult {
    /// Job ID for lifecycle/progress correlation
    pub job_id: String,
    /// Sequence being cached
    pub sequence_id: String,
    /// Total segments in the timeline
    pub total_segments: u32,
    /// Number of segments that need rendering
    pub segments_to_render: u32,
    /// Job status
    pub status: RenderCacheJobStatus,
}

// =============================================================================
// Point Tracking
// =============================================================================

/// Arguments for the track_point command.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrackPointArgs {
    pub sequence_id: String,
    pub track_id: String,
    pub clip_id: String,
    /// Frame index to start tracking from (0-based).
    pub start_frame: usize,
    /// Normalized X coordinate of the point to track (0.0–1.0).
    pub x: f64,
    /// Normalized Y coordinate of the point to track (0.0–1.0).
    pub y: f64,
    /// Template patch size in pixels. Default: 25.
    pub template_size: Option<u32>,
    /// Search area size in pixels. Default: 100.
    pub search_area_size: Option<u32>,
    /// Minimum confidence threshold (0.0–1.0). Default: 0.75.
    pub confidence_threshold: Option<f64>,
}

/// Result of point tracking analysis.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrackPointResult {
    /// JSON-encoded tracking data (Vec<TrackPointData>).
    pub tracking_data: String,
    /// Number of frames successfully tracked.
    pub points_count: usize,
    /// Average confidence score across all tracked points.
    pub average_confidence: f64,
}

/// Run point tracking analysis on a clip.
///
/// Uses NCC (Normalized Cross-Correlation) template matching to track
/// a user-selected point across video frames. The tracking data is returned
/// as JSON and should be stored in the ObjectTracking effect params.
///
/// Progress is reported via `track-point-progress` Tauri events.
#[tauri::command]
#[specta::specta]
pub async fn track_point(
    args: TrackPointArgs,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
) -> Result<TrackPointResult, String> {
    use crate::core::tracking::models::TrackingConfig;
    use crate::core::tracking::tracker;
    use tauri::Emitter;

    let TrackPointArgs {
        sequence_id,
        track_id,
        clip_id,
        start_frame,
        x,
        y,
        template_size,
        search_area_size,
        confidence_threshold,
    } = args;

    // Validate coordinates
    let valid_range = 0.0..=1.0;
    if !valid_range.contains(&x) || !valid_range.contains(&y) {
        return Err("Point coordinates must be in 0.0–1.0 range".to_string());
    }

    // Resolve clip source path and metadata
    let (source_path, video_width, video_height, fps, clip_source_in_sec, clip_total_frames) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;

        let sequence = project
            .state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| format!("Sequence not found: {sequence_id}"))?;

        let track = sequence
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;

        let clip = track
            .clips
            .iter()
            .find(|c| c.id == clip_id)
            .ok_or_else(|| format!("Clip not found: {clip_id}"))?;

        let asset = project
            .state
            .assets
            .get(&clip.asset_id)
            .ok_or_else(|| format!("Asset not found: {}", clip.asset_id))?;

        let (width, height, fps) = if let Some(ref video) = asset.video {
            (video.width, video.height, video.fps.as_f64())
        } else {
            (1920, 1080, sequence.format.fps.as_f64())
        };
        let asset_duration_sec = asset.duration_sec.ok_or_else(|| {
            "Asset has no known duration; cannot determine frame range for tracking".to_string()
        })?;
        let source_in_sec = clip.range.source_in_sec.clamp(0.0, asset_duration_sec);
        let source_out_sec = clip
            .range
            .source_out_sec
            .clamp(source_in_sec, asset_duration_sec);
        let clip_duration_sec = source_out_sec - source_in_sec;
        if clip_duration_sec <= 0.0 {
            return Err(format!("Clip has no trackable source range: {clip_id}"));
        }
        let frames = ((clip_duration_sec * fps).ceil() as usize).max(1);

        (asset.uri.clone(), width, height, fps, source_in_sec, frames)
    };

    // Validate start_frame against clip-local frame count
    if start_frame >= clip_total_frames {
        return Err(format!(
            "start_frame ({start_frame}) exceeds clip frames ({clip_total_frames})"
        ));
    }

    let source = validate_local_input_path(&source_path, "Tracking source file")?;

    // Get FFmpeg runner
    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    // Build tracking config
    let config = TrackingConfig {
        template_size: template_size.unwrap_or(25),
        search_area_size: search_area_size.unwrap_or(100),
        confidence_threshold: confidence_threshold.unwrap_or(0.75),
        ..TrackingConfig::default()
    };

    // Emit initial progress
    let _ = app_handle.emit(
        "track-point-progress",
        serde_json::json!({
            "clipId": clip_id,
            "progress": 0,
            "phase": "tracking"
        }),
    );

    // Set up progress channel
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<f32>(32);

    // Forward progress to Tauri events in a background task
    let clip_id_clone = clip_id.clone();
    let app_handle_clone = app_handle.clone();
    let progress_forwarder = tokio::spawn(async move {
        while let Some(progress) = progress_rx.recv().await {
            let _ = app_handle_clone.emit(
                "track-point-progress",
                serde_json::json!({
                    "clipId": clip_id_clone,
                    "progress": progress.round() as u32,
                    "phase": "tracking"
                }),
            );
        }
    });

    // Run tracking
    let ffmpeg_path = ffmpeg.info().ffmpeg_path.clone();

    let result = tracker::track_point(
        &crate::core::tracking::tracker::TrackPointInput {
            ffmpeg_path: &ffmpeg_path,
            video_path: &source,
            start_frame,
            origin_x: x,
            origin_y: y,
            video_width,
            video_height,
            fps,
            clip_source_in_sec,
            clip_total_frames,
        },
        &config,
        Some(&progress_tx),
    )
    .await
    .map_err(|e| format!("Tracking failed: {e}"))?;

    // Clean up progress channel
    drop(progress_tx);
    let _ = progress_forwarder.await;

    // Compute stats
    let points_count = result.points.len();
    let average_confidence = if points_count > 0 {
        result.points.iter().map(|p| p.confidence).sum::<f64>() / points_count as f64
    } else {
        0.0
    };

    // Serialize tracking data
    let tracking_data = serde_json::to_string(&result.points)
        .map_err(|e| format!("Failed to serialize tracking data: {e}"))?;

    // Emit completion
    let _ = app_handle.emit(
        "track-point-progress",
        serde_json::json!({
            "clipId": clip_id,
            "progress": 100,
            "phase": "complete"
        }),
    );

    Ok(TrackPointResult {
        tracking_data,
        points_count,
        average_confidence,
    })
}

#[cfg(test)]
mod tests {
    use super::validate_batch_item_range;

    #[test]
    fn validate_batch_item_range_rejects_negative_in_point() {
        assert_eq!(
            validate_batch_item_range(2, Some(-0.1), Some(1.0)).unwrap_err(),
            "Batch item 2: In point must be non-negative"
        );
    }

    #[test]
    fn validate_batch_item_range_rejects_in_point_at_or_after_out_point() {
        assert_eq!(
            validate_batch_item_range(1, Some(5.0), Some(5.0)).unwrap_err(),
            "Batch item 1: In point must be before Out point"
        );
        assert_eq!(
            validate_batch_item_range(1, Some(6.0), Some(5.0)).unwrap_err(),
            "Batch item 1: In point must be before Out point"
        );
    }

    #[test]
    fn validate_batch_item_range_accepts_open_or_forward_ranges() {
        assert!(validate_batch_item_range(0, None, None).is_ok());
        assert!(validate_batch_item_range(0, Some(0.0), None).is_ok());
        assert!(validate_batch_item_range(0, Some(0.0), Some(1.0)).is_ok());
    }
}

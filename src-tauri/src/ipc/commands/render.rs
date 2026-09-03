//! Render/export commands
//!
//! Tauri IPC commands for starting final render exports,
//! batch rendering, range-based rendering, and render cancellation.

use specta::Type;
use tauri::State;

use crate::core::{
    fs::{
        export_allowed_roots, validate_local_input_path, validate_path_id_component,
        validate_scoped_output_path,
    },
    render::{
        cancel_render_job, is_agent_render_output, prune_agent_renders, register_render_job,
        unregister_render_job, AudioExportFormat, ExportError, ImageFormat, VideoExportRequest,
        MAX_AGENT_RENDERS,
    },
    CoreError,
};
use crate::AppState;

/// Runs export validation without blocking the async runtime.
///
/// Validation measures every transformed clip's source with a synchronous
/// FFprobe. Calling it inline would park a Tauri runtime worker on a child
/// process for as long as the probe takes, which is exactly the blocking the
/// worker-separation rule exists to prevent.
async fn validate_export_settings_off_runtime(
    sequence: &crate::core::timeline::Sequence,
    assets: &std::collections::HashMap<String, crate::core::assets::Asset>,
    effects: &std::collections::HashMap<String, crate::core::effects::Effect>,
    settings: &crate::core::render::ExportSettings,
) -> Result<crate::core::render::ExportValidation, String> {
    let sequence = sequence.clone();
    let assets = assets.clone();
    let effects = effects.clone();
    let settings = settings.clone();

    tokio::task::spawn_blocking(move || {
        crate::core::render::validate_export_settings(&sequence, &assets, &effects, &settings)
    })
    .await
    .map_err(|error| format!("Export validation task failed: {}", error))
}

/// Everything an export checks before it is allowed to start.
///
/// An export runs two independent validation passes — the settings pass and the
/// render-plan pass — and refuses on either. Keeping them together in one type
/// is what lets the preflight command report exactly the set of problems the
/// render enforces, instead of a second opinion that can drift from it.
pub(crate) struct ExportPreflight {
    settings: crate::core::render::ExportValidation,
    plan: crate::core::render::RenderPlan,
}

impl ExportPreflight {
    /// Whether a render started right now would be allowed to proceed.
    fn is_valid(&self) -> bool {
        self.settings.is_valid && self.plan.validation.is_valid
    }

    /// Refuses the export exactly as the render commands always have.
    ///
    /// The settings pass is reported before the plan pass, and each keeps its
    /// own message prefix, so an existing caller reading the error string sees
    /// the same text it saw before.
    fn enforce(&self) -> Result<(), String> {
        if !self.settings.is_valid {
            return Err(format!(
                "Export validation failed: {}",
                self.settings.errors.join("; ")
            ));
        }
        if !self.plan.validation.is_valid {
            return Err(format!(
                "Render plan validation failed: {}",
                self.plan.validation.errors.join("; ")
            ));
        }
        Ok(())
    }

    /// Logs the non-blocking findings; `scope` names the export that produced them.
    fn log_warnings(&self, scope: &str) {
        for warning in &self.settings.warnings {
            tracing::warn!("{} warning: {}", scope, warning);
        }
        for warning in &self.plan.validation.warnings {
            tracing::warn!("Render plan warning: {}", warning);
        }
    }

    /// Flattens both passes into one navigable list for the UI.
    fn findings(&self) -> Vec<ExportFindingDto> {
        use crate::core::render::ExportFindingSeverity;

        let mut findings: Vec<ExportFindingDto> = self
            .settings
            .findings
            .iter()
            .map(|finding| ExportFindingDto {
                severity: match finding.severity {
                    ExportFindingSeverity::Error => ExportFindingSeverityDto::Error,
                    ExportFindingSeverity::Warning => ExportFindingSeverityDto::Warning,
                },
                message: finding.message.clone(),
                clip_id: finding.clip_id.clone(),
                sequence_id: finding.sequence_id.clone(),
            })
            .collect();

        // The render-plan pass reports findings as plain strings, so even the
        // ones that name a clip carry no structured id to point at yet; these
        // rows render as (clip-named) plain text rather than jump-to-clip
        // buttons. Threading structured clip ids through RenderPlanValidation
        // the way ExportValidation now does is a follow-up.
        let plan_sequence_id = Some(self.plan.sequence_id.clone());
        findings.extend(
            self.plan
                .validation
                .errors
                .iter()
                .map(|message| ExportFindingDto {
                    severity: ExportFindingSeverityDto::Error,
                    message: message.clone(),
                    clip_id: None,
                    sequence_id: plan_sequence_id.clone(),
                }),
        );
        findings.extend(
            self.plan
                .validation
                .warnings
                .iter()
                .map(|message| ExportFindingDto {
                    severity: ExportFindingSeverityDto::Warning,
                    message: message.clone(),
                    clip_id: None,
                    sequence_id: plan_sequence_id.clone(),
                }),
        );

        findings
    }
}

/// Runs both validation passes an export performs, without starting one.
///
/// `start_render`, `render_range` and the `validate_export` preflight all go
/// through here so the dialog can never warn about something the render does
/// not enforce, or stay silent about something it does.
pub(crate) async fn run_export_preflight(
    sequence: &crate::core::timeline::Sequence,
    assets: &std::collections::HashMap<String, crate::core::assets::Asset>,
    effects: &std::collections::HashMap<String, crate::core::effects::Effect>,
    render_graph: &crate::core::render::RenderGraph,
    settings: &crate::core::render::ExportSettings,
) -> Result<ExportPreflight, String> {
    let settings_validation =
        validate_export_settings_off_runtime(sequence, assets, effects, settings).await?;
    let plan = crate::core::render::build_render_plan(render_graph, assets, effects, settings);

    Ok(ExportPreflight {
        settings: settings_validation,
        plan,
    })
}

// =============================================================================
// DTOs
// =============================================================================

/// How badly a preflight finding affects the export (IPC DTO).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ExportFindingSeverityDto {
    /// The export is blocked until this is fixed.
    Error,
    /// The export runs, but the file differs from the timeline.
    Warning,
}

/// One preflight finding, carrying the ids needed to navigate to its cause.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportFindingDto {
    /// Whether this blocks the export or only degrades it.
    pub severity: ExportFindingSeverityDto,
    /// Human-readable description of the problem.
    pub message: String,
    /// Clip the finding is about, when it is about one clip.
    pub clip_id: Option<String>,
    /// Sequence the finding belongs to.
    pub sequence_id: Option<String>,
}

/// Result of an export preflight (IPC DTO).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportValidationDto {
    /// Whether a render started with these settings would be allowed to run.
    pub is_valid: bool,
    /// Every finding from both validation passes, errors and warnings alike.
    pub findings: Vec<ExportFindingDto>,
}

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

/// Builds the settings a render runs with, from an explicit request or a preset id.
///
/// `canvas` is the sequence canvas. It only matters to the proxy profile, which
/// fits its frame to the sequence instead of to a fixed 854x480 — a vertical or
/// square edit rendered into a landscape frame arrives with a fraction of its
/// picture and is useless to look at.
///
/// The proxy is handled before
/// [`ExportPreset::from_legacy_id`](crate::core::render::ExportPreset::from_legacy_id)
/// because it is
/// not one of its variants: `proxy_480p` is a documented preset the CLI serves,
/// and reaching the enum with it produced "Unknown export preset" from every
/// desktop render command.
fn build_export_settings(
    output_path: std::path::PathBuf,
    preset: &str,
    request: Option<&VideoExportRequest>,
    canvas: &crate::core::timeline::Canvas,
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
        None => crate::core::render::ExportSettings::from_preset_id(
            preset,
            output_path,
            canvas,
            start_time,
            end_time,
        )
        .map_err(|error| error.to_string()),
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

/// Runs the export's validation passes without starting a render.
///
/// The dialog calls this first so a project that would be refused — or silently
/// degraded — is reported against the clips that caused it, before any encoding
/// work begins. It takes the same inputs `start_render`/`render_range` use to
/// build their settings, and runs them through the same helper those commands
/// enforce with, so a clean preflight means a render that will not be refused.
///
/// Pass `in_point`/`out_point` for the range case; omit both for a full export.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(skip(state), fields(sequence_id = %sequence_id, preset = %preset))]
pub async fn validate_export(
    sequence_id: String,
    output_path: String,
    preset: String,
    settings: Option<VideoExportRequest>,
    in_point: Option<f64>,
    out_point: Option<f64>,
    state: State<'_, AppState>,
) -> Result<ExportValidationDto, String> {
    if let (Some(in_pt), Some(out_pt)) = (in_point, out_point) {
        if in_pt >= out_pt {
            return Err("In point must be before Out point".to_string());
        }
        if in_pt < 0.0 {
            return Err("In point must be non-negative".to_string());
        }
    }

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

    // The output path decides the container, which the settings pass validates,
    // so the preflight has to resolve it exactly the way the render does.
    let approved_dirs = state.approved_export_dirs_snapshot().await;
    let roots = export_allowed_roots(&project_path, &approved_dirs);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    let validated_output_path =
        validate_scoped_output_path(&output_path, "Output path", &root_refs)?;

    // Hardware preferences are deliberately not resolved here: they only pick an
    // encoder and a GPU device, neither of which any validator inspects, and
    // resolving them would spawn two FFmpeg probes for a check that is supposed
    // to be cheap enough to run on every Export click.
    let export_settings = build_export_settings(
        validated_output_path,
        &preset,
        settings.as_ref(),
        &sequence.format.canvas,
        in_point,
        out_point,
    )?;

    let preflight = run_export_preflight(
        &sequence,
        &assets,
        &effects,
        &render_graph,
        &export_settings,
    )
    .await?;

    Ok(ExportValidationDto {
        is_valid: preflight.is_valid(),
        findings: preflight.findings(),
    })
}

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
    use crate::core::render::{ExportEngine, ExportProgress};
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
    let approved_dirs = state.approved_export_dirs_snapshot().await;
    let roots = export_allowed_roots(&project_path, &approved_dirs);
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
        &sequence.format.canvas,
        None,
        None,
    )?;

    resolve_export_hardware_preferences(&app_handle, &ffmpeg.info().ffmpeg_path, &mut settings)
        .await?;

    // Validate export settings and the render plan before starting. This is the
    // same helper the `validate_export` preflight calls, so the dialog's warning
    // list and this refusal can never disagree.
    let preflight =
        run_export_preflight(&sequence, &assets, &effects, &render_graph, &settings).await?;
    preflight.enforce()?;
    preflight.log_warnings("Export");

    let render_plan = preflight.plan;
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

/// Trims the agent render directory, off the runtime driving the UI.
///
/// Does nothing unless `output_path` is a draft render inside that directory —
/// a user's own export is never pruned. Both the recognition and the pruning
/// touch the filesystem (`canonicalize`, `read_dir`, `remove_file`), which is
/// exactly the blocking the worker-separation rule exists to prevent.
///
/// Best-effort in every direction: a directory that cannot be listed, a file
/// that will not delete, or a blocking thread that panicked are all logged and
/// stepped over. A full agent cache is a housekeeping problem, not a reason to
/// refuse the render the user asked for.
async fn prune_agent_renders_off_runtime(
    project_path: &std::path::Path,
    output_path: &std::path::Path,
) {
    let project_path = project_path.to_path_buf();
    let output_path = output_path.to_path_buf();

    let pruned = tokio::task::spawn_blocking(move || {
        if !is_agent_render_output(&project_path, &output_path) {
            return Ok(0);
        }
        prune_agent_renders(&project_path, MAX_AGENT_RENDERS, Some(&output_path))
    })
    .await;

    match pruned {
        Ok(Ok(0)) => {}
        Ok(Ok(removed)) => tracing::debug!("Pruned {} stale agent draft render(s)", removed),
        Ok(Err(error)) => {
            tracing::warn!("Failed to prune the agent render directory: {}", error)
        }
        Err(error) => tracing::warn!("Agent render pruning did not complete: {}", error),
    }
}

// =============================================================================
// Render Range Command
// =============================================================================

/// Starts a render export of a specific time range within the sequence.
///
/// Uses `in_point` and `out_point` (in seconds) to restrict the export
/// to a portion of the timeline. Reports progress via Tauri events.
///
/// # Agent draft renders
///
/// An output path inside the project's agent render directory
/// (`.openreelio/cache/renders/agent/`) is treated as an agent's scratch draft:
/// before the job starts, that directory is trimmed back to its newest
/// `MAX_AGENT_RENDERS` (8) `.mp4` files, never touching the file this call is
/// about to write. Nothing else prunes it, and an agent that renders a draft
/// per iteration of a judge loop would otherwise leave every intermediate cut
/// inside the user's project. Renders anywhere else are untouched.
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
    use crate::core::render::{ExportEngine, ExportProgress};
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
    let approved_dirs = state.approved_export_dirs_snapshot().await;
    let roots = export_allowed_roots(&project_path, &approved_dirs);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    let validated_output_path =
        validate_scoped_output_path(&output_path, "Output path", &root_refs)?;

    // An agent's draft renders land in a directory nothing else prunes, so the
    // bound is enforced here, before the job that adds to it starts. The file
    // this call is about to write is excluded, so re-rendering over an existing
    // draft cannot delete the very output being produced.
    prune_agent_renders_off_runtime(&project_path, &validated_output_path).await;

    let ffmpeg_guard = ffmpeg_state.read().await;
    let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
        "FFmpeg not initialized. Please install FFmpeg and restart the application.".to_string()
    })?;

    // Build settings with range
    let mut settings = build_export_settings(
        validated_output_path,
        &preset,
        settings.as_ref(),
        &sequence.format.canvas,
        Some(in_point),
        Some(out_point),
    )?;

    resolve_export_hardware_preferences(&app_handle, &ffmpeg.info().ffmpeg_path, &mut settings)
        .await?;

    let preflight =
        run_export_preflight(&sequence, &assets, &effects, &render_graph, &settings).await?;
    preflight.enforce()?;

    // Same warnings `start_render` logs: motion keyframes and the rest describe
    // ways the file will differ from the preview, and a range export differs the
    // same way.
    preflight.log_warnings("Range export");

    let render_plan = preflight.plan;
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
    use crate::core::render::{ExportEngine, ExportProgress, ExportSettings};
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
    let approved_dirs = state.approved_export_dirs_snapshot().await;
    let roots = export_allowed_roots(&project_path, &approved_dirs);
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
            &sequence.format.canvas,
            item.in_point,
            item.out_point,
        )?;

        let validation =
            validate_export_settings_off_runtime(&sequence, &assets, &effects, &settings).await?;
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
    let approved_dirs = state.approved_export_dirs_snapshot().await;
    let roots = export_allowed_roots(&project_path, &approved_dirs);
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
        // The GUI still exports stills at the source's native resolution.
        max_width: None,
    };

    let result = engine
        .export_frame(&sequence, &assets, &project_path, &settings)
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
    let approved_dirs = state.approved_export_dirs_snapshot().await;
    let roots = export_allowed_roots(&project_path, &approved_dirs);
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

    // Security: `clip_id` is used as a file name component below
    // (`.openreelio/stabilize/<clipId>.trf`). Clip ids come from the project file,
    // which is untrusted input, so reject separators and `..` before they can
    // escape the stabilization directory.
    validate_path_id_component(&clip_id, "clipId")?;

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

    // Security: asset URIs from a loaded project file have not passed the
    // command-layer validation, so re-validate before handing it to ffmpeg. This
    // rejects `..`/URL/protocol strings and non-existent files, preventing path
    // traversal, ffmpeg-protocol SSRF, and argument injection at the input arg.
    let source_path = validate_local_input_path(&source_path, "stabilize source")
        .map_err(|e| format!("Invalid source media path: {}", e))?
        .to_string_lossy()
        .to_string();

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

    // `vidstabdetect=result='<path>'` and the `vidstabtransform` apply pass both carry
    // this path as a quoted filter option, and FFmpeg's filtergraph grammar cannot
    // represent a literal `'` in one. The path derives from the project directory, which
    // can legitimately sit under a profile like `C:\Users\Ben's PC\`. Without this guard
    // pass 1 writes its transforms somewhere else and pass 2 stabilizes against nothing.
    crate::core::fs::validate_filter_safe_path(&transforms_path, "Stabilization data path")?;

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

    let detect_filter = crate::core::effects::build_vidstabdetect_filter(&transforms_path);

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

    // Security: asset URIs from a loaded project file have not passed the
    // command-layer validation, so re-validate before handing it to ffprobe/ffmpeg.
    // This rejects `..`/URL/protocol strings and non-existent files, preventing path
    // traversal, ffmpeg-protocol SSRF, and ffprobe argument injection (the URI is
    // passed as a bare positional arg below, so a leading `-` would otherwise be
    // parsed as an option; an absolute validated path cannot).
    let source_path = validate_local_input_path(&source_path, "reframe source")
        .map_err(|e| format!("Invalid source media path: {}", e))?
        .to_string_lossy()
        .to_string();

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
///
/// This command is read-only. The frontend polls it on every render-cache
/// progress event, so a persisted reconcile here would let the poll invalidate
/// the cache the background render is filling.
#[tauri::command]
#[specta::specta]
pub async fn get_cache_status(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<crate::core::render::RenderCacheStatus, String> {
    use crate::core::render::cache::{cache_status_snapshot, preview_profile_hash};

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

    // The status snapshot re-fingerprints a private copy of the manifest so the
    // indicator reports staleness honestly (it never persists). That needs the
    // same render graph / assets / effects the fill path builds.
    let render_graph = crate::core::render::build_render_graph(&project.state, seq_id)
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

    let config = resolve_cache_config(&app);

    cache_status_snapshot(
        &project.path,
        sequence,
        &preview_profile_hash(&sequence.format.canvas),
        &render_graph,
        &assets,
        &effects,
        &config,
    )
    .map_err(|error| format!("Failed to load cache manifest: {error}"))
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
    profile_hash: &str,
    files: &[String],
) {
    if files.is_empty() {
        return;
    }

    // `sequence_id`, `profile_hash` and every entry in `files` originate in the on-disk
    // manifest, so all three are validated before this reaches `remove_file`.
    let seq_dir =
        match crate::core::render::profile_cache_dir(project_path, sequence_id, profile_hash) {
            Ok(dir) => dir,
            Err(error) => {
                tracing::warn!("Skipping orphaned render cache cleanup: {error}");
                return;
            }
        };
    for file in files {
        let Some(file_path) = crate::core::render::resolve_cached_segment_path(&seq_dir, file)
        else {
            continue;
        };
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

/// Brings a manifest's segment layout in line with the sequence and persists it.
///
/// Only render commands may call this: it resets segments left in
/// [`CacheSegmentState::Rendering`](crate::core::render::CacheSegmentState) by an
/// interrupted run, which is correct only for the caller that is about to own the
/// render, and it writes the manifest back to disk. Read-only callers use
/// [`cache_status_snapshot`](crate::core::render::cache_status_snapshot).
fn reconcile_cache_manifest(
    manifest: &mut crate::core::render::RenderCacheManifest,
    project_path: &std::path::Path,
    sequence: &crate::core::timeline::Sequence,
    config: &crate::core::render::RenderCacheConfig,
) -> Result<(), String> {
    let sync = manifest.reconcile_with_sequence(
        sequence.duration(),
        config.segment_duration_sec,
        crate::core::render::InterruptedRenderPolicy::Reset,
    );

    cleanup_orphaned_cache_files(
        project_path,
        &manifest.sequence_id,
        &manifest.profile_hash,
        &sync.orphaned_files,
    );

    if sync.changed {
        crate::core::render::save_manifest(project_path, manifest)
            .map_err(|error| format!("Failed to save cache manifest: {error}"))?;
    }

    Ok(())
}

use crate::core::render::preview_cancel::PreviewCacheCancel;
use crate::core::render::preview_fill::{
    self, ActiveFillView, CacheFillWorkSet, CancelledOutcome, EnsureAction, PreviewCacheScope,
};

/// Cancellation handle, identity and live queue of the active cache render task.
///
/// At most one cache render is active at a time, but a later request does not
/// automatically replace it: the decision is
/// [`preview_fill::decide_ensure_action`], and a request that only changes
/// *which* segments are wanted retargets `work` in place instead of restarting.
struct ActiveCacheRender {
    job_id: String,
    sequence_id: String,
    cancel: std::sync::Arc<PreviewCacheCancel>,
    /// Segments the running fill is still trying to produce.
    ///
    /// Shared with the fill task, which pops from it, so a retarget is visible
    /// to the loop on its next iteration without restarting anything.
    work: std::sync::Arc<std::sync::Mutex<CacheFillWorkSet>>,
}

static ACTIVE_CACHE_RENDER: std::sync::LazyLock<std::sync::Mutex<Option<ActiveCacheRender>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// What [`ensure_cache_fill`] settled on inside the registry critical section.
///
/// Carried out of the lock so the emits and the task spawn happen without
/// holding it.
enum EnsureOutcome {
    /// Register and spawn a new fill; `superseded` names the fill it replaced.
    Spawn {
        /// `(job_id, sequence_id)` of the replaced fill, for its cancel event.
        superseded: Option<(String, String)>,
    },
    /// The running fill is already producing this work set; nothing to do.
    Converging { job_id: String },
    /// The running fill's queue was swapped in place.
    Retargeted {
        job_id: String,
        /// Size of the merged queue the fill is now converging on.
        queued: u32,
    },
}

/// Folds a request into a registered fill's work and asks
/// [`preview_fill::decide_ensure_action`] what to do about it.
///
/// Returns the action together with the work set the fill should end up
/// converging on, which is the *merged* set — a request in a narrower scope must
/// not shrink a broader fill.
///
/// Split out only so the borrow of the registry entry and of its queue guard
/// both end before the caller mutates the registry.
fn decide_ensure_action_for(
    active: &ActiveCacheRender,
    active_work: &CacheFillWorkSet,
    desired: &CacheFillWorkSet,
) -> (EnsureAction, CacheFillWorkSet) {
    // Read once and use for both the merge and the decision: two reads could
    // straddle the fill arming or disarming a segment, and then the target would
    // be folded for one identity while the verdict was computed against another.
    let in_flight = active.cancel.in_flight();
    let target = preview_fill::merge_work_sets(active_work, desired, in_flight);
    let view = ActiveFillView {
        work: active_work,
        in_flight,
    };
    (
        preview_fill::decide_ensure_action(Some(&view), &target),
        target,
    )
}

/// Clears the cancel slot's in-flight identity when a fill iteration ends,
/// however it ends.
///
/// The identity is published at *pop* time rather than at encode time, so every
/// early exit between the two — a project closed, a graph that will not build, a
/// plan that fails validation — has to retract it. A `Drop` guard covers those
/// exits without threading a `disarm_segment` call through each one, where a
/// missed branch would leave the registry claiming an encode that is not
/// running.
struct ArmedSegmentGuard(std::sync::Arc<PreviewCacheCancel>);

impl Drop for ArmedSegmentGuard {
    fn drop(&mut self) {
        self.0.disarm_segment();
    }
}

/// How a fill's end-of-queue check resolved, decided under the registry lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FillExit {
    /// Work is still queued; keep going.
    Continue,
    /// The queue is empty and this fill has deregistered itself.
    Finished,
    /// The registry belongs to someone else; stop without deregistering.
    Superseded,
}

/// Settles whether a fill with an empty-looking queue may stop.
///
/// This closes the dying-fill race. Seeing an empty queue and *then* taking the
/// registry lock to deregister leaves a window in which an ensure call takes the
/// registry, finds this fill still registered, and retargets it — pushing work
/// onto a queue whose owner is already on its way out. That work would never be
/// rendered and no later request would notice, because the registry entry
/// disappears a moment later.
///
/// Re-reading the queue *under the registry lock* removes the window: an ensure
/// call has to hold that same lock to retarget, so either it lands before this
/// check (and the re-read sees the new work, returning
/// [`Continue`](FillExit::Continue)) or it lands after (and finds no registered
/// fill, so it starts a new one). Lock order is registry → queue, matching
/// `ensure_cache_fill`, so the two cannot deadlock.
fn settle_fill_exit(job_id: &str, work: &std::sync::Mutex<CacheFillWorkSet>) -> FillExit {
    let Ok(mut handle) = ACTIVE_CACHE_RENDER.lock() else {
        // The registry cannot be read, so nothing can be retargeted onto this
        // fill either. Stopping is the only safe move.
        tracing::warn!("Preview cache registry unavailable; ending fill");
        return FillExit::Finished;
    };

    if handle.as_ref().is_none_or(|active| active.job_id != job_id) {
        return FillExit::Superseded;
    }

    match work.lock() {
        Ok(queue) if !queue.is_empty() => FillExit::Continue,
        Ok(_) => {
            *handle = None;
            FillExit::Finished
        }
        Err(_) => {
            tracing::warn!("Preview cache fill queue unavailable; ending fill");
            *handle = None;
            FillExit::Finished
        }
    }
}

/// Retracts a preview-cache segment whose encode was cancelled, and reports
/// whether the fill itself should stop.
///
/// Used for both cancellation windows — before the encode starts and during it —
/// so a segment cancelled either way is left renderable rather than failed, and
/// the fill's next move is decided by the same rule in both cases.
fn retract_cancelled_segment(
    app_handle: &tauri::AppHandle,
    project_path: &std::path::Path,
    seq_id: &str,
    job_id: &str,
    index: u32,
    plan_hash: Option<String>,
    superseded: bool,
) -> CancelledOutcome {
    reload_mutate_save_manifest(project_path, seq_id, |manifest| {
        if let Some(segment) = manifest
            .segments
            .iter_mut()
            .find(|segment| segment.index == index)
        {
            segment.state = crate::core::render::CacheSegmentState::Empty;
            segment.cached_file = None;
            segment.file_size_bytes = 0;
        }
    });

    let outcome = preview_fill::cancelled_outcome(superseded);
    let message = match outcome {
        CancelledOutcome::StopFill => {
            format!("Preview cache segment {index} superseded by a newer render")
        }
        CancelledOutcome::ContinueFill => {
            format!("Preview cache segment {index} restarted with newer inputs")
        }
    };
    emit_render_lifecycle(
        app_handle,
        RenderLifecycleEvent {
            job_id: job_id.to_string(),
            sequence_id: Some(seq_id.to_string()),
            kind: RenderLifecycleKind::PreviewCache,
            state: RenderLifecycleState::Cancelled,
            progress: None,
            message: Some(message),
            output_path: None,
            plan_hash,
        },
    );

    outcome
}

/// Reloads a sequence's cache manifest, applies `mutate`, and saves the result.
///
/// Every manifest write in the fill loop goes through this. A manifest snapshot
/// read before an `.await` — or simply read a moment earlier, since the ensure
/// path runs on a different thread — is stale by the time it is written back,
/// and saving it whole reverts everything that landed in between: `Cached` →
/// `Stale` demotions, refreshed fingerprints, work another request queued. The
/// reverted state then reads as "nothing to do" and the retargeted work is lost.
///
/// Reloading immediately before the mutation, applying only the one segment's
/// change, and saving with no `.await` in between narrows that window to the
/// span of this function.
fn reload_mutate_save_manifest(
    project_path: &std::path::Path,
    seq_id: &str,
    mutate: impl FnOnce(&mut crate::core::render::RenderCacheManifest),
) -> Option<crate::core::render::RenderCacheManifest> {
    let mut manifest = match crate::core::render::load_manifest(project_path, seq_id) {
        Ok(Some(manifest)) => manifest,
        Ok(None) => {
            tracing::warn!("Cache manifest for sequence {seq_id} disappeared before a write");
            return None;
        }
        Err(error) => {
            tracing::warn!("Failed to reload cache manifest for sequence {seq_id}: {error}");
            return None;
        }
    };

    mutate(&mut manifest);

    if let Err(error) = crate::core::render::save_manifest(project_path, &manifest) {
        tracing::warn!("Failed to save cache manifest for sequence {seq_id}: {error}");
        return None;
    }

    Some(manifest)
}

/// Everything a preview cache command needs from the open project, copied out
/// from under the project lock so nothing downstream holds it.
struct CacheRenderInputs {
    sequence: crate::core::timeline::Sequence,
    assets: std::collections::HashMap<String, crate::core::assets::Asset>,
    effects: std::collections::HashMap<String, crate::core::effects::Effect>,
    render_graph: crate::core::render::RenderGraph,
    project_path: std::path::PathBuf,
    seq_id: String,
}

/// Copies the active sequence and its render inputs out of the open project.
async fn gather_cache_render_inputs(
    state: &State<'_, AppState>,
) -> Result<CacheRenderInputs, String> {
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

    Ok(CacheRenderInputs {
        sequence,
        assets,
        effects,
        render_graph,
        project_path: project.path.clone(),
        seq_id,
    })
}

/// Loads the preview cache manifest for a sequence and brings its freshness
/// verdict up to date.
///
/// A manifest left by another encode profile describes files in a different
/// directory that were encoded to different settings, so it is discarded along
/// with those files. What survives is then reconciled against the sequence
/// layout, re-fingerprinted against the current render plan, and stripped of
/// segments whose files have gone missing.
///
/// This may persist the manifest — it resets segments an interrupted run left in
/// [`CacheSegmentState::Rendering`](crate::core::render::CacheSegmentState) — so
/// only a caller that is about to own the render may call it. Read-only callers
/// use [`crate::core::render::cache_status_snapshot`].
#[allow(clippy::too_many_arguments)]
fn prepare_cache_manifest(
    project_path: &std::path::Path,
    seq_id: &str,
    profile_hash: &str,
    sequence: &crate::core::timeline::Sequence,
    render_graph: &crate::core::render::RenderGraph,
    assets: &std::collections::HashMap<String, crate::core::assets::Asset>,
    effects: &std::collections::HashMap<String, crate::core::effects::Effect>,
    config: &crate::core::render::RenderCacheConfig,
) -> Result<crate::core::render::RenderCacheManifest, String> {
    use crate::core::render::cache::{
        cleanup_stale_files, manifest_for_profile, prune_other_profile_caches, save_manifest,
    };

    let loaded = manifest_for_profile(
        project_path,
        seq_id,
        profile_hash,
        sequence.duration(),
        config.segment_duration_sec,
    )
    .map_err(|e| format!("Failed to load cache manifest: {e}"))?;
    if let Some(discarded) = loaded.discarded_profile {
        tracing::info!(
            "Discarding preview cache for sequence {seq_id} written with render profile \
             {discarded:?}; current profile is {profile_hash:?}"
        );
        if let Err(error) = prune_other_profile_caches(project_path, seq_id, profile_hash) {
            tracing::warn!("Failed to prune stale render profile caches: {error}");
        }
    }
    let mut manifest = loaded.manifest;

    reconcile_cache_manifest(&mut manifest, project_path, sequence, config)?;
    let fingerprints_changed = crate::core::render::refresh_manifest_plan_fingerprints(
        &mut manifest,
        project_path,
        sequence,
        render_graph,
        assets,
        effects,
    )?;
    // Flags are persisted alongside fingerprints so the stored manifest explains
    // why each segment is worth filling. They never demote a segment, so a
    // flag-only change is a plain metadata write.
    let flags_changed = crate::core::render::refresh_manifest_segment_flags(
        &mut manifest,
        sequence,
        assets,
        effects,
    );
    if fingerprints_changed || flags_changed {
        save_manifest(project_path, &manifest)
            .map_err(|error| format!("Failed to save cache manifest: {error}"))?;
    }
    cleanup_stale_files(project_path, &mut manifest);

    Ok(manifest)
}

/// Render preview cache for the active sequence.
///
/// Triggers background rendering of uncached segments. Returns the cache
/// status immediately; rendering progress is reported via Tauri events.
///
/// `scope` selects which segments are wanted;
/// [`PreviewCacheScope::WholeTimeline`] when omitted.
///
/// A fill already in flight is *converged onto*, not cancelled: calling this
/// repeatedly with unchanged work is a no-op, and a changed work set retargets
/// the running fill. See [`crate::core::render::preview_fill`].
#[tauri::command]
#[specta::specta]
pub async fn render_preview_cache(
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app_handle: tauri::AppHandle,
    scope: Option<PreviewCacheScope>,
) -> Result<RenderCacheJobResult, String> {
    use crate::core::render::cache::preview_profile_hash;

    let scope = scope.unwrap_or_default();
    let config = resolve_cache_config(&app_handle);

    // Gather project data
    let CacheRenderInputs {
        sequence,
        assets,
        effects,
        render_graph,
        project_path,
        seq_id,
    } = gather_cache_render_inputs(&state).await?;

    // `State<'_>` cannot be moved into the spawned task, so the runner is cloned
    // out here. It stays optional so that an already-current cache still reports
    // `AlreadyCached` when FFmpeg is missing, exactly as it did while the fill
    // was inlined: the "FFmpeg not initialized" error is only raised on the path
    // that actually spawns.
    //
    // Cloned *before* the manifest is prepared, and deliberately so: this is the
    // last `.await` on the path, and `ensure_cache_fill` saves the manifest
    // prepared below. An await between the two would let a running fill mark a
    // segment `Cached` in the meantime, and saving the older snapshot would
    // revert it to `Error` — orphaning the file it just wrote and undercounting
    // the cache size. Nothing between here and that save may await.
    let ffmpeg_runner = ffmpeg_state.read().await.runner().cloned();

    let profile_hash = preview_profile_hash(&sequence.format.canvas);
    let manifest = prepare_cache_manifest(
        &project_path,
        &seq_id,
        &profile_hash,
        &sequence,
        &render_graph,
        &assets,
        &effects,
        &config,
    )?;

    // Find segments this scope wants rendered
    let pending = preview_fill::select_fill_segments(&manifest, scope);

    ensure_cache_fill(
        app_handle,
        ffmpeg_runner,
        project_path,
        seq_id,
        profile_hash,
        config,
        manifest,
        pending,
        scope,
    )
}

/// Converges the preview cache of a sequence onto the named segments.
///
/// Its caller — [`render_preview_cache`] — decides *which* segments are wanted;
/// this owns the rest: the already-current early return, persisting the
/// manifest, reconciling with any fill already running, and the background fill
/// task.
///
/// `manifest` must already be reconciled and re-fingerprinted; this function
/// trusts `pending` and does not recompute freshness.
///
/// At most one cache render runs at a time, but this does not simply supersede:
/// [`preview_fill::decide_ensure_action`] decides whether to start, converge
/// silently, retarget the running fill's queue, or replace it outright. This is
/// the only place that registers into [`ACTIVE_CACHE_RENDER`].
#[allow(clippy::too_many_arguments)]
fn ensure_cache_fill(
    app_handle: tauri::AppHandle,
    ffmpeg_runner: Option<crate::core::ffmpeg::FFmpegRunner>,
    project_path: std::path::PathBuf,
    seq_id: String,
    profile_hash: String,
    config: crate::core::render::RenderCacheConfig,
    manifest: crate::core::render::RenderCacheManifest,
    pending: Vec<(u32, crate::core::render::SegmentFingerprint)>,
    scope: PreviewCacheScope,
) -> Result<RenderCacheJobResult, String> {
    use crate::core::render::cache::{enforce_cache_limit, load_manifest, save_manifest};
    use crate::core::render::ExportEngine;
    use tauri::Emitter;

    let cache_job_id = ulid::Ulid::new().to_string();
    let desired = CacheFillWorkSet::new(seq_id.clone(), profile_hash.clone(), scope, pending);
    let total_pending = desired.len() as u32;

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

    let total_segments = manifest.segments.len() as u32;

    // Checked before the critical section so a failure here cannot leave a
    // registration behind with no task to honour it. A fill can only be in
    // flight if FFmpeg resolved, so the converge and retarget arms below are
    // unaffected in practice.
    let ffmpeg_runner = ffmpeg_runner.ok_or("FFmpeg not initialized")?;

    let job_seq_id = seq_id.clone();
    let job_profile_hash = profile_hash.clone();
    let cache_config = config;

    let cache_job_id_for_task = cache_job_id.clone();
    let cancel = std::sync::Arc::new(PreviewCacheCancel::default());
    let task_cancel = cancel.clone();
    let work = std::sync::Arc::new(std::sync::Mutex::new(desired.clone()));
    let task_work = work.clone();

    // Reconcile with the fill already in flight and register this one in a
    // single critical section, so two concurrent calls cannot both end up
    // running: if the decision and the register were separate locks, a second
    // call could decide (finding nothing yet registered) and register over this
    // one, leaving this fill with no one able to cancel it. A supersede that
    // lands before the task spawns is still caught by the loop-top
    // `is_superseded()`.
    let outcome = if let Ok(mut handle) = ACTIVE_CACHE_RENDER.lock() {
        let (action, target) = match handle.as_ref() {
            None => (EnsureAction::Start, desired.clone()),
            Some(active) => match active.work.lock() {
                Ok(active_work) => decide_ensure_action_for(active, &active_work, &desired),
                // The running fill's queue cannot be read, so there is no way to
                // converge onto it: take over wholesale rather than guess.
                Err(_) => (EnsureAction::Supersede, desired.clone()),
            },
        };

        match action {
            EnsureAction::Start | EnsureAction::Supersede => {
                let previous = handle.take();
                if let Some(previous) = &previous {
                    previous.cancel.trigger();
                }
                *handle = Some(ActiveCacheRender {
                    job_id: cache_job_id.clone(),
                    sequence_id: seq_id.clone(),
                    cancel,
                    work,
                });
                EnsureOutcome::Spawn {
                    superseded: previous.map(|previous| (previous.job_id, previous.sequence_id)),
                }
            }
            // Both arms below are only produced from a registered fill, so a
            // missing entry means the decision and the registry disagree. Fail
            // loudly instead of fabricating a job id or spawning a fill that
            // nothing owns.
            EnsureAction::AlreadyConverging => match handle.as_ref() {
                Some(active) => EnsureOutcome::Converging {
                    job_id: active.job_id.clone(),
                },
                None => {
                    tracing::error!(
                        "Preview cache registry lost its active fill while converging onto it"
                    );
                    return Err(
                        "Preview cache fill state is inconsistent; please try again".to_string()
                    );
                }
            },
            EnsureAction::Retarget { cancel_in_flight } => match handle.as_ref() {
                Some(active) => {
                    if let Ok(mut active_work) = active.work.lock() {
                        *active_work = target.clone();
                    }
                    // Ordered after the swap: the running fill must already see
                    // the new queue when it picks the cancelled segment back up.
                    if cancel_in_flight {
                        active.cancel.cancel_segment_if_stale(&target);
                    }
                    EnsureOutcome::Retargeted {
                        job_id: active.job_id.clone(),
                        queued: target.len() as u32,
                    }
                }
                None => {
                    tracing::error!(
                        "Preview cache registry lost its active fill while retargeting it"
                    );
                    return Err(
                        "Preview cache fill state is inconsistent; please try again".to_string()
                    );
                }
            },
        }
    } else {
        // The registry is unusable. Spawn anyway rather than refusing to fill —
        // this fill just cannot be cancelled, which is the pre-existing
        // behaviour of an unlockable registry.
        EnsureOutcome::Spawn { superseded: None }
    };

    let superseded = match outcome {
        EnsureOutcome::Converging { job_id } => {
            tracing::debug!("Preview cache fill {job_id} is already producing this work set");
            return Ok(RenderCacheJobResult {
                job_id,
                sequence_id: seq_id,
                total_segments,
                segments_to_render: total_pending,
                status: RenderCacheJobStatus::AlreadyConverging,
            });
        }
        EnsureOutcome::Retargeted { job_id, queued } => {
            tracing::info!("Retargeted preview cache fill {job_id}");
            return Ok(RenderCacheJobResult {
                job_id,
                sequence_id: seq_id,
                total_segments,
                // The merged queue, not this request's own list: a narrower
                // request folded into a broader fill still reports the real
                // amount of outstanding work.
                segments_to_render: queued,
                status: RenderCacheJobStatus::Retargeted,
            });
        }
        EnsureOutcome::Spawn { superseded } => superseded,
    };

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

    if let Some((previous_job_id, previous_sequence_id)) = superseded {
        tracing::info!("Superseded previous cache render task");
        emit_render_lifecycle(
            &app_handle,
            RenderLifecycleEvent {
                job_id: previous_job_id,
                sequence_id: Some(previous_sequence_id),
                kind: RenderLifecycleKind::PreviewCache,
                state: RenderLifecycleState::Cancelled,
                progress: None,
                message: Some("Preview cache render was replaced by a newer job".to_string()),
                output_path: None,
                plan_hash: None,
            },
        );
    }

    tokio::spawn(async move {
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

        // The queue is not frozen at spawn time: a later request can retarget it
        // while this loop runs, so every iteration re-reads what is left rather
        // than walking a list captured up front.
        let mut completed: usize = 0;
        loop {
            // A newer fill has taken over: stop before starting another segment
            // rather than render work no one will read.
            if task_cancel.is_superseded() {
                completed_normally = false;
                break;
            }

            // Nothing queued: stop, but settle that under the registry lock so a
            // concurrent retarget cannot push work onto a fill that is leaving.
            match settle_fill_exit(&cache_job_id_for_task, &task_work) {
                FillExit::Continue => {}
                FillExit::Finished => break,
                FillExit::Superseded => {
                    completed_normally = false;
                    break;
                }
            }

            // Re-load manifest to get latest state
            let current_manifest = match load_manifest(&project_path, &job_seq_id) {
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

            // Take the lowest-index segment still worth rendering. Entries the
            // manifest has moved on from — rendered by this fill's own earlier
            // pass, evicted, or re-queued by a retarget after they were already
            // produced — are dropped rather than re-encoded.
            let next = match task_work.lock() {
                Ok(mut queue) => queue.pop_next_where(|index| {
                    current_manifest
                        .segments
                        .iter()
                        .any(|segment| segment.index == index && segment.needs_render())
                }),
                Err(_) => {
                    tracing::warn!("Preview cache fill queue unavailable; stopping fill");
                    completed_normally = false;
                    break;
                }
            };
            let Some((idx, fingerprint)) = next else {
                // The pop drained the queue without finding work. Same race as
                // the loop-top check, same atomic exit.
                match settle_fill_exit(&cache_job_id_for_task, &task_work) {
                    FillExit::Continue => continue,
                    FillExit::Finished => break,
                    FillExit::Superseded => {
                        completed_normally = false;
                        break;
                    }
                }
            };

            // The window comes from the manifest, the identity from the queue:
            // the queue's fingerprint is what a later request compares against,
            // so arming with anything else would make retarget decisions
            // disagree with what is actually encoding.
            let Some((start_sec, end_sec)) = current_manifest
                .segments
                .iter()
                .find(|segment| segment.index == idx)
                .map(|segment| (segment.start_sec, segment.end_sec))
            else {
                continue;
            };

            // Publish this segment's identity *now*, at pop time, not when the
            // encode starts. Between the two the fill re-acquires the project
            // lock, rebuilds the graph and validates — several awaits, during
            // which the segment is in no queue at all. If the cancel slot were
            // still empty there, a request landing in that window would see
            // nothing in flight, decline to cancel, and let the encode run on
            // pre-edit state; the finished file would then be recorded against
            // the post-edit fingerprint and look current forever.
            //
            // Arming early means a cancel can fire before the exporter is
            // holding the receiver, so the receiver is polled once immediately
            // before the encode and a fired cancel is honoured there instead.
            let mut segment_cancel_rx = task_cancel.arm_segment(idx, fingerprint);
            // Retracts the identity on every path out of this iteration.
            let _armed = ArmedSegmentGuard(task_cancel.clone());

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

            // Mark rendering. Reloaded rather than written from the snapshot
            // taken before the project lock above: an ensure call on another
            // thread may have demoted segments or refreshed fingerprints in
            // between, and saving the older snapshot would revert that.
            reload_mutate_save_manifest(&project_path, &job_seq_id, |manifest| {
                if let Some(segment) = manifest
                    .segments
                    .iter_mut()
                    .find(|segment| segment.index == idx)
                {
                    segment.state = crate::core::render::CacheSegmentState::Rendering;
                }
            });

            // Build segment export settings
            let seg_output = match crate::core::render::segment_cache_file(
                &project_path,
                &job_seq_id,
                &job_profile_hash,
                idx,
            ) {
                Ok(path) => path,
                Err(error) => {
                    tracing::warn!("Skipping cache segment {idx}: {error}");
                    continue;
                }
            };

            if let Some(parent) = seg_output.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    tracing::warn!("Failed to create cache directory {}: {e}", parent.display());
                }
            }

            // Built from the same `preview_cache(canvas)` profile the manifest's
            // fingerprints were computed with, so the settings that render a
            // segment and the profile hash that identifies it agree.
            let seg_settings = crate::core::render::ExportSettings::preview_cache(
                seg_output.clone(),
                &fresh_sequence.format.canvas,
                Some(start_sec),
                Some(end_sec),
            );

            let validation = match validate_export_settings_off_runtime(
                &fresh_sequence,
                &fresh_assets,
                &fresh_effects,
                &seg_settings,
            )
            .await
            {
                Ok(validation) => validation,
                Err(error) => {
                    tracing::warn!("Preview cache segment {} validation failed: {error}", idx);
                    let _ = app_handle.emit("render-cache-error", error);
                    // The fill is stopping on an error, so it must not go on to
                    // announce itself complete.
                    completed_normally = false;
                    break;
                }
            };
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

            // The identity has been armed since the pop, so a cancel may already
            // have fired while this segment was being prepared. Honour it here
            // rather than starting an encode nobody wants. `Closed` counts as
            // cancelled too: the sender is only ever dropped by disarming, so a
            // closed channel means this encode could no longer be stopped.
            let cancelled_before_encode = !matches!(
                segment_cancel_rx.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            );
            if cancelled_before_encode {
                match retract_cancelled_segment(
                    &app_handle,
                    &project_path,
                    &job_seq_id,
                    &cache_job_id_for_task,
                    idx,
                    Some(segment_plan_hash.clone()),
                    task_cancel.is_superseded(),
                ) {
                    CancelledOutcome::StopFill => {
                        completed_normally = false;
                        break;
                    }
                    CancelledOutcome::ContinueFill => continue,
                }
            }

            // Render with fresh data. The segment cancel lets a superseding fill
            // kill this FFmpeg mid-encode instead of orphaning it, and carries the
            // segment's identity so a fill that was merely retargeted can cancel
            // this encode only if this segment's own work changed.
            let result = engine
                .export_sequence_with_effects_for_plan(
                    &fresh_sequence,
                    &fresh_assets,
                    &fresh_effects,
                    &seg_settings,
                    &render_plan,
                    None,
                    Some(segment_cancel_rx),
                )
                .await;
            task_cancel.disarm_segment();

            match result {
                Ok(export_result) => {
                    // The identity this encode was started for may have moved
                    // while it ran. Reload, compare, and only then record —
                    // `mark_segment_cached` writes `Cached` next to whatever
                    // fingerprint the manifest now holds, so accepting a
                    // mismatched file would bind pre-edit pixels to a post-edit
                    // identity that every later freshness check reports as
                    // current. That never self-heals.
                    let mut verdict = preview_fill::RenderedSegmentVerdict::Discard;
                    let cached_name = seg_output
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let saved =
                        reload_mutate_save_manifest(&project_path, &job_seq_id, |manifest| {
                            let stored = manifest
                                .segments
                                .iter()
                                .find(|segment| segment.index == idx)
                                .map(|segment| segment.fingerprint);
                            verdict =
                                preview_fill::verdict_for_rendered_segment(fingerprint, stored);
                            match verdict {
                                preview_fill::RenderedSegmentVerdict::Accept => {
                                    manifest.mark_segment_cached(
                                        idx,
                                        cached_name,
                                        export_result.file_size,
                                    );
                                }
                                preview_fill::RenderedSegmentVerdict::Discard => {
                                    if let Some(segment) = manifest
                                        .segments
                                        .iter_mut()
                                        .find(|segment| segment.index == idx)
                                    {
                                        segment.state =
                                            crate::core::render::CacheSegmentState::Empty;
                                        segment.cached_file = None;
                                        segment.file_size_bytes = 0;
                                    }
                                }
                            }
                        });

                    if verdict == preview_fill::RenderedSegmentVerdict::Discard {
                        // The bytes belong to a timeline that no longer exists.
                        // The retarget that moved the fingerprint also re-queued
                        // the segment, so it will be rendered again from current
                        // inputs; this attempt counts as no progress.
                        if let Err(error) = std::fs::remove_file(&seg_output) {
                            tracing::warn!(
                                "Failed to remove superseded cache segment {}: {error}",
                                seg_output.display()
                            );
                        }
                        tracing::info!(
                            "Discarded preview cache segment {idx}: its render plan changed while it was encoding"
                        );
                        continue;
                    }

                    // Only the segment just written is pinned: a fill must stay
                    // bounded by the size cap, and a single eviction pass must
                    // never delete the frame it just produced.
                    if let Some(mut manifest) = saved {
                        let protected = std::collections::HashSet::from([idx]);
                        if enforce_cache_limit(
                            &project_path,
                            &mut manifest,
                            cache_config.max_cache_bytes,
                            &protected,
                        ) > 0
                        {
                            let _ = save_manifest(&project_path, &manifest);
                        }
                    }

                    completed += 1;
                }
                Err(crate::core::render::ExportError::Cancelled) => {
                    // Something cancelled this segment mid-encode. The exporter
                    // already killed FFmpeg and removed the partial file; the
                    // segment is left renderable (not failed) either way, so the
                    // timeline shows work still to do rather than a permanent
                    // error. Whether the fill itself is over depends on which
                    // cancel fired: a supersede stops it, a retarget only
                    // discarded this one encode.
                    match retract_cancelled_segment(
                        &app_handle,
                        &project_path,
                        &job_seq_id,
                        &cache_job_id_for_task,
                        idx,
                        Some(segment_plan_hash.clone()),
                        task_cancel.is_superseded(),
                    ) {
                        CancelledOutcome::StopFill => {
                            completed_normally = false;
                            break;
                        }
                        // The retarget put this segment back in the queue with
                        // its new fingerprint, so the next iteration picks it up
                        // again against fresh inputs. It counts as no progress.
                        CancelledOutcome::ContinueFill => continue,
                    }
                }
                Err(error) => {
                    reload_mutate_save_manifest(&project_path, &job_seq_id, |manifest| {
                        if let Some(segment) = manifest
                            .segments
                            .iter_mut()
                            .find(|segment| segment.index == idx)
                        {
                            segment.state = crate::core::render::CacheSegmentState::Error;
                            segment.cached_file = None;
                            segment.file_size_bytes = 0;
                        }
                    });

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
                    // Deliberately not counted as completed: a failed segment
                    // produced nothing, and reporting it as progress would let a
                    // fill of nothing but failures read as finished work.
                    completed_normally = false;
                }
            }

            // The denominator moves: a retarget can grow or shrink the queue
            // mid-fill, so progress is measured against what this fill has done
            // plus what it still has left, not against the count it started
            // with.
            //
            // The segment just handled is excluded from "what is left" even
            // though it may sit in the queue again: a request that landed while
            // it was encoding re-derives its work set from a manifest where this
            // segment reads as `Rendering`, which reconciliation resets to
            // `Error` — so it is re-queued at the same fingerprint and would
            // otherwise be counted as both done and outstanding, pinning
            // progress below where it belongs. The pop-time `needs_render` check
            // drops it on the next pass.
            //
            // The scope label is read from the shared queue, not from this
            // task's spawn-time copy, so a fill that was widened by a retarget
            // reports the wider scope from then on.
            let (remaining, active_scope) = match task_work.lock() {
                Ok(queue) => (queue.len_excluding(idx), queue.scope),
                Err(_) => (0, scope),
            };
            let total_known = completed + remaining;
            let percent = if total_known == 0 {
                100.0
            } else {
                (completed as f64 / total_known as f64) * 100.0
            };

            // Emit progress
            let _ = app_handle.emit(
                "render-cache-progress",
                serde_json::json!({
                    "jobId": cache_job_id_for_task.clone(),
                    "sequenceId": job_seq_id.clone(),
                    "completedSegments": completed,
                    "totalSegments": total_known,
                    "percent": percent,
                    "scope": active_scope.event_key(),
                }),
            );
            emit_render_lifecycle(
                &app_handle,
                RenderLifecycleEvent {
                    job_id: cache_job_id_for_task.clone(),
                    sequence_id: Some(job_seq_id.clone()),
                    kind: RenderLifecycleKind::PreviewCache,
                    state: RenderLifecycleState::Running,
                    progress: Some(percent),
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
                    // From the shared queue, so a fill widened by a retarget
                    // reports what it actually finished, not what it started as.
                    "scope": task_work
                        .lock()
                        .map(|queue| queue.scope)
                        .unwrap_or(scope)
                        .event_key(),
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
    /// A fill already in flight is producing exactly this work; nothing changed.
    ///
    /// The returned job id is that running fill's, not a new one.
    AlreadyConverging,
    /// A fill already in flight had its queue swapped to this work set.
    ///
    /// The returned job id is that running fill's, not a new one.
    Retargeted,
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

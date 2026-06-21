//! Transcription, caption export, and shot detection commands
//!
//! Tauri IPC commands for speech-to-text, caption export, and shot detection.

use specta::Type;
use tauri::{Emitter, State};

use crate::core::{
    fs::{
        default_export_allowed_roots, validate_path_id_component, validate_scoped_output_path,
        write_bytes_atomic_no_symlink,
    },
    jobs::{Job, JobType, Priority},
    CoreError,
};
use crate::AppState;

// =============================================================================
// Transcription DTOs
// =============================================================================

/// Result of speech-to-text transcription.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResultDto {
    /// Detected or specified language code
    pub language: String,
    /// Transcribed segments with timestamps
    pub segments: Vec<TranscriptionSegmentDto>,
    /// Total audio duration in seconds
    pub duration: f64,
    /// Full transcription text (all segments concatenated)
    pub full_text: String,
}

/// A single transcription segment with timing.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionSegmentDto {
    /// Start time in seconds
    pub start_time: f64,
    /// End time in seconds
    pub end_time: f64,
    /// Transcribed text for this segment
    pub text: String,
}

/// Options for transcription request.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOptionsDto {
    /// Language code (e.g., "en", "ko") or "auto" for detection
    pub language: Option<String>,
    /// Whether to translate to English
    pub translate: Option<bool>,
    /// Whisper model to use, or "auto" to choose the best installed model
    pub model: Option<String>,
}

/// Installed/available local Whisper model state.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelDto {
    /// Stable model ID used in transcription options
    pub id: String,
    /// Human-readable model name
    pub display_name: String,
    /// Expected whisper.cpp model filename
    pub filename: String,
    /// Whether the model file exists and is non-empty
    pub installed: bool,
    /// Absolute expected model path
    pub path: String,
    /// Model file size in bytes when installed
    pub size_bytes: Option<u64>,
    /// Whether this is OpenReelio's default model
    pub is_default: bool,
    /// Whether this model is a recommended quality/performance choice
    pub recommended: bool,
    /// Official upstream download URL for the converted ggml model
    pub download_url: String,
    /// Estimated download size in bytes
    pub estimated_size_bytes: u64,
    /// Upstream source repository
    pub source: String,
    /// Upstream license label
    pub license: String,
}

/// Overall local transcription readiness and model inventory.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionStatusDto {
    /// Whether the current build includes local Whisper support
    pub feature_available: bool,
    /// Whether at least one supported local Whisper model is installed
    pub ready: bool,
    /// Directory where OpenReelio expects whisper.cpp ggml models
    pub models_dir: String,
    /// Default model ID used when no model is provided.
    ///
    /// This is the best installed model (or the recommended candidate when nothing
    /// is installed). It is always safe to transcribe with, so it never points at an
    /// uninstalled model.
    pub default_model: String,
    /// Recommended model ID for best quality/performance balance.
    ///
    /// This is OpenReelio's preferred model (`large-v3-turbo-q5_0`) regardless of
    /// install state. Combined with `recommended_installed`, the agent/UI can detect
    /// that a better model should be fetched even when an inferior model is already
    /// installed and currently used as the default.
    #[serde(default)]
    pub recommended_model: String,
    /// Whether the recommended model's file exists in `models_dir`.
    ///
    /// When `false`, the recommended model is not installed and the agent/UI can
    /// surface a download prompt to upgrade transcription quality.
    #[serde(default)]
    pub recommended_installed: bool,
    /// Number of installed supported models
    pub installed_count: usize,
    /// Supported models and install status
    pub models: Vec<TranscriptionModelDto>,
    /// Acceleration backend compiled into this build.
    ///
    /// One of "cuda", "metal", "vulkan", "coreml", "openblas", or "cpu". This is
    /// additive and lets the UI surface "GPU accelerated" status. Default builds
    /// report "cpu".
    #[serde(default)]
    pub acceleration: String,
}

/// Progress emitted while downloading a local Whisper model.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionModelDownloadProgressDto {
    /// Stable model ID being downloaded
    pub model: String,
    /// Downloaded bytes so far
    pub downloaded_bytes: u64,
    /// Total bytes when known
    pub total_bytes: Option<u64>,
    /// Progress percentage when total bytes is known
    pub percent: Option<f32>,
    /// Current stage
    pub stage: String,
}

// =============================================================================
// Caption Export DTOs
// =============================================================================

/// Export format for captions
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CaptionExportFormat {
    /// SubRip format (.srt)
    Srt,
    /// WebVTT format (.vtt)
    Vtt,
}

/// Caption data for export
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptionForExport {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Caption text
    pub text: String,
    /// Optional speaker name
    pub speaker: Option<String>,
}

// =============================================================================
// Shot Detection DTOs
// =============================================================================

/// Configuration options for shot detection
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShotDetectionConfig {
    /// Scene change detection threshold (0.0 - 1.0)
    /// Lower values detect more scene changes
    pub threshold: Option<f64>,
    /// Minimum shot duration in seconds
    pub min_shot_duration: Option<f64>,
}

impl Default for ShotDetectionConfig {
    fn default() -> Self {
        Self {
            threshold: Some(0.3),
            min_shot_duration: Some(0.5),
        }
    }
}

/// Detected shot data for frontend
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShotDto {
    /// Unique shot ID
    pub id: String,
    /// Asset ID this shot belongs to
    pub asset_id: String,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Path to keyframe thumbnail (if generated)
    pub keyframe_path: Option<String>,
    /// Quality score (0.0 - 1.0)
    pub quality_score: Option<f64>,
    /// Tags/labels for this shot
    pub tags: Vec<String>,
}

impl From<crate::core::indexing::Shot> for ShotDto {
    fn from(shot: crate::core::indexing::Shot) -> Self {
        Self {
            id: shot.id,
            asset_id: shot.asset_id,
            start_sec: shot.start_sec,
            end_sec: shot.end_sec,
            keyframe_path: shot.keyframe_path,
            quality_score: shot.quality_score,
            tags: shot.tags,
        }
    }
}

/// Result of shot detection operation
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShotDetectionResult {
    /// Number of shots detected
    pub shot_count: usize,
    /// Detected shots
    pub shots: Vec<ShotDto>,
    /// Total video duration in seconds
    pub total_duration: f64,
}

// =============================================================================
// Transcription Commands
// =============================================================================

/// Checks if transcription is available
#[tauri::command]
#[specta::specta]
pub async fn is_transcription_available() -> Result<bool, String> {
    Ok(crate::core::captions::whisper::is_whisper_available())
}

fn resolve_transcription_model(
    requested: Option<&str>,
    models_dir: &std::path::Path,
) -> Result<crate::core::captions::whisper::WhisperModel, String> {
    crate::core::captions::whisper::WhisperModel::resolve_requested_or_default(
        requested, models_dir,
    )
    .map_err(|error| {
        let value = requested.unwrap_or("auto");
        format!("Invalid Whisper model '{}': {}", value, error)
    })
}

fn build_transcription_model_dto(
    model: crate::core::captions::whisper::WhisperModel,
    models_dir: &std::path::Path,
    default_model: crate::core::captions::whisper::WhisperModel,
) -> TranscriptionModelDto {
    use crate::core::captions::whisper::WhisperModel;

    let path = models_dir.join(model.filename());
    let metadata = std::fs::metadata(&path).ok();
    let installed = metadata
        .as_ref()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false);

    TranscriptionModelDto {
        id: model.name().to_string(),
        display_name: model.display_name().to_string(),
        filename: model.filename().to_string(),
        installed,
        path: path.display().to_string(),
        size_bytes: metadata.map(|metadata| metadata.len()),
        is_default: model == default_model,
        recommended: matches!(
            model,
            WhisperModel::LargeV3TurboQ5
                | WhisperModel::LargeV3Turbo
                | WhisperModel::LargeV3
                | WhisperModel::Small
                | WhisperModel::Base
        ),
        download_url: model.download_url().to_string(),
        estimated_size_bytes: model.estimated_size_bytes(),
        source: model.source().to_string(),
        license: model.license().to_string(),
    }
}

async fn resolve_transcription_ffmpeg_path(
    ffmpeg_state: &State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    app: Option<&tauri::AppHandle>,
) -> Result<String, String> {
    let existing_path = {
        let guard = ffmpeg_state.read().await;
        guard
            .info()
            .map(|info| info.ffmpeg_path.to_string_lossy().into_owned())
    };
    if let Some(path) = existing_path {
        return Ok(path);
    }

    {
        let mut guard = ffmpeg_state.write().await;
        #[cfg(test)]
        {
            let _ = guard.initialize();
        }
        #[cfg(all(not(test), feature = "gui"))]
        {
            let _ = guard.initialize(app);
        }

        if let Some(info) = guard.info() {
            return Ok(info.ffmpeg_path.to_string_lossy().into_owned());
        }
    }

    Err(
        "FFmpeg is not available for transcription audio extraction. Install FFmpeg or restart OpenReelio so the bundled FFmpeg runner can initialize."
            .to_string(),
    )
}

/// Returns local Whisper transcription readiness and installed model status.
#[tauri::command]
#[specta::specta]
pub async fn get_transcription_status() -> Result<TranscriptionStatusDto, String> {
    use crate::core::captions::whisper::WhisperModel;

    let feature_available = crate::core::captions::whisper::is_whisper_available();
    let models_dir = crate::core::captions::whisper::default_models_dir();
    let default_model = WhisperModel::default_for_dir(&models_dir);
    let recommended_model = WhisperModel::recommended_default();
    let recommended_installed = recommended_model.is_installed_in(&models_dir);
    let models = WhisperModel::all()
        .iter()
        .map(|model| build_transcription_model_dto(*model, &models_dir, default_model))
        .collect::<Vec<_>>();
    let installed_count = models.iter().filter(|model| model.installed).count();

    Ok(TranscriptionStatusDto {
        feature_available,
        ready: feature_available && installed_count > 0,
        models_dir: models_dir.display().to_string(),
        default_model: default_model.name().to_string(),
        recommended_model: recommended_model.name().to_string(),
        recommended_installed,
        installed_count,
        models,
        acceleration: crate::core::captions::whisper::compiled_acceleration_backend().to_string(),
    })
}

/// Downloads and installs a local Whisper model into OpenReelio's model directory.
#[tauri::command]
#[specta::specta]
pub async fn download_whisper_model(
    model: String,
    overwrite: Option<bool>,
    app: tauri::AppHandle,
) -> Result<TranscriptionModelDto, String> {
    use crate::core::captions::whisper::{
        default_models_dir, download_whisper_model_blocking, WhisperModel,
    };

    if !crate::core::captions::whisper::is_whisper_available() {
        return Err(
            "Transcription model downloads require a build with the whisper feature enabled."
                .to_string(),
        );
    }

    let model = model
        .parse::<WhisperModel>()
        .map_err(|error| format!("Invalid Whisper model '{}': {}", model, error))?;
    let overwrite = overwrite.unwrap_or(false);
    let app_for_progress = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        download_whisper_model_blocking(model, overwrite, |progress| {
            let payload = TranscriptionModelDownloadProgressDto {
                model: progress.model.name().to_string(),
                downloaded_bytes: progress.downloaded_bytes,
                total_bytes: progress.total_bytes,
                percent: progress.percent(),
                stage: progress.stage.to_string(),
            };
            if let Err(error) =
                app_for_progress.emit("transcription:model-download-progress", payload)
            {
                tracing::debug!("Failed to emit transcription model download progress: {error}");
            }
        })
    })
    .await
    .map_err(|error| format!("Model download task failed: {}", error))?;

    result.map_err(|error| error.to_string())?;

    let models_dir = default_models_dir();
    let default_model = WhisperModel::default_for_dir(&models_dir);
    Ok(build_transcription_model_dto(
        model,
        &models_dir,
        default_model,
    ))
}

/// Transcribes an asset's audio content
///
/// This command extracts audio from the asset, runs Whisper transcription,
/// and returns the transcribed text with timestamps.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_asset(
    asset_id: String,
    options: Option<TranscriptionOptionsDto>,
    app: tauri::AppHandle,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    state: State<'_, AppState>,
) -> Result<TranscriptionResultDto, String> {
    use crate::core::captions::{
        audio::{extract_audio_for_transcription, load_audio_samples},
        whisper::{subtitle_ready_segments, TranscriptionOptions, WhisperEngine},
    };
    use std::path::PathBuf;

    // Check if whisper is available
    if !crate::core::captions::whisper::is_whisper_available() {
        return Err(
            "Transcription is not available. Rebuild OpenReelio with the whisper feature enabled."
                .to_string(),
        );
    }

    // Get asset from project
    let (asset_path, asset_name) = {
        let guard = state.project.lock().await;

        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        (PathBuf::from(&asset.uri), asset.name.clone())
    };

    tracing::info!(
        "Starting transcription for asset: {} ({})",
        asset_name,
        asset_id
    );

    // Get model path
    let models_dir = crate::core::captions::whisper::default_models_dir();
    let model = resolve_transcription_model(
        options
            .as_ref()
            .and_then(|options| options.model.as_deref()),
        &models_dir,
    )?;
    let model_path = models_dir.join(model.filename());

    if !model_path.exists() {
        return Err(format!(
            "Whisper model not found at {}. Please download the {} model.",
            model_path.display(),
            model.name()
        ));
    }
    let ffmpeg_path = resolve_transcription_ffmpeg_path(&ffmpeg_state, Some(&app)).await?;

    // Create temp directory for audio extraction
    let temp_dir = std::env::temp_dir()
        .join("openreelio")
        .join("transcription");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let audio_path = temp_dir.join(format!("{}.wav", asset_id));

    // RAII guard for temp file cleanup (ensures cleanup on both success and error)
    struct TempFileGuard(PathBuf);
    impl Drop for TempFileGuard {
        fn drop(&mut self) {
            if self.0.exists() {
                let _ = std::fs::remove_file(&self.0);
                tracing::debug!("Cleaned up temp audio file: {}", self.0.display());
            }
        }
    }
    let _temp_guard = TempFileGuard(audio_path.clone());

    // Create transcription options before moving into spawn_blocking
    let whisper_options = TranscriptionOptions {
        language: options.as_ref().and_then(|o| o.language.clone()),
        translate: options.as_ref().and_then(|o| o.translate).unwrap_or(false),
        threads: 0, // Auto-detect
        initial_prompt: None,
    };

    // Run heavy blocking operations (FFmpeg, file I/O, Whisper inference) in spawn_blocking
    let result = tokio::task::spawn_blocking(move || {
        // Extract audio from asset
        tracing::debug!("Extracting audio to: {}", audio_path.display());
        extract_audio_for_transcription(&asset_path, &audio_path, Some(ffmpeg_path.as_str()))
            .map_err(|e| format!("Audio extraction failed: {}", e))?;

        // Load audio samples
        let samples = load_audio_samples(&audio_path)
            .map_err(|e| format!("Failed to load audio samples: {}", e))?;

        tracing::debug!("Loaded {} audio samples", samples.len());

        // Create whisper engine and transcribe
        let engine = WhisperEngine::new(&model_path)
            .map_err(|e| format!("Failed to load Whisper model: {}", e))?;

        let result = engine
            .transcribe(&samples, &whisper_options)
            .map_err(|e| format!("Transcription failed: {}", e))?;

        tracing::info!(
            "Transcription complete: {} segments, {:.1}s duration",
            result.segments.len(),
            result.duration
        );

        Ok::<_, String>(result)
    })
    .await
    .map_err(|e| format!("Transcription task panicked: {}", e))??;

    // Convert to DTO - get full_text before consuming segments
    let full_text = result.full_text();
    let subtitle_segments = subtitle_ready_segments(&result.segments);
    Ok(TranscriptionResultDto {
        language: result.language,
        segments: subtitle_segments
            .into_iter()
            .map(|s| TranscriptionSegmentDto {
                start_time: s.start_time,
                end_time: s.end_time,
                text: s.text,
            })
            .collect(),
        duration: result.duration,
        full_text,
    })
}

/// Transcribes the audible audio mix of a sequence.
#[tauri::command]
#[specta::specta]
pub async fn transcribe_sequence(
    sequence_id: Option<String>,
    options: Option<TranscriptionOptionsDto>,
    app: tauri::AppHandle,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    state: State<'_, AppState>,
) -> Result<TranscriptionResultDto, String> {
    use crate::core::captions::{
        audio::{load_audio_samples, mix_sequence_audio_for_transcription},
        whisper::{subtitle_ready_segments, TranscriptionOptions, WhisperEngine},
    };

    if !crate::core::captions::whisper::is_whisper_available() {
        return Err(
            "Transcription is not available. Rebuild OpenReelio with the whisper feature enabled."
                .to_string(),
        );
    }

    let models_dir = crate::core::captions::whisper::default_models_dir();
    let model = resolve_transcription_model(
        options
            .as_ref()
            .and_then(|options| options.model.as_deref()),
        &models_dir,
    )?;
    let model_path = models_dir.join(model.filename());
    if !model_path.exists() {
        return Err(format!(
            "Whisper model not found at {}. Please download the {} model.",
            model_path.display(),
            model.name()
        ));
    }
    let ffmpeg_path = resolve_transcription_ffmpeg_path(&ffmpeg_state, Some(&app)).await?;

    let (project_state, resolved_sequence_id) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
        let resolved_sequence_id = sequence_id
            .clone()
            .or_else(|| project.state.active_sequence_id.clone())
            .ok_or_else(|| "No active sequence is available for transcription.".to_string())?;
        if !project.state.sequences.contains_key(&resolved_sequence_id) {
            return Err(format!("Sequence not found: {}", resolved_sequence_id));
        }
        (project.state.clone(), resolved_sequence_id)
    };

    tracing::info!(
        "Starting sequence transcription for sequence: {}",
        resolved_sequence_id
    );

    let temp_dir = std::env::temp_dir()
        .join("openreelio")
        .join("transcription");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let audio_path = temp_dir.join(format!("sequence-{}.wav", resolved_sequence_id));

    struct TempFileGuard(std::path::PathBuf);
    impl Drop for TempFileGuard {
        fn drop(&mut self) {
            if self.0.exists() {
                let _ = std::fs::remove_file(&self.0);
            }
        }
    }
    let _temp_guard = TempFileGuard(audio_path.clone());

    let whisper_options = TranscriptionOptions {
        language: options.as_ref().and_then(|o| o.language.clone()),
        translate: options.as_ref().and_then(|o| o.translate).unwrap_or(false),
        threads: 0,
        initial_prompt: None,
    };

    let result = tokio::task::spawn_blocking(move || {
        let mixdown = mix_sequence_audio_for_transcription(
            &project_state,
            &resolved_sequence_id,
            &audio_path,
            Some(ffmpeg_path.as_str()),
        )
        .map_err(|e| format!("Sequence audio mixdown failed: {}", e))?;
        tracing::debug!(
            "Sequence audio mixdown complete: {} layers, {:.2}s",
            mixdown.layer_count,
            mixdown.duration_sec
        );

        let samples = load_audio_samples(&audio_path)
            .map_err(|e| format!("Failed to load mixed sequence audio: {}", e))?;
        let engine = WhisperEngine::new(&model_path)
            .map_err(|e| format!("Failed to load Whisper model: {}", e))?;
        engine
            .transcribe(&samples, &whisper_options)
            .map_err(|e| format!("Transcription failed: {}", e))
    })
    .await
    .map_err(|e| format!("Transcription task failed: {}", e))??;

    let full_text = result.full_text();
    let subtitle_segments = subtitle_ready_segments(&result.segments);
    let segments = subtitle_segments
        .into_iter()
        .map(|s| TranscriptionSegmentDto {
            start_time: s.start_time,
            end_time: s.end_time,
            text: s.text,
        })
        .collect();

    Ok(TranscriptionResultDto {
        language: result.language,
        segments,
        duration: result.duration,
        full_text,
    })
}

/// Submits a transcription job to the worker pool
#[tauri::command]
#[specta::specta]
pub async fn submit_transcription_job(
    asset_id: String,
    options: Option<TranscriptionOptionsDto>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Resolve asset path at submission time so the job remains runnable even if
    // the project is closed later.
    let input_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;
        let asset = project
            .state
            .assets
            .get(&asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;
        asset.uri.clone()
    };

    // Create job payload
    let payload = serde_json::json!({
        "assetId": asset_id,
        "inputPath": input_path,
        "model": options.as_ref().and_then(|o| o.model.clone()),
        "language": options.as_ref().and_then(|o| o.language.clone()),
        "translate": options.as_ref().and_then(|o| o.translate),
        "options": options,
    });

    // Submit to job pool
    let job = Job::new(JobType::Transcription, payload).with_priority(Priority::UserRequest);
    let pool = state.job_pool.lock().await;
    let job_id = pool.submit(job).map_err(|e| e.to_string())?;

    tracing::info!(
        "Submitted transcription job: {} for asset: {}",
        job_id,
        asset_id
    );

    Ok(job_id)
}

// =============================================================================
// Caption Export Commands
// =============================================================================

/// Exports captions to a file in the specified format
///
/// # Arguments
///
/// * `captions` - Array of captions to export
/// * `output_path` - File path where captions will be saved
/// * `format` - Export format (SRT or VTT)
#[tauri::command]
#[specta::specta]
pub async fn export_captions(
    captions: Vec<CaptionForExport>,
    output_path: String,
    format: CaptionExportFormat,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::core::captions::{export_srt, export_vtt, Caption};

    // Convert to internal Caption type
    let internal_captions: Vec<Caption> = captions
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let mut caption = Caption::new(&format!("cap_{}", i), c.start_sec, c.end_sec, &c.text);
            caption.speaker = c.speaker;
            caption
        })
        .collect();

    // Export to the specified format
    let content = match format {
        CaptionExportFormat::Srt => export_srt(&internal_captions),
        CaptionExportFormat::Vtt => export_vtt(&internal_captions),
    };

    // Validate output path (IPC is a trust boundary) and restrict exports to safe roots.
    let project_path = {
        let guard = state.project.lock().await;
        let project = guard.as_ref().ok_or("No project open")?;
        project.path.clone()
    };

    let output_ext = match format {
        CaptionExportFormat::Srt => ".srt",
        CaptionExportFormat::Vtt => ".vtt",
    };

    let output_path_trimmed = output_path.trim();
    if !output_path_trimmed
        .to_ascii_lowercase()
        .ends_with(output_ext)
    {
        return Err(format!(
            "outputPath must end with '{}' for {:?} export",
            output_ext, format
        ));
    }

    let roots = default_export_allowed_roots(&project_path);
    let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();
    let validated_output_path =
        validate_scoped_output_path(output_path_trimmed, "outputPath", &root_refs)?;

    let write_path = validated_output_path.clone();
    tokio::task::spawn_blocking(move || {
        write_bytes_atomic_no_symlink(&write_path, content.as_bytes(), "outputPath")
    })
    .await
    .map_err(|e| format!("Caption write task failed: {e}"))?
    .map_err(|e| format!("Failed to write caption file: {e}"))?;

    tracing::info!(
        "Exported {} captions to {} as {:?}",
        internal_captions.len(),
        validated_output_path.display(),
        format
    );

    Ok(())
}

/// Gets caption content as a string in the specified format (without writing to file)
#[tauri::command]
#[specta::specta]
pub async fn get_captions_as_string(
    captions: Vec<CaptionForExport>,
    format: CaptionExportFormat,
) -> Result<String, String> {
    use crate::core::captions::{export_srt, export_vtt, Caption};

    // Convert to internal Caption type
    let internal_captions: Vec<Caption> = captions
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let mut caption = Caption::new(&format!("cap_{}", i), c.start_sec, c.end_sec, &c.text);
            caption.speaker = c.speaker;
            caption
        })
        .collect();

    // Export to the specified format
    let content = match format {
        CaptionExportFormat::Srt => export_srt(&internal_captions),
        CaptionExportFormat::Vtt => export_vtt(&internal_captions),
    };

    Ok(content)
}

// =============================================================================
// Shot Detection Commands
// =============================================================================

/// Detects shots/scenes in a video file
#[tauri::command]
#[specta::specta]
pub async fn detect_shots(
    asset_id: String,
    video_path: String,
    config: Option<ShotDetectionConfig>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
    state: State<'_, AppState>,
) -> Result<ShotDetectionResult, String> {
    use crate::core::indexing::{IndexDb, ShotDetector, ShotDetectorConfig};

    validate_path_id_component(&asset_id, "Asset ID")?;

    let video_path_ref = std::path::Path::new(&video_path);
    let video_path_canon = std::fs::canonicalize(video_path_ref)
        .map_err(|e| format!("Failed to resolve video path '{}': {}", video_path, e))?;

    let metadata = std::fs::metadata(&video_path_canon)
        .map_err(|e| format!("Failed to stat video file '{}': {}", video_path, e))?;
    if !metadata.is_file() {
        return Err(format!(
            "Expected a file path, got a directory: {}",
            video_path
        ));
    }

    // Resolve FFmpeg paths from global FFmpegState (bundled or system).
    let ffmpeg_info = {
        let guard = ffmpeg_state.read().await;
        guard.info().cloned()
    };

    let ffmpeg_info = match ffmpeg_info {
        Some(info) => info,
        None => {
            // Best-effort initialization (system FFmpeg only) in case the command
            // is called before app startup initialization completes.
            let mut guard = ffmpeg_state.write().await;
            let _ = guard.initialize(None);
            guard
                .info()
                .cloned()
                .ok_or_else(|| "FFmpeg is not available".to_string())?
        }
    };

    // Build detector config
    let detector_config = if let Some(cfg) = config {
        let threshold = cfg.threshold.unwrap_or(0.3);
        if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
            return Err("threshold must be a finite number between 0.0 and 1.0".to_string());
        }

        let min_shot_duration = cfg.min_shot_duration.unwrap_or(0.5);
        if !min_shot_duration.is_finite() || min_shot_duration < 0.0 {
            return Err("minShotDuration must be a finite number >= 0".to_string());
        }

        ShotDetectorConfig {
            threshold,
            min_shot_duration,
            generate_keyframes: false,
            keyframe_dir: None,
            ffmpeg_path: Some(ffmpeg_info.ffmpeg_path.clone()),
            ffprobe_path: Some(ffmpeg_info.ffprobe_path.clone()),
            ..ShotDetectorConfig::default()
        }
    } else {
        ShotDetectorConfig {
            ffmpeg_path: Some(ffmpeg_info.ffmpeg_path.clone()),
            ffprobe_path: Some(ffmpeg_info.ffprobe_path.clone()),
            ..ShotDetectorConfig::default()
        }
    };

    let detector = ShotDetector::with_config(detector_config);

    tracing::info!(
        "Shot detection started: asset_id={}, video_path={}",
        asset_id,
        video_path_canon.to_string_lossy()
    );

    // Detect shots
    let shots = detector
        .detect(&video_path_canon, &asset_id)
        .await
        .map_err(|e| e.to_ipc_error())?;

    // Calculate total duration from shots
    let total_duration = shots.last().map(|s| s.end_sec).unwrap_or(0.0);

    // Save to database if project is open.
    // Do not hold the project mutex while doing SQLite I/O.
    let index_db_path = {
        if let Ok(guard) = state.project.try_lock() {
            guard.as_ref().map(|project| project.path.join("index.db"))
        } else {
            None
        }
    };

    if let Some(index_db_path) = index_db_path {
        let index_db = if index_db_path.exists() {
            IndexDb::open(&index_db_path)
        } else {
            IndexDb::create(&index_db_path)
        };

        if let Ok(db) = index_db {
            // Retry a few times to mitigate transient SQLITE_BUSY (concurrent writers).
            let mut last_err: Option<String> = None;
            for attempt in 0..3 {
                match detector.save_to_db(&db, &shots) {
                    Ok(()) => {
                        last_err = None;
                        break;
                    }
                    Err(e) => {
                        last_err = Some(e.to_string());
                        tokio::time::sleep(std::time::Duration::from_millis(
                            50 * (attempt + 1) as u64,
                        ))
                        .await;
                    }
                }
            }
            if let Some(e) = last_err {
                tracing::warn!("Failed to save shots to database after retries: {}", e);
            }
        }
    }

    let shot_count = shots.len();
    let shot_dtos: Vec<ShotDto> = shots.into_iter().map(ShotDto::from).collect();

    tracing::info!(
        "Detected {} shots in asset {} ({:.2}s total)",
        shot_count,
        asset_id,
        total_duration
    );

    Ok(ShotDetectionResult {
        shot_count,
        shots: shot_dtos,
        total_duration,
    })
}

/// Retrieves cached shots for an asset from the database
#[tauri::command]
#[specta::specta]
pub async fn get_asset_shots(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ShotDto>, String> {
    use crate::core::indexing::{IndexDb, ShotDetector};

    validate_path_id_component(&asset_id, "Asset ID")?;

    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project open".to_string())?;

    // Open (or create) the project's index database
    let index_db_path = project.path.join("index.db");
    if !index_db_path.exists() {
        // No database yet, return empty list
        return Ok(Vec::new());
    }

    let index_db = IndexDb::open(&index_db_path).map_err(|e| e.to_ipc_error())?;

    let shots = ShotDetector::load_from_db(&index_db, &asset_id).map_err(|e| e.to_ipc_error())?;

    Ok(shots.into_iter().map(ShotDto::from).collect())
}

/// Deletes all shots for an asset from the database
#[tauri::command]
#[specta::specta]
pub async fn delete_asset_shots(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::core::indexing::IndexDb;

    validate_path_id_component(&asset_id, "Asset ID")?;

    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project open".to_string())?;

    // Open the project's index database
    let index_db_path = project.path.join("index.db");
    if !index_db_path.exists() {
        // No database yet, nothing to delete
        return Ok(());
    }

    let index_db = IndexDb::open(&index_db_path).map_err(|e| e.to_ipc_error())?;

    let conn = index_db.connection();
    conn.execute("DELETE FROM shots WHERE asset_id = ?", [&asset_id])
        .map_err(|e| format!("Failed to delete shots: {}", e))?;

    tracing::info!("Deleted shots for asset {}", asset_id);

    Ok(())
}

/// Checks if shot detection is available (requires FFmpeg)
#[tauri::command]
#[specta::specta]
pub async fn is_shot_detection_available(
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
) -> Result<bool, String> {
    // Best-effort initialization in case startup init hasn't completed yet.
    {
        let guard = ffmpeg_state.read().await;
        if guard.is_available() {
            return Ok(true);
        }
    }

    let mut guard = ffmpeg_state.write().await;
    let _ = guard.initialize(None);
    Ok(guard.is_available())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn get_transcription_status_includes_acceleration_field() {
        // The status DTO must report the compiled acceleration backend. On the
        // default CPU test build this is "cpu".
        let status = get_transcription_status()
            .await
            .expect("status should be available");
        assert_eq!(status.acceleration, "cpu");
    }

    #[tokio::test]
    async fn get_transcription_status_reports_recommended_model() {
        use crate::core::captions::whisper::WhisperModel;

        // The status DTO must always advertise the recommended model id so the
        // agent/UI can detect a recommended-model gap, independent of what is
        // currently installed as the default.
        let status = get_transcription_status()
            .await
            .expect("status should be available");
        assert_eq!(status.recommended_model, "large-v3-turbo-q5_0");
        // `recommended_installed` must reflect the actual presence of the
        // recommended model file in the resolved models directory.
        let models_dir = crate::core::captions::whisper::default_models_dir();
        let expected = WhisperModel::recommended_default().is_installed_in(&models_dir);
        assert_eq!(status.recommended_installed, expected);
    }

    #[test]
    fn recommended_installed_reflects_file_presence() {
        use crate::core::captions::whisper::WhisperModel;

        let temp_dir = std::env::temp_dir().join(format!(
            "openreelio-transcription-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp_dir).expect("temp models dir should be creatable");

        // RAII cleanup so the temp directory does not leak across test runs.
        struct DirGuard(std::path::PathBuf);
        impl Drop for DirGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = DirGuard(temp_dir.clone());

        let recommended = WhisperModel::recommended_default();

        // Empty directory: the recommended model is not installed.
        assert!(!recommended.is_installed_in(&temp_dir));

        // After writing a non-empty model file, it must be reported as installed.
        let model_path = temp_dir.join(recommended.filename());
        std::fs::write(&model_path, b"ggml-model-stub").expect("model file should be writable");
        assert!(recommended.is_installed_in(&temp_dir));
    }

    #[test]
    fn transcription_status_dto_recommended_fields_are_backward_compatible() {
        // A legacy payload without the recommended-model fields must still
        // deserialize, defaulting `recommended_model` to empty and
        // `recommended_installed` to false (additive, serde-default).
        let json = r#"{
            "featureAvailable": true,
            "ready": false,
            "modelsDir": "/models",
            "defaultModel": "small",
            "installedCount": 1,
            "models": []
        }"#;
        let status: TranscriptionStatusDto =
            serde_json::from_str(json).expect("legacy status should deserialize");
        assert!(status.recommended_model.is_empty());
        assert!(!status.recommended_installed);
    }

    #[test]
    fn transcription_status_dto_acceleration_is_backward_compatible() {
        // A legacy payload without `acceleration` must still deserialize, with the
        // field defaulting to an empty string (additive, serde-default).
        let json = r#"{
            "featureAvailable": true,
            "ready": false,
            "modelsDir": "/models",
            "defaultModel": "large-v3-turbo-q5_0",
            "installedCount": 0,
            "models": []
        }"#;
        let status: TranscriptionStatusDto =
            serde_json::from_str(json).expect("legacy status should deserialize");
        assert!(status.acceleration.is_empty());
    }
}

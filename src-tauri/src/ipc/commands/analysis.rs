//! Analysis Pipeline IPC Commands
//!
//! Tauri commands for the reference video analysis pipeline (ADR-048)
//! and the Editing Style Document (ESD) system (ADR-049).
//!
//! ## Commands
//!
//! - `analyze_video_full`: Run composable analysis pipeline on a video asset
//! - `get_analysis_bundle`: Retrieve cached analysis bundle for an asset
//! - `generate_esd`: Generate an ESD from an analysis bundle
//! - `get_esd`: Retrieve an ESD by ID
//! - `list_esds`: List all ESDs in the project
//! - `delete_esd`: Delete an ESD by ID
//! - `apply_editing_style`: Apply an ESD's style to source footage
//! - `auto_color_match`: Automatically match target clip color to reference clip
//! - `analyze_timeline_clip`: Build clip-local timeline/source frame evidence
//! - `sample_clip_frames`: Extract dense clip-local frame samples
//! - `inspect_timeline_range`: Analyze enabled visible clips in a timeline range
//! - `describe_timeline_clip`: Add semantic frame observations to clip evidence
//! - `describe_timeline_range`: Add semantic frame observations to clips in a range
//! - `search_clip_evidence`: Search cached clip-local semantic observations
//! - `plan_semantic_clip_edit`: Plan temporal edit ranges from semantic evidence

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use tauri::State;

use crate::core::analysis::clip_analysis::{
    analyze_timeline_clip_bundle, inspect_timeline_range_bundles,
    load_clip_analysis_bundle_optional, map_timeline_times_for_clip, ClipAnalysisBundle,
    ClipAnalysisOptions, ClipAnalysisResponse, TimelineRangeSelection, TimelineSourceMappingEntry,
};
use crate::core::analysis::clip_perception::{
    describe_timeline_clip_perception, describe_timeline_range_perception,
    enrich_clip_perception_bundle, load_clip_perception_bundle_optional,
    search_clip_perception_bundles, ClipEvidenceSearchHit, ClipPerceptionBundle,
    ClipPerceptionOptions, ClipPerceptionProvider, ClipPerceptionResponse,
    TimelineClipPerceptionInput, TimelineRangePerceptionInput,
};
use crate::core::analysis::color_match::{
    analyze_frame_color, compute_color_correction, ColorCorrection,
};
use crate::core::analysis::diarization_import::{
    apply_imported_diarization, parse_imported_diarization_json,
};
use crate::core::analysis::esd::{self, EditingStyleDocument, EsdGenerator, EsdSummary};
use crate::core::analysis::style_planner::{StylePlanResult, StylePlanner, StylePlanningContext};
use crate::core::analysis::{
    plan_semantic_clip_edit as plan_semantic_clip_edit_bundle, SemanticTemporalEditAction,
    SemanticTemporalEditPlan, SemanticTemporalEditPlanOptions,
};
use crate::core::analysis::{AnalysisBundle, AnalysisJobRunner, AnalysisOptions, VideoMetadata};
use crate::core::commands::AddEffectCommand;
#[cfg(feature = "ai-providers")]
use crate::core::credentials::{CredentialType, CredentialVault};
use crate::core::effects::{curve_points_to_json, CurvePoint, EffectType, ParamValue};
use crate::core::ffmpeg::{FFmpegRunner, MediaInfo, SharedFFmpegState};
use crate::core::jobs::{Job, JobStatus, JobType, Priority};
use crate::core::project::ProjectState;
#[cfg(feature = "ai-providers")]
use crate::core::settings::{ProviderType, SettingsManager};
#[cfg(feature = "ai-providers")]
use crate::ipc::commands::system::get_app_data_dir;
use crate::AppState;

#[cfg(feature = "ai-providers")]
use crate::core::analysis::openai_perception::{
    analyze_keyframes_with_openai, transcribe_with_openai, OpenAiPerceptionConfig,
};
#[cfg(feature = "ai-providers")]
use crate::core::analysis::OpenAiResponsesClipPerceptionProvider;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiarizationImportSummary {
    pub asset_id: String,
    pub transcript_segment_count: usize,
    pub speaker_count: usize,
    pub speaker_turn_count: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDiarizationRunSummary {
    pub asset_id: String,
    pub input_audio_path: String,
    pub output_json_path: String,
    pub transcript_segment_count: usize,
    pub speaker_count: usize,
    pub speaker_turn_count: usize,
}

struct ResolvedAssetContext {
    project_path: PathBuf,
    asset_path: String,
    metadata: VideoMetadata,
    active_sequence_id: Option<String>,
}

async fn resolve_project_snapshot(
    state: &State<'_, AppState>,
) -> Result<(PathBuf, ProjectState), String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project is currently open".to_string())?;

    Ok((project.path.clone(), project.state.clone()))
}

async fn resolve_ffmpeg_runner(
    ffmpeg_state: &State<'_, SharedFFmpegState>,
) -> Result<FFmpegRunner, String> {
    let ffmpeg = ffmpeg_state.read().await;
    ffmpeg
        .runner()
        .cloned()
        .ok_or_else(|| "FFmpeg is not available for clip analysis".to_string())
}

async fn resolve_asset_context(
    asset_id: &str,
    state: &State<'_, AppState>,
    ffmpeg_state: &State<'_, SharedFFmpegState>,
) -> Result<ResolvedAssetContext, String> {
    let (project_path, asset_path, active_sequence_id, cached_metadata) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;

        let asset = project
            .state
            .assets
            .get(asset_id)
            .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

        (
            project.path.clone(),
            asset.uri.clone(),
            project.state.active_sequence_id.clone(),
            asset
                .duration_sec
                .map(|duration| build_asset_video_metadata(duration, asset)),
        )
    };

    if let Some(metadata) = cached_metadata {
        return Ok(ResolvedAssetContext {
            project_path,
            asset_path,
            metadata,
            active_sequence_id,
        });
    }

    let resolved_asset_path = resolve_asset_media_path(&project_path, &asset_path);
    let probed = probe_missing_asset_metadata(&resolved_asset_path, ffmpeg_state).await?;
    if probed.duration_sec <= 0.0 {
        return Err("Asset has no duration (not a video/audio file?)".to_string());
    }

    Ok(ResolvedAssetContext {
        project_path,
        asset_path,
        metadata: build_probe_video_metadata(&probed),
        active_sequence_id,
    })
}

fn resolve_asset_media_path(project_path: &std::path::Path, asset_path: &str) -> PathBuf {
    let path = PathBuf::from(asset_path);
    if path.is_absolute() {
        path
    } else {
        project_path.join(path)
    }
}

fn build_asset_video_metadata(duration: f64, asset: &crate::core::assets::Asset) -> VideoMetadata {
    let has_audio = asset.audio.is_some();
    asset.video.as_ref().map_or_else(
        || VideoMetadata::new(duration).with_audio(has_audio),
        |video| {
            VideoMetadata::new(duration)
                .with_dimensions(video.width, video.height)
                .with_fps(video.fps.as_f64())
                .with_codec(&video.codec)
                .with_audio(has_audio)
        },
    )
}

fn build_probe_video_metadata(probed: &MediaInfo) -> VideoMetadata {
    let mut metadata = VideoMetadata::new(probed.duration_sec).with_audio(probed.audio.is_some());
    if let Some(video) = probed.video.as_ref() {
        metadata = metadata
            .with_dimensions(video.width, video.height)
            .with_fps(video.fps)
            .with_codec(&video.codec);
    }
    metadata
}

async fn probe_missing_asset_metadata(
    asset_path: &std::path::Path,
    ffmpeg_state: &State<'_, SharedFFmpegState>,
) -> Result<MediaInfo, String> {
    let ffmpeg = ffmpeg_state.read().await;
    let runner = ffmpeg
        .runner()
        .ok_or_else(|| "FFmpeg not available to probe missing asset metadata".to_string())?;

    runner.probe(asset_path).await.map_err(|error| {
        format!(
            "Asset metadata is incomplete and probing failed for '{}': {}",
            asset_path.display(),
            error
        )
    })
}

async fn submit_analysis_job_and_wait(
    asset_id: &str,
    project_path: &PathBuf,
    asset_path: &str,
    metadata: &VideoMetadata,
    options: &AnalysisOptions,
    state: &State<'_, AppState>,
) -> Result<AnalysisBundle, String> {
    let payload = serde_json::json!({
        "assetId": asset_id,
        "projectPath": project_path,
        "assetPath": asset_path,
        "metadata": metadata,
        "options": options,
    });
    let job = Job::new(JobType::VideoAnalysis, payload).with_priority(Priority::UserRequest);

    let job_id = {
        let pool = state.job_pool.lock().await;
        pool.submit(job)
            .map_err(|error| format!("Failed to queue analysis job: {}", error))?
    };

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30 * 60);

    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err("Timed out waiting for analysis job completion".to_string());
        }

        let status = {
            let pool = state.job_pool.lock().await;
            pool.get_job(&job_id).map(|job| job.status)
        };

        match status {
            Some(JobStatus::Completed { result }) => {
                let bundle: AnalysisBundle = serde_json::from_value(result)
                    .map_err(|error| format!("Invalid analysis bundle result: {}", error))?;
                return Ok(bundle);
            }
            Some(JobStatus::Failed { error }) => {
                return Err(format!("Analysis pipeline failed: {}", error));
            }
            Some(JobStatus::Cancelled) => {
                return Err("Analysis job was cancelled".to_string());
            }
            Some(JobStatus::Queued) | Some(JobStatus::Running { .. }) | None => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

#[cfg(feature = "ai-providers")]
async fn resolve_openai_perception_config(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
) -> Result<Option<OpenAiPerceptionConfig>, String> {
    let app_data_dir = get_app_data_dir(app)?;
    let settings = SettingsManager::new(app_data_dir.clone()).load();
    if settings.ai.local_only_mode {
        return Ok(None);
    }

    let provider = settings
        .ai
        .vision_provider
        .unwrap_or(settings.ai.primary_provider);
    if provider != ProviderType::OpenAI {
        return Ok(None);
    }

    let vault_path = app_data_dir.join("credentials.vault");
    if !vault_path.exists() {
        return Err(
            "OpenAI perception provider is selected but the OpenAI credential is missing"
                .to_string(),
        );
    }

    let api_key = {
        let mut guard = state.credential_vault.lock().await;
        if guard.is_none() {
            *guard = Some(
                CredentialVault::new(vault_path)
                    .map_err(|error| format!("Failed to initialize credential vault: {error}"))?,
            );
        }
        let vault = guard
            .as_ref()
            .ok_or_else(|| "Credential vault unavailable".to_string())?;
        vault
            .retrieve(CredentialType::OpenaiApiKey)
            .await
            .map_err(|error| {
                format!(
                    "OpenAI perception provider is selected but credential lookup failed: {error}"
                )
            })?
    };

    Ok(Some(OpenAiPerceptionConfig::new(
        api_key,
        settings.ai.vision_model,
    )))
}

#[cfg(feature = "ai-providers")]
async fn resolve_clip_perception_provider(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    options: &ClipPerceptionOptions,
) -> Result<Option<OpenAiResponsesClipPerceptionProvider>, String> {
    if !options.allow_cloud {
        return Ok(None);
    }
    if options
        .provider
        .as_ref()
        .is_some_and(|provider| !provider.eq_ignore_ascii_case("openai"))
    {
        return Ok(None);
    }

    let config = match resolve_openai_perception_config(app, state).await? {
        Some(config) => config,
        None => return Ok(None),
    };

    Ok(Some(OpenAiResponsesClipPerceptionProvider::new(
        config.api_key,
        options
            .model
            .clone()
            .unwrap_or_else(|| config.vision_model.clone()),
        config.base_url,
    )))
}

#[cfg(feature = "ai-providers")]
async fn maybe_enhance_bundle_with_openai(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    ffmpeg_state: &State<'_, SharedFFmpegState>,
    asset_context: &ResolvedAssetContext,
    options: &AnalysisOptions,
    bundle: &mut AnalysisBundle,
) -> Result<(), String> {
    if options.local_only {
        return Ok(());
    }

    let mut changed = false;
    let config = match resolve_openai_perception_config(app, state).await {
        Ok(Some(config)) => {
            changed |= bundle.errors.remove("perception_provider").is_some();
            config
        }
        Ok(None) => return Ok(()),
        Err(error) => {
            bundle.add_error("perception_provider", error);
            AnalysisJobRunner::new(&asset_context.project_path)
                .save_bundle(bundle)
                .map_err(|error| format!("Failed to save provider warning: {error}"))?;
            return Ok(());
        }
    };

    if options.visual && needs_openai_frame_observations(bundle) {
        match bundle.shots.as_deref() {
            Some(shots) if !shots.is_empty() => {
                let contact_sheet_path = bundle
                    .contact_sheet
                    .as_ref()
                    .map(|artifact| PathBuf::from(&artifact.path));
                match analyze_keyframes_with_openai(&config, shots, contact_sheet_path.as_deref())
                    .await
                {
                    Ok((frames, observations)) => {
                        bundle.errors.remove("perception_provider");
                        bundle.errors.remove("openai_vision");
                        if !frames.is_empty() {
                            bundle.frame_analysis = Some(frames);
                        }
                        if !observations.is_empty() {
                            bundle.frame_observations = Some(observations);
                        }
                        changed = true;
                    }
                    Err(error) => {
                        bundle.add_error("openai_vision", error.to_string());
                        changed = true;
                    }
                }
            }
            _ => {}
        }
    }

    if options.transcript && bundle.metadata.has_audio && needs_openai_transcript_detail(bundle) {
        let video_path =
            resolve_asset_media_path(&asset_context.project_path, &asset_context.asset_path);
        let analysis_dir = AnalysisJobRunner::new(&asset_context.project_path)
            .asset_analysis_dir(&bundle.asset_id)
            .map_err(|error| format!("Failed to resolve analysis artifact directory: {error}"))?;
        let ffmpeg_path = {
            let ffmpeg = ffmpeg_state.read().await;
            ffmpeg
                .info()
                .ok_or_else(|| "FFmpeg is not available for OpenAI transcription".to_string())?
                .ffmpeg_path
                .clone()
        };
        match transcribe_with_openai(&config, &video_path, &analysis_dir, &ffmpeg_path).await {
            Ok((segments, detail)) => {
                bundle.errors.remove("perception_provider");
                bundle.errors.remove("openai_transcript");
                bundle.transcript = Some(segments);
                bundle.transcript_detail = Some(detail);
                bundle.errors.remove("transcript");
                changed = true;
            }
            Err(error) => {
                bundle.add_error("openai_transcript", error.to_string());
                changed = true;
            }
        }
    }

    if changed {
        AnalysisJobRunner::new(&asset_context.project_path)
            .save_bundle(bundle)
            .map_err(|error| format!("Failed to save OpenAI-enhanced analysis bundle: {error}"))?;
    }

    Ok(())
}

#[cfg(not(feature = "ai-providers"))]
async fn maybe_enhance_bundle_with_openai(
    _app: &tauri::AppHandle,
    _state: &State<'_, AppState>,
    _ffmpeg_state: &State<'_, SharedFFmpegState>,
    _asset_context: &ResolvedAssetContext,
    _options: &AnalysisOptions,
    _bundle: &mut AnalysisBundle,
) -> Result<(), String> {
    Ok(())
}

#[cfg(feature = "ai-providers")]
fn needs_openai_frame_observations(bundle: &AnalysisBundle) -> bool {
    !bundle
        .frame_observations
        .as_ref()
        .is_some_and(|observations| {
            observations
                .iter()
                .any(|observation| observation.provider.provider == "openai")
        })
        && bundle.frame_observations.as_ref().is_none_or(Vec::is_empty)
}

#[cfg(feature = "ai-providers")]
fn needs_openai_transcript_detail(bundle: &AnalysisBundle) -> bool {
    !bundle.transcript_detail.as_ref().is_some_and(|detail| {
        detail
            .provider
            .as_ref()
            .is_some_and(|provider| provider.provider == "openai")
            && !detail.speaker_segments.is_empty()
    })
}

// =============================================================================
// Commands
// =============================================================================

/// Runs the full composable analysis pipeline on a video asset.
///
/// Queues the analysis pipeline on the background worker pool and waits for the
/// resulting `AnalysisBundle`. Failed sub-jobs are recorded in the bundle's
/// `errors` field without blocking other enabled analyses.
///
/// The resulting bundle is cached at:
/// `{project}/.openreelio/analysis/{asset_id}/bundle.json`
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, ffmpeg_state))]
pub async fn analyze_video_full(
    app: tauri::AppHandle,
    asset_id: String,
    options: AnalysisOptions,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<AnalysisBundle, String> {
    let asset_context = resolve_asset_context(&asset_id, &state, &ffmpeg_state).await?;

    let mut bundle = submit_analysis_job_and_wait(
        &asset_id,
        &asset_context.project_path,
        &asset_context.asset_path,
        &asset_context.metadata,
        &options,
        &state,
    )
    .await?;

    maybe_enhance_bundle_with_openai(
        &app,
        &state,
        &ffmpeg_state,
        &asset_context,
        &options,
        &mut bundle,
    )
    .await?;

    Ok(bundle)
}

/// Retrieves a cached analysis bundle for an asset.
///
/// Returns the previously computed bundle from disk without re-running analysis.
/// Returns `Ok(None)` when no cached bundle exists yet.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn get_analysis_bundle(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AnalysisBundle>, String> {
    let project_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;
        project.path.clone()
    };

    let runner = AnalysisJobRunner::new(&project_path);

    runner
        .load_bundle_optional(&asset_id)
        .map_err(|e| format!("Failed to load analysis bundle: {}", e))
}

/// Analyzes one timeline clip at clip-local frame sample granularity.
/// The command returns a cacheable bundle that maps timeline seconds to source
/// seconds/frame indices and extracts representative or dense frame samples.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, ffmpeg_state, options))]
pub async fn analyze_timeline_clip(
    sequence_id: String,
    track_id: String,
    clip_id: String,
    options: ClipAnalysisOptions,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<ClipAnalysisResponse, String> {
    let (project_path, project_state) = resolve_project_snapshot(&state).await?;
    let runner = resolve_ffmpeg_runner(&ffmpeg_state).await?;

    analyze_timeline_clip_bundle(
        &project_path,
        &project_state,
        &runner,
        &sequence_id,
        &track_id,
        &clip_id,
        options,
    )
    .await
    .map_err(|error| format!("Failed to analyze timeline clip: {}", error))
}

/// Loads a cached clip analysis bundle by fingerprint.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn get_clip_analysis(
    fingerprint: String,
    state: State<'_, AppState>,
) -> Result<Option<ClipAnalysisBundle>, String> {
    let (project_path, _) = resolve_project_snapshot(&state).await?;
    load_clip_analysis_bundle_optional(&project_path, &fingerprint)
        .map_err(|error| format!("Failed to load clip analysis bundle: {}", error))
}

/// Maps timeline positions inside a clip to the corresponding source positions.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, timeline_times))]
pub async fn map_timeline_to_source(
    sequence_id: String,
    track_id: String,
    clip_id: String,
    timeline_times: Vec<f64>,
    state: State<'_, AppState>,
) -> Result<Vec<TimelineSourceMappingEntry>, String> {
    let (_, project_state) = resolve_project_snapshot(&state).await?;
    map_timeline_times_for_clip(
        &project_state,
        &sequence_id,
        &track_id,
        &clip_id,
        &timeline_times,
    )
    .map_err(|error| format!("Failed to map timeline times to source: {}", error))
}

/// Extracts clip frame samples and returns the same bundle shape as clip analysis.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, ffmpeg_state, options))]
pub async fn sample_clip_frames(
    sequence_id: String,
    track_id: String,
    clip_id: String,
    options: ClipAnalysisOptions,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<ClipAnalysisResponse, String> {
    analyze_timeline_clip(sequence_id, track_id, clip_id, options, state, ffmpeg_state).await
}

/// Analyzes all visible video clips overlapping a timeline range.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, ffmpeg_state, options))]
pub async fn inspect_timeline_range(
    sequence_id: String,
    start_sec: f64,
    end_sec: f64,
    track_id: Option<String>,
    options: ClipAnalysisOptions,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<Vec<ClipAnalysisResponse>, String> {
    let (project_path, project_state) = resolve_project_snapshot(&state).await?;
    let runner = resolve_ffmpeg_runner(&ffmpeg_state).await?;

    inspect_timeline_range_bundles(
        &project_path,
        &project_state,
        &runner,
        TimelineRangeSelection {
            sequence_id: &sequence_id,
            track_id: track_id.as_deref(),
            start_sec,
            end_sec,
        },
        options,
    )
    .await
    .map_err(|error| format!("Failed to inspect timeline range: {}", error))
}

/// Enriches a cached clip-analysis bundle with semantic frame observations.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app, state, options))]
pub async fn enrich_clip_perception(
    app: tauri::AppHandle,
    fingerprint: String,
    options: ClipPerceptionOptions,
    state: State<'_, AppState>,
) -> Result<ClipPerceptionResponse, String> {
    let (project_path, _) = resolve_project_snapshot(&state).await?;
    #[cfg(feature = "ai-providers")]
    let provider = resolve_clip_perception_provider(&app, &state, &options).await?;
    #[cfg(feature = "ai-providers")]
    let provider_ref = provider
        .as_ref()
        .map(|provider| provider as &(dyn ClipPerceptionProvider + Send + Sync));
    #[cfg(not(feature = "ai-providers"))]
    let provider_ref: Option<&(dyn ClipPerceptionProvider + Send + Sync)> = {
        let _ = &app;
        None
    };

    enrich_clip_perception_bundle(&project_path, &fingerprint, options, provider_ref)
        .await
        .map_err(|error| format!("Failed to enrich clip perception: {}", error))
}

/// Loads a cached semantic clip-perception bundle by perception fingerprint.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn get_clip_perception(
    perception_fingerprint: String,
    state: State<'_, AppState>,
) -> Result<Option<ClipPerceptionBundle>, String> {
    let (project_path, _) = resolve_project_snapshot(&state).await?;
    load_clip_perception_bundle_optional(&project_path, &perception_fingerprint)
        .map_err(|error| format!("Failed to load clip perception bundle: {}", error))
}

/// Builds clip-local frame evidence and semantic observations for one timeline clip.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(skip(app, state, ffmpeg_state, analysis_options, perception_options))]
pub async fn describe_timeline_clip(
    app: tauri::AppHandle,
    sequence_id: String,
    track_id: String,
    clip_id: String,
    analysis_options: ClipAnalysisOptions,
    perception_options: ClipPerceptionOptions,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<ClipPerceptionResponse, String> {
    let (project_path, project_state) = resolve_project_snapshot(&state).await?;
    let runner = resolve_ffmpeg_runner(&ffmpeg_state).await?;
    #[cfg(feature = "ai-providers")]
    let provider = resolve_clip_perception_provider(&app, &state, &perception_options).await?;
    #[cfg(feature = "ai-providers")]
    let provider_ref = provider
        .as_ref()
        .map(|provider| provider as &(dyn ClipPerceptionProvider + Send + Sync));
    #[cfg(not(feature = "ai-providers"))]
    let provider_ref: Option<&(dyn ClipPerceptionProvider + Send + Sync)> = {
        let _ = &app;
        None
    };

    describe_timeline_clip_perception(
        &project_path,
        &project_state,
        &runner,
        TimelineClipPerceptionInput {
            sequence_id: &sequence_id,
            track_id: &track_id,
            clip_id: &clip_id,
            analysis_options,
            perception_options,
        },
        provider_ref,
    )
    .await
    .map_err(|error| format!("Failed to describe timeline clip: {}", error))
}

/// Builds clip-local frame evidence and semantic observations for visible clips in a range.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
#[tracing::instrument(skip(app, state, ffmpeg_state, analysis_options, perception_options))]
pub async fn describe_timeline_range(
    app: tauri::AppHandle,
    sequence_id: String,
    start_sec: f64,
    end_sec: f64,
    track_id: Option<String>,
    analysis_options: ClipAnalysisOptions,
    perception_options: ClipPerceptionOptions,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<Vec<ClipPerceptionResponse>, String> {
    let (project_path, project_state) = resolve_project_snapshot(&state).await?;
    let runner = resolve_ffmpeg_runner(&ffmpeg_state).await?;
    #[cfg(feature = "ai-providers")]
    let provider = resolve_clip_perception_provider(&app, &state, &perception_options).await?;
    #[cfg(feature = "ai-providers")]
    let provider_ref = provider
        .as_ref()
        .map(|provider| provider as &(dyn ClipPerceptionProvider + Send + Sync));
    #[cfg(not(feature = "ai-providers"))]
    let provider_ref: Option<&(dyn ClipPerceptionProvider + Send + Sync)> = {
        let _ = &app;
        None
    };

    describe_timeline_range_perception(
        &project_path,
        &project_state,
        &runner,
        TimelineRangePerceptionInput {
            selection: TimelineRangeSelection {
                sequence_id: &sequence_id,
                track_id: track_id.as_deref(),
                start_sec,
                end_sec,
            },
            analysis_options,
            perception_options,
        },
        provider_ref,
    )
    .await
    .map_err(|error| format!("Failed to describe timeline range: {}", error))
}

/// Searches cached semantic clip-perception bundles.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn search_clip_evidence(
    query: String,
    limit: Option<u32>,
    sequence_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ClipEvidenceSearchHit>, String> {
    let (project_path, _) = resolve_project_snapshot(&state).await?;
    let limit = limit.unwrap_or(10).clamp(1, 100) as usize;
    search_clip_perception_bundles(&project_path, &query, limit, sequence_id.as_deref())
        .map_err(|error| format!("Failed to search clip evidence: {}", error))
}

/// Plans temporal edit ranges and command drafts from cached semantic clip evidence.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, options))]
pub async fn plan_semantic_clip_edit(
    perception_fingerprint: String,
    query: String,
    action: SemanticTemporalEditAction,
    options: SemanticTemporalEditPlanOptions,
    state: State<'_, AppState>,
) -> Result<SemanticTemporalEditPlan, String> {
    let (project_path, _) = resolve_project_snapshot(&state).await?;
    plan_semantic_clip_edit_bundle(
        &project_path,
        &perception_fingerprint,
        &query,
        action,
        options,
    )
    .map_err(|error| format!("Failed to plan semantic clip edit: {}", error))
}

/// Imports external diarization JSON and merges speaker IDs into the cached transcript bundle.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(asset_id = %asset_id, input_path = %input_path))]
pub async fn import_diarization_json(
    asset_id: String,
    input_path: String,
    state: State<'_, AppState>,
) -> Result<DiarizationImportSummary, String> {
    let project_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;
        project.path.clone()
    };

    let resolved_input_path = {
        let path = PathBuf::from(&input_path);
        if path.is_absolute() {
            path
        } else {
            project_path.join(path)
        }
    };

    let json = tokio::fs::read_to_string(&resolved_input_path)
        .await
        .map_err(|e| format!("Failed to read diarization JSON: {}", e))?;
    let diarization_segments =
        parse_imported_diarization_json(&json).map_err(|e| e.to_ipc_error())?;

    let runner = AnalysisJobRunner::new(&project_path);
    let mut bundle = runner
        .load_bundle_optional(&asset_id)
        .map_err(|e| format!("Failed to load analysis bundle: {}", e))?
        .ok_or_else(|| "No cached analysis bundle exists for this asset".to_string())?;

    let transcript = bundle
        .transcript
        .as_ref()
        .ok_or_else(|| "The cached analysis bundle does not contain a transcript".to_string())?;
    let speech_regions = bundle
        .audio_profile
        .as_ref()
        .map(|profile| profile.speech_regions.as_slice())
        .unwrap_or(&[]);

    let updated_transcript =
        apply_imported_diarization(transcript, &diarization_segments, speech_regions);
    let speaker_count = updated_transcript
        .iter()
        .filter_map(|segment| segment.speaker_id.as_deref())
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let speaker_turn_count = updated_transcript
        .iter()
        .filter_map(|segment| segment.speaker_turn_id.as_deref())
        .collect::<std::collections::BTreeSet<_>>()
        .len();

    bundle.transcript = Some(updated_transcript.clone());
    runner
        .save_bundle(&bundle)
        .map_err(|e| format!("Failed to save updated analysis bundle: {}", e))?;

    Ok(DiarizationImportSummary {
        asset_id,
        transcript_segment_count: updated_transcript.len(),
        speaker_count,
        speaker_turn_count,
    })
}

/// Runs an external diarization runner and imports the resulting JSON into the cached bundle.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, args, ffmpeg_state), fields(asset_id = %asset_id, executable = %executable))]
pub async fn run_external_diarization(
    asset_id: String,
    executable: String,
    args: Vec<String>,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<ExternalDiarizationRunSummary, String> {
    let _ = (&state, &ffmpeg_state);
    tracing::warn!(
        asset_id = %asset_id,
        requested_executable = %executable,
        requested_arg_count = args.len(),
        "Blocked external diarization runner launch from IPC"
    );

    Err(
        "External diarization runners are disabled until a trusted runner registration and approval flow is available."
            .to_string(),
    )
}

// =============================================================================
// ESD Commands (ADR-049)
// =============================================================================

/// Generates an Editing Style Document from an analysis bundle.
///
/// The bundle is provided directly. The generated ESD is saved to disk at
/// `{project}/.openreelio/esds/{id}.json` and returned.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, bundle), fields(asset_id = %bundle.asset_id))]
pub async fn generate_esd(
    bundle: AnalysisBundle,
    state: State<'_, AppState>,
) -> Result<EditingStyleDocument, String> {
    let project_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;
        project.path.clone()
    };

    let generated =
        EsdGenerator::generate(&bundle).map_err(|e| format!("Failed to generate ESD: {}", e))?;

    esd::save_esd(&project_path, &generated)
        .await
        .map_err(|e| format!("Failed to save ESD: {}", e))?;

    tracing::info!(esd_id = %generated.id, "ESD generated and saved");
    Ok(generated)
}

/// Retrieves an ESD by its ID.
///
/// Returns `Ok(None)` if the ESD does not exist.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(esd_id = %esd_id))]
pub async fn get_esd(
    esd_id: String,
    state: State<'_, AppState>,
) -> Result<Option<EditingStyleDocument>, String> {
    let project_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;
        project.path.clone()
    };

    esd::load_esd(&project_path, &esd_id)
        .await
        .map_err(|e| format!("Failed to load ESD: {}", e))
}

/// Lists all ESDs in the active project.
///
/// Returns summary objects containing id, name, source_asset_id,
/// created_at, and tempo_classification (not the full document).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn list_esds(state: State<'_, AppState>) -> Result<Vec<EsdSummary>, String> {
    let project_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;
        project.path.clone()
    };

    esd::list_esds_in_project(&project_path)
        .await
        .map_err(|e| format!("Failed to list ESDs: {}", e))
}

/// Deletes an ESD by its ID.
///
/// Returns `true` if the file existed and was deleted, `false` if not found.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state), fields(esd_id = %esd_id))]
pub async fn delete_esd(esd_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let project_path = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;
        project.path.clone()
    };

    esd::delete_esd_file(&project_path, &esd_id)
        .await
        .map_err(|e| format!("Failed to delete ESD: {}", e))
}

// =============================================================================
// Style Transfer Commands (ADR-050)
// =============================================================================

/// Applies an ESD's editing style to source footage.
///
/// Loads the specified ESD and the source asset's analysis bundle (generating
/// one when needed), then generates an executable [`AgentPlan`] that creates a
/// dedicated track, inserts the source asset, and applies DTW-guided splits.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, ffmpeg_state), fields(esd_id = %esd_id, source_asset_id = %source_asset_id))]
pub async fn apply_editing_style(
    esd_id: String,
    source_asset_id: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<StylePlanResult, String> {
    let asset_context = resolve_asset_context(&source_asset_id, &state, &ffmpeg_state).await?;
    let project_path = asset_context.project_path.clone();
    let sequence_id = asset_context
        .active_sequence_id
        .clone()
        .ok_or_else(|| "No active sequence available for style application".to_string())?;

    // Load the ESD
    let loaded_esd = esd::load_esd(&project_path, &esd_id)
        .await
        .map_err(|e| format!("Failed to load ESD: {}", e))?
        .ok_or_else(|| format!("ESD not found: {}", esd_id))?;

    // Load the source analysis bundle, generating one when it does not exist yet.
    let runner = AnalysisJobRunner::new(&project_path);
    let source_bundle = match runner
        .load_bundle_optional(&source_asset_id)
        .map_err(|e| format!("Failed to load source analysis bundle: {}", e))?
    {
        Some(bundle) => bundle,
        None => {
            submit_analysis_job_and_wait(
                &source_asset_id,
                &asset_context.project_path,
                &asset_context.asset_path,
                &asset_context.metadata,
                &AnalysisOptions::default(),
                &state,
            )
            .await?
        }
    };

    let planning_context = StylePlanningContext::new(sequence_id, source_asset_id)
        .with_track_name(format!("Style Match - {}", loaded_esd.name));

    // Generate the style plan
    StylePlanner::plan(&loaded_esd, &source_bundle, &planning_context)
        .map_err(|e| format!("Failed to generate style plan: {}", e))
}

// =============================================================================
// Color Match Commands (TASK-S38-002)
// =============================================================================

/// Result of an auto color match operation.
///
/// Contains the created effect ID and the computed correction details
/// so the frontend can report success and optionally display the adjustments.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ColorMatchResult {
    /// ID of the Curves effect created on the target clip
    pub effect_id: String,
    /// Brightness offset applied (-1.0 to 1.0)
    pub brightness_offset: f64,
    /// Saturation multiplier applied
    pub saturation_multiplier: f64,
    /// Temperature shift estimate (negative=cooler, positive=warmer)
    pub temperature_shift: f64,
}

/// Clip context extracted from project state for color matching.
struct ClipContext {
    asset_uri: String,
    source_midpoint_sec: f64,
    sequence_id: String,
    track_id: String,
}

/// Resolves a clip's context (asset path, timing) from project state.
///
/// Searches the requested sequence for the given clip ID and returns
/// the information needed to extract a representative frame.
fn resolve_clip_context(
    state: &crate::core::project::ProjectState,
    sequence_id: &str,
    clip_id: &str,
) -> Result<ClipContext, String> {
    let sequence = state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?;

    for track in &sequence.tracks {
        for clip in &track.clips {
            if clip.id == clip_id {
                let asset = state
                    .assets
                    .get(&clip.asset_id)
                    .ok_or_else(|| format!("Asset not found: {}", clip.asset_id))?;

                // Use the midpoint of the clip's source range as the representative frame
                let midpoint = (clip.range.source_in_sec + clip.range.source_out_sec) / 2.0;

                return Ok(ClipContext {
                    asset_uri: asset.uri.clone(),
                    source_midpoint_sec: midpoint,
                    sequence_id: sequence_id.to_string(),
                    track_id: track.id.clone(),
                });
            }
        }
    }

    Err(format!(
        "Clip not found in sequence {}: {}",
        sequence_id, clip_id
    ))
}

/// Automatically matches a target clip's color to a reference clip.
///
/// Extracts representative frames from both clips, analyzes their color profiles
/// via FFmpeg, computes a histogram-matched correction, and applies the result
/// as a Curves effect on the target clip.
///
/// The generated effect is fully editable — the user can tweak the R/G/B curves
/// in the effect inspector after the match is applied.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, ffmpeg_state))]
pub async fn auto_color_match(
    reference_clip_id: String,
    target_clip_id: String,
    sequence_id: String,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<ColorMatchResult, String> {
    // 1. Resolve clip contexts and FFmpeg path under project lock
    let (ref_ctx, target_ctx, ffmpeg_path, project_path) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;

        let ref_ctx = resolve_clip_context(&project.state, &sequence_id, &reference_clip_id)?;
        let target_ctx = resolve_clip_context(&project.state, &sequence_id, &target_clip_id)?;

        let ffmpeg_guard = ffmpeg_state.read().await;
        let ffmpeg_info = ffmpeg_guard
            .info()
            .ok_or_else(|| "FFmpeg is not available".to_string())?;

        (
            ref_ctx,
            target_ctx,
            ffmpeg_info.ffmpeg_path.clone(),
            project.path.clone(),
        )
    };

    // 2. Determine temp directory for frame extraction
    let temp_dir = project_path.join(".openreelio").join("color_match");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("Failed to create temp directory: {}", e))?;

    let ref_frame_path = temp_dir.join(format!("ref_{}.jpg", ulid::Ulid::new()));
    let target_frame_path = temp_dir.join(format!("target_{}.jpg", ulid::Ulid::new()));

    // 3. Extract representative frames from both clips
    let ref_asset_path = PathBuf::from(&ref_ctx.asset_uri);
    let target_asset_path = PathBuf::from(&target_ctx.asset_uri);

    {
        let ffmpeg_guard = ffmpeg_state.read().await;
        let runner = ffmpeg_guard
            .runner()
            .ok_or_else(|| "FFmpeg runner not available".to_string())?;

        runner
            .extract_frame(
                &ref_asset_path,
                ref_ctx.source_midpoint_sec,
                &ref_frame_path,
            )
            .await
            .map_err(|e| format!("Failed to extract reference frame: {}", e))?;

        runner
            .extract_frame(
                &target_asset_path,
                target_ctx.source_midpoint_sec,
                &target_frame_path,
            )
            .await
            .map_err(|e| format!("Failed to extract target frame: {}", e))?;
    }

    // 4. Analyze color profiles of both frames
    let ref_profile = analyze_frame_color(&ffmpeg_path, &ref_frame_path)
        .await
        .map_err(|e| format!("Failed to analyze reference frame: {}", e))?;

    let target_profile = analyze_frame_color(&ffmpeg_path, &target_frame_path)
        .await
        .map_err(|e| format!("Failed to analyze target frame: {}", e))?;

    // 5. Compute the color correction
    let correction = compute_color_correction(&ref_profile, &target_profile);

    // 6. Build Curves effect params from the correction
    let params = build_curves_params(&correction);

    // 7. Apply the effect to the target clip via Command
    let effect_id = {
        let mut guard = state.project.lock().await;
        let project = guard
            .as_mut()
            .ok_or_else(|| "No project is currently open".to_string())?;

        let mut cmd = AddEffectCommand::new(
            &target_ctx.sequence_id,
            &target_ctx.track_id,
            &target_clip_id,
            EffectType::Curves,
        );
        for (key, value) in params {
            cmd = cmd.with_param(key, value);
        }

        let result = project
            .executor
            .execute(Box::new(cmd), &mut project.state)
            .map_err(|e| format!("Failed to add color match effect: {}", e))?;

        result
            .created_ids
            .first()
            .cloned()
            .ok_or_else(|| "Effect creation did not return an ID".to_string())?
    };

    // 8. Clean up temp frames (best-effort)
    let _ = tokio::fs::remove_file(&ref_frame_path).await;
    let _ = tokio::fs::remove_file(&target_frame_path).await;

    tracing::info!(
        effect_id = %effect_id,
        brightness_offset = correction.brightness_offset,
        temperature_shift = correction.temperature_shift,
        "Color match applied to clip"
    );

    Ok(ColorMatchResult {
        effect_id,
        brightness_offset: correction.brightness_offset,
        saturation_multiplier: correction.saturation_multiplier,
        temperature_shift: correction.temperature_shift,
    })
}

/// Builds Curves effect parameters from a computed color correction.
///
/// Maps the per-channel transfer curves into the JSON-serialized format
/// expected by the Curves effect type.
fn build_curves_params(correction: &ColorCorrection) -> HashMap<String, ParamValue> {
    let mut params = HashMap::new();

    // Master curve: identity (no overall luminance curve needed;
    // per-channel curves handle the color shift)
    let identity = curve_points_to_json(&[CurvePoint::new(0.0, 0.0), CurvePoint::new(1.0, 1.0)]);
    params.insert("master_curve".to_string(), ParamValue::String(identity));

    // Per-channel curves from histogram matching
    params.insert(
        "red_curve".to_string(),
        ParamValue::String(curve_points_to_json(&correction.red_curve)),
    );
    params.insert(
        "green_curve".to_string(),
        ParamValue::String(curve_points_to_json(&correction.green_curve)),
    );
    params.insert(
        "blue_curve".to_string(),
        ParamValue::String(curve_points_to_json(&correction.blue_curve)),
    );

    // Advanced curves: flat (no change) since histogram matching
    // already accounts for hue/sat shifts via the RGB channels
    let flat = curve_points_to_json(&[CurvePoint::new(0.0, 0.5), CurvePoint::new(1.0, 0.5)]);
    params.insert(
        "hue_vs_hue_curve".to_string(),
        ParamValue::String(flat.clone()),
    );
    params.insert(
        "hue_vs_sat_curve".to_string(),
        ParamValue::String(flat.clone()),
    );
    params.insert("luma_vs_sat_curve".to_string(), ParamValue::String(flat));

    params
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{Asset, AudioInfo, VideoInfo};
    use crate::core::ffmpeg::{AudioStreamInfo, VideoStreamInfo};
    use crate::core::Ratio;

    #[test]
    fn build_asset_video_metadata_uses_asset_duration_and_streams() {
        let mut asset = Asset::new_video(
            "clip.mp4",
            "/tmp/clip.mp4",
            VideoInfo {
                width: 1280,
                height: 720,
                fps: Ratio::new(30000, 1001),
                codec: "h264".to_string(),
                bitrate: Some(4_000_000),
                has_alpha: false,
                is_hdr: false,
                color_transfer: None,
            },
        )
        .with_duration(12.5);
        asset.audio = Some(AudioInfo::default());

        let metadata = build_asset_video_metadata(12.5, &asset);

        assert_eq!(metadata.duration_sec, 12.5);
        assert_eq!(metadata.width, Some(1280));
        assert_eq!(metadata.height, Some(720));
        assert_eq!(metadata.codec.as_deref(), Some("h264"));
        assert!(metadata.has_audio);
    }

    #[test]
    fn build_probe_video_metadata_uses_probed_duration_when_asset_metadata_is_missing() {
        let metadata = build_probe_video_metadata(&MediaInfo {
            duration_sec: 8.25,
            video: Some(VideoStreamInfo {
                width: 1920,
                height: 1080,
                fps: 23.976,
                codec: "prores".to_string(),
                pixel_format: "yuv422p10le".to_string(),
                bitrate: Some(12_000_000),
                is_hdr: false,
                color_transfer: None,
            }),
            audio: Some(AudioStreamInfo {
                sample_rate: 48_000,
                channels: 2,
                codec: "aac".to_string(),
                bitrate: Some(192_000),
            }),
            format: "mov,mp4,m4a,3gp,3g2,mj2".to_string(),
            size_bytes: 123,
        });

        assert_eq!(metadata.duration_sec, 8.25);
        assert_eq!(metadata.width, Some(1920));
        assert_eq!(metadata.height, Some(1080));
        assert_eq!(metadata.codec.as_deref(), Some("prores"));
        assert!(metadata.has_audio);
    }

    #[test]
    fn resolve_asset_media_path_joins_relative_paths_to_project_root() {
        let project_path = PathBuf::from("/project");
        assert_eq!(
            resolve_asset_media_path(&project_path, "media/clip.mp4"),
            PathBuf::from("/project/media/clip.mp4")
        );
    }
}

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

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use tauri::State;

use crate::core::analysis::color_match::{
    analyze_frame_color, compute_color_correction, ColorCorrection,
};
use crate::core::analysis::diarization_import::{
    apply_imported_diarization, parse_imported_diarization_json,
};
use crate::core::analysis::diarization_runner::run_external_diarization_runner;
use crate::core::analysis::esd::{self, EditingStyleDocument, EsdGenerator, EsdSummary};
use crate::core::analysis::style_planner::{StylePlanResult, StylePlanner, StylePlanningContext};
use crate::core::analysis::{AnalysisBundle, AnalysisJobRunner, AnalysisOptions, VideoMetadata};
use crate::core::captions::audio::extract_audio_for_transcription_async;
use crate::core::commands::AddEffectCommand;
use crate::core::effects::{curve_points_to_json, CurvePoint, EffectType, ParamValue};
use crate::core::ffmpeg::{MediaInfo, SharedFFmpegState};
use crate::core::jobs::{Job, JobStatus, JobType, Priority};
use crate::AppState;

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
    asset_id: String,
    options: AnalysisOptions,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<AnalysisBundle, String> {
    let asset_context = resolve_asset_context(&asset_id, &state, &ffmpeg_state).await?;

    submit_analysis_job_and_wait(
        &asset_id,
        &asset_context.project_path,
        &asset_context.asset_path,
        &asset_context.metadata,
        &options,
        &state,
    )
    .await
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
    let asset_context = resolve_asset_context(&asset_id, &state, &ffmpeg_state).await?;
    let runner = AnalysisJobRunner::new(&asset_context.project_path);
    let bundle = runner
        .load_bundle_optional(&asset_id)
        .map_err(|e| format!("Failed to load analysis bundle: {}", e))?
        .ok_or_else(|| "No cached analysis bundle exists for this asset".to_string())?;
    if bundle
        .transcript
        .as_ref()
        .map(|segments| segments.is_empty())
        .unwrap_or(true)
    {
        return Err("The cached analysis bundle does not contain a transcript".to_string());
    }

    let analysis_dir = runner
        .asset_analysis_dir(&asset_id)
        .map_err(|e| format!("Failed to resolve analysis directory: {}", e))?;
    tokio::fs::create_dir_all(&analysis_dir)
        .await
        .map_err(|e| format!("Failed to create analysis directory: {}", e))?;

    let audio_path = analysis_dir.join("external-diarization-input.wav");
    let output_path = analysis_dir.join("external-diarization.json");
    let resolved_asset_path = {
        let path = PathBuf::from(&asset_context.asset_path);
        if path.is_absolute() {
            path
        } else {
            asset_context.project_path.join(path)
        }
    };

    extract_audio_for_transcription_async(resolved_asset_path.as_path(), &audio_path, None)
        .await
        .map_err(|e| format!("Failed to extract diarization input audio: {}", e))?;

    run_external_diarization_runner(&executable, &args, &audio_path, &output_path, None)
        .await
        .map_err(|e| e.to_ipc_error())?;

    let imported = import_diarization_json(
        asset_id.clone(),
        output_path.to_string_lossy().to_string(),
        state,
    )
    .await?;

    Ok(ExternalDiarizationRunSummary {
        asset_id,
        input_audio_path: audio_path.to_string_lossy().to_string(),
        output_json_path: output_path.to_string_lossy().to_string(),
        transcript_segment_count: imported.transcript_segment_count,
        speaker_count: imported.speaker_count,
        speaker_turn_count: imported.speaker_turn_count,
    })
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

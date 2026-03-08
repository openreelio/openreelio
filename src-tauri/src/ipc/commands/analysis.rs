//! Analysis Pipeline IPC Commands
//!
//! Tauri commands for the reference video analysis pipeline (ADR-048).
//!
//! ## Commands
//!
//! - `analyze_video_full`: Run composable analysis pipeline on a video asset
//! - `get_analysis_bundle`: Retrieve cached analysis bundle for an asset

use std::path::PathBuf;
use std::time::Duration;

use tauri::State;

use crate::core::analysis::{AnalysisBundle, AnalysisJobRunner, AnalysisOptions, VideoMetadata};
use crate::core::jobs::{Job, JobStatus, JobType, Priority};
use crate::AppState;

struct ResolvedAssetContext {
    project_path: PathBuf,
    asset_path: String,
    metadata: VideoMetadata,
}

async fn resolve_asset_context(
    asset_id: &str,
    state: &State<'_, AppState>,
) -> Result<ResolvedAssetContext, String> {
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| "No project is currently open".to_string())?;

    let asset = project
        .state
        .assets
        .get(asset_id)
        .ok_or_else(|| format!("Asset not found: {}", asset_id))?;

    let duration = asset
        .duration_sec
        .ok_or_else(|| "Asset has no duration (not a video/audio file?)".to_string())?;

    let has_audio = asset.audio.is_some();
    let metadata = asset.video.as_ref().map_or_else(
        || VideoMetadata::new(duration).with_audio(has_audio),
        |video| {
            VideoMetadata::new(duration)
                .with_dimensions(video.width, video.height)
                .with_fps(video.fps.as_f64())
                .with_codec(&video.codec)
                .with_audio(has_audio)
        },
    );

    Ok(ResolvedAssetContext {
        project_path: project.path.clone(),
        asset_path: asset.uri.clone(),
        metadata,
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
#[tracing::instrument(skip(state))]
pub async fn analyze_video_full(
    asset_id: String,
    options: AnalysisOptions,
    state: State<'_, AppState>,
) -> Result<AnalysisBundle, String> {
    let asset_context = resolve_asset_context(&asset_id, &state).await?;

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

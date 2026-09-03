//! Frame-probe IPC command — the in-app agent's eye on the edit.
//!
//! A thin entry point: the request shape, the translation into the engine's own
//! request, path confinement, the inline budget and the validate-then-allocate
//! ordering all live in [`crate::ipc::dto::frame_probe`], which is Tauri-free
//! and therefore unit tested. What is here is what only a command can do — take
//! the project snapshot, resolve the FFmpeg runner, and drive the probe, moving
//! every filesystem step off the runtime that is also driving the UI.

use tauri::State;

use crate::core::ffmpeg::SharedFFmpegState;
use crate::core::render::frame_probe::{FrameOutput, FrameProbeProject};
use crate::ipc::commands::analysis::{resolve_ffmpeg_runner_for, resolve_project_snapshot};
use crate::ipc::dto::frame_probe::{
    check_asset_media, collect_images, confine_requested_file, plan_frame_probe,
    TimelineFrameProbeRequestDto, TimelineFrameProbeResultDto,
};
use crate::AppState;

/// Extracts stills or a contact sheet of the composited edit for an in-app agent.
///
/// Output always lands in the project's own frame cache; `inline` decides
/// whether the bytes come back with the paths.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(request, state, ffmpeg_state))]
pub async fn extract_timeline_frames(
    request: TimelineFrameProbeRequestDto,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<TimelineFrameProbeResultDto, String> {
    request.validate_inline_budget()?;
    let format = request.resolve_format()?;
    let limit = request.resolve_limit();
    let inline = request.inline;

    let (project_path, project_state) = resolve_project_snapshot(&state).await?;
    let runner = resolve_ffmpeg_runner_for(&ffmpeg_state, "frame extraction").await?;

    // A rendered file is a caller-supplied path handed straight to FFmpeg, so it
    // is confined outright. Resolving the project root and the path against it
    // both hit the disk, so they run on a blocking thread.
    let file = match request.file.as_deref() {
        Some(requested) => Some(confine_requested_file(&project_path, requested).await?),
        None => None,
    };
    // An asset arrives as an id, and the media behind it is the project's own —
    // only its locality is checked, not its location.
    if let Some(asset_id) = request.asset.as_deref() {
        check_asset_media(&project_path, &project_state, asset_id)?;
    }

    let (plan, output) = {
        let project_path = project_path.clone();
        tokio::task::spawn_blocking(move || {
            plan_frame_probe(&project_path, request, file, format, limit)
        })
        .await
        .map_err(|error| format!("Frame probe planning failed: {error}"))??
    };

    let probe_project = FrameProbeProject {
        path: &project_path,
        state: &project_state,
    };
    let payload = match plan.run(&runner, Some(&probe_project)).await {
        Ok(payload) => payload,
        Err(error) => {
            // Nothing usable came back, so this call's entry is residue: an
            // empty directory per failed probe is how the cache grows fastest.
            discard_frame_output(output).await;
            return Err(error.to_string());
        }
    };

    // A read-back that fails leaves the stills on disk with nobody told where:
    // the payload names them, but the payload is not what comes back from an
    // error. Discarding the entry keeps the cache honest — every directory in
    // it belongs to an answer somebody received.
    let images = match collect_images(&payload, inline).await {
        Ok(images) => images,
        Err(error) => {
            discard_frame_output(output).await;
            return Err(error);
        }
    };

    Ok(TimelineFrameProbeResultDto { payload, images })
}

/// Removes the cache entry of an extraction that produced nothing usable.
///
/// A recursive delete on the async runtime would block the thread that is also
/// driving the UI, so it goes to a blocking one. Best-effort in both senses:
/// the removal itself is, and so is the join — a leftover directory is not
/// worth replacing the real error with a housekeeping one.
async fn discard_frame_output(output: FrameOutput) {
    let _ = tokio::task::spawn_blocking(move || output.discard()).await;
}

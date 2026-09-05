//! Frame-probe IPC command — the in-app agent's eye on the edit.
//!
//! A thin entry point: the request shape, the translation into the engine's own
//! request, path confinement, the inline budget and the validate-then-allocate
//! ordering all live in [`crate::ipc::dto::frame_probe`], which is Tauri-free
//! and therefore unit tested. What is here is what only a command can do — take
//! the project snapshot, resolve the FFmpeg runner, and drive the probe, moving
//! every filesystem step off the runtime that is also driving the UI.

use std::sync::Arc;

use tauri::State;

use crate::core::ffmpeg::SharedFFmpegState;
use crate::core::render::frame_probe::{FrameOutput, FrameProbeProject};
use crate::ipc::commands::analysis::{resolve_ffmpeg_runner_for, resolve_project_snapshot};
use crate::ipc::dto::frame_probe::{
    check_asset_media, check_sequence_media, collect_images, confine_requested_file,
    plan_frame_probe, TimelineFrameProbeRequestDto, TimelineFrameProbeResultDto,
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
    // Shared rather than cloned: the locality check below runs on a blocking
    // thread and needs the same snapshot the probe itself reads.
    let project_state = Arc::new(project_state);

    // A rendered file is a caller-supplied path handed straight to FFmpeg, so it
    // is confined outright. Resolving the project root and the path against it
    // both hit the disk, so they run on a blocking thread.
    let file = match request.file.as_deref() {
        Some(requested) => Some(confine_requested_file(&project_path, requested).await?),
        None => None,
    };
    // An asset arrives as an id, and the media behind it is the project's own —
    // only its locality is checked, not its location.
    //
    // A timeline still is a render, and a render reads every asset the graph
    // references — not just an explicitly named one. Checking only `asset` let a
    // sequence of off-host clips reach FFmpeg, where the stat of a UNC path is
    // itself the outbound connection this rule exists to prevent.
    //
    // Both checks end in a `stat` per asset, so they go to a blocking thread:
    // on a sequence cut from media on a slow or disconnected drive, running
    // them here would stall the runtime that is also driving the UI.
    let media_check = {
        let project_path = project_path.clone();
        let project_state = Arc::clone(&project_state);
        let asset_id = request.asset.clone();
        let sequence_id = (request.file.is_none() && request.asset.is_none())
            .then(|| {
                request
                    .sequence
                    .clone()
                    .or_else(|| project_state.active_sequence_id.clone())
            })
            .flatten();
        tokio::task::spawn_blocking(move || {
            if let Some(asset_id) = asset_id.as_deref() {
                check_asset_media(&project_path, &project_state, asset_id)?;
            }
            if let Some(sequence_id) = sequence_id.as_deref() {
                check_sequence_media(&project_path, &project_state, sequence_id)?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|error| format!("Media locality check failed: {error}"))?
    };
    media_check?;

    let (plan, output) = {
        let project_path = project_path.clone();
        tokio::task::spawn_blocking(move || {
            plan_frame_probe(&project_path, request, file, format, limit)
        })
        .await
        .map_err(|error| format!("Frame probe planning failed: {error}"))??
    };

    // Resolved last, after confinement and planning: a machine without FFmpeg
    // must be told which argument is wrong before it is told what is missing,
    // or every malformed request reads as "FFmpeg not found". `verify_sequence`
    // orders itself the same way.
    let runner = match resolve_ffmpeg_runner_for(&ffmpeg_state, "frame extraction").await {
        Ok(runner) => runner,
        Err(error) => {
            discard_frame_output(output).await;
            return Err(error);
        }
    };

    let probe_project = FrameProbeProject {
        path: &project_path,
        state: &project_state,
    };
    // Boxed to keep the probe's own state machine off this command's future.
    // Nothing here calls `block_on`, so the stack amplification that overflowed
    // the CLI's main thread cannot arise on this path — a Tauri command is a
    // spawned task, and its future already lives on the heap. What boxing buys
    // is that the probe's tens of kilobytes stop being inlined into every
    // `extract_timeline_frames` future, whatever the request asked for.
    let payload = match Box::pin(plan.run(&runner, Some(&probe_project))).await {
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

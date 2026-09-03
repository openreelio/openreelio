//! Frame-probe IPC command — the in-app agent's eye on the edit.
//!
//! A thin entry point: the request shape, the translation into the engine's own
//! request, path confinement and the inline budget all live in
//! [`crate::ipc::dto::frame_probe`], which is Tauri-free and therefore unit
//! tested. What is here is what only a command can do — take the project
//! snapshot, resolve the FFmpeg runner, and drive the probe.

use tauri::State;

use crate::core::ffmpeg::SharedFFmpegState;
use crate::core::render::frame_probe::{allocate_frame_output, FrameProbePlan, FrameProbeProject};
use crate::ipc::commands::analysis::{resolve_ffmpeg_runner, resolve_project_snapshot};
use crate::ipc::dto::frame_probe::{
    collect_images, confine_asset_media, confine_probe_file, TimelineFrameProbeRequestDto,
    TimelineFrameProbeResultDto,
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
    let artifact = request.artifact();
    let inline = request.inline;

    let (project_path, project_state) = resolve_project_snapshot(&state).await?;
    let runner = resolve_ffmpeg_runner(&ffmpeg_state).await?;

    // Resolved once: every confinement decision below compares against this one
    // spelling of the project root.
    let canonical_project = std::fs::canonicalize(&project_path).map_err(|error| {
        format!(
            "Project directory '{}' could not be resolved: {error}",
            project_path.display()
        )
    })?;

    // A rendered file is a caller-supplied path handed straight to FFmpeg, so it
    // is confined outright. An asset arrives as an id, and what needs confining
    // is the media behind it.
    let file = match request.file.as_deref() {
        Some(requested) => Some(confine_probe_file(&canonical_project, requested)?),
        None => None,
    };
    if let Some(asset_id) = request.asset.as_deref() {
        confine_asset_media(&canonical_project, &project_path, &project_state, asset_id)?;
    }

    // Allocated only once every argument and path check has passed, so a
    // rejected request leaves no directory behind at all.
    let output = allocate_frame_output(&project_path, artifact, format)
        .map_err(|error| error.to_string())?;

    let probe_request = request.into_probe_request(output.out().to_path_buf(), file, format, limit);
    let plan = match FrameProbePlan::resolve(probe_request) {
        Ok(plan) => plan,
        Err(error) => {
            output.discard();
            return Err(error.to_string());
        }
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
            output.discard();
            return Err(error.to_string());
        }
    };

    let images = collect_images(&payload, inline).await?;

    Ok(TimelineFrameProbeResultDto { payload, images })
}

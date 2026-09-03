//! Verify IPC command — the in-app agent's self-check on the edit.
//!
//! A thin entry point: the request shape, the translation into the engine's own
//! request and the path confinement all live in [`crate::ipc::dto::verify`],
//! which is Tauri-free and therefore unit tested. What is here is what only a
//! command can do — take the project snapshot, resolve the FFmpeg runner (and
//! only when there is a file to measure), and drive the verification, moving
//! the filesystem steps off the runtime that is also driving the UI.

use std::path::PathBuf;

use tauri::State;

use crate::core::ffmpeg::SharedFFmpegState;
use crate::ipc::commands::analysis::{resolve_ffmpeg_runner_for, resolve_project_snapshot};
use crate::ipc::dto::verify::{
    confine_probe_file, plan_verify_sequence, VerifySequenceRequestDto, VerifySequenceResultDto,
};
use crate::AppState;

/// Runs deterministic QC over a sequence, and over a rendered file when named.
///
/// The same report `openreelio-cli verify` prints, so an agent working inside
/// the app judges its edit by exactly the rules the headless surfaces apply.
/// Structural checks always run; the rendered measurements — black, freeze,
/// silence, EBU R128 loudness, true peak — need a `file`, which must be inside
/// the project directory.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(request, state, ffmpeg_state))]
pub async fn verify_sequence(
    request: VerifySequenceRequestDto,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<VerifySequenceResultDto, String> {
    let (project_path, project_state) = resolve_project_snapshot(&state).await?;

    // A rendered file is a caller-supplied path handed straight to FFmpeg, so
    // it is confined outright. Resolving the project root and the path against
    // it both hit the disk, so they run on a blocking thread.
    let file = match request.file.as_deref() {
        Some(requested) => Some(confine_requested_file(&project_path, requested).await?),
        None => None,
    };

    // Planning stats the rendered file, and it is what decides whether FFmpeg is
    // needed at all — so it happens before the runner is resolved, and a
    // structural verify works on a machine that has no FFmpeg.
    let plan = tokio::task::spawn_blocking(move || plan_verify_sequence(request, file))
        .await
        .map_err(|error| format!("Verification planning failed: {error}"))??;

    let runner = if plan.requires_ffmpeg() {
        Some(resolve_ffmpeg_runner_for(&ffmpeg_state, "verification").await?)
    } else {
        None
    };

    let report = plan
        .run(&project_state, runner.as_ref())
        .await
        .map_err(|error| error.to_string())?;

    Ok(VerifySequenceResultDto {
        exit_code: report.exit_code(),
        payload: report.into_payload(),
    })
}

/// Resolves the project root and confines a caller-supplied render path to it.
///
/// Both halves canonicalize, which is a filesystem round trip on a path that
/// may not exist and, on Windows, a call that can block for as long as the
/// volume takes to answer.
async fn confine_requested_file(
    project_path: &std::path::Path,
    requested: &str,
) -> Result<PathBuf, String> {
    let project_path = project_path.to_path_buf();
    let requested = requested.to_string();

    tokio::task::spawn_blocking(move || {
        // The message names no path: it travels to an external agent, and where
        // the user keeps their project is not part of "the project could not be
        // resolved".
        let canonical_project = std::fs::canonicalize(&project_path)
            .map_err(|error| format!("The project directory could not be resolved: {error}"))?;
        confine_probe_file(&canonical_project, &requested)
    })
    .await
    .map_err(|error| format!("Project path resolution failed: {error}"))?
}

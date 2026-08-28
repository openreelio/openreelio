//! IPC surface for the resident preview decoder.
//!
//! `get_preview_frame` returns raw RGBA through [`tauri::ipc::Response`], which
//! reaches the webview as an `ArrayBuffer`. Returning `Vec<u8>` from a plain
//! command would serialise every pixel as a JSON number, which costs more than
//! the decode it replaced.

use tauri::ipc::Response;
use tauri::State;

use super::state::SharedPreviewDecoders;
use crate::core::ffmpeg::SharedFFmpegState;
use crate::core::fs::validate_local_input_path;

/// Decodes the preview frame nearest `time_sec` and returns it as raw RGBA.
///
/// The frame is downscaled to fit inside `max_width` by `max_height` without
/// changing its aspect ratio, because the canvas composites with a contain-fit
/// that reads the drawable's own dimensions.
///
/// The reply is a 32-byte little-endian header followed by
/// `width * height * 4` bytes of pixels: `u32` version (2), `u32` width, `u32`
/// height, `u32` frame index, `f64` source time, `u32` flags, `u32` reserved.
///
/// Bit 0 of the flags word (`PreviewFrame::FLAG_INDEXED`) says whether the frame
/// index means anything. It is clear for a variable-rate source, whose
/// presentation times are not `index / fps`; such a frame can only be addressed
/// by the source time it answers for.
#[tauri::command]
pub async fn get_preview_frame(
    input_path: String,
    time_sec: f64,
    max_width: u32,
    max_height: u32,
    decoders: State<'_, SharedPreviewDecoders>,
    ffmpeg_state: State<'_, SharedFFmpegState>,
) -> Result<Response, String> {
    let input_path = validate_local_input_path(&input_path, "inputPath")?;
    let pool = decoders.pool(&ffmpeg_state).await?;

    // The decode blocks on a pipe read, so it must not run on an async worker.
    let frame = tokio::task::spawn_blocking(move || {
        pool.frame_at(&input_path, time_sec, max_width, max_height)
    })
    .await
    .map_err(|error| format!("Preview decode task failed: {error}"))?
    .map_err(|error| error.to_string())?;

    Ok(Response::new(frame.into_wire_bytes()))
}

/// Kills every resident preview decoder.
///
/// The frontend calls this when the canvas preview goes away, so an idle
/// project does not keep FFmpeg processes alive.
#[tauri::command]
pub async fn release_preview_decoders(
    decoders: State<'_, SharedPreviewDecoders>,
) -> Result<(), String> {
    decoders.release_all().await;
    Ok(())
}

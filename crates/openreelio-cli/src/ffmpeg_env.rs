//! FFmpeg resolution for the CLI process.
//!
//! Every command that spawns ffmpeg/ffprobe (directly or through a core
//! module) must call [`ensure_ffmpeg`] first: core modules read the globally
//! registered paths, and without registration they fall back to bare `ffmpeg`,
//! which fails on installs where FFmpeg is only bundled or managed.

use openreelio_core::ffmpeg::{resolve_and_register, FFmpegInfo, FFmpegResolveOptions};
use std::path::PathBuf;

/// Resolve FFmpeg and publish the paths process-wide.
///
/// Search order: `OPENREELIO_FFMPEG_PATH` / `OPENREELIO_FFPROBE_PATH` →
/// bundled binaries next to the project or executable → managed install →
/// dev-mode binaries → system PATH.
pub fn ensure_ffmpeg() -> anyhow::Result<FFmpegInfo> {
    resolve_and_register(&resolve_options())
        .map_err(|error| anyhow::anyhow!("FFmpeg initialization failed: {}", error))
}

/// Resolve FFmpeg without failing the command when it is missing.
///
/// For paths where FFmpeg only enriches the result (media metadata probing on
/// import), a missing toolchain must stay a degraded success rather than an
/// error.
pub fn ensure_ffmpeg_optional() -> Option<FFmpegInfo> {
    match resolve_and_register(&resolve_options()) {
        Ok(info) => Some(info),
        Err(error) => {
            tracing::debug!("FFmpeg not available: {}", error);
            None
        }
    }
}

fn resolve_options() -> FFmpegResolveOptions {
    let mut resource_roots = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        resource_roots.push(cwd.join("src-tauri"));
        resource_roots.push(cwd);
    }

    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
    {
        resource_roots.push(exe_dir);
    }

    FFmpegResolveOptions {
        resource_roots,
        use_env: true,
        ..Default::default()
    }
}

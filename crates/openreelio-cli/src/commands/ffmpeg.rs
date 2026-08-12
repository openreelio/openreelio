//! FFmpeg toolchain inspection commands.

use crate::ffmpeg_env::ensure_ffmpeg;
use crate::output;
use clap::Subcommand;

#[derive(Subcommand)]
pub enum FfmpegAction {
    /// Resolve the FFmpeg/FFprobe binaries this CLI will use
    Info,
}

pub fn execute(action: FfmpegAction) -> anyhow::Result<()> {
    match action {
        FfmpegAction::Info => {
            let info = ensure_ffmpeg()?;

            output::print_json_pretty(&serde_json::json!({
                "status": "ok",
                "ffmpegPath": info.ffmpeg_path.display().to_string(),
                "ffprobePath": info.ffprobe_path.display().to_string(),
                "version": info.version,
                "source": info.source.as_str(),
            }))
        }
    }
}

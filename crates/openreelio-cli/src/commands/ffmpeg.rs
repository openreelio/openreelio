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
            // Whether this binary's `subtitles` filter can be asked to break
            // scripts written without word spaces. An agent inspecting a
            // Japanese or Chinese caption render needs to know: on a binary
            // that answers `false` the cue is laid out on one line and cropped,
            // and no amount of re-styling changes that.
            let wraps_unicode_captions =
                openreelio_core::ffmpeg::binary_supports_subtitles_wrap_unicode(&info.ffmpeg_path);

            output::print_json_pretty(&serde_json::json!({
                "status": "ok",
                "ffmpegPath": info.ffmpeg_path.display().to_string(),
                "ffprobePath": info.ffprobe_path.display().to_string(),
                "version": info.version,
                "source": info.source.as_str(),
                "wrapsUnicodeCaptions": wraps_unicode_captions,
            }))
        }
    }
}

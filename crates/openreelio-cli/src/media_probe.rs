//! Reading a media file's real length and shape from the CLI process.
//!
//! The GUI probes every file it imports, so its assets carry a duration and an
//! insert lands a clip as long as the media. The CLI used to skip the probe,
//! which left `durationSec` null and made every insert fall back to a ten
//! second default: a four second file became a clip that overran its own
//! media, the next insert collided with it, and a composite sampled past the
//! media end produced a file with no video stream. Both surfaces now translate
//! the same probe through `openreelio_core::commands::import_command_from_probe`.

use crate::ffmpeg_env::ensure_ffmpeg_optional;
use openreelio_core::commands::{update_command_from_probe, UpdateAssetCommand};
use openreelio_core::ffmpeg::{FFmpegRunner, MediaInfo};
use openreelio_core::project::ProjectState;
use std::path::Path;

/// Probes a media file, or explains in one line why there is no reading.
///
/// Never an error: a probe only enriches what is being recorded, and a missing
/// or unreadable FFmpeg must leave the verb a degraded success rather than
/// failing it. The `Err` side is a human-readable reason meant for a
/// `warnings[]` entry.
pub fn probe_media(path: &Path) -> Result<MediaInfo, String> {
    let Some(info) = ensure_ffmpeg_optional() else {
        return Err(format!(
            "FFmpeg could not be resolved, so '{}' was not probed; run 'openreelio-cli ffmpeg info' to see what was searched",
            path.display()
        ));
    };

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Failed to create a Tokio runtime for the probe: {error}"))?;

    runtime
        .block_on(FFmpegRunner::new(info).probe(path))
        .map_err(|error| format!("FFprobe could not read '{}': {error}", path.display()))
}

/// The duration a probe is allowed to hand to an asset, or `None`.
///
/// FFprobe reports `0` or a non-finite duration for containers it cannot
/// measure, and recording that as the asset's length would make every later
/// insert fail with an empty source range instead of falling back to the
/// default. Only a positive, finite reading is a duration.
pub fn usable_duration_sec(media_info: &MediaInfo) -> Option<f64> {
    Some(media_info.duration_sec).filter(|value| value.is_finite() && *value > 0.0)
}

/// Builds the command that back-fills a probe onto an asset that lacks one.
///
/// Returns `None` when the probe carried no usable duration, so a caller never
/// logs an op that records nothing worth replaying.
pub fn back_fill_command(asset_id: &str, media_info: &MediaInfo) -> Option<UpdateAssetCommand> {
    usable_duration_sec(media_info)?;
    Some(update_command_from_probe(asset_id, media_info))
}

/// The local file an asset points at, when it points at one.
///
/// Assets can carry a workspace-relative path, so the project root is what
/// makes the URI resolvable. `None` when the asset is missing from the state or
/// its resolved path is not a file on this machine — a re-probe has nothing to
/// read in either case.
pub fn asset_source_path(
    state: &ProjectState,
    project_root: &Path,
    asset_id: &str,
) -> Option<std::path::PathBuf> {
    let asset = state.assets.get(asset_id)?;
    let path = openreelio_core::workspace::path_resolver::resolve_to_absolute(
        project_root,
        asset.relative_path.as_deref().unwrap_or(asset.uri.as_str()),
    );

    path.is_file().then_some(path)
}

//! Reading a media file's real length and shape from the CLI process.
//!
//! The GUI probes every file it imports, so its assets carry a duration and an
//! insert lands a clip as long as the media. The CLI used to skip the probe,
//! which left `durationSec` null and made every insert fall back to a ten
//! second default: a four second file became a clip that overran its own
//! media, the next insert collided with it, and a composite sampled past the
//! media end produced a file with no video stream. Both surfaces now translate
//! the same probe through `openreelio_core::commands::import_command_from_probe`.
//!
//! The guards that depend on that measurement live here too, and every mutating
//! surface of this binary — `timeline insert`/`trim`, `command execute`, `plan
//! execute` and the MCP tools — routes through [`guard_command_media_length`]
//! or the two helpers it calls. `help-json` promises both behaviours of the
//! whole command surface, so a surface that skipped them would be documented
//! into a lie.

use crate::ffmpeg_env::ensure_ffmpeg_optional;
use openreelio_core::commands::{
    ensure_asset_measured as core_ensure_asset_measured, ensure_source_out_within_media,
    measure_asset as core_measure_asset, AssetMeasurement,
};
use openreelio_core::ffmpeg::{FFmpegRunner, MediaInfo};
use openreelio_core::ipc::CommandPayload;
use openreelio_core::ActiveProject;
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

/// Measures an asset that carries no reading under the current probe rules.
///
/// The CLI's binding of [`openreelio_core::commands::measure_asset`]: the probe
/// runs on this process's own Tokio runtime through [`probe_media`], so the
/// warning a missing FFmpeg produces names `openreelio-cli ffmpeg info`.
pub fn measure_asset(project: &ActiveProject, asset_id: &str) -> AssetMeasurement {
    core_measure_asset(project, asset_id, probe_media)
}

/// Measures an unmeasured asset and records the reading in its own operation.
///
/// The CLI's binding of
/// [`openreelio_core::commands::ensure_asset_measured`]. `timeline insert` uses
/// [`measure_asset`] directly instead, so its `UpdateAsset` shares the insert's
/// recorder.
pub fn ensure_asset_measured(
    project: &mut ActiveProject,
    asset_id: &str,
) -> anyhow::Result<Vec<String>> {
    core_ensure_asset_measured(project, asset_id, probe_media)
        .map_err(|error| anyhow::anyhow!("Recording the probed asset duration failed: {error}"))
}

/// Applies the media-length guards a typed command payload calls for.
///
/// The entry point for `command execute`, which runs whatever payload it is
/// handed, so the lazy probe and the past-the-media refusal cannot hold on the
/// hand-written verbs and quietly not hold on the generic one.
///
/// `plan execute` and the MCP tools reach the same two guards a step at a time
/// rather than through here: a plan measures every asset it inserts *before*
/// the first step runs, because an op emitted mid-step would desynchronise a
/// rollback that undoes exactly one per succeeded step.
///
/// Returns the warnings the surface should report; the refusal is an `Err`.
pub fn guard_command_media_length(
    project: &mut ActiveProject,
    payload: &CommandPayload,
) -> anyhow::Result<Vec<String>> {
    // Which payloads place a clip from an asset is the shared payload's own
    // answer, so the app's `execute_command` measures exactly the same set.
    if let Some(asset_id) = payload.inserted_asset_id() {
        return ensure_asset_measured(project, asset_id);
    }

    if let CommandPayload::TrimClip(trim) = payload {
        ensure_source_out_within_media(
            &project.state,
            &trim.sequence_id,
            &trim.track_id,
            &trim.clip_id,
            trim.new_source_out,
        )
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    }

    Ok(Vec::new())
}

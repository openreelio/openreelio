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
use openreelio_core::assets::AssetKind;
use openreelio_core::commands::{
    ensure_source_out_within_media, recorded_duration_sec, update_command_from_probe,
    UpdateAssetCommand,
};
use openreelio_core::ffmpeg::{FFmpegRunner, MediaInfo};
use openreelio_core::ipc::CommandPayload;
use openreelio_core::project::ProjectState;
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

/// Builds the command that back-fills a probe onto an asset that lacks one.
///
/// Returns `None` when the probe carried no duration worth recording for an
/// asset of this kind — a still, or a container FFprobe could not measure — so
/// a caller never logs an op that records nothing worth replaying.
pub fn back_fill_command(
    asset_id: &str,
    asset_kind: &AssetKind,
    media_info: &MediaInfo,
) -> Option<UpdateAssetCommand> {
    recorded_duration_sec(media_info, asset_kind)?;
    Some(update_command_from_probe(asset_id, asset_kind, media_info))
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

/// What a lazy measurement produced: a command to record, and what to report.
pub struct AssetMeasurement {
    /// The `UpdateAsset` that records the reading, when there is one to record.
    ///
    /// The caller executes it — through its own [`EditRecorder`] where it has
    /// one — so the measurement lands in the same batch as the edit that needed
    /// it rather than in a batch of its own.
    ///
    /// [`EditRecorder`]: crate::commands::EditRecorder
    pub command: Option<UpdateAssetCommand>,
    /// Lines the verb should publish under `warnings[]`.
    pub warnings: Vec<String>,
}

/// Measures an asset that carries no duration.
///
/// The GUI probes on import, so its assets always know how long they are. An
/// asset imported headlessly before probing existed, or with `asset import
/// --no-probe`, does not — and every insert from it then falls back to a
/// default length regardless of the file, which overruns short media and
/// collides with whatever is placed after it. Correcting it through
/// `UpdateAsset` rather than by mutating the asset keeps the correction in the
/// ops log, so replaying the project reproduces it.
///
/// A probe that cannot run is a warning rather than a failure, because the
/// insert itself is still valid — it just takes the default length.
pub fn measure_asset(project: &ActiveProject, asset_id: &str) -> AssetMeasurement {
    let Some(asset) = project.state.assets.get(asset_id) else {
        // The command about to run reports the missing asset far better than a
        // warning would.
        return AssetMeasurement {
            command: None,
            warnings: Vec::new(),
        };
    };

    // A still has no length to measure, and the timeline gives it whatever slot
    // it asks for, so there is nothing here for it to be missing.
    if asset.kind == AssetKind::Image {
        return AssetMeasurement {
            command: None,
            warnings: Vec::new(),
        };
    }

    let already_known = asset
        .duration_sec
        .is_some_and(|duration| duration.is_finite() && duration > 0.0);
    if already_known {
        return AssetMeasurement {
            command: None,
            warnings: Vec::new(),
        };
    }

    let asset_kind = asset.kind.clone();
    let warning = |text: String| AssetMeasurement {
        command: None,
        warnings: vec![text],
    };

    let Some(source_path) = asset_source_path(&project.state, &project.path, asset_id) else {
        return warning(format!(
            "Asset '{asset_id}' records no duration and its file could not be located, so the clip takes the default length"
        ));
    };

    let media_info = match probe_media(&source_path) {
        Ok(info) => info,
        Err(reason) => {
            return warning(format!(
                "{reason}; asset '{asset_id}' still records no duration, so the clip takes the default length"
            ))
        }
    };

    let Some(command) = back_fill_command(asset_id, &asset_kind, &media_info) else {
        return warning(format!(
            "FFprobe reported no usable duration for asset '{asset_id}', so the clip takes the default length"
        ));
    };
    let duration_sec = recorded_duration_sec(&media_info, &asset_kind).unwrap_or_default();

    AssetMeasurement {
        command: Some(command),
        warnings: vec![format!(
            "Asset '{asset_id}' recorded no duration; it was probed at {duration_sec:.3}s and updated before the insert"
        )],
    }
}

/// Measures an unmeasured asset and records the reading in its own operation.
///
/// For surfaces that apply one command at a time and have no batch to fold the
/// measurement into. `timeline insert` uses [`measure_asset`] directly instead,
/// so its `UpdateAsset` shares the insert's recorder.
pub fn ensure_asset_measured(
    project: &mut ActiveProject,
    asset_id: &str,
) -> anyhow::Result<Vec<String>> {
    let measurement = measure_asset(project, asset_id);
    if let Some(command) = measurement.command {
        project
            .executor
            .execute(Box::new(command), &mut project.state)
            .map_err(|error| {
                anyhow::anyhow!("Recording the probed asset duration failed: {error}")
            })?;
    }

    Ok(measurement.warnings)
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
    match payload {
        CommandPayload::InsertMedia(insert) => ensure_asset_measured(project, &insert.asset_id),
        CommandPayload::InsertClip(insert) => ensure_asset_measured(project, &insert.asset_id),
        CommandPayload::TrimClip(trim) => {
            ensure_source_out_within_media(
                &project.state,
                &trim.sequence_id,
                &trim.clip_id,
                trim.new_source_out,
            )
            .map_err(|error| anyhow::anyhow!("{error}"))?;
            Ok(Vec::new())
        }
        _ => Ok(Vec::new()),
    }
}

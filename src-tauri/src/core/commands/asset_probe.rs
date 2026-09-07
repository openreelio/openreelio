//! Turning an FFprobe reading into asset commands.
//!
//! Import used to exist twice: the GUI probed a file and translated the
//! reading into an [`ImportAssetCommand`], while the CLI skipped the probe
//! entirely and imported a bare asset with no duration. An asset with no
//! duration makes every later insert fall back to a ten-second default, so a
//! four-second file became a clip that overran its own media, collided with
//! the next insert and produced a video-less render. The translation lives
//! here so both surfaces record the same asset for the same file.

use crate::core::{
    assets::{
        needs_probe_refresh, Asset, AssetKind, AudioInfo, MediaMetadata, VideoInfo,
        ASSET_PROBE_VERSION,
    },
    commands::{ImportAssetCommand, UpdateAssetCommand},
    ffmpeg::{AudioStreamInfo, MediaInfo, VideoStreamInfo},
    project::ProjectState,
    render::SOURCE_OVERRUN_TOLERANCE_SEC,
    timeline::TrackKind,
    CoreError, CoreResult, Ratio,
};
use crate::ActiveProject;
use std::path::{Path, PathBuf};

/// Tolerance for recognising an NTSC frame rate in a probed float.
const NTSC_TOLERANCE: f64 = 0.01;

/// Tolerance for treating a probed frame rate as a whole number.
const INTEGER_FPS_TOLERANCE: f64 = 0.001;

/// Denominator used for frame rates that are neither NTSC nor integral.
const FRACTIONAL_FPS_DENOMINATOR: i32 = 1000;

/// Slack below which a source bound is rounding rather than a real overrun.
const SOURCE_BOUND_EPSILON_SEC: f64 = 1e-6;

/// Converts a floating-point FPS value to a Ratio (numerator, denominator).
///
/// Handles common video frame rates including NTSC (23.976, 29.97, 59.94).
/// Returns `(0, 1)` for invalid input (NaN, Infinity, zero, negative).
pub fn fps_to_ratio(fps: f64) -> (i32, i32) {
    // Guard against invalid FPS values from malformed media or FFprobe errors
    if !fps.is_finite() || fps <= 0.0 {
        return (0, 1);
    }

    if (fps - 23.976).abs() < NTSC_TOLERANCE {
        return (24000, 1001);
    }
    if (fps - 29.97).abs() < NTSC_TOLERANCE {
        return (30000, 1001);
    }
    if (fps - 59.94).abs() < NTSC_TOLERANCE {
        return (60000, 1001);
    }

    // For standard frame rates (24, 25, 30, 50, 60, etc.)
    let rounded = fps.round();
    if (fps - rounded).abs() < INTEGER_FPS_TOLERANCE {
        return (rounded as i32, 1);
    }

    // For other fractional frame rates, use a reasonable approximation
    let num = (fps * FRACTIONAL_FPS_DENOMINATOR as f64).round() as i32;
    (num, FRACTIONAL_FPS_DENOMINATOR)
}

/// A recorded duration, or `None` when the number is not a length.
///
/// `0` and the non-finite values are what a file nobody could measure records:
/// FFprobe answers a PNG with no `format.duration` at all, which lands as
/// `Some(0.0)`, and projects written before the probe filtered its readings
/// still carry it. Trusting such a value is worse than having none — an insert
/// that took `0.0` for a length failed with "Invalid time range: 0~0" instead
/// of placing a default-length clip — so every reader of an asset's duration
/// passes it through here first.
pub fn usable_duration_sec(duration_sec: Option<f64>) -> Option<f64> {
    duration_sec.filter(|value| value.is_finite() && *value > 0.0)
}

/// The stream lengths a probe read, whichever prober produced them.
///
/// The same file is measured by two readers: [`MediaInfo`], which the FFmpeg
/// runner hands to import, and [`MediaMetadata`], which the workspace
/// scanner's extractor returns for a file it discovered on disk. They carry the
/// same three numbers, and the recording rules below must not come out
/// different because a surface happened to hold one rather than the other --
/// the scanner recording a container duration where import records the video
/// stream's is exactly how a scanned asset got a length no clip cut from it
/// could reach.
pub trait ProbedStreamDurations {
    /// The container's own duration: the maximum across every stream.
    fn container_duration_sec(&self) -> f64;

    /// The video stream's own duration, when it advertises one.
    fn video_stream_duration_sec(&self) -> Option<f64>;

    /// The audio stream's own duration, when it advertises one.
    fn audio_stream_duration_sec(&self) -> Option<f64>;

    /// Whether the file carries an audio stream at all.
    fn has_audio_stream(&self) -> bool;
}

impl ProbedStreamDurations for MediaInfo {
    fn container_duration_sec(&self) -> f64 {
        self.duration_sec
    }

    fn video_stream_duration_sec(&self) -> Option<f64> {
        self.video_duration_sec
    }

    fn audio_stream_duration_sec(&self) -> Option<f64> {
        self.audio_duration_sec
    }

    fn has_audio_stream(&self) -> bool {
        self.audio.is_some()
    }
}

impl ProbedStreamDurations for MediaMetadata {
    fn container_duration_sec(&self) -> f64 {
        self.duration_sec
    }

    fn video_stream_duration_sec(&self) -> Option<f64> {
        self.video_duration_sec
    }

    fn audio_stream_duration_sec(&self) -> Option<f64> {
        self.audio_duration_sec
    }

    fn has_audio_stream(&self) -> bool {
        self.audio.is_some()
    }
}

/// The duration a probe is allowed to hand to an asset, or `None`.
///
/// The container's own reading, filtered by [`usable_duration_sec`]: FFprobe
/// reports `0` or a non-finite duration for anything it cannot measure.
pub fn usable_media_duration_sec(media_info: &impl ProbedStreamDurations) -> Option<f64> {
    usable_duration_sec(Some(media_info.container_duration_sec()))
}

/// The duration to record for an asset of the given kind, or `None`.
///
/// Two readings of the same file are not interchangeable:
///
/// * A still has no length. FFprobe answers `0` for a PNG and one frame's worth
///   (`0.04`) for a JPEG, and recording either turns the next insert into a
///   refusal ("sourceOut must be greater than sourceIn") or a 40ms clip. An
///   image holds whatever slot the timeline gives it, so it records nothing.
/// * A video is bounded by its *video stream*, not by its container. The
///   renderer bounds every picture clip by
///   [`resolve_asset_source_duration`](crate::core::render::resolve_asset_source_duration),
///   which reads the video stream's own length; an mp4 whose AAC outlasts its
///   pictures by 0.2s would otherwise be recorded 0.2s too long and every clip
///   cut from it would carry a black tail and an overrun warning.
pub fn recorded_duration_sec(
    media_info: &impl ProbedStreamDurations,
    asset_kind: &AssetKind,
) -> Option<f64> {
    match asset_kind {
        AssetKind::Image => None,
        AssetKind::Video => usable_duration_sec(media_info.video_stream_duration_sec())
            .or_else(|| usable_media_duration_sec(media_info)),
        _ => usable_media_duration_sec(media_info),
    }
}

/// The sound's own length to record beside [`recorded_duration_sec`], or `None`.
///
/// Only a video asset needs one: its `durationSec` is the *picture's* length,
/// so a container whose AAC outlasts its video holds sound the recorded
/// duration does not admit to. Capping the linked audio clip — and every
/// `audioOnly` insert — at the picture's length made those seconds unreachable
/// through any edit.
///
/// `None` when the file carries no sound, when the sound does not outlast the
/// picture (there is then nothing the recorded duration gets wrong), and for
/// every non-video kind, whose `durationSec` already measures what it plays.
pub fn recorded_audio_duration_sec(
    media_info: &impl ProbedStreamDurations,
    asset_kind: &AssetKind,
) -> Option<f64> {
    if !matches!(asset_kind, AssetKind::Video) || !media_info.has_audio_stream() {
        return None;
    }

    let audio_duration_sec = usable_duration_sec(media_info.audio_stream_duration_sec())
        .or_else(|| usable_media_duration_sec(media_info))?;
    let picture_duration_sec = recorded_duration_sec(media_info, asset_kind)?;

    (audio_duration_sec > picture_duration_sec + SOURCE_BOUND_EPSILON_SEC)
        .then_some(audio_duration_sec)
}

/// How far the media behind a clip runs, as read for a track of the given kind.
///
/// An audio track plays the asset's sound and a video track plays its pictures,
/// and the two do not have to be the same length — see
/// [`Asset::audio_duration_sec`](crate::core::assets::Asset::audio_duration_sec).
/// Every bound taken against an asset therefore has to say which of the two it
/// means, or a linked audio clip is measured against the picture it was split
/// away from.
///
/// `None` when nothing has measured the file, or when the asset is a still —
/// which holds whatever slot the timeline gives it.
pub fn asset_duration_for_track(
    asset: &crate::core::assets::Asset,
    track_kind: &TrackKind,
) -> Option<f64> {
    if asset.kind == AssetKind::Image {
        return None;
    }

    let picture_duration_sec = usable_duration_sec(asset.duration_sec);
    match track_kind {
        TrackKind::Audio => usable_duration_sec(asset.audio_duration_sec).or(picture_duration_sec),
        _ => picture_duration_sec,
    }
}

/// Refuses a source-out point that reaches past the end of a clip's media.
///
/// Nothing downstream can recover the frames such an edit asks for: the render
/// pads the missing seconds with black and the preview shows the same. Naming
/// the asset's recorded length here is what lets the caller retry with a number
/// that exists. Shared by every surface that trims — `timeline trim`, `command
/// execute --type TrimClip`, `plan execute` and the MCP plan tools — so the
/// refusal cannot be true of one of them and not the others.
///
/// Silent (`Ok`) whenever the bound is unknowable rather than satisfied: a
/// missing sequence, a clip that is nowhere in it, or a missing asset is the
/// executing command's error to report, an unmeasured asset has no length to
/// check against, and a still holds its slot however long the timeline makes
/// it.
///
/// The bound is read for the named track — see [`asset_duration_for_track`]
/// — so the linked audio clip of an mp4 whose sound outlasts its pictures is
/// measured against the sound. The track comes from the caller rather than from
/// a search: a clip id is unique within its sequence only by convention, and a
/// scan that stopped at the first match could measure a picture clip against
/// the sound clip that shares its id on another track.
///
/// A track that does not hold the clip is *not* a pass, and it is not measured
/// elsewhere either: the guard raises exactly the error
/// [`TrimClipCommand`](crate::core::commands::TrimClipCommand) raises for the
/// same arguments — [`CoreError::TrackNotFound`] for a track the sequence does
/// not have, [`CoreError::ClipNotFound`] for a track that has no such clip on
/// it. Measuring on whichever track *did* hold the clip made `plan validate`
/// refuse a wrong-track trim for one reason and `plan execute` refuse it for
/// another, and returning `Ok` before that made the guard a hole the trim then
/// walked through. Only a clip that is nowhere in the sequence is left to the
/// command to report, because then there is nothing here to measure.
///
/// That resolution runs whether or not the trim carries a `newSourceOut`:
/// hanging it off the bound made the refusal depend on which field the caller
/// happened to send, so a wrong-track trim that moved only `newSourceIn` was
/// accepted everywhere.
///
/// The slack is the renderer's own
/// [`SOURCE_OVERRUN_TOLERANCE_SEC`](crate::core::render::SOURCE_OVERRUN_TOLERANCE_SEC),
/// so nothing is refused here that the export would have rendered without
/// complaint, and the number the message names is *floored* to the millisecond
/// it prints: rounding it up named a value that was itself past the end, and a
/// caller who did as it said was refused a second time with the same sentence.
pub fn ensure_source_out_within_media(
    state: &ProjectState,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
    source_out: Option<f64>,
) -> CoreResult<()> {
    let Some(sequence) = state.sequences.get(sequence_id) else {
        return Ok(());
    };
    // A clip the sequence does not hold at all is the command's error to
    // report: there is no track here to read a bound from, and raising
    // `ClipNotFound` before the command runs would only restate what it is
    // about to say.
    if !sequence
        .tracks
        .iter()
        .any(|track| track.get_clip(clip_id).is_some())
    {
        return Ok(());
    }
    // From here the guard resolves the clip exactly as `TrimClipCommand` does,
    // so a wrong `trackId` is refused with the same error on every surface.
    let Some(track) = sequence.tracks.iter().find(|track| track.id == track_id) else {
        return Err(CoreError::TrackNotFound(track_id.to_string()));
    };
    let Some(clip) = track.get_clip(clip_id) else {
        return Err(CoreError::ClipNotFound(clip_id.to_string()));
    };
    // Only now is there nothing left to refuse: a trim that moves `sourceIn`
    // alone still names a track and a clip, and resolving them after this early
    // return let a wrong-track trim through on whichever surface happened not
    // to send a `newSourceOut`.
    let Some(source_out) = source_out else {
        return Ok(());
    };
    let Some(asset) = state.assets.get(&clip.asset_id) else {
        return Ok(());
    };
    let Some(duration_sec) = asset_duration_for_track(asset, &track.kind) else {
        return Ok(());
    };

    if source_out > duration_sec + SOURCE_OVERRUN_TOLERANCE_SEC {
        let usable_sec = floor_to_milliseconds(duration_sec);
        return Err(CoreError::ValidationError(format!(
            "sourceOut {source_out} is past the end of asset '{}', which holds only {usable_sec:.3}s of media. Use {usable_sec:.3} or less.",
            asset.id
        )));
    }

    Ok(())
}

/// Rounds a duration *down* to the millisecond a `{:.3}` message would print.
///
/// The message has to name a number the same guard accepts. `{:.3}` rounds to
/// nearest, so an NTSC 3.336667s asset was reported as "3.337s of media. Use
/// 3.337 or less" — and 3.337 is past 3.336667, so following the instruction
/// produced the identical refusal.
fn floor_to_milliseconds(duration_sec: f64) -> f64 {
    (duration_sec * 1_000.0).floor() / 1_000.0
}

/// Builds the stored video metadata for a probed video stream.
pub fn video_info_from_probe(video_stream: &VideoStreamInfo) -> VideoInfo {
    let (fps_num, fps_den) = fps_to_ratio(video_stream.fps);
    VideoInfo {
        width: video_stream.width,
        height: video_stream.height,
        fps: Ratio::new(fps_num, fps_den),
        codec: video_stream.codec.clone(),
        bitrate: video_stream.bitrate,
        has_alpha: false,
        is_hdr: video_stream.is_hdr,
        color_transfer: video_stream.color_transfer.clone(),
    }
}

/// Builds the stored audio metadata for a probed audio stream.
pub fn audio_info_from_probe(audio_stream: &AudioStreamInfo) -> AudioInfo {
    AudioInfo {
        sample_rate: audio_stream.sample_rate,
        channels: audio_stream.channels,
        codec: audio_stream.codec.clone(),
        bitrate: audio_stream.bitrate,
    }
}

/// Builds the import command for a file, enriched by a probe when there is one.
///
/// Without `media_info` this is exactly [`ImportAssetCommand::new`]: extension
/// inference and no duration. With one, the asset kind is corrected against
/// what the file actually contains — an `.ogg` holding pictures is a video, an
/// `.mp4` holding only sound is audio — and duration, size, dimensions, frame
/// rate and audio format are recorded — except a duration the file does not
/// have, which is left unknown rather than recorded as zero; see
/// [`recorded_duration_sec`].
pub fn import_command_from_probe(
    name: &str,
    resolved_uri: &str,
    media_info: Option<&MediaInfo>,
) -> ImportAssetCommand {
    let mut command = ImportAssetCommand::new(name, resolved_uri);
    let extension = std::path::Path::new(resolved_uri)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    let is_ambiguous_ogg = extension == "ogg";

    let Some(info) = media_info else {
        return command;
    };

    let has_video = info.video.is_some();
    let has_audio = info.audio.is_some();

    command = match command.asset.kind {
        AssetKind::Image => ImportAssetCommand::image(name, resolved_uri, 1920, 1080),
        AssetKind::Audio => {
            if is_ambiguous_ogg && has_video {
                match info.video.as_ref() {
                    Some(video_stream) => ImportAssetCommand::video(
                        name,
                        resolved_uri,
                        video_info_from_probe(video_stream),
                    ),
                    None => ImportAssetCommand::new(name, resolved_uri),
                }
            } else if let Some(audio_stream) = info.audio.as_ref() {
                ImportAssetCommand::audio(name, resolved_uri, audio_info_from_probe(audio_stream))
            } else {
                ImportAssetCommand::audio(name, resolved_uri, AudioInfo::default())
            }
        }
        AssetKind::Video => {
            if !has_video && has_audio {
                match info.audio.as_ref() {
                    Some(audio_stream) => ImportAssetCommand::audio(
                        name,
                        resolved_uri,
                        audio_info_from_probe(audio_stream),
                    ),
                    None => ImportAssetCommand::new(name, resolved_uri),
                }
            } else if let Some(video_stream) = info.video.as_ref() {
                ImportAssetCommand::video(name, resolved_uri, video_info_from_probe(video_stream))
            } else {
                ImportAssetCommand::new(name, resolved_uri)
            }
        }
        _ => ImportAssetCommand::new(name, resolved_uri),
    };

    // Only a length the file actually has: a still records none, and a video
    // records its picture's length rather than its container's. See
    // [`recorded_duration_sec`].
    if let Some(duration_sec) = recorded_duration_sec(info, &command.asset.kind) {
        command = command.with_duration(duration_sec);
    }
    // The sound's own length when it outlasts the picture, so a linked audio
    // clip is not cut short by the video stream. See
    // [`recorded_audio_duration_sec`].
    let audio_duration_sec = recorded_audio_duration_sec(info, &command.asset.kind);
    command = command.with_audio_duration_sec(audio_duration_sec);
    // Stamped whether or not the sound outlasted the picture: the marker says
    // the file was *read* under these rules, so an asset with no
    // `audioDurationSec` is not re-probed forever looking for one. See
    // [`Asset::probe_version`](crate::core::assets::Asset::probe_version).
    command = command.with_probe_version(Some(ASSET_PROBE_VERSION));
    command = command.with_file_size(info.size_bytes);

    if matches!(command.asset.kind, AssetKind::Video) {
        if let Some(video_stream) = info.video.as_ref() {
            command = command.with_video_info(video_info_from_probe(video_stream));
        }
    }

    if matches!(command.asset.kind, AssetKind::Audio | AssetKind::Video) {
        if let Some(audio_stream) = info.audio.as_ref() {
            command = command.with_audio_info(audio_info_from_probe(audio_stream));
        }
    }

    command
}

/// Builds the update command that back-fills a probe onto an existing asset.
///
/// Used when an asset was imported without a probe — `asset import
/// --no-probe`, or an import that ran while FFmpeg was unresolvable — and a
/// later verb needs the duration. Going through a command rather than mutating
/// the asset keeps the correction in the ops log, so replaying the project
/// reproduces it.
///
/// `asset_kind` decides which reading is recorded — see
/// [`recorded_duration_sec`] — and a probe carrying no usable duration for that
/// kind leaves the asset's duration untouched rather than clearing it.
pub fn update_command_from_probe(
    asset_id: &str,
    asset_kind: &AssetKind,
    media_info: &MediaInfo,
) -> UpdateAssetCommand {
    let mut command = UpdateAssetCommand::new(asset_id);

    if let Some(duration_sec) = recorded_duration_sec(media_info, asset_kind) {
        command = command.with_duration_sec(Some(duration_sec));
        // Recorded beside the picture length and only alongside it: an update
        // that left the two readings from different probes could bound a linked
        // audio clip by a file the asset no longer claims to be.
        command =
            command.with_audio_duration_sec(recorded_audio_duration_sec(media_info, asset_kind));
    }
    // The marker records that the file was read under the current rules, which
    // is true even when the reading held no usable duration for this kind — a
    // container FFprobe could not measure, say. Stamping it only alongside a
    // duration left such an asset permanently stale, so every later insert
    // re-probed the same unmeasurable file and paid for the same reading again.
    // See [`Asset::probe_version`](crate::core::assets::Asset::probe_version).
    command = command.with_probe_version(Some(ASSET_PROBE_VERSION));
    // A probe that could not size the file must not erase a size the import
    // already recorded: `0` here means "unread", not "empty".
    if media_info.size_bytes > 0 {
        command = command.with_file_size(media_info.size_bytes);
    }

    if let Some(video_stream) = media_info.video.as_ref() {
        command = command.with_video(Some(video_info_from_probe(video_stream)));
    }
    if let Some(audio_stream) = media_info.audio.as_ref() {
        command = command.with_audio(Some(audio_info_from_probe(audio_stream)));
    }

    command
}

/// What a lazy measurement produced: a command to record, and what to report.
pub struct AssetMeasurement {
    /// The `UpdateAsset` that records the reading, when there is one to record.
    ///
    /// The caller executes it — through its own recorder where it has one — so
    /// the measurement lands in the same batch as the edit that needed it
    /// rather than in a batch of its own.
    pub command: Option<UpdateAssetCommand>,
    /// Lines the surface should publish to the caller.
    pub warnings: Vec<String>,
}

/// Whether an asset still has to be read before its length can be trusted.
///
/// A still has no length to measure — the timeline gives it whatever slot it
/// asks for — so it is never worth probing. Everything else is measured until
/// a probe has stamped [`ASSET_PROBE_VERSION`] on it, whether or not that probe
/// found a duration: an asset FFprobe genuinely cannot measure would otherwise
/// be re-read on every insert forever. See
/// [`needs_probe_refresh`](crate::core::assets::needs_probe_refresh).
pub fn asset_needs_measurement(asset: &Asset) -> bool {
    asset.kind != AssetKind::Image && needs_probe_refresh(asset)
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
) -> Option<PathBuf> {
    let asset = state.assets.get(asset_id)?;
    let path = crate::core::workspace::path_resolver::resolve_to_absolute(
        project_root,
        asset.relative_path.as_deref().unwrap_or(asset.uri.as_str()),
    );

    path.is_file().then_some(path)
}

/// Measures an asset that has not been read under the current probe rules.
///
/// The GUI probes on import, so its assets know how long they are — but an
/// asset imported before `audioDurationSec` was recorded bounds its linked
/// audio clip by the picture and cuts the last seconds of the recording off,
/// and one imported headlessly with `--no-probe` records no length at all so
/// every insert from it falls back to a default regardless of the file.
/// Correcting either through `UpdateAsset` rather than by mutating the asset
/// keeps the correction in the ops log, so replaying the project reproduces it.
///
/// `probe` reads the file; it is the caller's because the CLI runs FFprobe on
/// its own runtime while the app runs it on the shared `FFmpegRunner`. A probe
/// that cannot run is a warning rather than a failure, because the edit that
/// needed the measurement is still valid — it just takes the default length.
pub fn measure_asset<P>(project: &ActiveProject, asset_id: &str, probe: P) -> AssetMeasurement
where
    P: FnOnce(&Path) -> Result<MediaInfo, String>,
{
    let nothing_to_do = AssetMeasurement {
        command: None,
        warnings: Vec::new(),
    };

    let Some(asset) = project.state.assets.get(asset_id) else {
        // The command about to run reports the missing asset far better than a
        // warning would.
        return nothing_to_do;
    };
    if !asset_needs_measurement(asset) {
        return nothing_to_do;
    }

    let asset_kind = asset.kind.clone();
    // A re-read that fails leaves an already-measured asset exactly as usable
    // as it was, and the edit it precedes is unaffected — so there is nothing
    // for the caller to act on and nothing to report. Only an asset with no
    // length at all is worth warning about, because that edit really does fall
    // back to the default.
    let measured_duration = asset
        .duration_sec
        .is_some_and(|duration| duration.is_finite() && duration > 0.0);
    let warning = |text: String| AssetMeasurement {
        command: None,
        warnings: if measured_duration {
            Vec::new()
        } else {
            vec![text]
        },
    };

    let Some(source_path) = asset_source_path(&project.state, &project.path, asset_id) else {
        return warning(format!(
            "Asset '{asset_id}' records no duration and its file could not be located, so the clip takes the default length"
        ));
    };

    let media_info = match probe(&source_path) {
        Ok(info) => info,
        Err(reason) => {
            return warning(format!(
                "{reason}; asset '{asset_id}' still records no duration, so the clip takes the default length"
            ))
        }
    };

    let command = update_command_from_probe(asset_id, &asset_kind, &media_info);
    let Some(duration_sec) = recorded_duration_sec(&media_info, &asset_kind) else {
        // The file was read, it just held no length for this kind. Recording
        // the reading anyway stamps the probe marker, which is what stops the
        // next insert from paying for the same unmeasurable reading again.
        return AssetMeasurement {
            command: Some(command),
            warnings: if measured_duration {
                Vec::new()
            } else {
                vec![format!(
                    "FFprobe reported no usable duration for asset '{asset_id}', so the clip takes the default length"
                )]
            },
        };
    };

    let report = if measured_duration {
        format!(
            "Asset '{asset_id}' was measured before sound lengths were recorded; it was re-probed at {duration_sec:.3}s and updated before the insert"
        )
    } else {
        format!(
            "Asset '{asset_id}' recorded no duration; it was probed at {duration_sec:.3}s and updated before the insert"
        )
    };

    AssetMeasurement {
        command: Some(command),
        warnings: vec![report],
    }
}

/// Measures an unmeasured asset and records the reading in its own operation.
///
/// For surfaces that apply one command at a time and have no batch to fold the
/// measurement into — `command execute`, the MCP edit tools, `plan execute`'s
/// pre-pass, and the app's own `execute_command`. `timeline insert` uses
/// [`measure_asset`] directly instead, so its `UpdateAsset` shares the insert's
/// recorder.
pub fn ensure_asset_measured<P>(
    project: &mut ActiveProject,
    asset_id: &str,
    probe: P,
) -> CoreResult<Vec<String>>
where
    P: FnOnce(&Path) -> Result<MediaInfo, String>,
{
    let measurement = measure_asset(project, asset_id, probe);
    if let Some(command) = measurement.command {
        project
            .executor
            .execute(Box::new(command), &mut project.state)?;
    }

    Ok(measurement.warnings)
}

// =============================================================================
// Off-lock measurement passes
// =============================================================================

/// Refusal raised when the open project changed while its assets were probed.
///
/// Shared so every surface that releases the project lock for a measurement
/// reports the same reason, and so a test can pin it without copying a string.
pub const PROJECT_CHANGED_DURING_PROBE: &str =
    "The open project changed while its assets were being read";

/// Refuses to record readings against a project the caller never decided about.
///
/// The measurement cycle releases the project lock, and the operator can close
/// project A and open project B in that window. Nothing else catches it: B has
/// its own ops-log watermark, so the external-change check passes, and an asset
/// id that exists in both would take an `UpdateAsset` derived from A's path
/// resolution — appended to B's log behind no plan, no validation and no
/// approval. So identity is asked first, on the way back in, and asked for
/// every surface rather than only the one that remembered to.
pub fn ensure_probed_project_unchanged(
    state: &ProjectState,
    expected_project_id: &str,
) -> Result<(), String> {
    if state.meta.id != expected_project_id {
        return Err(PROJECT_CHANGED_DURING_PROBE.to_string());
    }
    Ok(())
}

/// Takes an *owned* copy of the shared FFmpeg runner, holding the read lock
/// only for as long as the copy takes.
///
/// The return type is the whole point: an `Option<&FFmpegRunner>` borrowed from
/// the guard would keep the guard alive for as long as the caller used the
/// runner, and tokio's `RwLock` is write-preferring — a single queued
/// `initialize_shared_ffmpeg` writer would then park every later FFmpeg reader
/// behind however long the borrower runs. Returning an owned runner makes that
/// impossible to write by accident rather than merely discouraged.
async fn ffmpeg_runner_snapshot(
    ffmpeg_state: &crate::core::ffmpeg::SharedFFmpegState,
) -> Option<crate::core::ffmpeg::FFmpegRunner> {
    ffmpeg_state.read().await.runner().cloned()
}

/// One asset a placement is about to cut from that nothing has measured yet.
///
/// Carries the file the collect pass resolved for it, so the probe itself can
/// run with no project lock held. See [`collect_unmeasured_assets`].
pub struct UnmeasuredAsset {
    asset_id: String,
    /// `None` when the asset resolves to no file on this machine.
    source_path: Option<PathBuf>,
}

/// One asset, and what reading it off the lock produced.
pub struct PendingAssetMeasurement {
    /// The asset the reading belongs to.
    pub asset_id: String,
    /// `None` when no probe was attempted, because the collect pass found no
    /// file to read. The apply pass still asks [`ensure_asset_measured`], which
    /// resolves the path itself and names its absence better than this could.
    pub probed: Option<Result<MediaInfo, String>>,
}

/// Picks out the assets a placement is about to take a length from unread.
///
/// The CLI probes lazily before every placement, so a project imported with
/// `asset import --no-probe`, or one written before `audioDurationSec` was
/// recorded, is corrected the first time a clip is cut from it. Nothing in the
/// app did: it probes on import and never again, so opening such a project in
/// the GUI and dragging the asset onto the timeline landed a clip of the
/// default length — the very case the CLI back-fill exists to stop.
///
/// This is the first of three passes, and the only one that needs the project.
/// FFprobe carries a two-minute watchdog, and running it while the project
/// mutex is held blocks every other project-touching IPC for as long as it
/// takes — a plan inserting from ten unread assets would hold the app still for
/// twenty minutes. So the lock is used to *decide* here, dropped, and taken
/// again only to record the readings. Duplicates are dropped, because a plan
/// that inserts five clips from one asset should pay for one probe.
pub fn collect_unmeasured_assets<'a, I>(
    state: &ProjectState,
    project_root: &Path,
    asset_ids: I,
) -> Vec<UnmeasuredAsset>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut collected: Vec<UnmeasuredAsset> = Vec::new();
    for asset_id in asset_ids {
        if collected.iter().any(|target| target.asset_id == asset_id) {
            continue;
        }
        let needs_measurement = state
            .assets
            .get(asset_id)
            .is_some_and(asset_needs_measurement);
        if !needs_measurement {
            continue;
        }
        collected.push(UnmeasuredAsset {
            asset_id: asset_id.to_string(),
            source_path: asset_source_path(state, project_root, asset_id),
        });
    }

    collected
}

/// Reads each collected file. Must run with no project lock held.
///
/// FFprobe runs on the app's own `FFmpegRunner` rather than on a runtime of its
/// own, which is why the probe is taken here and handed to
/// [`ensure_asset_measured`] rather than being called from inside it. A probe
/// that cannot run is carried as its reason rather than raised: the placement
/// it precedes is still valid, it just takes the default length, and failing
/// the edit over the measurement would be worse than the length.
///
/// The runner is *cloned* out of the shared FFmpeg state by
/// [`ffmpeg_runner_snapshot`] and the read guard dropped before the first probe
/// runs. Holding the guard across the batch would be as bad as holding the
/// project lock: tokio's `RwLock` is write-preferring, so one queued
/// `initialize_shared_ffmpeg` writer parks every later reader behind a batch
/// that can take two minutes per asset.
pub async fn probe_unmeasured_assets(
    targets: Vec<UnmeasuredAsset>,
    ffmpeg_state: &crate::core::ffmpeg::SharedFFmpegState,
) -> Vec<PendingAssetMeasurement> {
    if targets.is_empty() {
        return Vec::new();
    }

    let runner = ffmpeg_runner_snapshot(ffmpeg_state).await;

    let mut measurements = Vec::with_capacity(targets.len());
    for target in targets {
        let probed = match (&target.source_path, runner.as_ref()) {
            (Some(source_path), Some(runner)) => {
                Some(runner.probe(source_path).await.map_err(|error| {
                    format!(
                        "FFprobe could not read '{}': {error}",
                        source_path.display()
                    )
                }))
            }
            (Some(_), None) => Some(Err(
                "FFmpeg could not be resolved, so the asset was not re-probed".to_string(),
            )),
            (None, _) => None,
        };
        measurements.push(PendingAssetMeasurement {
            asset_id: target.asset_id,
            probed,
        });
    }

    measurements
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video_stream() -> VideoStreamInfo {
        VideoStreamInfo {
            width: 1920,
            height: 1080,
            fps: 30.0,
            codec: "h264".to_string(),
            pixel_format: "yuv420p".to_string(),
            bitrate: Some(8_000_000),
            is_hdr: false,
            color_transfer: None,
            rotation_deg: 0.0,
        }
    }

    fn audio_stream() -> AudioStreamInfo {
        AudioStreamInfo {
            sample_rate: 48_000,
            channels: 2,
            codec: "aac".to_string(),
            bitrate: Some(192_000),
        }
    }

    fn media_info(duration_sec: f64) -> MediaInfo {
        MediaInfo {
            duration_sec,
            video_duration_sec: Some(duration_sec),
            audio_duration_sec: Some(duration_sec),
            video: Some(video_stream()),
            audio: Some(audio_stream()),
            format: "mov,mp4,m4a".to_string(),
            size_bytes: 4096,
        }
    }

    #[test]
    fn should_record_the_probed_duration_and_dimensions_when_a_probe_is_given() {
        let command =
            import_command_from_probe("clip.mp4", "/media/clip.mp4", Some(&media_info(4.0)));

        assert_eq!(command.asset.duration_sec, Some(4.0));
        let video = command.asset.video.expect("probed video metadata");
        assert_eq!(video.width, 1920);
        assert_eq!(video.height, 1080);
        assert_eq!(video.fps.num, 30);
        assert!(command.asset.audio.is_some());
    }

    #[test]
    fn should_leave_the_duration_unknown_when_no_probe_is_given() {
        let command = import_command_from_probe("clip.mp4", "/media/clip.mp4", None);

        assert_eq!(command.asset.duration_sec, None);
    }

    #[test]
    fn should_classify_a_video_container_holding_only_sound_as_audio() {
        let mut info = media_info(4.0);
        info.video = None;

        let command = import_command_from_probe("voice.mp4", "/media/voice.mp4", Some(&info));

        assert_eq!(command.asset.kind, AssetKind::Audio);
        assert_eq!(command.asset.duration_sec, Some(4.0));
    }

    #[test]
    fn should_back_fill_duration_and_streams_through_an_update_command() {
        let command = update_command_from_probe("asset-1", &AssetKind::Video, &media_info(5.76));

        assert_eq!(command.duration_sec, Some(Some(5.76)));
        assert!(command.video.is_some());
        assert!(command.audio.is_some());
    }

    #[test]
    fn should_keep_the_image_kind_when_a_still_reports_a_video_stream() {
        let mut info = media_info(0.04);
        info.audio = None;

        let command = import_command_from_probe("cover.jpg", "/tmp/cover.jpg", Some(&info));

        assert_eq!(command.asset.kind, AssetKind::Image);
    }

    #[test]
    fn should_leave_a_still_without_a_duration_whatever_ffprobe_reported() {
        // FFprobe answers a PNG with no `format.duration` at all, which reads
        // back as `0`, and a JPEG with a single frame's `0.04`.
        let mut png = media_info(0.0);
        png.video_duration_sec = None;
        png.audio = None;
        let mut jpeg = media_info(0.04);
        jpeg.audio = None;

        let png_command = import_command_from_probe("still.png", "/tmp/still.png", Some(&png));
        let jpeg_command = import_command_from_probe("cover.jpg", "/tmp/cover.jpg", Some(&jpeg));

        assert_eq!(png_command.asset.duration_sec, None);
        assert_eq!(jpeg_command.asset.duration_sec, None);
        assert_eq!(
            update_command_from_probe("asset-1", &AssetKind::Image, &jpeg).duration_sec,
            None
        );
    }

    #[test]
    fn should_leave_the_duration_unknown_when_the_probe_reported_nothing_measurable() {
        let mut unmeasurable = media_info(0.0);
        unmeasurable.video_duration_sec = None;
        let mut infinite = media_info(f64::INFINITY);
        infinite.video_duration_sec = None;

        assert_eq!(
            import_command_from_probe("clip.mp4", "/tmp/clip.mp4", Some(&unmeasurable))
                .asset
                .duration_sec,
            None
        );
        assert_eq!(
            import_command_from_probe("clip.mp4", "/tmp/clip.mp4", Some(&infinite))
                .asset
                .duration_sec,
            None
        );
    }

    #[test]
    fn should_record_the_video_streams_length_rather_than_the_containers() {
        // An mp4 whose AAC outlasts its pictures: the renderer bounds the clip
        // by the 4.0s of video, so recording the container's 4.2s would give
        // every clip a black tail and an overrun warning.
        let mut info = media_info(4.2);
        info.video_duration_sec = Some(4.0);

        let command = import_command_from_probe("clip.mp4", "/tmp/clip.mp4", Some(&info));

        assert_eq!(command.asset.duration_sec, Some(4.0));
        assert_eq!(
            update_command_from_probe("asset-1", &AssetKind::Video, &info).duration_sec,
            Some(Some(4.0))
        );
    }

    #[test]
    fn should_keep_the_container_length_for_sound_carried_beside_cover_art() {
        // A podcast .m4a carries a one-frame cover-art "video stream"; the
        // sound is what the asset is.
        let mut info = media_info(120.0);
        info.video_duration_sec = Some(0.04);

        let command = import_command_from_probe("podcast.m4a", "/tmp/podcast.m4a", Some(&info));

        assert_eq!(command.asset.kind, AssetKind::Audio);
        assert_eq!(command.asset.duration_sec, Some(120.0));
    }

    #[test]
    fn should_keep_a_recorded_file_size_when_the_probe_could_not_measure_one() {
        let mut info = media_info(4.0);
        info.size_bytes = 0;

        let command = update_command_from_probe("asset-1", &AssetKind::Video, &info);

        assert_eq!(command.file_size, None);
    }

    #[test]
    fn should_keep_the_audio_kind_when_cover_art_reports_a_video_stream() {
        let command =
            import_command_from_probe("podcast.m4a", "/tmp/podcast.m4a", Some(&media_info(120.0)));

        assert_eq!(command.asset.kind, AssetKind::Audio);
    }

    #[test]
    fn should_promote_an_ambiguous_ogg_carrying_pictures_to_video() {
        let command =
            import_command_from_probe("clip.ogg", "/tmp/clip.ogg", Some(&media_info(6.0)));

        assert_eq!(command.asset.kind, AssetKind::Video);
    }

    #[test]
    fn should_promote_an_unknown_extension_without_pictures_to_audio() {
        let mut info = media_info(6.0);
        info.video = None;

        let command = import_command_from_probe("voice.track", "/tmp/voice.track", Some(&info));

        assert_eq!(command.asset.kind, AssetKind::Audio);
    }

    #[test]
    fn should_preserve_hdr_metadata_from_the_probed_video_stream() {
        let stream = VideoStreamInfo {
            width: 3840,
            height: 2160,
            fps: 23.976,
            codec: "hevc".to_string(),
            pixel_format: "yuv420p10le".to_string(),
            bitrate: Some(25_000_000),
            is_hdr: true,
            color_transfer: Some("smpte2084".to_string()),
            rotation_deg: 0.0,
        };

        let video_info = video_info_from_probe(&stream);

        assert!(video_info.is_hdr);
        assert_eq!(video_info.color_transfer.as_deref(), Some("smpte2084"));
        assert_eq!(video_info.fps.num, 24000);
        assert_eq!(video_info.fps.den, 1001);
    }

    #[test]
    fn should_map_ntsc_and_invalid_frame_rates_to_stable_ratios() {
        assert_eq!(fps_to_ratio(29.97), (30000, 1001));
        assert_eq!(fps_to_ratio(25.0), (25, 1));
        assert_eq!(fps_to_ratio(f64::NAN), (0, 1));
        assert_eq!(fps_to_ratio(0.0), (0, 1));
    }

    #[test]
    fn should_record_the_sound_length_only_when_it_outlasts_the_picture() {
        // 4s of video, 6s of AAC. The picture bounds a clip on a video track
        // and the sound bounds one on an audio track, so both are recorded.
        let mut outlasting = media_info(6.0);
        outlasting.video_duration_sec = Some(4.0);
        outlasting.audio_duration_sec = Some(6.0);

        let command = import_command_from_probe("clip.mp4", "/tmp/clip.mp4", Some(&outlasting));
        assert_eq!(command.asset.duration_sec, Some(4.0));
        assert_eq!(command.asset.audio_duration_sec, Some(6.0));

        // Streams of the same length say nothing the picture's length does not,
        // so there is no second reading to carry.
        let matched = media_info(4.0);
        assert_eq!(
            import_command_from_probe("clip.mp4", "/tmp/clip.mp4", Some(&matched))
                .asset
                .audio_duration_sec,
            None
        );

        // An audio asset's own `durationSec` already measures what it plays.
        let mut voice = media_info(6.0);
        voice.video = None;
        voice.video_duration_sec = None;
        assert_eq!(
            import_command_from_probe("voice.mp4", "/tmp/voice.mp4", Some(&voice))
                .asset
                .audio_duration_sec,
            None
        );
    }

    #[test]
    fn should_back_fill_the_sound_length_through_an_update_command() {
        let mut info = media_info(6.0);
        info.video_duration_sec = Some(4.0);
        info.audio_duration_sec = Some(6.0);

        let command = update_command_from_probe("asset-1", &AssetKind::Video, &info);

        assert_eq!(command.duration_sec, Some(Some(4.0)));
        assert_eq!(command.audio_duration_sec, Some(Some(6.0)));
    }

    /// A project holding a 4s-picture / 6s-sound asset placed on both kinds of
    /// track. Returns the state, the sequence, and the `(track, clip)` pair for
    /// the picture and then for the sound.
    #[allow(clippy::type_complexity)]
    fn state_with_mixed_length_asset() -> (ProjectState, String, (String, String), (String, String))
    {
        use crate::core::commands::{AddTrackCommand, Command, InsertClipCommand};

        let mut state = ProjectState::new("Media Bound Test");
        let sequence_id = state
            .active_sequence_id
            .clone()
            .expect("a new project has an active sequence");

        let mut info = media_info(6.0);
        info.video_duration_sec = Some(4.0);
        info.audio_duration_sec = Some(6.0);
        // The asset the probe would have recorded, placed directly: this test
        // is about the bound, not about the import command's path validation.
        let asset = import_command_from_probe("clip.mp4", "/tmp/clip.mp4", Some(&info)).asset;
        let asset_id = asset.id.clone();
        state.assets.insert(asset_id.clone(), asset);

        let mut placements = Vec::new();
        for kind in [TrackKind::Video, TrackKind::Audio] {
            let mut add = AddTrackCommand::new(&sequence_id, "Bound", kind);
            let track_id = add
                .execute(&mut state)
                .expect("the track must be added")
                .created_ids
                .first()
                .cloned()
                .expect("AddTrack reports its track");

            let mut insert = InsertClipCommand::new(&sequence_id, &track_id, &asset_id, 0.0)
                .with_source_range(0.0, 4.0);
            let clip_id = insert
                .execute(&mut state)
                .expect("the clip must be placed")
                .created_ids
                .first()
                .cloned()
                .expect("InsertClip reports its clip");
            placements.push((track_id, clip_id));
        }

        (
            state,
            sequence_id,
            placements[0].clone(),
            placements[1].clone(),
        )
    }

    #[test]
    fn should_bound_a_clip_by_the_stream_its_own_track_plays() {
        let (
            state,
            sequence_id,
            (picture_track_id, picture_clip_id),
            (sound_track_id, sound_clip_id),
        ) = state_with_mixed_length_asset();

        // The sound runs to 6s, so the clip on the audio track may reach it.
        assert!(
            ensure_source_out_within_media(
                &state,
                &sequence_id,
                &sound_track_id,
                &sound_clip_id,
                Some(6.0)
            )
            .is_ok(),
            "an audio clip is bounded by the sound, not by the picture it was split away from"
        );
        // The pictures stop at 4s, and a clip on a video track stops with them.
        assert!(
            ensure_source_out_within_media(
                &state,
                &sequence_id,
                &picture_track_id,
                &picture_clip_id,
                Some(6.0)
            )
            .is_err(),
            "a picture clip cannot reach past the last frame the file holds"
        );
        // Neither may reach past the sound.
        assert!(ensure_source_out_within_media(
            &state,
            &sequence_id,
            &sound_track_id,
            &sound_clip_id,
            Some(9.0)
        )
        .is_err());
    }

    #[test]
    fn should_refuse_a_named_track_that_does_not_hold_the_clip() {
        let (state, sequence_id, (picture_track_id, picture_clip_id), (sound_track_id, _)) =
            state_with_mixed_length_asset();

        // Naming a track the clip is not on is `ClipNotFound` here because it
        // is `ClipNotFound` in `TrimClipCommand`. Measuring the clip on
        // whichever track *did* hold it made `plan validate` and `plan execute`
        // refuse the same step for different reasons.
        let error = ensure_source_out_within_media(
            &state,
            &sequence_id,
            &sound_track_id,
            &picture_clip_id,
            // Within the sound's 6s, so only the track mismatch can refuse it.
            Some(6.0),
        )
        .expect_err("a track that does not hold the clip is not this clip's track");
        assert!(
            matches!(&error, CoreError::ClipNotFound(id) if id == &picture_clip_id),
            "expected ClipNotFound, got {error:?}"
        );

        // A track the sequence does not have at all is `TrackNotFound`, again
        // mirroring the command.
        let error = ensure_source_out_within_media(
            &state,
            &sequence_id,
            "no-such-track",
            &picture_clip_id,
            Some(6.0),
        )
        .expect_err("a track the sequence does not have cannot hold the clip");
        assert!(
            matches!(&error, CoreError::TrackNotFound(id) if id == "no-such-track"),
            "expected TrackNotFound, got {error:?}"
        );

        // A clip that is nowhere in the sequence stays the command's error to
        // report, not this guard's.
        assert!(ensure_source_out_within_media(
            &state,
            &sequence_id,
            &picture_track_id,
            "no-such-clip",
            Some(600.0)
        )
        .is_ok());
    }

    #[test]
    fn should_refuse_a_wrong_track_trim_that_moves_only_the_source_in() {
        let (state, sequence_id, (picture_track_id, picture_clip_id), (sound_track_id, _)) =
            state_with_mixed_length_asset();

        // A trim that only pulls `sourceIn` in carries no `newSourceOut`, and
        // the guard used to return `Ok` on that before it had resolved the
        // track at all — so the wrong-track refusal held on whichever surface
        // happened to send both fields and not on the one that sent one.
        let error = ensure_source_out_within_media(
            &state,
            &sequence_id,
            &sound_track_id,
            &picture_clip_id,
            None,
        )
        .expect_err("a track that does not hold the clip is refused with or without a bound");
        assert!(
            matches!(&error, CoreError::ClipNotFound(id) if id == &picture_clip_id),
            "expected ClipNotFound, got {error:?}"
        );

        let error = ensure_source_out_within_media(
            &state,
            &sequence_id,
            "no-such-track",
            &picture_clip_id,
            None,
        )
        .expect_err("a track the sequence does not have is refused with or without a bound");
        assert!(
            matches!(&error, CoreError::TrackNotFound(id) if id == "no-such-track"),
            "expected TrackNotFound, got {error:?}"
        );

        // The track that does hold the clip still passes: there is no bound to
        // measure, and moving `sourceIn` alone can never reach past the media.
        assert!(ensure_source_out_within_media(
            &state,
            &sequence_id,
            &picture_track_id,
            &picture_clip_id,
            None
        )
        .is_ok());

        // And a clip that is nowhere in the sequence is still the command's
        // error to report rather than this guard's.
        assert!(ensure_source_out_within_media(
            &state,
            &sequence_id,
            &picture_track_id,
            "no-such-clip",
            None
        )
        .is_ok());
    }

    /// A project holding one asset that points at a real file nothing measured.
    ///
    /// The file's contents do not matter — every test here supplies its own
    /// probe reading — but it has to exist, because an asset whose file cannot
    /// be located has nothing to re-read.
    fn project_with_unmeasured_asset(
        name: &str,
    ) -> (tempfile::TempDir, crate::ActiveProject, String) {
        let temp_dir = tempfile::TempDir::new().expect("a temp dir");
        let project_path = temp_dir.path().join(name);
        let mut project =
            crate::ActiveProject::create(name, project_path).expect("the project must be created");

        let media_path = temp_dir.path().join("legacy.mp4");
        std::fs::write(&media_path, b"not really a video").expect("the media file must be written");

        // The asset an `--no-probe` import records: a real file, no duration,
        // and no probe marker.
        let asset = crate::core::assets::Asset::new_video(
            "legacy",
            &media_path.to_string_lossy(),
            VideoInfo::default(),
        );
        let asset_id = asset.id.clone();
        project.state.assets.insert(asset_id.clone(), asset);

        (temp_dir, project, asset_id)
    }

    #[test]
    fn should_probe_an_unmeasured_asset_once_and_leave_it_alone_after() {
        let (_temp_dir, mut project, asset_id) =
            project_with_unmeasured_asset("measure_once_project");

        let mut info = media_info(6.0);
        info.video_duration_sec = Some(4.0);
        info.audio_duration_sec = Some(6.0);

        let warnings = ensure_asset_measured(&mut project, &asset_id, |_| Ok(info))
            .expect("the reading must be recorded");
        assert_eq!(
            warnings.len(),
            1,
            "an unmeasured asset is reported: {warnings:?}"
        );

        let asset = project.state.assets.get(&asset_id).expect("the asset");
        assert_eq!(
            asset.duration_sec,
            Some(4.0),
            "the picture bounds the asset"
        );
        assert_eq!(
            asset.audio_duration_sec,
            Some(6.0),
            "the sound is recorded beside it"
        );
        assert_eq!(asset.probe_version, Some(ASSET_PROBE_VERSION));

        // The marker is what stops the next placement paying for the same
        // reading again, so the second call must not reach the probe at all.
        let warnings = ensure_asset_measured(&mut project, &asset_id, |_| {
            panic!("a measured asset must not be probed again")
        })
        .expect("a measured asset is a no-op");
        assert!(warnings.is_empty(), "nothing to report: {warnings:?}");
    }

    #[test]
    fn should_stamp_the_probe_marker_even_when_the_reading_held_no_duration() {
        let (_temp_dir, mut project, asset_id) =
            project_with_unmeasured_asset("unmeasurable_project");

        // A container FFprobe read but could not measure: `0` is what it
        // answers for a file whose length it cannot work out.
        let mut info = media_info(0.0);
        info.video_duration_sec = None;
        info.audio_duration_sec = None;

        let warnings = ensure_asset_measured(&mut project, &asset_id, |_| Ok(info))
            .expect("the reading must be recorded");
        assert_eq!(
            warnings.len(),
            1,
            "the caller is told the clip takes the default length: {warnings:?}"
        );

        let asset = project.state.assets.get(&asset_id).expect("the asset");
        assert_eq!(asset.duration_sec, None, "nothing usable was measured");
        assert_eq!(
            asset.probe_version,
            Some(ASSET_PROBE_VERSION),
            "the file was still read under the current rules"
        );

        // Without the marker this file was re-probed before every placement,
        // forever, and never got any further.
        let warnings = ensure_asset_measured(&mut project, &asset_id, |_| {
            panic!("an asset already read under these rules must not be probed again")
        })
        .expect("a read asset is a no-op");
        assert!(warnings.is_empty(), "nothing to report: {warnings:?}");
    }

    #[test]
    fn should_leave_an_asset_untouched_when_the_probe_could_not_run() {
        let (_temp_dir, mut project, asset_id) = project_with_unmeasured_asset("failed_probe");

        let warnings = ensure_asset_measured(&mut project, &asset_id, |_| {
            Err("FFmpeg is missing".to_string())
        })
        .expect("a probe that cannot run is not a failure");
        assert_eq!(warnings.len(), 1, "the caller is warned: {warnings:?}");

        let asset = project.state.assets.get(&asset_id).expect("the asset");
        assert_eq!(
            asset.probe_version, None,
            "nothing read the file, so nothing is stamped"
        );
        assert!(
            asset_needs_measurement(asset),
            "a failed reading must leave the asset open to being read again"
        );
    }

    #[test]
    fn should_name_a_source_out_the_same_guard_would_accept() {
        use crate::core::commands::{Command, InsertClipCommand};

        // 100 NTSC frames: 3.336667s, which `{:.3}` rounds *up* to 3.337. The
        // refusal used to name that, and 3.337 was itself refused.
        let ntsc_duration_sec = 100.0 * 1001.0 / 30_000.0;
        let mut state = ProjectState::new("NTSC Bound Test");
        let sequence_id = state
            .active_sequence_id
            .clone()
            .expect("a new project has an active sequence");
        let track_id = state
            .sequences
            .get(&sequence_id)
            .expect("the active sequence")
            .tracks
            .iter()
            .find(|track| matches!(track.kind, TrackKind::Video))
            .expect("a video track")
            .id
            .clone();

        let mut info = media_info(ntsc_duration_sec);
        info.audio = None;
        info.video_duration_sec = Some(ntsc_duration_sec);
        let asset = import_command_from_probe("ntsc.mp4", "/tmp/ntsc.mp4", Some(&info)).asset;
        let asset_id = asset.id.clone();
        state.assets.insert(asset_id.clone(), asset);

        let mut insert = InsertClipCommand::new(&sequence_id, &track_id, &asset_id, 0.0)
            .with_source_range(0.0, 1.0);
        let clip_id = insert
            .execute(&mut state)
            .expect("the clip must be placed")
            .created_ids
            .first()
            .cloned()
            .expect("InsertClip reports its clip");

        let error =
            ensure_source_out_within_media(&state, &sequence_id, &track_id, &clip_id, Some(9.0))
                .expect_err("nine seconds is past the media")
                .to_string();
        assert!(
            error.contains("3.336"),
            "the refusal must name a floored length, got: {error}"
        );

        // Both the number the message names and the frame-grid slack the
        // renderer allows are accepted, so a caller who follows the
        // instruction — or who cuts on the output frame grid — gets through.
        for accepted in [3.336, 3.337] {
            assert!(
                ensure_source_out_within_media(
                    &state,
                    &sequence_id,
                    &track_id,
                    &clip_id,
                    Some(accepted)
                )
                .is_ok(),
                "{accepted} must be accepted"
            );
        }
    }

    // =========================================================================
    // Off-lock measurement passes
    // =========================================================================

    /// A project holding one asset nothing has read, backed by a real file.
    fn state_with_unmeasured_asset(root: &Path) -> (ProjectState, String) {
        let mut state = ProjectState::new("Unmeasured Test");
        let media = root.join("clip.mp4");
        std::fs::write(&media, b"not really an mp4").expect("the fixture file must be written");

        let asset = Asset::new_video("clip.mp4", &media.to_string_lossy(), VideoInfo::default());
        assert!(
            asset_needs_measurement(&asset),
            "an asset with no probe marker is what this pass exists to find"
        );
        let asset_id = asset.id.clone();
        state.assets.insert(asset_id.clone(), asset);
        (state, asset_id)
    }

    /// Feature: reading a placement's asset off the project lock
    /// Scenario: the same unread asset is placed five times in one plan
    ///   Given a plan that inserts five clips cut from one unread asset
    ///   When the collect pass picks out what has to be read
    ///   Then the asset is listed once, with the file it resolves to
    ///
    /// Each probe carries a two-minute watchdog, so a repeated asset costing a
    /// probe apiece is the difference between one wait and five.
    #[test]
    fn should_list_a_repeated_asset_once() {
        let dir = tempfile::tempdir().expect("a temp project root");
        let (state, asset_id) = state_with_unmeasured_asset(dir.path());

        let targets = collect_unmeasured_assets(
            &state,
            dir.path(),
            std::iter::repeat_n(asset_id.as_str(), 5),
        );

        assert_eq!(targets.len(), 1, "one asset is one probe");
        assert_eq!(targets[0].asset_id, asset_id);
        assert_eq!(
            targets[0].source_path,
            Some(dir.path().join("clip.mp4")),
            "the path is resolved under the lock, so the probe needs none"
        );
    }

    /// An asset already read under the current rules, a still (which has no
    /// length to measure), and an id the project does not hold are all left
    /// alone — so the ordinary edit, where everything is measured, releases no
    /// lock and pays for no probe.
    #[test]
    fn should_list_nothing_when_every_named_asset_is_already_measured() {
        let dir = tempfile::tempdir().expect("a temp project root");
        let (mut state, measured_id) = state_with_unmeasured_asset(dir.path());
        state
            .assets
            .get_mut(&measured_id)
            .expect("the fixture asset")
            .probe_version = Some(ASSET_PROBE_VERSION);

        let still = Asset::new_image("frame.png", "/nowhere/frame.png", 1920, 1080);
        let still_id = still.id.clone();
        state.assets.insert(still_id.clone(), still);

        let targets = collect_unmeasured_assets(
            &state,
            dir.path(),
            [measured_id.as_str(), still_id.as_str(), "no-such-asset"],
        );

        assert!(
            targets.is_empty(),
            "nothing to read means the caller never releases the project lock"
        );
    }

    /// An asset whose file is gone is still listed, carrying no path: the
    /// placement is not refused over a missing measurement, and the apply pass
    /// names the absence better than the collect pass could.
    #[test]
    fn should_list_an_unmeasured_asset_whose_file_is_missing_with_no_path() {
        let dir = tempfile::tempdir().expect("a temp project root");
        let mut state = ProjectState::new("Missing File Test");
        let asset = Asset::new_video("gone.mp4", "/nowhere/gone.mp4", VideoInfo::default());
        let asset_id = asset.id.clone();
        state.assets.insert(asset_id.clone(), asset);

        let targets = collect_unmeasured_assets(&state, dir.path(), [asset_id.as_str()]);

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].source_path, None);
    }

    /// Feature: readings are recorded against the project they were decided for
    /// Scenario: the operator swaps projects while the assets are read
    ///   Given a caller that decided what to probe against project A
    ///   When project B is open by the time the readings come back
    ///   Then recording them is refused
    ///
    /// B has its own ops-log watermark, so the external-change check passes,
    /// and an asset id both projects hold would take an `UpdateAsset` derived
    /// from A's paths — appended to B's log behind nothing at all.
    #[test]
    fn should_refuse_to_record_readings_against_a_project_that_was_swapped() {
        let decided_against = ProjectState::new("Project A");
        let now_open = ProjectState::new("Project B");
        assert_ne!(
            decided_against.meta.id, now_open.meta.id,
            "two projects are two identities"
        );

        assert_eq!(
            ensure_probed_project_unchanged(&decided_against, &decided_against.meta.id),
            Ok(()),
            "the ordinary path is the same project coming back"
        );
        assert_eq!(
            ensure_probed_project_unchanged(&now_open, &decided_against.meta.id),
            Err(PROJECT_CHANGED_DURING_PROBE.to_string())
        );
    }

    /// Feature: the probe batch must not park FFmpeg's other readers
    /// Scenario: the runner is taken out of the shared state
    ///   Given the shared FFmpeg state
    ///   When the batch takes the runner it is about to probe with
    ///   Then the read lock is already free
    ///
    /// The batch used to hold this guard for its whole run, because the runner
    /// was borrowed from it. Tokio's `RwLock` is write-preferring, so one
    /// queued `initialize_shared_ffmpeg` writer then parked every later FFmpeg
    /// reader behind a batch that can take two minutes per asset. The owned
    /// return type is what makes that unwritable; this pins the behaviour.
    #[tokio::test]
    async fn should_release_the_ffmpeg_read_lock_when_the_runner_is_taken() {
        let ffmpeg_state = crate::core::ffmpeg::create_ffmpeg_state();

        let runner = ffmpeg_runner_snapshot(&ffmpeg_state).await;

        assert!(runner.is_none(), "nothing initialised this state");
        assert!(
            ffmpeg_state.try_write().is_ok(),
            "a writer must not be made to wait on the batch that follows"
        );
    }

    /// Feature: reading a placement's asset off the project lock
    /// Scenario: FFmpeg could not be resolved on this machine
    ///   Given a batch of one asset with a file and one without
    ///   When the probe pass runs with no runner available
    ///   Then each asset comes back in order, the one with a file carrying the
    ///   reason it was not read and the one without carrying no attempt
    ///
    /// A probe that cannot run must not fail the edit: the placement is still
    /// valid, it just takes the default length.
    #[tokio::test]
    async fn should_carry_an_unresolvable_ffmpeg_as_a_reason_rather_than_a_failure() {
        let ffmpeg_state = crate::core::ffmpeg::create_ffmpeg_state();
        let targets = vec![
            UnmeasuredAsset {
                asset_id: "with-file".to_string(),
                source_path: Some(PathBuf::from("/nowhere/clip.mp4")),
            },
            UnmeasuredAsset {
                asset_id: "without-file".to_string(),
                source_path: None,
            },
        ];

        let measurements = probe_unmeasured_assets(targets, &ffmpeg_state).await;

        assert_eq!(
            measurements
                .iter()
                .map(|measurement| measurement.asset_id.as_str())
                .collect::<Vec<_>>(),
            ["with-file", "without-file"],
            "every asset comes back, in the order it was collected"
        );
        let reason = measurements[0]
            .probed
            .as_ref()
            .expect("a file was there to read")
            .as_ref()
            .expect_err("no runner could read it");
        assert!(
            reason.contains("FFmpeg could not be resolved"),
            "unexpected reason: {reason}"
        );
        assert!(
            measurements[1].probed.is_none(),
            "no file means no probe was attempted"
        );
        assert!(
            ffmpeg_state.try_write().is_ok(),
            "the batch leaves no reader behind"
        );
    }

    /// Nothing to read is the ordinary case, and it must not even touch the
    /// FFmpeg lock — the caller has not released the project lock for it, so a
    /// writer holding the FFmpeg state cannot stall it.
    #[tokio::test]
    async fn should_probe_nothing_when_no_asset_needs_reading() {
        let ffmpeg_state = crate::core::ffmpeg::create_ffmpeg_state();
        let held = ffmpeg_state.write().await;

        let measurements = probe_unmeasured_assets(Vec::new(), &ffmpeg_state).await;

        assert!(measurements.is_empty());
        drop(held);
    }
}

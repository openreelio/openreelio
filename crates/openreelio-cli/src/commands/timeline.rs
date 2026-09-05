//! Timeline editing commands: insert, move, trim, split, speed, tracks, effects.

use crate::media_probe;
use crate::output;
use crate::validate;
use clap::Subcommand;
use openreelio_core::assets::AssetKind;
use openreelio_core::commands::*;
use openreelio_core::ActiveProject;
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum TimelineAction {
    /// Display timeline information
    Info {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// List all clips in the timeline
    Clips {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,

        /// Filter by track ID
        #[arg(long)]
        track: Option<String>,
    },

    /// List all tracks in the timeline
    Tracks {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Insert a clip onto the timeline
    Insert {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Asset ID to insert
        #[arg(long)]
        asset: String,

        /// Track ID to insert onto
        #[arg(long)]
        track: String,

        /// Timeline position in seconds
        #[arg(long)]
        at: f64,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Remove a clip from the timeline
    Remove {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Clip ID to remove
        #[arg(long)]
        clip: String,

        /// Track ID containing the clip
        #[arg(long)]
        track: String,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Move a clip to a new position
    Move {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Clip ID to move
        #[arg(long)]
        clip: String,

        /// New timeline position in seconds
        #[arg(long)]
        to: f64,

        /// Current track ID
        #[arg(long)]
        track: String,

        /// Target track ID (for cross-track moves)
        #[arg(long)]
        new_track: Option<String>,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Trim a clip's in/out points
    Trim {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Clip ID to trim
        #[arg(long)]
        clip: String,

        /// Track ID containing the clip
        #[arg(long)]
        track: String,

        /// New source in point (seconds)
        #[arg(long, name = "in")]
        source_in: Option<f64>,

        /// New source out point (seconds)
        #[arg(long, name = "out")]
        source_out: Option<f64>,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Split a clip at a specific position
    Split {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Clip ID to split
        #[arg(long)]
        clip: String,

        /// Track ID containing the clip
        #[arg(long)]
        track: String,

        /// Split position in seconds (timeline time)
        #[arg(long)]
        at: f64,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Change clip playback speed
    Speed {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Clip ID
        #[arg(long)]
        clip: String,

        /// Track ID
        #[arg(long)]
        track: String,

        /// Speed multiplier (e.g. 2.0 for 2x)
        #[arg(long)]
        speed: f32,

        /// Reverse playback
        #[arg(long, default_value = "false")]
        reverse: bool,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Add a new track to the timeline
    AddTrack {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Track type: video or audio
        #[arg(long)]
        kind: String,

        /// Track name
        #[arg(long)]
        name: String,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Change the sequence delivery format (frame rate, canvas, audio)
    ///
    /// Every option is optional and at least one must be given; the rest keep
    /// their current value. Changing the frame rate re-times nothing — the
    /// timeline is stored in seconds — and changing the canvas leaves clip
    /// transforms alone, because they are canvas-relative.
    SetFormat {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Frame rate, e.g. 25, 29.97, 23.976 (decimals snap to the exact
        /// broadcast rational: 29.97 becomes 30000/1001)
        #[arg(long)]
        fps: Option<f64>,

        /// Canvas width in pixels (even, 16..=16384)
        #[arg(long)]
        width: Option<u32>,

        /// Canvas height in pixels (even, 16..=16384)
        #[arg(long)]
        height: Option<u32>,

        /// Audio sample rate in Hz, e.g. 48000
        #[arg(long)]
        audio_sample_rate: Option<u32>,

        /// Audio channel count (1 or 2)
        #[arg(long)]
        audio_channels: Option<u8>,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Remove a track from the timeline
    RemoveTrack {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Track ID to remove
        #[arg(long)]
        track: String,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,
    },

    /// Undo the last operation
    Undo {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,
    },

    /// Redo the last undone operation
    Redo {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,
    },
}

pub fn execute(action: TimelineAction) -> anyhow::Result<()> {
    match action {
        TimelineAction::Info { path, sequence } => {
            let project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let seq = project
                .state
                .sequences
                .get(&seq_id)
                .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", seq_id))?;

            let tracks: Vec<serde_json::Value> = seq
                .tracks
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "id": t.id,
                        "name": t.name,
                        "kind": format!("{:?}", t.kind),
                        "clipCount": t.clips.len(),
                    })
                })
                .collect();

            // The inspection summary answers "where do I look" — duration,
            // frame rate, cut times, marker times, transition spans and the
            // caption/text spans — so an agent stops reconstructing those from
            // `timeline clips` by hand. It is merged alongside the existing
            // keys, never in place of them.
            let summary =
                openreelio_core::timeline::inspection_summary(seq, &project.state.effects);
            let mut info = serde_json::json!({
                "sequenceId": seq_id,
                "name": seq.name,
                "tracks": tracks,
                "trackCount": seq.tracks.len(),
            });
            merge_summary(&mut info, &summary)?;

            output::print_json_pretty(&info)
        }

        TimelineAction::Clips {
            path,
            sequence,
            track,
        } => {
            let project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let seq = project
                .state
                .sequences
                .get(&seq_id)
                .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", seq_id))?;

            let mut clips = Vec::new();
            for t in &seq.tracks {
                if let Some(ref filter_track) = track {
                    if &t.id != filter_track {
                        continue;
                    }
                }
                for c in &t.clips {
                    clips.push(serde_json::json!({
                        "id": c.id,
                        "trackId": t.id,
                        "assetId": c.asset_id,
                        "timelineInSec": c.place.timeline_in_sec,
                        "durationSec": c.place.duration_sec,
                        "sourceInSec": c.range.source_in_sec,
                        "sourceOutSec": c.range.source_out_sec,
                        "speed": c.speed,
                    }));
                }
            }

            output::print_json_pretty(&serde_json::json!({
                "sequenceId": seq_id,
                "clips": clips,
                "count": clips.len(),
            }))
        }

        TimelineAction::Tracks { path, sequence } => {
            let project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let seq = project
                .state
                .sequences
                .get(&seq_id)
                .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", seq_id))?;

            let tracks: Vec<serde_json::Value> = seq
                .tracks
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "id": t.id,
                        "name": t.name,
                        "kind": format!("{:?}", t.kind),
                        "clipCount": t.clips.len(),
                        "muted": t.muted,
                        "locked": t.locked,
                    })
                })
                .collect();

            output::print_json_pretty(&serde_json::json!({
                "sequenceId": seq_id,
                "tracks": tracks,
                "count": tracks.len(),
            }))
        }

        TimelineAction::Insert {
            path,
            asset,
            track,
            at,
            sequence,
        } => {
            validate::non_empty(&asset, "asset")?;
            validate::non_empty(&track, "track")?;
            validate::time_non_negative(at, "at")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            // Delegate to the canonical composite InsertMedia command so the CLI
            // gets drag-and-drop parity (linked-audio extraction for video assets
            // that carry audio) instead of re-implementing a bare single-clip
            // insert. For audio-less assets this behaves identically to a plain
            // clip insert.
            // An asset imported before probing existed — or with `--no-probe`
            // — carries no duration, and an insert with no duration falls back
            // to a default length whatever the media is. Measuring it here, and
            // recording the measurement through a command, is what keeps a
            // four-second file from becoming a ten-second clip.
            let mut warnings = back_fill_asset_duration(&mut project, &asset)?;

            let cmd = InsertMediaCommand::new(&seq_id, &track, &asset, at);
            let mut edit = super::EditRecorder::begin(&project, &seq_id);
            let result = edit
                .execute(&mut project, Box::new(cmd))
                .map_err(|e| anyhow::anyhow!("Insert failed: {}", e))?;
            let affected_ranges = edit.finish(&mut project)?;

            warnings.extend(inserted_clip_warnings(
                &project,
                &seq_id,
                &asset,
                &result.created_ids,
            ));

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
                "sequenceId": seq_id,
                "affectedRanges": affected_ranges,
                "warnings": warnings,
            }))
        }

        TimelineAction::Remove {
            path,
            clip,
            track,
            sequence,
        } => {
            validate::non_empty(&clip, "clip")?;
            validate::non_empty(&track, "track")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let cmd = RemoveClipCommand::new(&seq_id, &track, &clip);
            let mut edit = super::EditRecorder::begin(&project, &seq_id);
            let result = edit
                .execute(&mut project, Box::new(cmd))
                .map_err(|e| anyhow::anyhow!("Remove failed: {}", e))?;
            let affected_ranges = edit.finish(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "deletedIds": result.deleted_ids,
                "sequenceId": seq_id,
                "affectedRanges": affected_ranges,
            }))
        }

        TimelineAction::Move {
            path,
            clip,
            to,
            track,
            new_track,
            sequence,
        } => {
            validate::non_empty(&clip, "clip")?;
            validate::non_empty(&track, "track")?;
            if let Some(ref nt) = new_track {
                validate::non_empty(nt, "new-track")?;
            }
            validate::time_non_negative(to, "to")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let mut cmd = MoveClipCommand::new(&seq_id, &track, &clip, to, None);
            if let Some(ref target_track) = new_track {
                cmd = cmd.to_track(target_track);
            }
            let mut edit = super::EditRecorder::begin(&project, &seq_id);
            let result = edit
                .execute(&mut project, Box::new(cmd))
                .map_err(|e| anyhow::anyhow!("Move failed: {}", e))?;
            let affected_ranges = edit.finish(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "sequenceId": seq_id,
                "affectedRanges": affected_ranges,
            }))
        }

        TimelineAction::Trim {
            path,
            clip,
            track,
            source_in,
            source_out,
            sequence,
        } => {
            validate::non_empty(&clip, "clip")?;
            validate::non_empty(&track, "track")?;
            validate::trim_points_ordered(source_in, source_out)?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            // Trimming past the end of the media is how a clip that renders as
            // black gets made by hand; refusing it here names the length the
            // caller should have asked for.
            reject_source_out_past_media(&project, &seq_id, &clip, source_out)?;
            let cmd = TrimClipCommand::new(
                &seq_id, &track, &clip, source_in, source_out, None, // timeline_in
            );
            let mut edit = super::EditRecorder::begin(&project, &seq_id);
            let result = edit
                .execute(&mut project, Box::new(cmd))
                .map_err(|e| anyhow::anyhow!("Trim failed: {}", e))?;
            let affected_ranges = edit.finish(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "sequenceId": seq_id,
                "affectedRanges": affected_ranges,
            }))
        }

        TimelineAction::Split {
            path,
            clip,
            track,
            at,
            sequence,
        } => {
            validate::non_empty(&clip, "clip")?;
            validate::non_empty(&track, "track")?;
            validate::time_non_negative(at, "at")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let cmd = SplitClipCommand::new(&seq_id, &track, &clip, at);
            let mut edit = super::EditRecorder::begin(&project, &seq_id);
            let result = edit
                .execute(&mut project, Box::new(cmd))
                .map_err(|e| anyhow::anyhow!("Split failed: {}", e))?;
            let affected_ranges = edit.finish(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
                "sequenceId": seq_id,
                "affectedRanges": affected_ranges,
            }))
        }

        TimelineAction::Speed {
            path,
            clip,
            track,
            speed,
            reverse,
            sequence,
        } => {
            validate::non_empty(&clip, "clip")?;
            validate::non_empty(&track, "track")?;
            validate::speed_positive(speed)?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let cmd = SetClipSpeedCommand::new(&seq_id, &track, &clip, speed, reverse);
            let mut edit = super::EditRecorder::begin(&project, &seq_id);
            let result = edit
                .execute(&mut project, Box::new(cmd))
                .map_err(|e| anyhow::anyhow!("Set speed failed: {}", e))?;
            let affected_ranges = edit.finish(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "sequenceId": seq_id,
                "affectedRanges": affected_ranges,
            }))
        }

        TimelineAction::AddTrack {
            path,
            kind,
            name,
            sequence,
        } => {
            validate::non_empty(&name, "name")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let track_kind = match kind.to_lowercase().as_str() {
                "video" => openreelio_core::timeline::TrackKind::Video,
                "audio" => openreelio_core::timeline::TrackKind::Audio,
                "caption" => openreelio_core::timeline::TrackKind::Caption,
                "overlay" => openreelio_core::timeline::TrackKind::Overlay,
                _ => {
                    return Err(anyhow::anyhow!(
                        "Unknown track kind '{}'. Use: video, audio, caption, overlay",
                        kind
                    ))
                }
            };
            let cmd = AddTrackCommand::new(&seq_id, &name, track_kind);
            let mut edit = super::EditRecorder::begin(&project, &seq_id);
            let result = edit
                .execute(&mut project, Box::new(cmd))
                .map_err(|e| anyhow::anyhow!("Add track failed: {}", e))?;
            let affected_ranges = edit.finish(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "createdIds": result.created_ids,
                "sequenceId": seq_id,
                "affectedRanges": affected_ranges,
            }))
        }

        TimelineAction::RemoveTrack {
            path,
            track,
            sequence,
        } => {
            validate::non_empty(&track, "track")?;
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let cmd = RemoveTrackCommand::new(&seq_id, &track);
            let mut edit = super::EditRecorder::begin(&project, &seq_id);
            let result = edit
                .execute(&mut project, Box::new(cmd))
                .map_err(|e| anyhow::anyhow!("Remove track failed: {}", e))?;
            let affected_ranges = edit.finish(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": result.op_id,
                "deletedIds": result.deleted_ids,
                "sequenceId": seq_id,
                "affectedRanges": affected_ranges,
            }))
        }

        TimelineAction::SetFormat {
            path,
            fps,
            width,
            height,
            audio_sample_rate,
            audio_channels,
            sequence,
        } => {
            let request = SequenceFormatRequest {
                fps,
                width,
                height,
                audio_sample_rate,
                audio_channels,
            };
            let mut project = super::load_project(&path)?;
            let seq_id = super::resolve_sequence_id(&project, sequence)?;
            let outcome = apply_sequence_format(&mut project, &seq_id, &request)?;
            output::print_json(&outcome)
        }

        TimelineAction::Undo { path } => {
            let mut project = super::load_project(&path)?;
            let op_id = project
                .undo_persisted()
                .map_err(|e| anyhow::anyhow!("Undo failed: {}", e))?;
            super::save_project(&mut project)?;
            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": op_id,
            }))
        }

        TimelineAction::Redo { path } => {
            let mut project = super::load_project(&path)?;
            let op_id = project
                .redo_persisted()
                .map_err(|e| anyhow::anyhow!("Redo failed: {}", e))?;
            super::save_project(&mut project)?;

            output::print_json(&serde_json::json!({
                "status": "ok",
                "opId": op_id,
            }))
        }
    }
}

/// The delivery-format fields a caller asked to change.
///
/// Shared by `timeline set-format` and `project create`, so a project created
/// at 25fps and one retimed to 25fps go through exactly the same command and
/// the same validation.
#[derive(Debug, Default)]
pub(crate) struct SequenceFormatRequest {
    /// Frame rate as a decimal; snapped to an exact rational by the command.
    pub(crate) fps: Option<f64>,
    /// Canvas width in pixels.
    pub(crate) width: Option<u32>,
    /// Canvas height in pixels.
    pub(crate) height: Option<u32>,
    /// Audio sample rate in Hz.
    pub(crate) audio_sample_rate: Option<u32>,
    /// Audio channel count.
    pub(crate) audio_channels: Option<u8>,
}

impl SequenceFormatRequest {
    /// True when the caller asked for no change at all.
    pub(crate) fn is_empty(&self) -> bool {
        self.fps.is_none()
            && self.width.is_none()
            && self.height.is_none()
            && self.audio_sample_rate.is_none()
            && self.audio_channels.is_none()
    }
}

/// Applies a format change as a logged, undoable command and reports the result.
///
/// Routed through [`super::EditRecorder`] like every other mutating verb, so
/// `affectedRanges` is populated: a frame rate or canvas change re-quantises and
/// re-fits the whole timeline, which is why the recorder reports the entire
/// sequence rather than a clip-sized window.
pub(crate) fn apply_sequence_format(
    project: &mut openreelio_core::ActiveProject,
    sequence_id: &str,
    request: &SequenceFormatRequest,
) -> anyhow::Result<serde_json::Value> {
    let mut cmd = SetSequenceFormatCommand::new().for_sequence(sequence_id);
    if let Some(fps) = request.fps {
        cmd = cmd.with_fps(openreelio_core::timeline::FpsSpec::Decimal(fps));
    }
    cmd.width = request.width;
    cmd.height = request.height;
    cmd.audio_sample_rate = request.audio_sample_rate;
    cmd.audio_channels = request.audio_channels;

    let mut edit = super::EditRecorder::begin(project, sequence_id);
    let result = edit
        .execute(project, Box::new(cmd))
        .map_err(|e| anyhow::anyhow!("Set format failed: {}", e))?;
    let affected_ranges = edit.finish(project)?;

    let format = project
        .state
        .sequences
        .get(sequence_id)
        .map(|sequence| sequence.format.clone())
        .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", sequence_id))?;

    Ok(serde_json::json!({
        "status": "ok",
        "opId": result.op_id,
        "sequenceId": sequence_id,
        "fps": format.fps.as_f64(),
        "fpsRatio": format.fps,
        "canvas": format.canvas,
        "audioSampleRate": format.audio_sample_rate,
        "audioChannels": format.audio_channels,
        "affectedRanges": affected_ranges,
    }))
}

/// Merges a serialized [`openreelio_core::timeline::InspectionSummary`] into an
/// existing JSON object.
///
/// Additive by contract: every key the summary contributes is new, so an
/// existing reader of `timeline info` keeps every field it already parsed.
fn merge_summary(
    target: &mut serde_json::Value,
    summary: &openreelio_core::timeline::InspectionSummary,
) -> anyhow::Result<()> {
    let serde_json::Value::Object(fields) = serde_json::to_value(summary)? else {
        anyhow::bail!("Inspection summary did not serialize to a JSON object");
    };
    let Some(object) = target.as_object_mut() else {
        anyhow::bail!("Timeline info payload is not a JSON object");
    };
    object.extend(fields);
    Ok(())
}

// =============================================================================
// Media-length guards
// =============================================================================

/// Slack below which a clamp is rounding rather than a change worth reporting.
const SOURCE_CLAMP_EPSILON_SEC: f64 = 1e-6;

/// Measures an asset that carries no duration, and records what it found.
///
/// The GUI probes on import, so its assets always know how long they are. An
/// asset imported headlessly before probing existed, or with `asset import
/// --no-probe`, does not — and every insert from it then falls back to a
/// default length regardless of the file, which overruns short media and
/// collides with whatever is placed after it. Correcting it through
/// `UpdateAsset` rather than by mutating the asset keeps the correction in the
/// ops log, so replaying the project reproduces it.
///
/// Returns the warnings the verb should report; a probe that cannot run is one
/// of them rather than a failure, because the insert itself is still valid.
fn back_fill_asset_duration(
    project: &mut ActiveProject,
    asset_id: &str,
) -> anyhow::Result<Vec<String>> {
    let already_known = project
        .state
        .assets
        .get(asset_id)
        .and_then(|asset| asset.duration_sec)
        .is_some_and(|duration| duration.is_finite() && duration > 0.0);
    if already_known {
        return Ok(Vec::new());
    }

    let Some(source_path) = media_probe::asset_source_path(&project.state, &project.path, asset_id)
    else {
        return Ok(vec![format!(
            "Asset '{asset_id}' records no duration and its file could not be located, so the clip takes the default length"
        )]);
    };

    let media_info = match media_probe::probe_media(&source_path) {
        Ok(info) => info,
        Err(reason) => {
            return Ok(vec![format!(
                "{reason}; asset '{asset_id}' still records no duration, so the clip takes the default length"
            )])
        }
    };

    let Some(command) = media_probe::back_fill_command(asset_id, &media_info) else {
        return Ok(vec![format!(
            "FFprobe reported no usable duration for asset '{asset_id}', so the clip takes the default length"
        )]);
    };
    let duration_sec = media_info.duration_sec;

    project
        .executor
        .execute(Box::new(command), &mut project.state)
        .map_err(|error| {
            anyhow::anyhow!("Recording the probed asset duration failed: {}", error)
        })?;

    Ok(vec![format!(
        "Asset '{asset_id}' recorded no duration; it was probed at {duration_sec:.3}s and updated before the insert"
    )])
}

/// Reports an inserted clip whose source range had to be bounded by the media.
///
/// The insert command clamps the range itself; this only says so, because a
/// clip that came out shorter than asked for is exactly the surprise an agent
/// needs to see in the response rather than discover in a render.
fn inserted_clip_warnings(
    project: &ActiveProject,
    sequence_id: &str,
    asset_id: &str,
    created_ids: &[String],
) -> Vec<String> {
    let Some(asset_duration) = project
        .state
        .assets
        .get(asset_id)
        .and_then(|asset| asset.duration_sec)
        .filter(|duration| duration.is_finite() && *duration > 0.0)
    else {
        return vec![format!(
            "Asset '{asset_id}' has no known duration, so the inserted clip takes the default length and may overrun its media"
        )];
    };

    let Some(sequence) = project.state.sequences.get(sequence_id) else {
        return Vec::new();
    };

    sequence
        .tracks
        .iter()
        .flat_map(|track| track.clips.iter())
        .filter(|clip| created_ids.iter().any(|id| id == &clip.id))
        .filter(|clip| clip.range.source_out_sec < asset_duration - SOURCE_CLAMP_EPSILON_SEC)
        .map(|clip| {
            format!(
                "Clip '{}' was clamped to the {asset_duration:.3}s of media asset '{asset_id}' holds",
                clip.id
            )
        })
        .collect()
}

/// Refuses a trim whose new out point is past the end of the media.
///
/// Nothing downstream can recover the frames such a trim asks for: the render
/// pads the missing seconds with black and the preview shows the same. Naming
/// the asset's measured length here is what lets the caller retry with a number
/// that exists.
fn reject_source_out_past_media(
    project: &ActiveProject,
    sequence_id: &str,
    clip_id: &str,
    source_out: Option<f64>,
) -> anyhow::Result<()> {
    let Some(source_out) = source_out else {
        return Ok(());
    };

    let Some(sequence) = project.state.sequences.get(sequence_id) else {
        return Ok(());
    };
    let Some(clip) = sequence
        .tracks
        .iter()
        .flat_map(|track| track.clips.iter())
        .find(|clip| clip.id == clip_id)
    else {
        return Ok(());
    };
    let Some(asset) = project.state.assets.get(&clip.asset_id) else {
        return Ok(());
    };
    // A still holds its slot however long the timeline gives it, so its source
    // window bounds nothing.
    if asset.kind == AssetKind::Image {
        return Ok(());
    }
    let Some(duration_sec) = asset
        .duration_sec
        .filter(|duration| duration.is_finite() && *duration > 0.0)
    else {
        return Ok(());
    };

    if source_out > duration_sec + SOURCE_CLAMP_EPSILON_SEC {
        anyhow::bail!(
            "Trim failed: --source-out {source_out} is past the end of asset '{}', which holds only {duration_sec:.3}s of media. Use --source-out {duration_sec:.3} or less.",
            asset.id
        );
    }

    Ok(())
}

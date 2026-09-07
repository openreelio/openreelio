//! Insert Media Command Module
//!
//! Implements the canonical composite "insert media" operation used by the
//! drag-and-drop parity path and external agent surfaces.
//!
//! Inserting media is a COMPOSITE edit: it places a primary clip on a video or
//! audio track and, when the source asset carries an audio stream, it also
//! creates (or reuses) an audio track, inserts a linked audio clip, links the
//! two clips, and mutes the video clip's audio. The whole composite is applied
//! and undone as a SINGLE history entry so that a single undo reverses every
//! sub-operation at once.

use serde::{Deserialize, Serialize};

use crate::core::{
    assets::AssetKind,
    commands::{
        asset_duration_for_track, AddTrackCommand, Command, CommandResult, InsertClipCommand,
        LinkClipsCommand, SetClipMuteCommand,
    },
    project::ProjectState,
    timeline::{Sequence, TrackKind},
    AssetId, CoreError, CoreResult, SequenceId, TimeSec, TrackId,
};

/// Default clip duration applied when the asset has no known duration and no
/// explicit source range is provided.
const DEFAULT_MEDIA_INSERT_DURATION_SEC: TimeSec = 10.0;

/// Linked-audio details produced when a composite insert created an audio clip.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedAudioInfo {
    /// Track that received the linked audio clip.
    pub track_id: TrackId,
    /// Clip ID of the linked audio clip.
    pub clip_id: AssetId,
    /// Whether a new audio track was created for the linked audio clip.
    pub created_track: bool,
}

/// Composite command: insert a clip and, when applicable, an extracted linked
/// audio clip, as a single undoable unit.
#[derive(Default)]
pub struct InsertMediaCommand {
    /// Target sequence ID.
    sequence_id: SequenceId,
    /// Target track for the primary clip.
    track_id: TrackId,
    /// Source asset ID.
    asset_id: AssetId,
    /// Timeline position to insert at.
    timeline_start: TimeSec,
    /// Optional explicit source start time.
    source_in: Option<TimeSec>,
    /// Optional explicit source end time.
    source_out: Option<TimeSec>,
    /// When true, place the asset on an audio track without preview clip.
    audio_only: bool,
    /// When true, extract a linked audio clip for video assets that have audio.
    auto_extract_linked_audio: bool,

    // --- Execution outputs (populated during execute) ---
    /// Sub-commands executed, in order, retained for undo (reversed).
    sub_commands: Vec<Box<dyn Command>>,
    /// Primary clip ID created on the target track.
    primary_clip_id: Option<AssetId>,
    /// Effective source range resolved during execution.
    resolved_source_range: Option<(TimeSec, TimeSec)>,
    /// Effective clip duration resolved during execution.
    resolved_duration_sec: TimeSec,
    /// Linked-audio details, when a linked audio clip was created.
    linked_audio: Option<LinkedAudioInfo>,
}

impl InsertMediaCommand {
    /// Creates a new insert media command targeting the given clip placement.
    pub fn new(sequence_id: &str, track_id: &str, asset_id: &str, timeline_start: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            asset_id: asset_id.to_string(),
            timeline_start,
            source_in: None,
            source_out: None,
            audio_only: false,
            auto_extract_linked_audio: true,
            sub_commands: Vec::new(),
            primary_clip_id: None,
            resolved_source_range: None,
            resolved_duration_sec: DEFAULT_MEDIA_INSERT_DURATION_SEC,
            linked_audio: None,
        }
    }

    /// Sets an explicit source range.
    pub fn with_source_range(
        mut self,
        source_in: Option<TimeSec>,
        source_out: Option<TimeSec>,
    ) -> Self {
        self.source_in = source_in;
        self.source_out = source_out;
        self
    }

    /// Marks the insert as audio-only (places a video asset onto an audio track
    /// intentionally and skips linked-audio extraction).
    pub fn with_audio_only(mut self, audio_only: bool) -> Self {
        self.audio_only = audio_only;
        self
    }

    /// Controls whether linked audio is auto-extracted for video assets.
    pub fn with_auto_extract_linked_audio(mut self, enabled: bool) -> Self {
        self.auto_extract_linked_audio = enabled;
        self
    }

    /// Returns the primary clip ID created by this command, if executed.
    pub fn primary_clip_id(&self) -> Option<&str> {
        self.primary_clip_id.as_deref()
    }

    /// Returns the resolved source range of the *primary* clip, if any.
    ///
    /// A linked audio clip is cut from the same asset but bounded by its
    /// sound's own length, which can outlast the picture — see
    /// [`Asset::audio_duration_sec`](crate::core::assets::Asset::audio_duration_sec).
    /// Read [`linked_audio`](Self::linked_audio) for that half; this range
    /// never describes it.
    pub fn resolved_source_range(&self) -> Option<(TimeSec, TimeSec)> {
        self.resolved_source_range
    }

    /// Returns the resolved clip duration of the *primary* clip.
    ///
    /// Scoped the same way as [`resolved_source_range`](Self::resolved_source_range):
    /// a linked audio clip placed beside it may run longer.
    pub fn resolved_duration_sec(&self) -> TimeSec {
        self.resolved_duration_sec
    }

    /// Returns the linked-audio details, if a linked audio clip was created.
    pub fn linked_audio(&self) -> Option<&LinkedAudioInfo> {
        self.linked_audio.as_ref()
    }

    /// Builds an `InsertClipCommand` carrying an explicit source range.
    ///
    /// The range is always spelled out, never left for `InsertClip` to derive
    /// from the asset: this command has already resolved a length for an asset
    /// with no usable duration — see [`media_insert_source_range`] — and
    /// handing the sub-command nothing made it re-derive one from the same
    /// unusable reading. An asset carrying `durationSec: 0.0` then failed the
    /// whole insert with "Invalid time range: 0~0" rather than taking the
    /// default length this command had already picked for it.
    fn build_insert_clip(
        &self,
        track_id: &str,
        source_range: (TimeSec, TimeSec),
    ) -> InsertClipCommand {
        InsertClipCommand::new(
            &self.sequence_id,
            track_id,
            &self.asset_id,
            self.timeline_start,
        )
        .with_source_range(source_range.0, source_range.1)
    }

    /// Executes a sub-command directly against state (no nested executor), so
    /// that the composite remains a single history entry, and records it for
    /// undo. Returns the sub-command result.
    fn run_sub_command(
        &mut self,
        mut command: Box<dyn Command>,
        state: &mut ProjectState,
        context: &str,
    ) -> CoreResult<CommandResult> {
        let result = command.execute(state).map_err(|error| {
            CoreError::Internal(format!("InsertMedia {context} failed: {error}"))
        })?;
        self.sub_commands.push(command);
        Ok(result)
    }

    /// Rolls back all successfully executed sub-commands after a composite
    /// failure so callers never observe a partially applied InsertMedia command.
    fn rollback_applied_sub_commands(&mut self, state: &mut ProjectState) -> CoreResult<()> {
        let mut rollback_errors = Vec::new();
        for command in self.sub_commands.iter().rev() {
            if let Err(error) = command.undo(state) {
                rollback_errors.push(error.to_string());
            }
        }

        self.sub_commands.clear();
        self.primary_clip_id = None;
        self.linked_audio = None;

        if rollback_errors.is_empty() {
            Ok(())
        } else {
            Err(CoreError::Internal(format!(
                "InsertMedia rollback failed: {}",
                rollback_errors.join("; ")
            )))
        }
    }

    fn execute_inner(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // --- Resolve asset + target metadata up front ---
        let asset = state
            .assets
            .get(&self.asset_id)
            .ok_or_else(|| CoreError::AssetNotFound(self.asset_id.clone()))?;
        let asset_kind = asset.kind.clone();
        // The picture's length and the sound's length are separate readings of
        // the same file, and a clip is bounded by whichever one its track
        // plays. Both are taken here, before the borrow on `state` ends.
        let picture_duration_sec = asset_duration_for_track(asset, &TrackKind::Video);
        let sound_duration_sec = asset_duration_for_track(asset, &TrackKind::Audio);
        let asset_has_audio = asset.audio.is_some();

        let sequence = state
            .sequences
            .get(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let target_track = sequence
            .tracks
            .iter()
            .find(|track| track.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        let target_track_kind = target_track.kind.clone();

        validate_media_track_compatibility(
            &self.asset_id,
            &asset_kind,
            &self.track_id,
            &target_track_kind,
            self.audio_only,
        )?;

        // The track decides which reading bounds the clip, because the track
        // decides what is played: an audio track plays the sound, everything
        // else plays the pictures. `audioOnly` cannot widen this — the
        // compatibility check above refuses it anywhere but an audio track, so
        // an audio-only clip is never measured against pictures it does not
        // show, and a video clip is never given the length of sound it does not
        // have.
        let primary_duration_bound_sec = if matches!(target_track_kind, TrackKind::Audio) {
            sound_duration_sec
        } else {
            picture_duration_sec
        };
        let (source_range, duration_sec) = media_insert_source_range(
            &self.asset_id,
            primary_duration_bound_sec,
            self.source_in,
            self.source_out,
        )?;
        self.resolved_source_range = source_range;
        self.resolved_duration_sec = duration_sec;
        let primary_range = source_range.unwrap_or((0.0, duration_sec));

        // --- 1) Insert the primary clip ---
        let primary_command =
            Box::new(self.build_insert_clip(&self.track_id.clone(), primary_range));
        let primary_result = self.run_sub_command(primary_command, state, "InsertClip")?;
        let primary_clip_id = primary_result.created_ids.first().cloned().ok_or_else(|| {
            CoreError::Internal("InsertMedia InsertClip did not return a clip id".to_string())
        })?;
        self.primary_clip_id = Some(primary_clip_id.clone());

        let mut aggregated_changes = primary_result.changes.clone();
        let mut aggregated_created = primary_result.created_ids.clone();

        // --- 2) Optionally extract a linked audio clip ---
        let should_extract_linked_audio = self.auto_extract_linked_audio
            && matches!(asset_kind, AssetKind::Video)
            && !self.audio_only
            && matches!(target_track_kind, TrackKind::Video | TrackKind::Overlay)
            && asset_has_audio;

        if should_extract_linked_audio {
            // The sound is bounded by the sound, not by the picture it was
            // split away from: an mp4 whose AAC runs two seconds past its last
            // frame holds two seconds no edit could otherwise reach.
            let (audio_source_range, audio_duration_sec) = media_insert_source_range(
                &self.asset_id,
                sound_duration_sec,
                self.source_in,
                self.source_out,
            )?;
            let audio_range = audio_source_range.unwrap_or((0.0, audio_duration_sec));

            let sequence = state
                .sequences
                .get(&self.sequence_id)
                .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

            let (audio_track_id, created_track) = if let Some(audio_track_id) =
                find_available_audio_track_id(sequence, self.timeline_start, audio_duration_sec)
            {
                (audio_track_id, false)
            } else {
                let track_name = next_audio_track_name(sequence);
                let position = default_audio_track_position(sequence);
                let create_command = Box::new(
                    AddTrackCommand::new(&self.sequence_id, &track_name, TrackKind::Audio)
                        .at_position(position),
                );
                let create_result = self.run_sub_command(create_command, state, "AddTrack")?;
                let created_track_id =
                    create_result.created_ids.first().cloned().ok_or_else(|| {
                        CoreError::Internal(
                            "InsertMedia AddTrack did not return a track id".to_string(),
                        )
                    })?;
                aggregated_changes.extend(create_result.changes.clone());
                aggregated_created.extend(create_result.created_ids.clone());
                (created_track_id, true)
            };

            let audio_command = Box::new(self.build_insert_clip(&audio_track_id, audio_range));
            let audio_result =
                self.run_sub_command(audio_command, state, "linked audio InsertClip")?;
            let audio_clip_id = audio_result.created_ids.first().cloned().ok_or_else(|| {
                CoreError::Internal(
                    "InsertMedia linked audio InsertClip did not return a clip id".to_string(),
                )
            })?;
            aggregated_changes.extend(audio_result.changes.clone());
            aggregated_created.extend(audio_result.created_ids.clone());

            let link_command = Box::new(LinkClipsCommand::new(
                &self.sequence_id,
                vec![
                    (self.track_id.clone(), primary_clip_id.clone()),
                    (audio_track_id.clone(), audio_clip_id.clone()),
                ],
            ));
            let link_result = self.run_sub_command(link_command, state, "LinkClips")?;
            aggregated_changes.extend(link_result.changes.clone());

            let mute_command = Box::new(SetClipMuteCommand::new(
                &self.sequence_id,
                &self.track_id,
                &primary_clip_id,
                true,
            ));
            let mute_result = self.run_sub_command(mute_command, state, "SetClipMute")?;
            aggregated_changes.extend(mute_result.changes.clone());

            self.linked_audio = Some(LinkedAudioInfo {
                track_id: audio_track_id,
                clip_id: audio_clip_id,
                created_track,
            });
        }

        // --- Build aggregated result (single op id for one history entry) ---
        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        result.changes = aggregated_changes;
        result.created_ids = aggregated_created;
        Ok(result)
    }
}

impl Command for InsertMediaCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        match self.execute_inner(state) {
            Ok(result) => Ok(result),
            Err(error) => {
                if !self.sub_commands.is_empty() {
                    if let Err(rollback_error) = self.rollback_applied_sub_commands(state) {
                        return Err(CoreError::Internal(format!("{error}; {rollback_error}")));
                    }
                }
                Err(error)
            }
        }
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        // Undo sub-commands in reverse execution order so the composite is
        // reversed atomically as a single history entry.
        for command in self.sub_commands.iter().rev() {
            command.undo(state)?;
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "InsertMedia"
    }

    fn to_json(&self) -> serde_json::Value {
        // Carries the static inputs; the executor derives the realized batch
        // operation payload from the post-execute result + state.
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "assetId": self.asset_id,
            "timelineStart": self.timeline_start,
            "sourceIn": self.source_in,
            "sourceOut": self.source_out,
            "audioOnly": self.audio_only,
            "autoExtractLinkedAudio": self.auto_extract_linked_audio,
        })
    }
}

// =============================================================================
// Helpers (moved from the CLI MCP server so the logic lives once, in core)
// =============================================================================

/// Resolves the effective source range and clip duration for a media insert.
///
/// Returns `(Some((source_in, source_out)), duration)` when a range is known,
/// or `(None, default_duration)` when the asset has neither a known duration
/// nor an explicit range.
///
/// A recorded duration of `0` or a non-finite one is read as *unknown* rather
/// than as a length. Assets imported before the probe recorded only measurable
/// readings carry exactly that: FFprobe gives a PNG no `format.duration` at
/// all, which lands as `Some(0.0)`, and an insert that trusted it would fail
/// with "sourceOut must be greater than sourceIn" instead of placing the still.
pub fn media_insert_source_range(
    asset_id: &str,
    asset_duration_sec: Option<TimeSec>,
    source_in: Option<TimeSec>,
    source_out: Option<TimeSec>,
) -> CoreResult<(Option<(TimeSec, TimeSec)>, TimeSec)> {
    fn validate_time(value: Option<TimeSec>, field_name: &str) -> CoreResult<()> {
        if let Some(time) = value {
            if !time.is_finite() || time < 0.0 {
                return Err(CoreError::ValidationError(format!(
                    "{field_name} must be a finite non-negative number"
                )));
            }
        }
        Ok(())
    }

    let asset_duration_sec =
        asset_duration_sec.filter(|duration| duration.is_finite() && *duration > 0.0);
    validate_time(source_in, "sourceIn")?;
    validate_time(source_out, "sourceOut")?;

    let has_explicit_range = source_in.is_some() || source_out.is_some();
    let source_start = source_in.unwrap_or(0.0);

    if !has_explicit_range && asset_duration_sec.is_none() {
        return Ok((None, DEFAULT_MEDIA_INSERT_DURATION_SEC));
    }

    let source_end = source_out
        .or(asset_duration_sec)
        .unwrap_or(source_start + DEFAULT_MEDIA_INSERT_DURATION_SEC);
    let clamped_source_end = asset_duration_sec
        .map(|duration| source_end.min(duration))
        .unwrap_or(source_end);

    if source_start >= clamped_source_end {
        return Err(CoreError::ValidationError(format!(
            "Invalid source range for asset '{asset_id}': sourceOut must be greater than sourceIn"
        )));
    }

    Ok((
        Some((source_start, clamped_source_end)),
        clamped_source_end - source_start,
    ))
}

/// Validates that the asset kind is compatible with the target track kind.
///
/// `audio_only` asks for the sound without the pictures, and only an audio
/// track plays that. Allowing it on a video or overlay track produced a clip
/// that a renderer still read as pictures while its length came from the sound:
/// an mp4 whose AAC outlasts its video became a video clip seconds longer than
/// the frames it has, and the overrun rendered black.
pub fn validate_media_track_compatibility(
    asset_id: &str,
    asset_kind: &AssetKind,
    track_id: &str,
    track_kind: &TrackKind,
    audio_only: bool,
) -> CoreResult<()> {
    if audio_only && !matches!(track_kind, TrackKind::Audio) {
        return Err(CoreError::ValidationError(format!(
            "audioOnly insert of asset '{asset_id}' was targeted at {track_kind:?} track '{track_id}', which plays pictures. Target an audio track, or drop audioOnly to insert the asset with its pictures."
        )));
    }

    match asset_kind {
        AssetKind::Video => {
            if matches!(track_kind, TrackKind::Audio) {
                if audio_only {
                    return Ok(());
                }
                return Err(CoreError::ValidationError(format!(
                    "Video asset '{asset_id}' was targeted at audio track '{track_id}'. That creates an audio-only clip and will not show in preview. Use a video/overlay track, or set audioOnly true intentionally."
                )));
            }
            if matches!(track_kind, TrackKind::Video | TrackKind::Overlay) {
                return Ok(());
            }
        }
        AssetKind::Audio if matches!(track_kind, TrackKind::Audio) => return Ok(()),
        AssetKind::Image if matches!(track_kind, TrackKind::Video | TrackKind::Overlay) => {
            return Ok(())
        }
        AssetKind::Subtitle if matches!(track_kind, TrackKind::Caption) => return Ok(()),
        _ => {}
    }

    Err(CoreError::ValidationError(format!(
        "Cannot place {asset_kind:?} asset '{asset_id}' on {track_kind:?} track '{track_id}'"
    )))
}

/// Returns true when any clip on the track overlaps the given time window.
fn track_has_overlap(
    track: &crate::core::timeline::Track,
    timeline_start: TimeSec,
    duration_sec: TimeSec,
) -> bool {
    let timeline_end = timeline_start + duration_sec;
    track.clips.iter().any(|clip| {
        let clip_start = clip.place.timeline_in_sec;
        let clip_end = clip.place.timeline_in_sec + clip.place.duration_sec;
        timeline_start < clip_end && timeline_end > clip_start
    })
}

/// Finds an existing, unlocked, unmuted audio track that is free at the target
/// window, suitable for hosting the linked audio clip.
pub fn find_available_audio_track_id(
    sequence: &Sequence,
    timeline_start: TimeSec,
    duration_sec: TimeSec,
) -> Option<TrackId> {
    sequence
        .tracks
        .iter()
        .find(|track| {
            matches!(track.kind, TrackKind::Audio)
                && !track.locked
                && !track.muted
                && !track_has_overlap(track, timeline_start, duration_sec)
        })
        .map(|track| track.id.clone())
}

/// Computes the next sequential audio track name (e.g. "Audio 2").
pub fn next_audio_track_name(sequence: &Sequence) -> String {
    let mut highest_index = 0usize;
    for track in &sequence.tracks {
        if !matches!(track.kind, TrackKind::Audio) {
            continue;
        }
        let name = track.name.trim();
        if name == "Audio" {
            highest_index = highest_index.max(1);
        } else if let Some(index) = name
            .strip_prefix("Audio ")
            .and_then(|value| value.parse::<usize>().ok())
        {
            highest_index = highest_index.max(index);
        }
    }
    format!("Audio {}", highest_index + 1)
}

/// Computes the default insertion position for a newly created audio track.
pub fn default_audio_track_position(sequence: &Sequence) -> usize {
    sequence
        .tracks
        .iter()
        .enumerate()
        .filter(|(_, track)| matches!(track.kind, TrackKind::Audio))
        .map(|(index, _)| index + 1)
        .next_back()
        .unwrap_or(sequence.tracks.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{Asset, VideoInfo};

    fn project_with_video_asset() -> (ProjectState, SequenceId, TrackId, AssetId) {
        let mut state = ProjectState::new("Insert Media Test");
        let sequence_id = state.active_sequence_id.clone().unwrap();
        let track_id = state
            .sequences
            .get(&sequence_id)
            .unwrap()
            .tracks
            .iter()
            .find(|track| matches!(track.kind, TrackKind::Video))
            .unwrap()
            .id
            .clone();

        let asset =
            Asset::new_video("clip.mp4", "/clip.mp4", VideoInfo::default()).with_duration(12.0);
        let asset_id = asset.id.clone();
        state.assets.insert(asset_id.clone(), asset);

        (state, sequence_id, track_id, asset_id)
    }

    #[test]
    fn media_insert_source_range_rejects_invalid_times() {
        assert!(media_insert_source_range("asset", Some(12.0), Some(-1.0), None).is_err());
        assert!(
            media_insert_source_range("asset", Some(12.0), Some(0.0), Some(f64::INFINITY)).is_err()
        );
    }

    /// A duration nobody could measure is not a length.
    ///
    /// Projects recorded before the import probe filtered its reading carry
    /// `Some(0.0)` for a PNG, and trusting it turned every insert of that still
    /// into "sourceOut must be greater than sourceIn".
    #[test]
    fn media_insert_source_range_reads_an_unmeasurable_duration_as_unknown() {
        for duration in [Some(0.0), Some(f64::NAN), Some(f64::INFINITY)] {
            let (range, duration_sec) = media_insert_source_range("asset", duration, None, None)
                .expect("an unmeasurable duration falls back to the default length");
            assert_eq!(range, None);
            assert_eq!(duration_sec, DEFAULT_MEDIA_INSERT_DURATION_SEC);
        }

        // An explicit range still wins: nothing about it depends on the asset.
        let (range, duration_sec) =
            media_insert_source_range("asset", Some(0.0), Some(1.0), Some(3.0))
                .expect("an explicit range is independent of the asset's duration");
        assert_eq!(range, Some((1.0, 3.0)));
        assert_eq!(duration_sec, 2.0);
    }

    /// A project whose only asset carries the poisoned `durationSec: 0.0`.
    ///
    /// What FFprobe hands back for a container it cannot measure, and what
    /// every project written before the import probe filtered its readings
    /// still holds on disk.
    fn project_with_unmeasurable_asset() -> (ProjectState, SequenceId, TrackId, AssetId) {
        let (mut state, sequence_id, track_id, asset_id) = project_with_video_asset();
        state
            .assets
            .get_mut(&asset_id)
            .expect("the seeded asset")
            .duration_sec = Some(0.0);
        (state, sequence_id, track_id, asset_id)
    }

    /// Feature: an unmeasurable duration never blocks an insert
    /// Scenario: inserting from an asset recorded as zero seconds long
    ///   Given an asset carrying `durationSec: 0.0`
    ///   When `InsertMedia` places a clip from it
    ///   Then the clip is placed at the default length rather than refused
    #[test]
    fn should_place_a_default_length_clip_when_the_asset_records_no_usable_duration() {
        let (mut state, sequence_id, track_id, asset_id) = project_with_unmeasurable_asset();
        let mut command = InsertMediaCommand::new(&sequence_id, &track_id, &asset_id, 0.0);

        let result = command
            .execute(&mut state)
            .expect("a zero duration is unknown, not an empty range");

        let clip_id = result.created_ids.first().expect("the placed clip");
        let clip = state
            .sequences
            .get(&sequence_id)
            .expect("the sequence")
            .tracks
            .iter()
            .flat_map(|track| track.clips.iter())
            .find(|clip| &clip.id == clip_id)
            .expect("the placed clip");
        assert_eq!(clip.place.duration_sec, DEFAULT_MEDIA_INSERT_DURATION_SEC);
        assert_eq!(clip.range.source_in_sec, 0.0);
        assert_eq!(clip.range.source_out_sec, DEFAULT_MEDIA_INSERT_DURATION_SEC);
    }

    /// The same asset through `InsertClip`, which `InsertMedia` delegates to and
    /// which every other surface can reach on its own.
    #[test]
    fn should_place_a_default_length_clip_through_insert_clip_too() {
        let (mut state, sequence_id, track_id, asset_id) = project_with_unmeasurable_asset();
        let mut command = InsertClipCommand::new(&sequence_id, &track_id, &asset_id, 0.0);

        let result = command
            .execute(&mut state)
            .expect("a zero duration is unknown, not an empty range");

        let clip_id = result.created_ids.first().expect("the placed clip");
        let clip = state
            .sequences
            .get(&sequence_id)
            .expect("the sequence")
            .tracks
            .iter()
            .flat_map(|track| track.clips.iter())
            .find(|clip| &clip.id == clip_id)
            .expect("the placed clip");
        assert!(clip.place.duration_sec > 0.0, "{:?}", clip.place);
    }

    /// A project holding one mp4 whose AAC outlasts its pictures: 4s of video,
    /// 6s of sound — the shape `frame extract` and the export disagree about
    /// when a clip is allowed to outrun its frames.
    fn project_with_sound_outlasting_its_pictures(
    ) -> (ProjectState, SequenceId, TrackId, TrackId, AssetId) {
        let (mut state, sequence_id, video_track_id, asset_id) = project_with_video_asset();
        {
            let asset = state.assets.get_mut(&asset_id).expect("the seeded asset");
            asset.duration_sec = Some(4.0);
            asset.audio_duration_sec = Some(6.0);
            asset.audio = Some(crate::core::assets::AudioInfo::default());
        }

        let audio_track_id = state
            .sequences
            .get(&sequence_id)
            .expect("the sequence")
            .tracks
            .iter()
            .find(|track| matches!(track.kind, TrackKind::Audio))
            .expect("a new project has an audio track")
            .id
            .clone();

        (state, sequence_id, video_track_id, audio_track_id, asset_id)
    }

    /// Feature: audioOnly places sound, and only a sound track plays sound
    /// Scenario: an audioOnly insert aimed at a video track
    ///   Given an mp4 whose sound outlasts its pictures
    ///   When `InsertMedia` is asked for an audioOnly clip on a video track
    ///   Then it is refused, naming the two ways out
    #[test]
    fn should_refuse_an_audio_only_insert_onto_a_track_that_plays_pictures() {
        let (mut state, sequence_id, video_track_id, _, asset_id) =
            project_with_sound_outlasting_its_pictures();

        let mut command = InsertMediaCommand::new(&sequence_id, &video_track_id, &asset_id, 0.0)
            .with_audio_only(true);

        let error = command
            .execute(&mut state)
            .expect_err("a video track cannot play sound alone");
        let message = error.to_string();
        assert!(
            message.contains("audioOnly") && message.contains("audio track"),
            "the refusal must name the fix, got: {message}"
        );

        // Nothing was placed: the clip that used to be created here ran two
        // seconds past its last frame.
        assert!(state
            .sequences
            .get(&sequence_id)
            .expect("the sequence")
            .tracks
            .iter()
            .all(|track| track.clips.is_empty()));
    }

    /// The same insert on the track that does play sound keeps all six seconds.
    #[test]
    fn should_bound_an_audio_only_insert_on_an_audio_track_by_the_sound() {
        let (mut state, sequence_id, _, audio_track_id, asset_id) =
            project_with_sound_outlasting_its_pictures();

        let mut command = InsertMediaCommand::new(&sequence_id, &audio_track_id, &asset_id, 0.0)
            .with_audio_only(true);
        let result = command
            .execute(&mut state)
            .expect("an audio track plays the sound");

        let clip_id = result.created_ids.first().expect("the placed clip");
        let clip = state
            .sequences
            .get(&sequence_id)
            .expect("the sequence")
            .tracks
            .iter()
            .flat_map(|track| track.clips.iter())
            .find(|clip| &clip.id == clip_id)
            .expect("the placed clip");
        assert_eq!(clip.range.source_out_sec, 6.0);
        assert_eq!(clip.place.duration_sec, 6.0);
    }

    /// And an ordinary insert on a video track still stops with the pictures.
    #[test]
    fn should_bound_a_video_track_insert_by_the_pictures() {
        let (mut state, sequence_id, video_track_id, _, asset_id) =
            project_with_sound_outlasting_its_pictures();

        let mut command = InsertMediaCommand::new(&sequence_id, &video_track_id, &asset_id, 0.0)
            .with_auto_extract_linked_audio(false);
        let result = command.execute(&mut state).expect("a plain video insert");

        let clip_id = result.created_ids.first().expect("the placed clip");
        let clip = state
            .sequences
            .get(&sequence_id)
            .expect("the sequence")
            .tracks
            .iter()
            .flat_map(|track| track.clips.iter())
            .find(|clip| &clip.id == clip_id)
            .expect("the placed clip");
        assert_eq!(clip.range.source_out_sec, 4.0);
    }

    #[test]
    fn rollback_applied_sub_commands_removes_successful_clip_insert() {
        let (mut state, sequence_id, track_id, asset_id) = project_with_video_asset();
        let mut command = InsertMediaCommand::new(&sequence_id, &track_id, &asset_id, 0.0);

        let result = command
            .run_sub_command(
                Box::new(InsertClipCommand::new(
                    &sequence_id,
                    &track_id,
                    &asset_id,
                    0.0,
                )),
                &mut state,
                "test clip insert",
            )
            .unwrap();
        let created_clip_id = result.created_ids.first().unwrap().clone();

        let track = state
            .sequences
            .get(&sequence_id)
            .unwrap()
            .tracks
            .iter()
            .find(|track| track.id == track_id)
            .unwrap();
        assert!(track.get_clip(&created_clip_id).is_some());

        command.rollback_applied_sub_commands(&mut state).unwrap();

        let track = state
            .sequences
            .get(&sequence_id)
            .unwrap()
            .tracks
            .iter()
            .find(|track| track.id == track_id)
            .unwrap();
        assert!(track.get_clip(&created_clip_id).is_none());
        assert!(command.sub_commands.is_empty());
    }
}

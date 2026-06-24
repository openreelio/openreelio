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
        AddTrackCommand, Command, CommandResult, InsertClipCommand, LinkClipsCommand,
        SetClipMuteCommand,
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
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        asset_id: &str,
        timeline_start: TimeSec,
    ) -> Self {
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
    pub fn with_source_range(mut self, source_in: Option<TimeSec>, source_out: Option<TimeSec>) -> Self {
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

    /// Returns the resolved source range, if any.
    pub fn resolved_source_range(&self) -> Option<(TimeSec, TimeSec)> {
        self.resolved_source_range
    }

    /// Returns the resolved clip duration.
    pub fn resolved_duration_sec(&self) -> TimeSec {
        self.resolved_duration_sec
    }

    /// Returns the linked-audio details, if a linked audio clip was created.
    pub fn linked_audio(&self) -> Option<&LinkedAudioInfo> {
        self.linked_audio.as_ref()
    }

    /// Builds an `InsertClipCommand` with the optional source range applied.
    fn build_insert_clip(&self, track_id: &str) -> InsertClipCommand {
        let command =
            InsertClipCommand::new(&self.sequence_id, track_id, &self.asset_id, self.timeline_start);
        match self.resolved_source_range {
            Some((source_in, source_out)) => command.with_source_range(source_in, source_out),
            None => command,
        }
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
}

impl Command for InsertMediaCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // --- Resolve asset + target metadata up front ---
        let asset = state
            .assets
            .get(&self.asset_id)
            .ok_or_else(|| CoreError::AssetNotFound(self.asset_id.clone()))?;
        let asset_kind = asset.kind.clone();
        let asset_duration_sec = asset.duration_sec;
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

        let (source_range, duration_sec) = media_insert_source_range(
            &self.asset_id,
            asset_duration_sec,
            self.source_in,
            self.source_out,
        )?;
        self.resolved_source_range = source_range;
        self.resolved_duration_sec = duration_sec;

        // --- 1) Insert the primary clip ---
        let primary_command = Box::new(self.build_insert_clip(&self.track_id.clone()));
        let primary_result = self.run_sub_command(primary_command, state, "InsertClip")?;
        let primary_clip_id = primary_result
            .created_ids
            .first()
            .cloned()
            .ok_or_else(|| {
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
            let sequence = state.sequences.get(&self.sequence_id).ok_or_else(|| {
                CoreError::SequenceNotFound(self.sequence_id.clone())
            })?;

            let (audio_track_id, created_track) = if let Some(audio_track_id) =
                find_available_audio_track_id(sequence, self.timeline_start, duration_sec)
            {
                (audio_track_id, false)
            } else {
                let track_name = next_audio_track_name(sequence);
                let position = default_audio_track_position(sequence);
                let create_command = Box::new(
                    AddTrackCommand::new(&self.sequence_id, &track_name, TrackKind::Audio)
                        .at_position(position),
                );
                let create_result =
                    self.run_sub_command(create_command, state, "AddTrack")?;
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

            let audio_command = Box::new(self.build_insert_clip(&audio_track_id));
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
pub fn media_insert_source_range(
    asset_id: &str,
    asset_duration_sec: Option<TimeSec>,
    source_in: Option<TimeSec>,
    source_out: Option<TimeSec>,
) -> CoreResult<(Option<(TimeSec, TimeSec)>, TimeSec)> {
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
pub fn validate_media_track_compatibility(
    asset_id: &str,
    asset_kind: &AssetKind,
    track_id: &str,
    track_kind: &TrackKind,
    audio_only: bool,
) -> CoreResult<()> {
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

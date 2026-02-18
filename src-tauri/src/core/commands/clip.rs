//! Clip Commands Module
//!
//! Implements all clip-related editing commands.

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    project::ProjectState,
    timeline::{AudioSettings, Clip, ClipPlace, ClipRange, Track, Transform},
    AssetId, ClipId, CoreError, CoreResult, SequenceId, TimeSec, TrackId,
};

fn is_valid_time_sec(value: TimeSec) -> bool {
    value.is_finite() && value >= 0.0
}

fn sort_track_clips(track: &mut Track) {
    track.clips.sort_by(|a, b| {
        a.place
            .timeline_in_sec
            .total_cmp(&b.place.timeline_in_sec)
            .then_with(|| {
                // Ensure deterministic ordering when two clips share the same start time.
                a.id.cmp(&b.id)
            })
    });
}

fn find_overlap<'a>(
    track: &'a Track,
    candidate: &ClipPlace,
    ignore_clip_id: Option<&str>,
) -> Option<&'a Clip> {
    track.clips.iter().find(|existing| {
        if ignore_clip_id.is_some_and(|id| id == existing.id) {
            return false;
        }
        existing.place.overlaps(candidate)
    })
}

fn validate_no_overlap(
    track: &Track,
    candidate: &ClipPlace,
    ignore_clip_id: Option<&str>,
) -> CoreResult<()> {
    if let Some(conflict) = find_overlap(track, candidate, ignore_clip_id) {
        return Err(CoreError::ClipOverlap {
            track_id: track.id.clone(),
            existing_clip_id: conflict.id.clone(),
            new_start: candidate.timeline_in_sec,
            new_end: candidate.timeline_out_sec(),
        });
    }
    Ok(())
}

fn insert_clip_sorted(track: &mut Track, clip: Clip) {
    // Keep clips ordered by timeline start.
    let idx = track
        .clips
        .binary_search_by(|existing| {
            existing
                .place
                .timeline_in_sec
                .total_cmp(&clip.place.timeline_in_sec)
        })
        .unwrap_or_else(|i| i);
    track.clips.insert(idx, clip);
    // Defensive: binary_search_by doesn't guarantee stable ordering when keys are equal.
    // We never allow overlaps, but keep ordering deterministic.
    sort_track_clips(track);
}

// =============================================================================
// InsertClipCommand
// =============================================================================

/// Command to insert a new clip into a track
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertClipCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Target track ID
    pub track_id: TrackId,
    /// Source asset ID
    pub asset_id: AssetId,
    /// Timeline position to insert at
    pub timeline_start: TimeSec,
    /// Source start time (optional, defaults to 0)
    pub source_start: Option<TimeSec>,
    /// Source end time (optional, defaults to asset duration)
    pub source_end: Option<TimeSec>,
    /// Created clip ID (stored after execution for undo)
    #[serde(skip)]
    created_clip_id: Option<ClipId>,
}

impl InsertClipCommand {
    /// Creates a new insert clip command
    pub fn new(sequence_id: &str, track_id: &str, asset_id: &str, timeline_start: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            asset_id: asset_id.to_string(),
            timeline_start,
            source_start: None,
            source_end: None,
            created_clip_id: None,
        }
    }

    /// Sets the source range
    pub fn with_source_range(mut self, start: TimeSec, end: TimeSec) -> Self {
        self.source_start = Some(start);
        self.source_end = Some(end);
        self
    }
}

impl Command for InsertClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !is_valid_time_sec(self.timeline_start) {
            return Err(CoreError::ValidationError(
                "timelineStart must be finite and non-negative".to_string(),
            ));
        }

        // Validate asset exists
        let asset = state
            .assets
            .get(&self.asset_id)
            .ok_or_else(|| CoreError::AssetNotFound(self.asset_id.clone()))?;

        // Get asset duration for default source range
        let asset_duration = asset.duration_sec.unwrap_or(10.0);
        let source_start = self.source_start.unwrap_or(0.0);
        let source_end = self.source_end.unwrap_or(asset_duration);

        // Validate source range
        if !source_start.is_finite()
            || !source_end.is_finite()
            || source_start < 0.0
            || source_end < 0.0
        {
            return Err(CoreError::ValidationError(
                "Source range must be finite and non-negative".to_string(),
            ));
        }
        if source_start >= source_end {
            return Err(CoreError::InvalidTimeRange(source_start, source_end));
        }

        // Validate sequence and track exist
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        // Create the clip
        let duration = source_end - source_start;
        if !duration.is_finite() || duration <= 0.0 {
            return Err(CoreError::ValidationError(
                "Clip duration must be finite and > 0".to_string(),
            ));
        }
        let mut clip = Clip::new(&self.asset_id);
        clip.range = ClipRange {
            source_in_sec: source_start,
            source_out_sec: source_end,
        };
        clip.place = ClipPlace {
            timeline_in_sec: self.timeline_start,
            duration_sec: duration,
        };

        let clip_id = clip.id.clone();

        // Store created clip ID for undo
        self.created_clip_id = Some(clip_id.clone());

        // Prevent overlap and keep clips sorted.
        validate_no_overlap(track, &clip.place, None)?;
        insert_clip_sorted(track, clip);

        // Generate operation ID
        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::ClipCreated {
                clip_id: clip_id.clone(),
            })
            .with_created_id(&clip_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        // Use the stored clip ID for precise undo
        if let Some(ref clip_id) = self.created_clip_id {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) {
                    track.clips.retain(|c| &c.id != clip_id);
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "InsertClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// RemoveClipCommand
// =============================================================================

/// Command to remove a clip from a track
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveClipCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Target track ID
    pub track_id: TrackId,
    /// Clip ID to remove
    pub clip_id: ClipId,
    /// Stored clip data for undo
    #[serde(skip)]
    removed_clip: Option<Clip>,
    /// Original position in track (for undo)
    #[serde(skip)]
    original_position: Option<usize>,
}

impl RemoveClipCommand {
    /// Creates a new remove clip command
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            removed_clip: None,
            original_position: None,
        }
    }
}

impl Command for RemoveClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip_pos = track
            .clips
            .iter()
            .position(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        // Store the clip and position before removal for undo
        self.removed_clip = Some(track.clips[clip_pos].clone());
        self.original_position = Some(clip_pos);

        track.clips.remove(clip_pos);

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::ClipDeleted {
                clip_id: self.clip_id.clone(),
            })
            .with_deleted_id(&self.clip_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let (Some(clip), Some(position)) = (&self.removed_clip, self.original_position) {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) {
                    // Insert at original position if possible
                    if position <= track.clips.len() {
                        track.clips.insert(position, clip.clone());
                    } else {
                        track.clips.push(clip.clone());
                    }

                    // Keep deterministic ordering.
                    sort_track_clips(track);
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RemoveClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// MoveClipCommand
// =============================================================================

/// Command to move a clip to a new position
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveClipCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Clip ID to move
    pub clip_id: ClipId,
    /// New timeline position
    pub new_timeline_in: TimeSec,
    /// New track ID (optional, for cross-track moves)
    pub new_track_id: Option<TrackId>,
    /// Previous timeline position (for undo)
    #[serde(skip)]
    old_timeline_in: Option<TimeSec>,
    /// Previous track ID (for undo)
    #[serde(skip)]
    old_track_id: Option<TrackId>,
}

impl MoveClipCommand {
    /// Creates a new move clip command (simple version without track)
    pub fn new_simple(sequence_id: &str, clip_id: &str, new_timeline_in: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            clip_id: clip_id.to_string(),
            new_timeline_in,
            new_track_id: None,
            old_timeline_in: None,
            old_track_id: None,
        }
    }

    /// Creates a new move clip command with optional cross-track move
    pub fn new(
        sequence_id: &str,
        _track_id: &str, // Source track (used for validation, not stored)
        clip_id: &str,
        new_timeline_in: TimeSec,
        new_track_id: Option<String>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            clip_id: clip_id.to_string(),
            new_timeline_in,
            new_track_id,
            old_timeline_in: None,
            old_track_id: None,
        }
    }

    /// Sets the target track for cross-track moves
    pub fn to_track(mut self, track_id: &str) -> Self {
        self.new_track_id = Some(track_id.to_string());
        self
    }
}

impl Command for MoveClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !is_valid_time_sec(self.new_timeline_in) {
            return Err(CoreError::ValidationError(
                "newTimelineIn must be finite and non-negative".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // Find the source track containing this clip
        let (src_track_idx, clip_idx) = sequence
            .tracks
            .iter()
            .enumerate()
            .find_map(|(t_idx, track)| {
                track
                    .clips
                    .iter()
                    .position(|c| c.id == self.clip_id)
                    .map(|c_idx| (t_idx, c_idx))
            })
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        let old_track_id = sequence.tracks[src_track_idx].id.clone();
        let old_timeline_in = sequence.tracks[src_track_idx].clips[clip_idx]
            .place
            .timeline_in_sec;

        self.old_track_id = Some(old_track_id.clone());
        self.old_timeline_in = Some(old_timeline_in);

        // Resolve destination track
        let dest_track_idx = if let Some(new_track_id) = &self.new_track_id {
            sequence
                .tracks
                .iter()
                .position(|t| &t.id == new_track_id)
                .ok_or_else(|| CoreError::TrackNotFound(new_track_id.clone()))?
        } else {
            src_track_idx
        };

        // Validate overlap BEFORE mutating state.
        let mut candidate = sequence.tracks[src_track_idx].clips[clip_idx].clone();
        candidate.place.timeline_in_sec = self.new_timeline_in;

        if dest_track_idx == src_track_idx {
            let track = &sequence.tracks[src_track_idx];
            validate_no_overlap(track, &candidate.place, Some(&candidate.id))?;
        } else {
            let dest_track = &sequence.tracks[dest_track_idx];
            validate_no_overlap(dest_track, &candidate.place, None)?;
        }

        // Apply move.
        let mut clip = sequence.tracks[src_track_idx].clips.remove(clip_idx);
        clip.place.timeline_in_sec = self.new_timeline_in;

        if dest_track_idx == src_track_idx {
            insert_clip_sorted(&mut sequence.tracks[src_track_idx], clip);
        } else {
            // Borrow both tracks mutably using split_at_mut.
            if src_track_idx < dest_track_idx {
                let (left, right) = sequence.tracks.split_at_mut(dest_track_idx);
                let dest_track = &mut right[0];
                insert_clip_sorted(dest_track, clip);
                // left[src_track_idx] already had the clip removed.
                sort_track_clips(&mut left[src_track_idx]);
            } else {
                let (left, right) = sequence.tracks.split_at_mut(src_track_idx);
                let dest_track = &mut left[dest_track_idx];
                insert_clip_sorted(dest_track, clip);
                sort_track_clips(&mut right[0]);
            }
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let (old_pos, old_track) = match (&self.old_timeline_in, &self.old_track_id) {
            (Some(pos), Some(track)) => (*pos, track.clone()),
            _ => return Ok(()),
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        // Find the current track containing the clip.
        let (current_track_idx, clip_idx) = sequence
            .tracks
            .iter()
            .enumerate()
            .find_map(|(t_idx, track)| {
                track
                    .clips
                    .iter()
                    .position(|c| c.id == self.clip_id)
                    .map(|c_idx| (t_idx, c_idx))
            })
            .unwrap_or((usize::MAX, usize::MAX));

        if current_track_idx == usize::MAX {
            return Ok(());
        }

        // If the original track differs (cross-track move), physically move the clip back.
        if old_track != sequence.tracks[current_track_idx].id {
            let Some(orig_idx) = sequence.tracks.iter().position(|t| t.id == old_track) else {
                return Ok(());
            };

            let mut clip = sequence.tracks[current_track_idx].clips.remove(clip_idx);
            clip.place.timeline_in_sec = old_pos;

            match current_track_idx.cmp(&orig_idx) {
                std::cmp::Ordering::Less => {
                    let (left, right) = sequence.tracks.split_at_mut(orig_idx);
                    insert_clip_sorted(&mut right[0], clip);
                    sort_track_clips(&mut left[current_track_idx]);
                }
                std::cmp::Ordering::Greater => {
                    let (left, right) = sequence.tracks.split_at_mut(current_track_idx);
                    insert_clip_sorted(&mut left[orig_idx], clip);
                    sort_track_clips(&mut right[0]);
                }
                std::cmp::Ordering::Equal => {
                    // Shouldn't happen, but keep it safe.
                    insert_clip_sorted(&mut sequence.tracks[orig_idx], clip);
                }
            }

            return Ok(());
        }

        // Same-track undo: restore timeline position and keep ordering deterministic.
        if let Some(clip) = sequence.tracks[current_track_idx]
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
        {
            clip.place.timeline_in_sec = old_pos;
            sort_track_clips(&mut sequence.tracks[current_track_idx]);
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "MoveClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }

    fn can_merge(&self, other: &dyn Command) -> bool {
        if other.type_name() == "MoveClip" {
            // Could merge consecutive moves of the same clip
            // This would be useful for drag operations
            false // For now, don't merge
        } else {
            false
        }
    }
}

// =============================================================================
// TrimClipCommand
// =============================================================================

/// Command to trim a clip (change source in/out points)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimClipCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Clip ID to trim
    pub clip_id: ClipId,
    /// New source in point (optional)
    pub new_source_in: Option<TimeSec>,
    /// New source out point (optional)
    pub new_source_out: Option<TimeSec>,
    /// New timeline in point (optional, for ripple trim)
    pub new_timeline_in: Option<TimeSec>,
    /// Previous values for undo
    #[serde(skip)]
    old_source_in: Option<TimeSec>,
    #[serde(skip)]
    old_source_out: Option<TimeSec>,
    #[serde(skip)]
    old_timeline_in: Option<TimeSec>,
    #[serde(skip)]
    old_duration_sec: Option<TimeSec>,
}

impl TrimClipCommand {
    /// Creates a new trim clip command (simple version)
    pub fn new_simple(sequence_id: &str, clip_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            clip_id: clip_id.to_string(),
            new_source_in: None,
            new_source_out: None,
            new_timeline_in: None,
            old_source_in: None,
            old_source_out: None,
            old_timeline_in: None,
            old_duration_sec: None,
        }
    }

    /// Creates a new trim clip command with all parameters
    pub fn new(
        sequence_id: &str,
        _track_id: &str, // For API consistency, not stored
        clip_id: &str,
        new_source_in: Option<TimeSec>,
        new_source_out: Option<TimeSec>,
        new_timeline_in: Option<TimeSec>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            clip_id: clip_id.to_string(),
            new_source_in,
            new_source_out,
            new_timeline_in,
            old_source_in: None,
            old_source_out: None,
            old_timeline_in: None,
            old_duration_sec: None,
        }
    }

    /// Sets the new source in point
    pub fn with_source_in(mut self, source_in: TimeSec) -> Self {
        self.new_source_in = Some(source_in);
        self
    }

    /// Sets the new source out point
    pub fn with_source_out(mut self, source_out: TimeSec) -> Self {
        self.new_source_out = Some(source_out);
        self
    }

    /// Sets the new timeline in point
    pub fn with_timeline_in(mut self, timeline_in: TimeSec) -> Self {
        self.new_timeline_in = Some(timeline_in);
        self
    }
}

impl Command for TrimClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let (track_idx, clip_idx) = sequence
            .tracks
            .iter()
            .enumerate()
            .find_map(|(t_idx, track)| {
                track
                    .clips
                    .iter()
                    .position(|c| c.id == self.clip_id)
                    .map(|c_idx| (t_idx, c_idx))
            })
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        let original = sequence.tracks[track_idx].clips[clip_idx].clone();

        // Store old values for undo BEFORE modification
        self.old_source_in = Some(original.range.source_in_sec);
        self.old_source_out = Some(original.range.source_out_sec);
        self.old_timeline_in = Some(original.place.timeline_in_sec);
        self.old_duration_sec = Some(original.place.duration_sec);

        // Prepare candidate without mutating the state.
        let mut candidate = original;

        if let Some(new_in) = self.new_source_in {
            if !is_valid_time_sec(new_in) {
                return Err(CoreError::ValidationError(
                    "newSourceIn must be finite and non-negative".to_string(),
                ));
            }
            candidate.range.source_in_sec = new_in;
        }
        if let Some(new_out) = self.new_source_out {
            if !is_valid_time_sec(new_out) {
                return Err(CoreError::ValidationError(
                    "newSourceOut must be finite and non-negative".to_string(),
                ));
            }
            candidate.range.source_out_sec = new_out;
        }
        if let Some(new_timeline_in) = self.new_timeline_in {
            if !is_valid_time_sec(new_timeline_in) {
                return Err(CoreError::ValidationError(
                    "newTimelineIn must be finite and non-negative".to_string(),
                ));
            }
            candidate.place.timeline_in_sec = new_timeline_in;
        }

        if candidate.range.source_in_sec >= candidate.range.source_out_sec {
            return Err(CoreError::InvalidTimeRange(
                candidate.range.source_in_sec,
                candidate.range.source_out_sec,
            ));
        }

        if !candidate.speed.is_finite() || candidate.speed <= 0.0 {
            return Err(CoreError::ValidationError(
                "Clip speed must be finite and > 0".to_string(),
            ));
        }

        candidate.place.duration_sec = candidate.range.duration() / candidate.speed as f64;
        if !candidate.place.duration_sec.is_finite() || candidate.place.duration_sec <= 0.0 {
            return Err(CoreError::ValidationError(
                "Clip duration must be finite and > 0 after trim".to_string(),
            ));
        }

        // Validate overlap BEFORE mutating state.
        {
            let track = &sequence.tracks[track_idx];
            validate_no_overlap(track, &candidate.place, Some(&candidate.id))?;
        }

        // Apply change and keep ordering deterministic.
        sequence.tracks[track_idx].clips[clip_idx] = candidate;
        sort_track_clips(&mut sequence.tracks[track_idx]);

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            for track in &mut sequence.tracks {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                    // Restore all old values
                    if let Some(old_in) = self.old_source_in {
                        clip.range.source_in_sec = old_in;
                    }
                    if let Some(old_out) = self.old_source_out {
                        clip.range.source_out_sec = old_out;
                    }
                    if let Some(old_timeline_in) = self.old_timeline_in {
                        clip.place.timeline_in_sec = old_timeline_in;
                    }
                    // Restore exact duration (not recalculated, to preserve any rounding)
                    if let Some(old_duration) = self.old_duration_sec {
                        clip.place.duration_sec = old_duration;
                    }

                    sort_track_clips(track);
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "TrimClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// SplitClipCommand
// =============================================================================

/// Command to split a clip at a given time
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitClipCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Target track ID
    pub track_id: TrackId,
    /// Clip ID to split
    pub clip_id: ClipId,
    /// Time to split at (in timeline time)
    pub split_at: TimeSec,
    /// Created clip ID (second half)
    #[serde(skip)]
    created_clip_id: Option<ClipId>,
    /// Original clip data (for undo)
    #[serde(skip)]
    original_clip: Option<Clip>,
}

impl SplitClipCommand {
    /// Creates a new split clip command
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str, split_at: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            split_at,
            created_clip_id: None,
            original_clip: None,
        }
    }
}

// =============================================================================
// SetClipMuteCommand
// =============================================================================

/// Command to set clip-level audio mute state.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClipMuteCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub muted: bool,
    #[serde(skip)]
    previous_muted: Option<bool>,
}

impl SetClipMuteCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str, muted: bool) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            muted,
            previous_muted: None,
        }
    }
}

impl Command for SetClipMuteCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_muted = Some(clip.audio.muted);
        clip.audio.muted = self.muted;

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous_muted) = self.previous_muted else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.audio.muted = previous_muted;
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetClipMute"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "muted": self.muted,
        })
    }
}

// =============================================================================
// SetClipAudioCommand
// =============================================================================

const MIN_CLIP_VOLUME_DB: f32 = -60.0;
const MAX_CLIP_VOLUME_DB: f32 = 6.0;

/// Command to set clip-level audio settings.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClipAudioCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub volume_db: Option<f32>,
    pub pan: Option<f32>,
    pub muted: Option<bool>,
    pub fade_in_sec: Option<TimeSec>,
    pub fade_out_sec: Option<TimeSec>,
    #[serde(skip)]
    previous_audio: Option<AudioSettings>,
}

impl SetClipAudioCommand {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sequence_id: &str,
        track_id: &str,
        clip_id: &str,
        volume_db: Option<f32>,
        pan: Option<f32>,
        muted: Option<bool>,
        fade_in_sec: Option<TimeSec>,
        fade_out_sec: Option<TimeSec>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            volume_db,
            pan,
            muted,
            fade_in_sec,
            fade_out_sec,
            previous_audio: None,
        }
    }

    fn clamp_volume_db(value: f32) -> f32 {
        value.clamp(MIN_CLIP_VOLUME_DB, MAX_CLIP_VOLUME_DB)
    }

    fn clamp_pan(value: f32) -> f32 {
        value.clamp(-1.0, 1.0)
    }

    fn clamp_fade_duration(value: TimeSec, clip_duration: TimeSec) -> TimeSec {
        value.clamp(0.0, clip_duration.max(0.0))
    }

    fn normalize_fade_pair(
        clip: &mut Clip,
        fade_in_updated: bool,
        fade_out_updated: bool,
    ) {
        let clip_duration = clip.duration().max(0.0);

        clip.audio.fade_in_sec = Self::clamp_fade_duration(clip.audio.fade_in_sec, clip_duration);
        clip.audio.fade_out_sec =
            Self::clamp_fade_duration(clip.audio.fade_out_sec, clip_duration);

        let total_fade = clip.audio.fade_in_sec + clip.audio.fade_out_sec;
        if total_fade <= clip_duration {
            return;
        }

        if fade_in_updated && !fade_out_updated {
            clip.audio.fade_in_sec = (clip_duration - clip.audio.fade_out_sec).max(0.0);
            return;
        }

        clip.audio.fade_out_sec = (clip_duration - clip.audio.fade_in_sec).max(0.0);
    }
}

impl Command for SetClipAudioCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if self.volume_db.is_none()
            && self.pan.is_none()
            && self.muted.is_none()
            && self.fade_in_sec.is_none()
            && self.fade_out_sec.is_none()
        {
            return Err(CoreError::InvalidCommand(
                "SetClipAudio requires at least one audio field".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_audio = Some(clip.audio.clone());

        if let Some(volume_db) = self.volume_db {
            if !volume_db.is_finite() {
                return Err(CoreError::InvalidCommand(
                    "volumeDb must be a finite number".to_string(),
                ));
            }
            clip.audio.volume_db = Self::clamp_volume_db(volume_db);
        }

        if let Some(pan) = self.pan {
            if !pan.is_finite() {
                return Err(CoreError::InvalidCommand(
                    "pan must be a finite number".to_string(),
                ));
            }
            clip.audio.pan = Self::clamp_pan(pan);
        }

        if let Some(muted) = self.muted {
            clip.audio.muted = muted;
        }

        if let Some(fade_in_sec) = self.fade_in_sec {
            if !is_valid_time_sec(fade_in_sec) {
                return Err(CoreError::InvalidCommand(
                    "fadeInSec must be a finite, non-negative number".to_string(),
                ));
            }
            clip.audio.fade_in_sec = fade_in_sec;
        }

        if let Some(fade_out_sec) = self.fade_out_sec {
            if !is_valid_time_sec(fade_out_sec) {
                return Err(CoreError::InvalidCommand(
                    "fadeOutSec must be a finite, non-negative number".to_string(),
                ));
            }
            clip.audio.fade_out_sec = fade_out_sec;
        }

        Self::normalize_fade_pair(
            clip,
            self.fade_in_sec.is_some(),
            self.fade_out_sec.is_some(),
        );

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous_audio) = &self.previous_audio else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.audio = previous_audio.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetClipAudio"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "volumeDb": self.volume_db,
            "pan": self.pan,
            "muted": self.muted,
            "fadeInSec": self.fade_in_sec,
            "fadeOutSec": self.fade_out_sec,
        })
    }
}

// =============================================================================
// SetClipTransformCommand
// =============================================================================

/// Command to update a clip's transform (position/scale/rotation/anchor).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClipTransformCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub transform: Transform,
    #[serde(skip)]
    previous_transform: Option<Transform>,
}

impl SetClipTransformCommand {
    pub fn new(sequence_id: &str, track_id: &str, clip_id: &str, transform: Transform) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            clip_id: clip_id.to_string(),
            transform,
            previous_transform: None,
        }
    }

    fn sanitize_transform(mut transform: Transform) -> Transform {
        // Position/anchor are normalized.
        transform.position.x = transform.position.x.clamp(0.0, 1.0);
        transform.position.y = transform.position.y.clamp(0.0, 1.0);
        transform.anchor.x = transform.anchor.x.clamp(0.0, 1.0);
        transform.anchor.y = transform.anchor.y.clamp(0.0, 1.0);

        // Scale must be finite and non-zero-ish. Clamp to a reasonable range.
        if !transform.scale.x.is_finite() {
            transform.scale.x = 1.0;
        }
        if !transform.scale.y.is_finite() {
            transform.scale.y = 1.0;
        }
        transform.scale.x = transform.scale.x.clamp(0.01, 100.0);
        transform.scale.y = transform.scale.y.clamp(0.01, 100.0);

        // Rotation must be finite.
        if !transform.rotation_deg.is_finite() {
            transform.rotation_deg = 0.0;
        }

        transform
    }
}

impl Command for SetClipTransformCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        self.previous_transform = Some(clip.transform.clone());
        clip.transform = Self::sanitize_transform(self.transform.clone());

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(prev) = &self.previous_transform else {
            return Ok(());
        };

        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };

        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
            clip.transform = prev.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetClipTransform"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "transform": self.transform,
        })
    }
}

impl Command for SplitClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip_idx = track
            .clips
            .iter()
            .position(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        // Store original clip for undo BEFORE any modification
        self.original_clip = Some(track.clips[clip_idx].clone());

        let original = track.clips[clip_idx].clone();

        // Validate split point is within clip bounds
        let clip_start = original.place.timeline_in_sec;
        let clip_end = clip_start + original.duration();

        if self.split_at <= clip_start || self.split_at >= clip_end {
            return Err(CoreError::InvalidSplitPoint(self.split_at));
        }

        // Calculate source time at split point (accounting for speed)
        let relative_split = self.split_at - clip_start;
        let safe_speed = if original.speed > 0.0 {
            original.speed as f64
        } else {
            1.0
        };
        // When speed is applied, the source time advances at a different rate
        // relative_split is in timeline seconds, multiply by speed to get source seconds
        let source_split = original.range.source_in_sec + (relative_split * safe_speed);

        // Create second clip (after split) with ALL properties copied
        let second_source_duration = original.range.source_out_sec - source_split;
        let second_timeline_duration = second_source_duration / safe_speed;

        let mut second_clip = Clip::new(&original.asset_id);
        second_clip.range = ClipRange {
            source_in_sec: source_split,
            source_out_sec: original.range.source_out_sec,
        };
        second_clip.place = ClipPlace {
            timeline_in_sec: self.split_at,
            duration_sec: second_timeline_duration,
        };
        // Copy all properties from original clip
        second_clip.transform = original.transform.clone();
        second_clip.audio = original.audio.clone();
        second_clip.speed = original.speed;
        second_clip.opacity = original.opacity;
        second_clip.effects = original.effects.clone();
        second_clip.label = original.label.clone();
        second_clip.color = original.color.clone();

        let second_clip_id = second_clip.id.clone();

        // Store created clip ID for undo
        self.created_clip_id = Some(second_clip_id.clone());

        // Prepare modified first clip without mutating track until validations pass.
        let mut first_clip = original.clone();
        first_clip.range.source_out_sec = source_split;
        first_clip.place.duration_sec = relative_split;

        if !first_clip.place.duration_sec.is_finite() || first_clip.place.duration_sec <= 0.0 {
            return Err(CoreError::ValidationError(
                "Split produced an invalid first clip duration".to_string(),
            ));
        }
        if !second_clip.place.duration_sec.is_finite() || second_clip.place.duration_sec <= 0.0 {
            return Err(CoreError::ValidationError(
                "Split produced an invalid second clip duration".to_string(),
            ));
        }

        // Validate overlap with the rest of the track BEFORE mutating.
        validate_no_overlap(track, &first_clip.place, Some(&first_clip.id))?;
        validate_no_overlap(track, &second_clip.place, Some(&first_clip.id))?;

        // Apply: replace original clip and insert the new clip in timeline order.
        track.clips[clip_idx] = first_clip;
        insert_clip_sorted(track, second_clip);

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            })
            .with_change(StateChange::ClipCreated {
                clip_id: second_clip_id.clone(),
            })
            .with_created_id(&second_clip_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let (Some(original), Some(created_id)) = (&self.original_clip, &self.created_clip_id) {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) {
                    // Remove the created clip
                    track.clips.retain(|c| &c.id != created_id);

                    // Restore original clip
                    if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                        *clip = original.clone();
                    }

                    sort_track_clips(track);
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SplitClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        assets::{Asset, VideoInfo},
        timeline::{Sequence, SequenceFormat, Track, TrackKind},
        Point2D,
    };

    fn create_test_state() -> ProjectState {
        let mut state = ProjectState::new("Test Project");

        // Add asset
        let asset =
            Asset::new_video("video.mp4", "/video.mp4", VideoInfo::default()).with_duration(60.0);
        state.assets.insert(asset.id.clone(), asset.clone());

        // Add sequence with track
        let mut sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let track = Track::new("Video 1", TrackKind::Video);
        sequence.tracks.push(track);
        state.active_sequence_id = Some(sequence.id.clone());
        state.sequences.insert(sequence.id.clone(), sequence);

        state
    }

    #[test]
    fn test_insert_clip_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 1);
        assert_eq!(track.clips[0].asset_id, asset_id);
    }

    #[test]
    fn test_insert_clip_validates_asset() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        let mut cmd = InsertClipCommand::new(&seq_id, &track_id, "nonexistent_asset", 0.0);
        let result = cmd.execute(&mut state);

        assert!(matches!(result, Err(CoreError::AssetNotFound(_))));
    }

    #[test]
    fn test_insert_clip_with_source_range() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 5.0)
            .with_source_range(10.0, 20.0);

        cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 10.0);
        assert_eq!(clip.range.source_out_sec, 20.0);
        assert_eq!(clip.place.timeline_in_sec, 5.0);
    }

    #[test]
    fn test_move_clip_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // First insert a clip
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Move the clip
        let mut move_cmd = MoveClipCommand::new_simple(&seq_id, &clip_id, 10.0);
        move_cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.place.timeline_in_sec, 10.0);
    }

    #[test]
    fn test_split_clip_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert a 10-second clip
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Split at 5 seconds
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 5.0);
        let result = split_cmd.execute(&mut state).unwrap();

        // Should have created a new clip
        assert_eq!(result.created_ids.len(), 1);

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 2);

        // First clip: 0-5 sec
        let first = &track.clips[0];
        assert_eq!(first.range.source_in_sec, 0.0);
        assert_eq!(first.range.source_out_sec, 5.0);

        // Second clip: 5-10 sec
        let second = &track.clips[1];
        assert_eq!(second.range.source_in_sec, 5.0);
        assert_eq!(second.range.source_out_sec, 10.0);
        assert_eq!(second.place.timeline_in_sec, 5.0);
    }

    #[test]
    fn test_split_clip_invalid_point() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert a clip at position 5-15 (10 sec duration)
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 5.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Try to split before clip start
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 3.0);
        assert!(matches!(
            split_cmd.execute(&mut state),
            Err(CoreError::InvalidSplitPoint(_))
        ));

        // Try to split after clip end
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 20.0);
        assert!(matches!(
            split_cmd.execute(&mut state),
            Err(CoreError::InvalidSplitPoint(_))
        ));
    }

    #[test]
    fn test_trim_clip_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clip
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Trim clip
        let mut trim_cmd = TrimClipCommand::new_simple(&seq_id, &clip_id)
            .with_source_in(2.0)
            .with_source_out(8.0);
        trim_cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 2.0);
        assert_eq!(clip.range.source_out_sec, 8.0);
    }

    #[test]
    fn test_remove_clip_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clip
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);

        // Remove clip
        let mut remove_cmd = RemoveClipCommand::new(&seq_id, &track_id, &clip_id);
        let result = remove_cmd.execute(&mut state).unwrap();

        assert_eq!(result.deleted_ids.len(), 1);
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);
    }

    #[test]
    fn test_command_serialization() {
        let cmd = InsertClipCommand::new("seq_001", "track_001", "asset_001", 5.0)
            .with_source_range(10.0, 20.0);

        let json = cmd.to_json();
        assert_eq!(json["sequenceId"], "seq_001");
        assert_eq!(json["trackId"], "track_001");
        assert_eq!(json["assetId"], "asset_001");
        assert_eq!(json["timelineStart"], 5.0);
    }

    // =============================================================================
    // Undo Tests
    // =============================================================================

    #[test]
    fn test_insert_clip_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);

        // Undo should remove the clip
        cmd.undo(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);
    }

    #[test]
    fn test_remove_clip_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clip
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 5.0)
            .with_source_range(10.0, 20.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Remove clip
        let mut remove_cmd = RemoveClipCommand::new(&seq_id, &track_id, &clip_id);
        remove_cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);

        // Undo should restore the clip
        remove_cmd.undo(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);
        let restored_clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(restored_clip.id, clip_id);
        assert_eq!(restored_clip.place.timeline_in_sec, 5.0);
        assert_eq!(restored_clip.range.source_in_sec, 10.0);
        assert_eq!(restored_clip.range.source_out_sec, 20.0);
    }

    #[test]
    fn test_move_clip_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clip at position 5.0
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 5.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Move clip to position 15.0
        let mut move_cmd = MoveClipCommand::new_simple(&seq_id, &clip_id, 15.0);
        move_cmd.execute(&mut state).unwrap();

        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .place
                .timeline_in_sec,
            15.0
        );

        // Undo should restore position to 5.0
        move_cmd.undo(&mut state).unwrap();

        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .place
                .timeline_in_sec,
            5.0
        );
    }

    #[test]
    fn test_trim_clip_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert clip with source range 0-10
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Trim clip to 2-8
        let mut trim_cmd = TrimClipCommand::new_simple(&seq_id, &clip_id)
            .with_source_in(2.0)
            .with_source_out(8.0);
        trim_cmd.execute(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 2.0);
        assert_eq!(clip.range.source_out_sec, 8.0);

        // Undo should restore to 0-10
        trim_cmd.undo(&mut state).unwrap();

        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 0.0);
        assert_eq!(clip.range.source_out_sec, 10.0);
    }

    #[test]
    fn test_split_clip_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert a 10-second clip
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Split at 5 seconds
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 5.0);
        split_cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 2);

        // Undo should restore single clip with original range
        split_cmd.undo(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);
        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 0.0);
        assert_eq!(clip.range.source_out_sec, 10.0);
    }

    #[test]
    fn test_split_clip_with_speed_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert a clip with speed 2.0x (plays twice as fast)
        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 20.0); // 20 sec of source
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Set speed to 2.0
        state.sequences.get_mut(&seq_id).unwrap().tracks[0].clips[0].speed = 2.0;

        // Timeline duration should be 10 sec (20 source sec / 2.0 speed)
        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.duration(), 10.0);

        // Split at 5 sec (timeline time)
        let mut split_cmd = SplitClipCommand::new(&seq_id, &track_id, &clip_id, 5.0);
        split_cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 2);

        // First clip: source 0-10 (because 5 timeline sec * 2.0 speed = 10 source sec)
        assert_eq!(track.clips[0].range.source_in_sec, 0.0);
        assert_eq!(track.clips[0].range.source_out_sec, 10.0);

        // Second clip: source 10-20
        assert_eq!(track.clips[1].range.source_in_sec, 10.0);
        assert_eq!(track.clips[1].range.source_out_sec, 20.0);
        assert_eq!(track.clips[1].speed, 2.0); // Speed should be copied

        // Undo
        split_cmd.undo(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);
        let clip = &state.sequences[&seq_id].tracks[0].clips[0];
        assert_eq!(clip.range.source_in_sec, 0.0);
        assert_eq!(clip.range.source_out_sec, 20.0);
        assert_eq!(clip.speed, 2.0);
    }

    #[test]
    fn test_move_clip_cross_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track1_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Add second track
        let track2 = Track::new("Video 2", TrackKind::Video);
        let track2_id = track2.id.clone();
        state
            .sequences
            .get_mut(&seq_id)
            .unwrap()
            .tracks
            .push(track2);

        // Insert clip in track 1
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track1_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        // Move clip to track 2 at position 10.0
        let mut move_cmd =
            MoveClipCommand::new_simple(&seq_id, &clip_id, 10.0).to_track(&track2_id);
        move_cmd.execute(&mut state).unwrap();

        // Verify clip moved to track 2
        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 0);
        assert_eq!(state.sequences[&seq_id].tracks[1].clips.len(), 1);
        assert_eq!(
            state.sequences[&seq_id].tracks[1].clips[0]
                .place
                .timeline_in_sec,
            10.0
        );

        // Undo should move back to track 1
        move_cmd.undo(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 1);
        assert_eq!(state.sequences[&seq_id].tracks[1].clips.len(), 0);
        assert_eq!(
            state.sequences[&seq_id].tracks[0].clips[0]
                .place
                .timeline_in_sec,
            0.0
        );
    }

    #[test]
    fn test_remove_clip_preserves_position_on_undo() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert 3 clips
        for i in 0..3 {
            // Use short, non-overlapping durations to satisfy the timeline invariant
            // that clips on the same track cannot overlap.
            let mut cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, (i * 10) as f64)
                .with_source_range(0.0, 5.0);
            cmd.execute(&mut state).unwrap();
        }

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3);

        // Get the middle clip ID
        let middle_clip_id = track.clips[1].id.clone();

        // Remove middle clip
        let mut remove_cmd = RemoveClipCommand::new(&seq_id, &track_id, &middle_clip_id);
        remove_cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks[0].clips.len(), 2);

        // Undo should restore clip at position 1 (middle)
        remove_cmd.undo(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.clips.len(), 3);
        assert_eq!(track.clips[1].id, middle_clip_id);
    }

    #[test]
    fn test_set_clip_transform_command_updates_and_undoes() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        // Insert a clip.
        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        let original = state.sequences[&seq_id].tracks[0].clips[0]
            .transform
            .clone();

        let mut cmd = SetClipTransformCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            Transform {
                position: Point2D::new(0.25, 0.75),
                scale: Point2D::new(1.5, 0.5),
                rotation_deg: 15.0,
                anchor: Point2D::center(),
            },
        );

        cmd.execute(&mut state).unwrap();

        let updated = &state.sequences[&seq_id].tracks[0].clips[0].transform;
        assert_eq!(updated.position.x, 0.25);
        assert_eq!(updated.position.y, 0.75);
        assert_eq!(updated.scale.x, 1.5);
        assert_eq!(updated.scale.y, 0.5);
        assert_eq!(updated.rotation_deg, 15.0);

        cmd.undo(&mut state).unwrap();
        let restored = &state.sequences[&seq_id].tracks[0].clips[0].transform;
        assert_eq!(restored, &original);
    }

    #[test]
    fn test_set_clip_mute_command_updates_and_undoes() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd = InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();
        assert!(!state.sequences[&seq_id].tracks[0].clips[0].audio.muted);

        let mut mute_cmd = SetClipMuteCommand::new(&seq_id, &track_id, &clip_id, true);
        mute_cmd.execute(&mut state).unwrap();

        assert!(state.sequences[&seq_id].tracks[0].clips[0].audio.muted);

        mute_cmd.undo(&mut state).unwrap();

        assert!(!state.sequences[&seq_id].tracks[0].clips[0].audio.muted);
    }

    #[test]
    fn test_set_clip_audio_command_updates_and_undoes() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();
        let asset_id = state.assets.keys().next().unwrap().clone();

        let mut insert_cmd =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 10.0);
        insert_cmd.execute(&mut state).unwrap();

        let clip_id = state.sequences[&seq_id].tracks[0].clips[0].id.clone();

        let mut audio_cmd = SetClipAudioCommand::new(
            &seq_id,
            &track_id,
            &clip_id,
            Some(24.0),
            Some(2.0),
            Some(true),
            Some(8.0),
            Some(8.0),
        );
        audio_cmd.execute(&mut state).unwrap();

        let audio = &state.sequences[&seq_id].tracks[0].clips[0].audio;
        assert_eq!(audio.volume_db, MAX_CLIP_VOLUME_DB);
        assert_eq!(audio.pan, 1.0);
        assert!(audio.muted);
        assert_eq!(audio.fade_in_sec, 8.0);
        assert_eq!(audio.fade_out_sec, 2.0);

        audio_cmd.undo(&mut state).unwrap();

        let restored = &state.sequences[&seq_id].tracks[0].clips[0].audio;
        assert_eq!(restored.volume_db, 0.0);
        assert_eq!(restored.pan, 0.0);
        assert!(!restored.muted);
        assert_eq!(restored.fade_in_sec, 0.0);
        assert_eq!(restored.fade_out_sec, 0.0);
    }
}

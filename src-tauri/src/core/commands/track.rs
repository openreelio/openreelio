//! Track Commands Module
//!
//! Implements all track-related editing commands.

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    project::ProjectState,
    timeline::{Track, TrackKind},
    CoreError, CoreResult, SequenceId, TrackId,
};

// =============================================================================
// AddTrackCommand
// =============================================================================

/// Command to add a new track to a sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTrackCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Track name
    pub name: String,
    /// Track type
    pub kind: TrackKind,
    /// Position to insert at (optional, defaults to end)
    pub position: Option<usize>,
    /// Created track ID (stored after execution)
    #[serde(skip)]
    created_track_id: Option<TrackId>,
}

impl AddTrackCommand {
    /// Creates a new add track command
    pub fn new(sequence_id: &str, name: &str, kind: TrackKind) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            name: name.to_string(),
            kind,
            position: None,
            created_track_id: None,
        }
    }

    /// Sets the position to insert the track at
    pub fn at_position(mut self, position: usize) -> Self {
        self.position = Some(position);
        self
    }
}

impl Command for AddTrackCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = Track::new(&self.name, self.kind.clone());
        let track_id = track.id.clone();

        // Store created track ID for undo
        self.created_track_id = Some(track_id.clone());

        if let Some(pos) = self.position {
            if pos <= sequence.tracks.len() {
                sequence.tracks.insert(pos, track);
            } else {
                sequence.tracks.push(track);
            }
        } else {
            sequence.tracks.push(track);
        }

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::TrackCreated {
                track_id: track_id.clone(),
            })
            .with_created_id(&track_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(track_id) = &self.created_track_id {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                sequence.tracks.retain(|t| &t.id != track_id);
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "AddTrack"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// RemoveTrackCommand
// =============================================================================

/// Command to remove a track from a sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveTrackCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Track ID to remove
    pub track_id: TrackId,
    /// Removed track data (for undo)
    #[serde(skip)]
    removed_track: Option<Track>,
    /// Original position (for undo)
    #[serde(skip)]
    original_position: Option<usize>,
}

impl RemoveTrackCommand {
    /// Creates a new remove track command
    pub fn new(sequence_id: &str, track_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            removed_track: None,
            original_position: None,
        }
    }
}

impl Command for RemoveTrackCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let position = sequence
            .tracks
            .iter()
            .position(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        // Store track and position before removal for undo
        self.removed_track = Some(sequence.tracks[position].clone());
        self.original_position = Some(position);

        sequence.tracks.remove(position);

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::TrackDeleted {
                track_id: self.track_id.clone(),
            })
            .with_deleted_id(&self.track_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let (Some(track), Some(position)) = (&self.removed_track, self.original_position) {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                if position <= sequence.tracks.len() {
                    sequence.tracks.insert(position, track.clone());
                } else {
                    sequence.tracks.push(track.clone());
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RemoveTrack"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// ReorderTracksCommand
// =============================================================================

/// Command to reorder tracks in a sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderTracksCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// New order of track IDs
    pub new_order: Vec<TrackId>,
    /// Original order (for undo)
    #[serde(skip)]
    original_order: Option<Vec<TrackId>>,
}

impl ReorderTracksCommand {
    /// Creates a new reorder tracks command
    pub fn new(sequence_id: &str, new_order: Vec<String>) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            new_order,
            original_order: None,
        }
    }
}

impl Command for ReorderTracksCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // Store original order before reordering for undo
        self.original_order = Some(sequence.tracks.iter().map(|t| t.id.clone()).collect());

        // Reorder tracks based on the provided order
        sequence.tracks.sort_by(|a, b| {
            let a_idx = self.new_order.iter().position(|id| id == &a.id).unwrap_or(usize::MAX);
            let b_idx = self.new_order.iter().position(|id| id == &b.id).unwrap_or(usize::MAX);
            a_idx.cmp(&b_idx)
        });

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id).with_change(StateChange::SequenceModified {
            sequence_id: self.sequence_id.clone(),
        }))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(original_order) = &self.original_order {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                sequence.tracks.sort_by(|a, b| {
                    let a_idx = original_order.iter().position(|id| id == &a.id).unwrap_or(usize::MAX);
                    let b_idx = original_order.iter().position(|id| id == &b.id).unwrap_or(usize::MAX);
                    a_idx.cmp(&b_idx)
                });
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "ReorderTracks"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// RenameTrackCommand
// =============================================================================

/// Command to rename a track
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameTrackCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Track ID to rename
    pub track_id: TrackId,
    /// New name
    pub new_name: String,
    /// Original name (for undo)
    #[serde(skip)]
    original_name: Option<String>,
}

impl RenameTrackCommand {
    /// Creates a new rename track command
    pub fn new(sequence_id: &str, track_id: &str, new_name: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            new_name: new_name.to_string(),
            original_name: None,
        }
    }
}

impl Command for RenameTrackCommand {
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

        // Store original name before modification for undo
        self.original_name = Some(track.name.clone());

        track.name = self.new_name.clone();

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id).with_change(StateChange::TrackModified {
            track_id: self.track_id.clone(),
        }))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(original_name) = &self.original_name {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) {
                    track.name = original_name.clone();
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RenameTrack"
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
    use crate::core::timeline::{Sequence, SequenceFormat};

    fn create_test_state() -> ProjectState {
        let mut state = ProjectState::new("Test Project");

        let sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        state.active_sequence_id = Some(sequence.id.clone());
        state.sequences.insert(sequence.id.clone(), sequence);

        state
    }

    #[test]
    fn test_add_track_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        let mut cmd = AddTrackCommand::new(&seq_id, "Video 1", TrackKind::Video);
        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);
        assert_eq!(state.sequences[&seq_id].tracks.len(), 1);
        assert_eq!(state.sequences[&seq_id].tracks[0].name, "Video 1");
    }

    #[test]
    fn test_add_track_at_position() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        // Add first track
        let mut cmd1 = AddTrackCommand::new(&seq_id, "Video 1", TrackKind::Video);
        cmd1.execute(&mut state).unwrap();

        // Add second track
        let mut cmd2 = AddTrackCommand::new(&seq_id, "Video 2", TrackKind::Video);
        cmd2.execute(&mut state).unwrap();

        // Insert at position 1
        let mut cmd3 = AddTrackCommand::new(&seq_id, "Audio 1", TrackKind::Audio).at_position(1);
        cmd3.execute(&mut state).unwrap();

        let tracks = &state.sequences[&seq_id].tracks;
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0].name, "Video 1");
        assert_eq!(tracks[1].name, "Audio 1");
        assert_eq!(tracks[2].name, "Video 2");
    }

    #[test]
    fn test_remove_track_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        // Add track
        let mut add_cmd = AddTrackCommand::new(&seq_id, "Video 1", TrackKind::Video);
        let result = add_cmd.execute(&mut state).unwrap();
        let track_id = &result.created_ids[0];

        // Remove track
        let mut remove_cmd = RemoveTrackCommand::new(&seq_id, track_id);
        remove_cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].tracks.len(), 0);
    }

    #[test]
    fn test_reorder_tracks_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        // Add tracks
        let mut cmd1 = AddTrackCommand::new(&seq_id, "A", TrackKind::Video);
        let r1 = cmd1.execute(&mut state).unwrap();

        let mut cmd2 = AddTrackCommand::new(&seq_id, "B", TrackKind::Video);
        let r2 = cmd2.execute(&mut state).unwrap();

        let mut cmd3 = AddTrackCommand::new(&seq_id, "C", TrackKind::Video);
        let r3 = cmd3.execute(&mut state).unwrap();

        // Reorder to C, A, B
        let new_order = vec![
            r3.created_ids[0].clone(),
            r1.created_ids[0].clone(),
            r2.created_ids[0].clone(),
        ];

        let mut reorder_cmd = ReorderTracksCommand::new(&seq_id, new_order);
        reorder_cmd.execute(&mut state).unwrap();

        let tracks = &state.sequences[&seq_id].tracks;
        assert_eq!(tracks[0].name, "C");
        assert_eq!(tracks[1].name, "A");
        assert_eq!(tracks[2].name, "B");
    }

    #[test]
    fn test_rename_track_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        // Add track
        let mut add_cmd = AddTrackCommand::new(&seq_id, "Original Name", TrackKind::Video);
        let result = add_cmd.execute(&mut state).unwrap();
        let track_id = &result.created_ids[0];

        // Rename track
        let mut rename_cmd = RenameTrackCommand::new(&seq_id, track_id, "New Name");
        rename_cmd.execute(&mut state).unwrap();

        let track = &state.sequences[&seq_id].tracks[0];
        assert_eq!(track.name, "New Name");
    }

    #[test]
    fn test_remove_nonexistent_track() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        let mut cmd = RemoveTrackCommand::new(&seq_id, "nonexistent_track");
        let result = cmd.execute(&mut state);

        assert!(matches!(result, Err(CoreError::TrackNotFound(_))));
    }
}

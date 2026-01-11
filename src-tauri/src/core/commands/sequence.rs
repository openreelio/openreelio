//! Sequence Commands Module
//!
//! Implements all sequence-related editing commands.

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    project::ProjectState,
    timeline::{Sequence, SequenceFormat, Track, TrackKind},
    CoreError, CoreResult, SequenceId,
};

// =============================================================================
// CreateSequenceCommand
// =============================================================================

/// Command to create a new sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSequenceCommand {
    /// Sequence name
    pub name: String,
    /// Sequence format preset
    pub format: String,
    /// Whether to add default tracks
    pub add_default_tracks: bool,
    /// Created sequence ID (stored after execution for undo)
    #[serde(skip)]
    created_sequence_id: Option<SequenceId>,
}

impl CreateSequenceCommand {
    /// Creates a new create sequence command
    pub fn new(name: &str, format: &str) -> Self {
        Self {
            name: name.to_string(),
            format: format.to_string(),
            add_default_tracks: true,
            created_sequence_id: None,
        }
    }

    /// Sets whether to add default tracks
    pub fn with_default_tracks(mut self, add: bool) -> Self {
        self.add_default_tracks = add;
        self
    }
}

impl Command for CreateSequenceCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Parse format
        let seq_format = match self.format.as_str() {
            "1080p" | "youtube_1080" => SequenceFormat::youtube_1080(),
            "4k" | "youtube_4k" => SequenceFormat::youtube_4k(),
            "shorts" | "youtube_shorts" => SequenceFormat::youtube_shorts(),
            _ => SequenceFormat::youtube_1080(),
        };

        // Create sequence
        let mut sequence = Sequence::new(&self.name, seq_format);

        // Add default tracks if requested
        if self.add_default_tracks {
            let video_track = Track::new("Video 1", TrackKind::Video);
            let audio_track = Track::new("Audio 1", TrackKind::Audio);
            sequence.add_track(video_track);
            sequence.add_track(audio_track);
        }

        let seq_id = sequence.id.clone();
        self.created_sequence_id = Some(seq_id.clone());

        // Insert into state
        state.sequences.insert(seq_id.clone(), sequence);

        // Set as active if first sequence
        if state.active_sequence_id.is_none() {
            state.active_sequence_id = Some(seq_id.clone());
        }

        state.is_dirty = true;

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::SequenceCreated {
                sequence_id: seq_id.clone(),
            })
            .with_created_id(&seq_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(ref seq_id) = self.created_sequence_id {
            state.sequences.remove(seq_id);

            // Clear active sequence if it was this one
            if state.active_sequence_id.as_ref() == Some(seq_id) {
                state.active_sequence_id = state.sequences.keys().next().cloned();
            }

            state.is_dirty = true;
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "CreateSequence"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// DeleteSequenceCommand
// =============================================================================

/// Command to delete a sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSequenceCommand {
    /// Sequence ID to delete
    pub sequence_id: SequenceId,
    /// Stored sequence data for undo
    #[serde(skip)]
    deleted_sequence: Option<Sequence>,
    /// Whether this was the active sequence
    #[serde(skip)]
    was_active: bool,
}

impl DeleteSequenceCommand {
    /// Creates a new delete sequence command
    pub fn new(sequence_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            deleted_sequence: None,
            was_active: false,
        }
    }
}

impl Command for DeleteSequenceCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Check if sequence exists
        let sequence = state
            .sequences
            .get(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?
            .clone();

        // Store for undo
        self.deleted_sequence = Some(sequence);
        self.was_active = state.active_sequence_id.as_ref() == Some(&self.sequence_id);

        // Remove from state
        state.sequences.remove(&self.sequence_id);

        // Update active sequence if needed
        if self.was_active {
            state.active_sequence_id = state.sequences.keys().next().cloned();
        }

        state.is_dirty = true;

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::SequenceModified {
                sequence_id: self.sequence_id.clone(),
            })
            .with_deleted_id(&self.sequence_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(ref sequence) = self.deleted_sequence {
            state
                .sequences
                .insert(self.sequence_id.clone(), sequence.clone());

            // Restore active sequence if it was active
            if self.was_active {
                state.active_sequence_id = Some(self.sequence_id.clone());
            }

            state.is_dirty = true;
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "DeleteSequence"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "sequenceId": self.sequence_id })
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_state() -> ProjectState {
        ProjectState::new("Test Project")
    }

    #[test]
    fn test_create_sequence_command() {
        let mut state = create_test_state();
        assert!(state.sequences.is_empty());

        let mut cmd = CreateSequenceCommand::new("Main Sequence", "1080p");
        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);
        assert_eq!(state.sequences.len(), 1);

        let seq = state.sequences.values().next().unwrap();
        assert_eq!(seq.name, "Main Sequence");
        assert_eq!(seq.tracks.len(), 2); // Video + Audio default tracks
    }

    #[test]
    fn test_create_sequence_sets_active() {
        let mut state = create_test_state();
        assert!(state.active_sequence_id.is_none());

        let mut cmd = CreateSequenceCommand::new("First", "1080p");
        cmd.execute(&mut state).unwrap();

        assert!(state.active_sequence_id.is_some());
    }

    #[test]
    fn test_create_sequence_without_default_tracks() {
        let mut state = create_test_state();

        let mut cmd = CreateSequenceCommand::new("Empty Sequence", "1080p")
            .with_default_tracks(false);
        cmd.execute(&mut state).unwrap();

        let seq = state.sequences.values().next().unwrap();
        assert!(seq.tracks.is_empty());
    }

    #[test]
    fn test_create_sequence_undo() {
        let mut state = create_test_state();

        let mut cmd = CreateSequenceCommand::new("To Remove", "1080p");
        cmd.execute(&mut state).unwrap();
        assert_eq!(state.sequences.len(), 1);

        cmd.undo(&mut state).unwrap();
        assert!(state.sequences.is_empty());
    }

    #[test]
    fn test_delete_sequence_command() {
        let mut state = create_test_state();

        // Create sequence first
        let mut create_cmd = CreateSequenceCommand::new("To Delete", "1080p");
        let result = create_cmd.execute(&mut state).unwrap();
        let seq_id = result.created_ids[0].clone();

        // Delete it
        let mut delete_cmd = DeleteSequenceCommand::new(&seq_id);
        delete_cmd.execute(&mut state).unwrap();

        assert!(state.sequences.is_empty());
    }

    #[test]
    fn test_delete_sequence_undo() {
        let mut state = create_test_state();

        // Create and delete
        let mut create_cmd = CreateSequenceCommand::new("Restorable", "1080p");
        let result = create_cmd.execute(&mut state).unwrap();
        let seq_id = result.created_ids[0].clone();

        let mut delete_cmd = DeleteSequenceCommand::new(&seq_id);
        delete_cmd.execute(&mut state).unwrap();
        assert!(state.sequences.is_empty());

        // Undo deletion
        delete_cmd.undo(&mut state).unwrap();
        assert_eq!(state.sequences.len(), 1);
        assert_eq!(state.sequences.get(&seq_id).unwrap().name, "Restorable");
    }

    #[test]
    fn test_delete_nonexistent_sequence() {
        let mut state = create_test_state();

        let mut cmd = DeleteSequenceCommand::new("nonexistent");
        let result = cmd.execute(&mut state);

        assert!(matches!(result, Err(CoreError::SequenceNotFound(_))));
    }
}

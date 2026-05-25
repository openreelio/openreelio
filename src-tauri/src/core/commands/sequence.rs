//! Sequence Commands Module
//!
//! Implements all sequence-related editing commands.

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    project::ProjectState,
    timeline::{Sequence, SequenceFormat, SequenceHdrSettings, Track, TrackKind},
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
    /// Previously active sequence ID, restored on undo when possible.
    #[serde(skip)]
    previous_active_sequence_id: Option<SequenceId>,
}

impl CreateSequenceCommand {
    /// Creates a new create sequence command
    pub fn new(name: &str, format: &str) -> Self {
        Self {
            name: name.to_string(),
            format: format.to_string(),
            add_default_tracks: true,
            created_sequence_id: None,
            previous_active_sequence_id: None,
        }
    }

    /// Sets whether to add default tracks
    pub fn with_default_tracks(mut self, add: bool) -> Self {
        self.add_default_tracks = add;
        self
    }

    fn resolve_sequence_format(format: &str) -> SequenceFormat {
        match format.trim().to_ascii_lowercase().as_str() {
            "1080p" | "youtube_1080" | "youtube_1080p" | "landscape_1080" | "1920x1080" => {
                SequenceFormat::youtube_1080()
            }
            "4k" | "uhd_4k" | "youtube_4k" | "3840x2160" => SequenceFormat::youtube_4k(),
            "shorts" | "youtube_shorts" | "shorts_1080" | "vertical" | "vertical_1080"
            | "vertical_1080p" | "portrait_1080" | "1080x1920" | "9:16" => {
                SequenceFormat::youtube_shorts()
            }
            _ => SequenceFormat::youtube_1080(),
        }
    }
}

impl Command for CreateSequenceCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let seq_format = Self::resolve_sequence_format(&self.format);

        // Create sequence
        let mut sequence = Sequence::new(&self.name, seq_format);

        // Add default tracks if requested
        if self.add_default_tracks {
            let video_track = Track::new("Video 1", TrackKind::Video).with_base_track(true);
            let audio_track = Track::new("Audio 1", TrackKind::Audio).with_base_track(true);
            sequence.add_track(video_track);
            sequence.add_track(audio_track);
        }

        let seq_id = sequence.id.clone();
        self.created_sequence_id = Some(seq_id.clone());
        self.previous_active_sequence_id = state.active_sequence_id.clone();

        // Insert into state
        state.sequences.insert(seq_id.clone(), sequence);

        // Newly created sequences should be visible immediately in the editor.
        state.active_sequence_id = Some(seq_id.clone());

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

            // Restore the previous active sequence when possible.
            if state.active_sequence_id.as_ref() == Some(seq_id) {
                state.active_sequence_id = self
                    .previous_active_sequence_id
                    .as_ref()
                    .filter(|previous_id| state.sequences.contains_key(*previous_id))
                    .cloned()
                    .or_else(|| state.sequences.keys().next().cloned());
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
// SetMasterVolumeCommand
// =============================================================================

const MASTER_MIN_VOLUME_DB: f32 = -60.0;
const MASTER_MAX_VOLUME_DB: f32 = 6.0;

/// Command to set the master output volume on a sequence.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMasterVolumeCommand {
    pub sequence_id: SequenceId,
    pub volume_db: f32,
    #[serde(skip)]
    previous_volume_db: Option<f32>,
}

impl SetMasterVolumeCommand {
    pub fn new(sequence_id: &str, volume_db: f32) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            volume_db,
            previous_volume_db: None,
        }
    }
}

impl Command for SetMasterVolumeCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !self.volume_db.is_finite() {
            return Err(CoreError::InvalidCommand(
                "Master volume must be a finite number".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        self.previous_volume_db = Some(sequence.master_volume_db);
        sequence.master_volume_db = self
            .volume_db
            .clamp(MASTER_MIN_VOLUME_DB, MASTER_MAX_VOLUME_DB);

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::SequenceModified {
                sequence_id: self.sequence_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous) = self.previous_volume_db else {
            return Ok(());
        };

        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            sequence.master_volume_db = previous;
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetMasterVolume"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "volumeDb": self.volume_db,
        })
    }
}

// =============================================================================
// UpdateSequenceHdrSettingsCommand
// =============================================================================

/// Command to update sequence-level HDR export settings.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSequenceHdrSettingsCommand {
    pub sequence_id: SequenceId,
    pub settings: SequenceHdrSettings,
    #[serde(skip)]
    previous_settings: Option<SequenceHdrSettings>,
}

impl UpdateSequenceHdrSettingsCommand {
    pub fn new(sequence_id: &str, settings: SequenceHdrSettings) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            settings: settings.normalized(),
            previous_settings: None,
        }
    }
}

impl Command for UpdateSequenceHdrSettingsCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        self.settings = self.settings.clone().normalized();
        self.previous_settings = Some(sequence.hdr_settings.clone());
        sequence.hdr_settings = self.settings.clone();
        sequence.modified_at = chrono::Utc::now().to_rfc3339();
        state.is_dirty = true;

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::SequenceModified {
                sequence_id: self.sequence_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous) = &self.previous_settings else {
            return Ok(());
        };

        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            sequence.hdr_settings = previous.clone();
            sequence.modified_at = chrono::Utc::now().to_rfc3339();
            state.is_dirty = true;
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "UpdateSequenceHdrSettings"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "settings": self.settings,
        })
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::SequenceHdrMode;

    fn create_test_state() -> ProjectState {
        // Use new_empty for isolated sequence tests
        ProjectState::new_empty("Test Project")
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
    fn test_create_sequence_replaces_active_sequence() {
        let mut state = create_test_state();

        let mut first_cmd = CreateSequenceCommand::new("First", "1080p");
        first_cmd.execute(&mut state).unwrap();
        let first_id = state.active_sequence_id.clone().unwrap();

        let mut second_cmd = CreateSequenceCommand::new("Second", "1080p");
        second_cmd.execute(&mut state).unwrap();
        let second_id = state.active_sequence_id.clone().unwrap();

        assert_ne!(first_id, second_id);
        assert_eq!(state.sequences.get(&second_id).unwrap().name, "Second");

        second_cmd.undo(&mut state).unwrap();
        assert_eq!(state.active_sequence_id, Some(first_id));
    }

    #[test]
    fn test_create_sequence_accepts_vertical_format_aliases() {
        for alias in [
            "shorts",
            "youtube_shorts",
            "vertical_1080",
            "1080x1920",
            "9:16",
        ] {
            let format = CreateSequenceCommand::resolve_sequence_format(alias);
            assert_eq!(format.canvas.width, 1080, "alias: {alias}");
            assert_eq!(format.canvas.height, 1920, "alias: {alias}");
        }
    }

    #[test]
    fn test_create_sequence_without_default_tracks() {
        let mut state = create_test_state();

        let mut cmd =
            CreateSequenceCommand::new("Empty Sequence", "1080p").with_default_tracks(false);
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

    // =========================================================================
    // SetMasterVolumeCommand Tests
    // =========================================================================

    fn create_test_state_with_sequence() -> (ProjectState, String) {
        let mut state = create_test_state();
        let mut cmd = CreateSequenceCommand::new("Test Seq", "1080p");
        let result = cmd.execute(&mut state).unwrap();
        let seq_id = result.created_ids[0].clone();
        (state, seq_id)
    }

    #[test]
    fn test_set_master_volume_applies_value() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = SetMasterVolumeCommand::new(&seq_id, -6.0);
        cmd.execute(&mut state).unwrap();

        assert!((state.sequences[&seq_id].master_volume_db - (-6.0)).abs() < 1e-6);
    }

    #[test]
    fn test_set_master_volume_clamps_to_range() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        // Above max
        let mut cmd = SetMasterVolumeCommand::new(&seq_id, 20.0);
        cmd.execute(&mut state).unwrap();
        assert!((state.sequences[&seq_id].master_volume_db - 6.0).abs() < 1e-6);

        // Below min
        let mut cmd2 = SetMasterVolumeCommand::new(&seq_id, -100.0);
        cmd2.execute(&mut state).unwrap();
        assert!((state.sequences[&seq_id].master_volume_db - (-60.0)).abs() < 1e-6);
    }

    #[test]
    fn test_set_master_volume_undo_restores_previous() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = SetMasterVolumeCommand::new(&seq_id, -12.0);
        cmd.execute(&mut state).unwrap();
        assert!((state.sequences[&seq_id].master_volume_db - (-12.0)).abs() < 1e-6);

        cmd.undo(&mut state).unwrap();
        assert!((state.sequences[&seq_id].master_volume_db - 0.0).abs() < 1e-6);
    }

    #[test]
    fn test_set_master_volume_rejects_nan() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = SetMasterVolumeCommand::new(&seq_id, f32::NAN);
        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_master_volume_persists_in_project() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = SetMasterVolumeCommand::new(&seq_id, -3.0);
        cmd.execute(&mut state).unwrap();

        // Verify the value is stored on the sequence
        let seq = state.sequences.get(&seq_id).unwrap();
        assert!((seq.master_volume_db - (-3.0)).abs() < 1e-6);
    }

    #[test]
    fn test_update_sequence_hdr_settings_normalizes_and_undoes() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = UpdateSequenceHdrSettingsCommand::new(
            &seq_id,
            SequenceHdrSettings {
                hdr_mode: SequenceHdrMode::Hdr10,
                max_cll: Some(20000),
                max_fall: None,
                bit_depth: 8,
            },
        );
        cmd.execute(&mut state).unwrap();

        let settings = &state.sequences[&seq_id].hdr_settings;
        assert_eq!(settings.hdr_mode, SequenceHdrMode::Hdr10);
        assert_eq!(settings.bit_depth, 10);
        assert_eq!(settings.max_cll, Some(10000));
        assert_eq!(settings.max_fall, Some(400));

        cmd.undo(&mut state).unwrap();

        let settings = &state.sequences[&seq_id].hdr_settings;
        assert_eq!(settings.hdr_mode, SequenceHdrMode::Sdr);
        assert_eq!(settings.bit_depth, 8);
        assert_eq!(settings.max_cll, None);
        assert_eq!(settings.max_fall, None);
    }
}

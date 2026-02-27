//! Marker Commands Module
//!
//! Implements all marker-related editing commands.

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    project::ProjectState,
    timeline::{Marker, MarkerType},
    Color, CoreError, CoreResult, SequenceId, TimeSec,
};

// =============================================================================
// AddMarkerCommand
// =============================================================================

/// Command to add a new marker to a sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMarkerCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Time position in seconds
    pub time_sec: TimeSec,
    /// Marker label
    pub label: String,
    /// Optional marker color (defaults to yellow)
    pub color: Option<Color>,
    /// Optional marker type (defaults to Generic)
    pub marker_type: Option<MarkerType>,
    /// Created marker ID (stored after execution)
    #[serde(skip)]
    created_marker_id: Option<String>,
}

impl AddMarkerCommand {
    /// Creates a new add marker command
    pub fn new(sequence_id: &str, time_sec: TimeSec, label: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            time_sec,
            label: label.to_string(),
            color: None,
            marker_type: None,
            created_marker_id: None,
        }
    }

    /// Sets the marker color
    pub fn with_color(mut self, color: Color) -> Self {
        self.color = Some(color);
        self
    }

    /// Sets the marker type
    pub fn with_marker_type(mut self, marker_type: MarkerType) -> Self {
        self.marker_type = Some(marker_type);
        self
    }
}

impl Command for AddMarkerCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let mut marker = Marker::new(self.time_sec, &self.label);

        if let Some(color) = &self.color {
            marker.color = color.clone();
        }
        if let Some(marker_type) = &self.marker_type {
            marker.marker_type = marker_type.clone();
        }

        let marker_id = marker.id.clone();

        // Store created marker ID for undo
        self.created_marker_id = Some(marker_id.clone());

        sequence.add_marker(marker);

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::MarkerCreated {
                marker_id: marker_id.clone(),
            })
            .with_created_id(&marker_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let marker_id = self.created_marker_id.as_ref().ok_or_else(|| {
            CoreError::Internal(
                "AddMarkerCommand::undo called before execute (no created_marker_id)".to_string(),
            )
        })?;

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        sequence
            .remove_marker(marker_id)
            .ok_or_else(|| CoreError::MarkerNotFound(marker_id.clone()))?;

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "AddMarker"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// RemoveMarkerCommand
// =============================================================================

/// Command to remove a marker from a sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveMarkerCommand {
    /// Target sequence ID
    pub sequence_id: SequenceId,
    /// Marker ID to remove
    pub marker_id: String,
    /// Removed marker data (for undo)
    #[serde(skip)]
    removed_marker: Option<Marker>,
}

impl RemoveMarkerCommand {
    /// Creates a new remove marker command
    pub fn new(sequence_id: &str, marker_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            marker_id: marker_id.to_string(),
            removed_marker: None,
        }
    }
}

impl Command for RemoveMarkerCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let marker = sequence
            .remove_marker(&self.marker_id)
            .ok_or_else(|| CoreError::MarkerNotFound(self.marker_id.clone()))?;

        // Store marker before removal for undo
        self.removed_marker = Some(marker);

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::MarkerDeleted {
                marker_id: self.marker_id.clone(),
            })
            .with_deleted_id(&self.marker_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let marker = self.removed_marker.as_ref().ok_or_else(|| {
            CoreError::Internal(
                "RemoveMarkerCommand::undo called before execute (no removed_marker)".to_string(),
            )
        })?;

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        sequence.add_marker(marker.clone());
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RemoveMarker"
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
    fn test_add_marker_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        let mut cmd = AddMarkerCommand::new(&seq_id, 5.0, "Chapter 1");
        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);
        assert_eq!(state.sequences[&seq_id].markers.len(), 1);
        assert_eq!(state.sequences[&seq_id].markers[0].label, "Chapter 1");
        assert_eq!(state.sequences[&seq_id].markers[0].time_sec, 5.0);
    }

    #[test]
    fn test_add_marker_with_options() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        let mut cmd = AddMarkerCommand::new(&seq_id, 10.0, "Hook")
            .with_color(Color::rgb(1.0, 0.0, 0.0))
            .with_marker_type(MarkerType::Hook);
        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);
        let marker = &state.sequences[&seq_id].markers[0];
        assert_eq!(marker.label, "Hook");
        assert_eq!(marker.color, Color::rgb(1.0, 0.0, 0.0));
        assert_eq!(marker.marker_type, MarkerType::Hook);
    }

    #[test]
    fn test_remove_marker_command() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        // Add a marker first
        let mut add_cmd = AddMarkerCommand::new(&seq_id, 5.0, "Chapter 1");
        let add_result = add_cmd.execute(&mut state).unwrap();
        let marker_id = &add_result.created_ids[0];

        // Remove the marker
        let mut remove_cmd = RemoveMarkerCommand::new(&seq_id, marker_id);
        let remove_result = remove_cmd.execute(&mut state).unwrap();

        assert_eq!(remove_result.deleted_ids.len(), 1);
        assert_eq!(remove_result.deleted_ids[0], *marker_id);
        assert_eq!(state.sequences[&seq_id].markers.len(), 0);
    }

    #[test]
    fn test_undo_add_marker() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        let mut cmd = AddMarkerCommand::new(&seq_id, 5.0, "Chapter 1");
        cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].markers.len(), 1);

        // Undo should remove the marker
        cmd.undo(&mut state).unwrap();
        assert_eq!(state.sequences[&seq_id].markers.len(), 0);
    }

    #[test]
    fn test_undo_remove_marker() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        // Add a marker first
        let mut add_cmd = AddMarkerCommand::new(&seq_id, 5.0, "Chapter 1");
        let add_result = add_cmd.execute(&mut state).unwrap();
        let marker_id = &add_result.created_ids[0];

        // Remove the marker
        let mut remove_cmd = RemoveMarkerCommand::new(&seq_id, marker_id);
        remove_cmd.execute(&mut state).unwrap();

        assert_eq!(state.sequences[&seq_id].markers.len(), 0);

        // Undo should re-insert the marker
        remove_cmd.undo(&mut state).unwrap();
        assert_eq!(state.sequences[&seq_id].markers.len(), 1);
        assert_eq!(state.sequences[&seq_id].markers[0].label, "Chapter 1");
        assert_eq!(state.sequences[&seq_id].markers[0].time_sec, 5.0);
    }

    #[test]
    fn test_remove_nonexistent_marker() {
        let mut state = create_test_state();
        let seq_id = state.active_sequence_id.clone().unwrap();

        let mut cmd = RemoveMarkerCommand::new(&seq_id, "nonexistent_marker");
        let result = cmd.execute(&mut state);

        assert!(matches!(result, Err(CoreError::MarkerNotFound(_))));
    }

    #[test]
    fn test_add_marker_to_nonexistent_sequence() {
        let mut state = create_test_state();

        let mut cmd = AddMarkerCommand::new("nonexistent_seq", 5.0, "Marker");
        let result = cmd.execute(&mut state);

        assert!(matches!(result, Err(CoreError::SequenceNotFound(_))));
    }
}

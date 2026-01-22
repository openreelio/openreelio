//! Command Trait Definition
//!
//! Defines the trait that all edit commands must implement.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::{project::ProjectState, CoreResult, OpId};

/// Command execution result.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    /// Generated Operation ID
    pub op_id: OpId,

    /// List of state changes
    pub changes: Vec<StateChange>,

    /// Newly created IDs (clips, tracks, etc.)
    pub created_ids: Vec<String>,

    /// Deleted IDs
    pub deleted_ids: Vec<String>,
}

impl CommandResult {
    /// Creates a new empty command result with the given operation ID
    pub fn new(op_id: &str) -> Self {
        Self {
            op_id: op_id.to_string(),
            changes: vec![],
            created_ids: vec![],
            deleted_ids: vec![],
        }
    }

    /// Adds a state change
    pub fn with_change(mut self, change: StateChange) -> Self {
        self.changes.push(change);
        self
    }

    /// Adds a created ID
    pub fn with_created_id(mut self, id: &str) -> Self {
        self.created_ids.push(id.to_string());
        self
    }

    /// Adds a deleted ID
    pub fn with_deleted_id(mut self, id: &str) -> Self {
        self.deleted_ids.push(id.to_string());
        self
    }
}

/// State change types for event broadcasting.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StateChange {
    /// A new clip was created
    ClipCreated { clip_id: String },
    /// An existing clip was modified
    ClipModified { clip_id: String },
    /// A clip was deleted
    ClipDeleted { clip_id: String },
    /// A new track was created
    TrackCreated { track_id: String },
    /// An existing track was modified
    TrackModified { track_id: String },
    /// A track was deleted
    TrackDeleted { track_id: String },
    /// A new asset was imported
    AssetAdded { asset_id: String },
    /// An existing asset was modified
    AssetModified { asset_id: String },
    /// An asset was removed from the project
    AssetRemoved { asset_id: String },
    /// A new caption was created
    CaptionCreated { caption_id: String },
    /// An existing caption was modified
    CaptionModified { caption_id: String },
    /// A caption was deleted
    CaptionDeleted { caption_id: String },
    /// An effect was applied to a clip
    EffectApplied { effect_id: String },
    /// An effect was removed from a clip
    EffectRemoved { effect_id: String },
    /// A new sequence was created
    SequenceCreated { sequence_id: String },
    /// An existing sequence was modified
    SequenceModified { sequence_id: String },
}

/// Trait that all edit commands must implement
///
/// # Core Principles
/// - All state changes must go through Commands.
/// - All Commands must be undoable.
/// - Commands must be serializable (for log storage).
///
/// # Example
/// ```rust,ignore
/// pub struct SplitClipCommand {
///     pub clip_id: ClipId,
///     pub at_time: TimeSec,
/// }
///
/// impl Command for SplitClipCommand {
///     fn execute(&self, state: &mut ProjectState) -> CoreResult<CommandResult> {
///         // Clip split logic
///     }
///
///     fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
///         // Undo split logic
///     }
///
///     fn type_name(&self) -> &'static str {
///         "SplitClip"
///     }
///
///     fn to_json(&self) -> serde_json::Value {
///         serde_json::json!({
///             "clipId": self.clip_id,
///             "atTime": self.at_time
///         })
///     }
/// }
/// ```
pub trait Command: Send + Sync {
    /// Execute the command
    ///
    /// Modifies state and returns the result.
    /// On failure, state must remain unchanged.
    /// Uses &mut self to allow storing undo state during execution.
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult>;

    /// Undo the command
    ///
    /// Inverse operation of execute.
    /// Only called after execute succeeds.
    fn undo(&self, state: &mut ProjectState) -> CoreResult<()>;

    /// Redo the command
    ///
    /// Default implementation is identical to execute.
    fn redo(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        self.execute(state)
    }

    /// Command type name
    ///
    /// Used for log storage and debugging.
    fn type_name(&self) -> &'static str;

    /// JSON serialization
    ///
    /// Format stored in ops.jsonl.
    fn to_json(&self) -> serde_json::Value;

    /// Check if commands can be merged
    ///
    /// Determines if consecutive commands of the same type can be combined.
    /// Example: consecutive text inputs, consecutive position changes
    fn can_merge(&self, _other: &dyn Command) -> bool {
        false
    }

    /// Merge commands
    ///
    /// Combines two commands into one when can_merge returns true.
    fn merge(&self, _other: &dyn Command) -> Option<Box<dyn Command>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_change_serialization() {
        let change = StateChange::ClipCreated {
            clip_id: "clip_01HZ".to_string(),
        };
        let json = serde_json::to_string(&change).unwrap();
        assert!(json.contains("clipCreated"));
    }

    #[test]
    fn test_command_result_builder() {
        let result = CommandResult::new("op_001")
            .with_change(StateChange::ClipCreated {
                clip_id: "clip_001".to_string(),
            })
            .with_created_id("clip_001");

        assert_eq!(result.op_id, "op_001");
        assert_eq!(result.changes.len(), 1);
        assert_eq!(result.created_ids.len(), 1);
    }
}

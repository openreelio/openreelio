//! Command Executor Module
//!
//! Handles command execution, undo/redo, and operation logging.
//! This is the central hub for all state-changing operations.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::core::{
    commands::{Command, CommandResult},
    project::{OpKind, Operation, OpsLog, ProjectState},
    CoreError, CoreResult, OpId,
};

// =============================================================================
// Constants
// =============================================================================

/// Default maximum number of undo/redo history entries.
/// This balances memory usage with user convenience.
/// At 100 entries, with average command size of ~1KB, this uses ~100KB of memory.
pub const DEFAULT_MAX_HISTORY_SIZE: usize = 100;

// =============================================================================
// History Entry
// =============================================================================

/// Entry in the undo/redo history
pub struct HistoryEntry {
    /// Operation ID
    pub op_id: OpId,
    /// Command that was executed (wrapped in Mutex for interior mutability)
    pub command: Arc<Mutex<Box<dyn Command>>>,
    /// Result from command execution
    pub result: CommandResult,
    /// Timestamp when command was executed
    pub timestamp: String,
}

impl std::fmt::Debug for HistoryEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HistoryEntry")
            .field("op_id", &self.op_id)
            .field("result", &self.result)
            .field("timestamp", &self.timestamp)
            .finish()
    }
}

impl HistoryEntry {
    /// Creates a new history entry
    fn new(command: Box<dyn Command>, result: CommandResult) -> Self {
        Self {
            op_id: result.op_id.clone(),
            command: Arc::new(Mutex::new(command)),
            result,
            timestamp: chrono::Utc::now().to_rfc3339(),
        }
    }
}

// =============================================================================
// Command Executor
// =============================================================================

/// Executes commands and manages undo/redo history
pub struct CommandExecutor {
    /// Operation log for persistence
    ops_log: Option<OpsLog>,
    /// Undo stack
    undo_stack: VecDeque<HistoryEntry>,
    /// Redo stack
    redo_stack: VecDeque<HistoryEntry>,
    /// Maximum history size
    max_history_size: usize,
}

impl CommandExecutor {
    /// Creates a new command executor without persistence
    pub fn new() -> Self {
        Self {
            ops_log: None,
            undo_stack: VecDeque::new(),
            redo_stack: VecDeque::new(),
            max_history_size: DEFAULT_MAX_HISTORY_SIZE,
        }
    }

    /// Creates a command executor with an ops log for persistence
    pub fn with_ops_log(ops_log: OpsLog) -> Self {
        Self {
            ops_log: Some(ops_log),
            undo_stack: VecDeque::new(),
            redo_stack: VecDeque::new(),
            max_history_size: DEFAULT_MAX_HISTORY_SIZE,
        }
    }

    /// Sets the maximum history size
    pub fn with_max_history(mut self, size: usize) -> Self {
        self.max_history_size = size;
        self
    }

    /// Executes a command and adds it to history
    pub fn execute(
        &mut self,
        command: Box<dyn Command>,
        state: &mut ProjectState,
    ) -> CoreResult<CommandResult> {
        self.execute_internal(command, state, true, true)
    }

    /// Executes a command and persists it to the ops log, but does not add it to undo/redo history.
    ///
    /// This is intended for background/system updates that must be event-sourced and replayable,
    /// but should not affect the user's undo/redo stack (e.g., proxy/thumbnail metadata updates).
    pub fn execute_without_history(
        &mut self,
        command: Box<dyn Command>,
        state: &mut ProjectState,
    ) -> CoreResult<CommandResult> {
        self.execute_internal(command, state, false, false)
    }

    fn execute_internal(
        &mut self,
        mut command: Box<dyn Command>,
        state: &mut ProjectState,
        record_history: bool,
        clear_redo: bool,
    ) -> CoreResult<CommandResult> {
        // Capture command metadata for persistence.
        // NOTE: ops.jsonl must contain replayable operations, not just the input command payload.
        let type_name = command.type_name().to_string();
        let command_json = command.to_json();
        let prev_op_id = state.last_op_id.clone();

        tracing::debug!(
            command_type = %type_name,
            record_history,
            clear_redo,
            "Executing command"
        );

        // Execute the command (needs &mut self)
        let result = command.execute(state)?;

        // Build replayable operation payload AFTER executing.
        // Many commands generate IDs at runtime (clips/tracks/sequences), so the operation
        // payload must include the realized entities/fields.
        let op_kind = Self::type_name_to_op_kind(&type_name);
        let op_payload =
            Self::build_operation_payload(op_kind.clone(), command_json, &result, state)?;

        tracing::debug!(
            command_type = %type_name,
            op_id = %result.op_id,
            op_kind = ?op_kind,
            "Command executed"
        );

        // Log the operation if persistence is enabled
        let op_timestamp = if let Some(ops_log) = &self.ops_log {
            let mut operation = Operation::with_id(&result.op_id, op_kind, op_payload);
            if let Some(prev_op_id) = prev_op_id.as_deref() {
                operation = operation.with_prev_op(prev_op_id);
            }
            ops_log.append(&operation)?;
            operation.timestamp
        } else {
            chrono::Utc::now().to_rfc3339()
        };

        if clear_redo {
            // Clear redo stack when a new user-facing command is executed.
            self.redo_stack.clear();
        }

        if record_history {
            // Add to undo stack
            let entry = HistoryEntry::new(command, result.clone());
            self.undo_stack.push_back(entry);

            // Trim history if needed - use drain for efficient batch removal
            // instead of popping one element at a time in a loop.
            if self.undo_stack.len() > self.max_history_size {
                let excess = self.undo_stack.len() - self.max_history_size;
                // drain(0..excess) removes elements from the front efficiently.
                drop(self.undo_stack.drain(0..excess));
            }
        }

        // Mark state as dirty
        state.last_op_id = Some(result.op_id.clone());
        state.op_count = state.op_count.saturating_add(1);
        state.meta.touch_at(&op_timestamp);
        state.is_dirty = true;

        Ok(result)
    }

    fn build_operation_payload(
        op_kind: OpKind,
        command_json: serde_json::Value,
        result: &CommandResult,
        state: &ProjectState,
    ) -> CoreResult<serde_json::Value> {
        fn get_str<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
            value.get(key).and_then(|v| v.as_str())
        }

        fn get_usize(value: &serde_json::Value, key: &str) -> Option<usize> {
            value.get(key).and_then(|v| v.as_u64()).map(|v| v as usize)
        }

        fn to_value<T: serde::Serialize>(value: &T) -> CoreResult<serde_json::Value> {
            serde_json::to_value(value).map_err(|e| {
                CoreError::Internal(format!("Failed to serialize operation payload: {e}"))
            })
        }

        match op_kind {
            // Asset ops are already replayable.
            OpKind::AssetImport | OpKind::AssetRemove => Ok(command_json),

            OpKind::AssetUpdate => {
                let asset_id = get_str(&command_json, "assetId").ok_or_else(|| {
                    CoreError::Internal("AssetUpdate payload missing assetId".to_string())
                })?;
                let asset = state.assets.get(asset_id).ok_or_else(|| {
                    CoreError::Internal(format!(
                        "AssetUpdate could not find asset in state: {asset_id}"
                    ))
                })?;

                // Use a canonical payload that ProjectState::apply_asset_update can replay.
                Ok(serde_json::json!({
                    "assetId": asset_id,
                    "name": asset.name.clone(),
                    "tags": asset.tags.clone(),
                    "license": asset.license.clone(),
                    "thumbnailUrl": asset.thumbnail_url.clone(),
                    "proxyStatus": asset.proxy_status,
                    "proxyUrl": asset.proxy_url.clone(),
                }))
            }

            OpKind::SequenceCreate => {
                let seq_id = result.created_ids.first().ok_or_else(|| {
                    CoreError::Internal("SequenceCreate missing createdId".to_string())
                })?;
                let sequence = state.sequences.get(seq_id).ok_or_else(|| {
                    CoreError::Internal(format!(
                        "SequenceCreate could not find sequence in state: {seq_id}"
                    ))
                })?;
                to_value(sequence)
            }

            OpKind::SequenceUpdate | OpKind::SequenceRemove => {
                // Keep shape consistent with ProjectState::apply_sequence_update/remove.
                Ok(command_json)
            }

            OpKind::TrackAdd => {
                let seq_id = get_str(&command_json, "sequenceId").ok_or_else(|| {
                    CoreError::Internal("TrackAdd payload missing sequenceId".to_string())
                })?;
                let track_id = result
                    .created_ids
                    .first()
                    .ok_or_else(|| CoreError::Internal("TrackAdd missing createdId".to_string()))?;
                let sequence = state.sequences.get(seq_id).ok_or_else(|| {
                    CoreError::Internal(format!("TrackAdd could not find sequence: {seq_id}"))
                })?;
                let track = sequence
                    .tracks
                    .iter()
                    .find(|t| t.id == *track_id)
                    .ok_or_else(|| {
                        CoreError::Internal(format!("TrackAdd could not find track: {track_id}"))
                    })?;

                Ok(serde_json::json!({
                    "sequenceId": seq_id,
                    "track": to_value(track)?,
                    "position": get_usize(&command_json, "position"),
                }))
            }

            OpKind::TrackRemove => Ok(command_json),

            OpKind::TrackReorder => {
                let seq_id = get_str(&command_json, "sequenceId").ok_or_else(|| {
                    CoreError::Internal("TrackReorder payload missing sequenceId".to_string())
                })?;
                let order = command_json
                    .get("newOrder")
                    .cloned()
                    .unwrap_or_else(|| serde_json::Value::Array(vec![]));
                Ok(serde_json::json!({
                    "sequenceId": seq_id,
                    "order": order,
                }))
            }

            OpKind::ClipAdd => {
                let seq_id = get_str(&command_json, "sequenceId").ok_or_else(|| {
                    CoreError::Internal("ClipAdd payload missing sequenceId".to_string())
                })?;
                let track_id = get_str(&command_json, "trackId").ok_or_else(|| {
                    CoreError::Internal("ClipAdd payload missing trackId".to_string())
                })?;
                let clip_id = result
                    .created_ids
                    .first()
                    .ok_or_else(|| CoreError::Internal("ClipAdd missing createdId".to_string()))?;

                let sequence = state.sequences.get(seq_id).ok_or_else(|| {
                    CoreError::Internal(format!("ClipAdd could not find sequence: {seq_id}"))
                })?;
                let track = sequence
                    .tracks
                    .iter()
                    .find(|t| t.id == track_id)
                    .ok_or_else(|| {
                        CoreError::Internal(format!("ClipAdd could not find track: {track_id}"))
                    })?;
                let clip = track
                    .clips
                    .iter()
                    .find(|c| c.id == *clip_id)
                    .ok_or_else(|| {
                        CoreError::Internal(format!("ClipAdd could not find clip: {clip_id}"))
                    })?;

                Ok(serde_json::json!({
                    "sequenceId": seq_id,
                    "trackId": track_id,
                    "clip": to_value(clip)?,
                }))
            }

            OpKind::ClipRemove => Ok(command_json),

            OpKind::ClipMove => {
                let seq_id = get_str(&command_json, "sequenceId").ok_or_else(|| {
                    CoreError::Internal("ClipMove payload missing sequenceId".to_string())
                })?;
                let clip_id = get_str(&command_json, "clipId").ok_or_else(|| {
                    CoreError::Internal("ClipMove payload missing clipId".to_string())
                })?;

                // Locate the clip to persist its realized destination and position.
                let sequence = state.sequences.get(seq_id).ok_or_else(|| {
                    CoreError::Internal(format!("ClipMove could not find sequence: {seq_id}"))
                })?;
                let (track_id, clip) = sequence
                    .tracks
                    .iter()
                    .find_map(|t| t.get_clip(clip_id).map(|c| (t.id.clone(), c)))
                    .ok_or_else(|| {
                        CoreError::Internal(format!("ClipMove could not find clip: {clip_id}"))
                    })?;

                Ok(serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "trackId": track_id,
                    "timelineIn": clip.place.timeline_in_sec,
                }))
            }

            OpKind::ClipTrim => {
                let seq_id = get_str(&command_json, "sequenceId").ok_or_else(|| {
                    CoreError::Internal("ClipTrim payload missing sequenceId".to_string())
                })?;
                let clip_id = get_str(&command_json, "clipId").ok_or_else(|| {
                    CoreError::Internal("ClipTrim payload missing clipId".to_string())
                })?;

                let sequence = state.sequences.get(seq_id).ok_or_else(|| {
                    CoreError::Internal(format!("ClipTrim could not find sequence: {seq_id}"))
                })?;
                let clip = sequence
                    .tracks
                    .iter()
                    .find_map(|t| t.get_clip(clip_id))
                    .ok_or_else(|| {
                        CoreError::Internal(format!("ClipTrim could not find clip: {clip_id}"))
                    })?;

                Ok(serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "sourceIn": clip.range.source_in_sec,
                    "sourceOut": clip.range.source_out_sec,
                    "timelineIn": clip.place.timeline_in_sec,
                    "duration": clip.place.duration_sec,
                }))
            }

            OpKind::ClipSplit => {
                let seq_id = get_str(&command_json, "sequenceId").ok_or_else(|| {
                    CoreError::Internal("ClipSplit payload missing sequenceId".to_string())
                })?;
                let track_id = get_str(&command_json, "trackId").ok_or_else(|| {
                    CoreError::Internal("ClipSplit payload missing trackId".to_string())
                })?;
                let original_clip_id = get_str(&command_json, "clipId").ok_or_else(|| {
                    CoreError::Internal("ClipSplit payload missing clipId".to_string())
                })?;
                let new_clip_id = result.created_ids.first().ok_or_else(|| {
                    CoreError::Internal("ClipSplit missing createdId".to_string())
                })?;

                let sequence = state.sequences.get(seq_id).ok_or_else(|| {
                    CoreError::Internal(format!("ClipSplit could not find sequence: {seq_id}"))
                })?;
                let track = sequence
                    .tracks
                    .iter()
                    .find(|t| t.id == track_id)
                    .ok_or_else(|| {
                        CoreError::Internal(format!("ClipSplit could not find track: {track_id}"))
                    })?;
                let original = track
                    .clips
                    .iter()
                    .find(|c| c.id == original_clip_id)
                    .ok_or_else(|| {
                        CoreError::Internal(format!(
                            "ClipSplit could not find original clip: {original_clip_id}"
                        ))
                    })?;
                let new_clip = track
                    .clips
                    .iter()
                    .find(|c| c.id == *new_clip_id)
                    .ok_or_else(|| {
                        CoreError::Internal(format!(
                            "ClipSplit could not find new clip: {new_clip_id}"
                        ))
                    })?;

                Ok(serde_json::json!({
                    "sequenceId": seq_id,
                    "trackId": track_id,
                    "originalClip": to_value(original)?,
                    "newClip": to_value(new_clip)?,
                }))
            }

            OpKind::EffectAdd => {
                let seq_id = get_str(&command_json, "sequenceId").ok_or_else(|| {
                    CoreError::Internal("EffectAdd payload missing sequenceId".to_string())
                })?;
                let clip_id = get_str(&command_json, "clipId").ok_or_else(|| {
                    CoreError::Internal("EffectAdd payload missing clipId".to_string())
                })?;
                let effect_id = result.created_ids.first().ok_or_else(|| {
                    CoreError::Internal("EffectAdd missing createdId".to_string())
                })?;
                let effect = state.effects.get(effect_id).ok_or_else(|| {
                    CoreError::Internal(format!(
                        "EffectAdd could not find effect in state: {effect_id}"
                    ))
                })?;

                Ok(serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "effect": to_value(effect)?,
                    "position": get_usize(&command_json, "position"),
                }))
            }

            OpKind::EffectRemove => {
                let seq_id = get_str(&command_json, "sequenceId").ok_or_else(|| {
                    CoreError::Internal("EffectRemove payload missing sequenceId".to_string())
                })?;
                let clip_id = get_str(&command_json, "clipId").ok_or_else(|| {
                    CoreError::Internal("EffectRemove payload missing clipId".to_string())
                })?;
                let effect_id = get_str(&command_json, "effectId").ok_or_else(|| {
                    CoreError::Internal("EffectRemove payload missing effectId".to_string())
                })?;

                Ok(serde_json::json!({
                    "sequenceId": seq_id,
                    "clipId": clip_id,
                    "effectId": effect_id,
                }))
            }

            OpKind::EffectUpdate => {
                let effect_id = get_str(&command_json, "effectId").ok_or_else(|| {
                    CoreError::Internal("EffectUpdate payload missing effectId".to_string())
                })?;

                // Persist a canonical payload that ProjectState::apply_effect_update can replay.
                // NOTE: Keep this schema stable over time; treat missing keys as no-ops.
                let enabled = command_json
                    .get("enabled")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let order = command_json
                    .get("order")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let params = command_json
                    .get("params")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);

                Ok(serde_json::json!({
                    "effectId": effect_id,
                    "enabled": enabled,
                    "order": order,
                    "params": params,
                }))
            }

            // Bin operations
            OpKind::BinCreate => {
                let bin_id = result.created_ids.first().ok_or_else(|| {
                    CoreError::Internal("BinCreate missing createdId".to_string())
                })?;
                let bin = state.bins.get(bin_id).ok_or_else(|| {
                    CoreError::Internal(format!("BinCreate could not find bin in state: {bin_id}"))
                })?;
                to_value(bin)
            }

            OpKind::BinRemove | OpKind::BinRename | OpKind::BinMove | OpKind::BinUpdateColor => {
                // These operations store command data which is sufficient for replay
                Ok(command_json)
            }

            // For everything else, fall back to the command JSON.
            _ => Ok(command_json),
        }
    }

    /// Undoes the last command
    pub fn undo(&mut self, state: &mut ProjectState) -> CoreResult<()> {
        let entry = self.undo_stack.pop_back().ok_or(CoreError::NothingToUndo)?;

        // Execute undo (undo uses &self, so we just need a lock)
        {
            let command = entry
                .command
                .lock()
                .map_err(|_| CoreError::Internal("Failed to lock command for undo".into()))?;
            command.undo(state)?;
        }

        // Move to redo stack
        self.redo_stack.push_back(entry);

        state.meta.touch();
        state.is_dirty = true;

        Ok(())
    }

    /// Redoes the last undone command
    pub fn redo(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let entry = self.redo_stack.pop_back().ok_or(CoreError::NothingToRedo)?;

        // Re-execute command (redo uses &mut self)
        let mut result = {
            let mut command = entry
                .command
                .lock()
                .map_err(|_| CoreError::Internal("Failed to lock command for redo".into()))?;
            command.redo(state)?
        };
        // Redo re-applies an existing history entry; keep the original op_id stable.
        result.op_id = entry.op_id.clone();

        // Move back to undo stack with updated result
        let new_entry = HistoryEntry {
            op_id: result.op_id.clone(),
            command: entry.command, // Reuse the Arc<Mutex<...>>
            result: result.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        self.undo_stack.push_back(new_entry);

        state.meta.touch();
        state.is_dirty = true;

        Ok(result)
    }

    /// Returns true if undo is available
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    /// Returns true if redo is available
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// Returns the number of commands in the undo stack
    pub fn undo_count(&self) -> usize {
        self.undo_stack.len()
    }

    /// Returns the number of commands in the redo stack
    pub fn redo_count(&self) -> usize {
        self.redo_stack.len()
    }

    /// Clears all history (undo and redo)
    pub fn clear_history(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }

    /// Gets the last executed command type name
    pub fn last_command_type(&self) -> Option<String> {
        self.undo_stack
            .back()
            .and_then(|e| e.command.lock().ok().map(|cmd| cmd.type_name().to_string()))
    }

    /// Gets the last undone command type name (for redo)
    pub fn last_undone_command_type(&self) -> Option<String> {
        self.redo_stack
            .back()
            .and_then(|e| e.command.lock().ok().map(|cmd| cmd.type_name().to_string()))
    }

    /// Converts command type name to OpKind
    fn type_name_to_op_kind(type_name: &str) -> OpKind {
        match type_name {
            "InsertClip" | "AddClip" => OpKind::ClipAdd,
            "RemoveClip" | "DeleteClip" => OpKind::ClipRemove,
            "MoveClip" => OpKind::ClipMove,
            "TrimClip" => OpKind::ClipTrim,
            "SplitClip" => OpKind::ClipSplit,
            "AddTrack" | "InsertTrack" => OpKind::TrackAdd,
            "RemoveTrack" | "DeleteTrack" => OpKind::TrackRemove,
            "ReorderTracks" => OpKind::TrackReorder,
            "ImportAsset" | "AddAsset" => OpKind::AssetImport,
            "RemoveAsset" | "DeleteAsset" => OpKind::AssetRemove,
            "UpdateAsset" => OpKind::AssetUpdate,
            "AddEffect" | "ApplyEffect" => OpKind::EffectAdd,
            "RemoveEffect" => OpKind::EffectRemove,
            "UpdateEffect" => OpKind::EffectUpdate,
            "AddCaption" => OpKind::CaptionAdd,
            "RemoveCaption" => OpKind::CaptionRemove,
            "UpdateCaption" => OpKind::CaptionUpdate,
            "CreateCaption" => OpKind::CaptionAdd,
            "DeleteCaption" => OpKind::CaptionRemove,
            "CreateSequence" => OpKind::SequenceCreate,
            "UpdateSequence" => OpKind::SequenceUpdate,
            "RemoveSequence" | "DeleteSequence" => OpKind::SequenceRemove,
            "CreateProject" => OpKind::ProjectCreate,
            "UpdateProjectSettings" => OpKind::ProjectSettings,
            // Bin operations
            "CreateBin" => OpKind::BinCreate,
            "RemoveBin" => OpKind::BinRemove,
            "RenameBin" => OpKind::BinRename,
            "MoveBin" => OpKind::BinMove,
            "SetBinColor" => OpKind::BinUpdateColor,
            _ => OpKind::Batch, // Default to batch for unknown types
        }
    }
}

impl Default for CommandExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{Asset, VideoInfo};
    use crate::core::commands::{
        AddEffectCommand, CreateSequenceCommand, ImportAssetCommand, InsertClipCommand,
        MoveClipCommand, SplitClipCommand, StateChange, TrimClipCommand,
    };
    use crate::core::effects::{EffectType, ParamValue};
    use crate::core::project::{OpKind, Operation, OpsLog, ProjectMeta, ProjectState};
    use crate::core::timeline::{Clip, Sequence, SequenceFormat, Track, TrackKind};
    use tempfile::TempDir;

    // Test command implementation
    struct TestAddAssetCommand {
        asset: Asset,
    }

    impl Command for TestAddAssetCommand {
        fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
            let op_id = ulid::Ulid::new().to_string();
            state
                .assets
                .insert(self.asset.id.clone(), self.asset.clone());

            Ok(CommandResult::new(&op_id)
                .with_change(StateChange::AssetAdded {
                    asset_id: self.asset.id.clone(),
                })
                .with_created_id(&self.asset.id))
        }

        fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
            state.assets.remove(&self.asset.id);
            Ok(())
        }

        fn type_name(&self) -> &'static str {
            "AddAsset"
        }

        fn to_json(&self) -> serde_json::Value {
            serde_json::to_value(&self.asset).unwrap_or(serde_json::json!({}))
        }
    }

    struct TestRemoveAssetCommand {
        asset_id: String,
        removed_asset: Option<Asset>,
    }

    impl TestRemoveAssetCommand {
        fn new(asset_id: &str) -> Self {
            Self {
                asset_id: asset_id.to_string(),
                removed_asset: None,
            }
        }
    }

    impl Command for TestRemoveAssetCommand {
        fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
            let op_id = ulid::Ulid::new().to_string();

            // Store asset for undo before removing
            self.removed_asset = state.assets.get(&self.asset_id).cloned();

            state
                .assets
                .remove(&self.asset_id)
                .ok_or_else(|| CoreError::AssetNotFound(self.asset_id.clone()))?;

            Ok(CommandResult::new(&op_id)
                .with_change(StateChange::AssetRemoved {
                    asset_id: self.asset_id.clone(),
                })
                .with_deleted_id(&self.asset_id))
        }

        fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
            if let Some(asset) = &self.removed_asset {
                state.assets.insert(asset.id.clone(), asset.clone());
            }
            Ok(())
        }

        fn type_name(&self) -> &'static str {
            "RemoveAsset"
        }

        fn to_json(&self) -> serde_json::Value {
            serde_json::json!({ "assetId": self.asset_id })
        }
    }

    #[test]
    fn test_executor_execute() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        let asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        let cmd = Box::new(TestAddAssetCommand {
            asset: asset.clone(),
        });

        let result = executor.execute(cmd, &mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);
        assert_eq!(state.assets.len(), 1);
        assert!(state.is_dirty);
    }

    #[test]
    fn test_executor_persists_op_id_and_updates_state_metadata() {
        let temp_dir = TempDir::new().unwrap();
        let ops_path = temp_dir.path().join("ops.jsonl");

        let mut executor = CommandExecutor::with_ops_log(OpsLog::new(&ops_path));
        let mut state = ProjectState::new("Test");

        let asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        let cmd = Box::new(TestAddAssetCommand {
            asset: asset.clone(),
        });

        let result = executor.execute(cmd, &mut state).unwrap();

        let persisted = OpsLog::new(&ops_path).last().unwrap().unwrap();
        assert_eq!(persisted.id, result.op_id);
        assert_eq!(state.last_op_id.as_deref(), Some(persisted.id.as_str()));
        assert_eq!(state.op_count, 1);
        assert_eq!(state.meta.modified_at, persisted.timestamp);
    }

    #[test]
    fn test_executor_persists_effect_add_payload_is_replayable() {
        let temp_dir = TempDir::new().unwrap();
        let ops_path = temp_dir.path().join("ops.jsonl");
        let ops_log = OpsLog::new(&ops_path);

        // Build an initial, replayable timeline via operations (no direct state mutation).
        let mut state = ProjectState::new_empty("Test Project");

        let sequence = Sequence::new("Test Sequence", SequenceFormat::youtube_1080());
        let seq_id = sequence.id.clone();
        let seq_op = Operation::new(
            OpKind::SequenceCreate,
            serde_json::to_value(&sequence).unwrap(),
        );
        ops_log.append(&seq_op).unwrap();
        state.apply_operation(&seq_op).unwrap();

        let track = Track::new("Video Track", TrackKind::Video);
        let track_id = track.id.clone();
        let track_op = Operation::new(
            OpKind::TrackAdd,
            serde_json::json!({
                "sequenceId": seq_id,
                "track": track,
                "position": 0,
            }),
        );
        ops_log.append(&track_op).unwrap();
        state.apply_operation(&track_op).unwrap();

        let clip = Clip::with_range("asset_001", 0.0, 5.0).place_at(0.0);
        let clip_id = clip.id.clone();
        let clip_op = Operation::new(
            OpKind::ClipAdd,
            serde_json::json!({
                "sequenceId": seq_id,
                "trackId": track_id,
                "clip": clip,
            }),
        );
        ops_log.append(&clip_op).unwrap();
        state.apply_operation(&clip_op).unwrap();

        // Execute effect commands with persistence enabled.
        let mut executor = CommandExecutor::with_ops_log(ops_log);

        let add_blur =
            AddEffectCommand::new(&seq_id, &track_id, &clip_id, EffectType::GaussianBlur)
                .with_param("radius", ParamValue::Float(5.0));
        let blur_result = executor.execute(Box::new(add_blur), &mut state).unwrap();
        let blur_id = blur_result.created_ids[0].clone();

        // Insert another effect at position 0 to validate stable ordering on replay.
        let add_brightness =
            AddEffectCommand::new(&seq_id, &track_id, &clip_id, EffectType::Brightness)
                .with_param("value", ParamValue::Float(0.2))
                .at_position(0);
        let brightness_result = executor
            .execute(Box::new(add_brightness), &mut state)
            .unwrap();
        let brightness_id = brightness_result.created_ids[0].clone();

        // Validate persisted payload schema for EffectAdd (must include realized effect object).
        let persisted = OpsLog::new(&ops_path).last().unwrap().unwrap();
        assert_eq!(persisted.kind, OpKind::EffectAdd);
        assert_eq!(
            persisted.payload["sequenceId"].as_str(),
            Some(seq_id.as_str())
        );
        assert_eq!(persisted.payload["clipId"].as_str(), Some(clip_id.as_str()));
        assert_eq!(
            persisted.payload["effect"]["id"].as_str(),
            Some(brightness_id.as_str())
        );
        assert_eq!(persisted.payload["position"].as_u64(), Some(0));

        // Replay ops log and ensure the resulting state matches the executed ordering.
        let replayed =
            ProjectState::from_ops_log(&OpsLog::new(&ops_path), ProjectMeta::new("Replay"))
                .unwrap();
        let seq = replayed.get_sequence(&seq_id).unwrap();
        let track = seq.get_track(&track_id).unwrap();
        let clip = track.get_clip(&clip_id).unwrap();

        assert_eq!(clip.effects.len(), 2);
        assert_eq!(clip.effects[0], brightness_id);
        assert_eq!(clip.effects[1], blur_id);
        assert!(replayed.effects.contains_key(&brightness_id));
        assert!(replayed.effects.contains_key(&blur_id));
    }

    #[test]
    fn test_executor_undo() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        let asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        let cmd = Box::new(TestAddAssetCommand {
            asset: asset.clone(),
        });

        executor.execute(cmd, &mut state).unwrap();
        assert_eq!(state.assets.len(), 1);

        executor.undo(&mut state).unwrap();
        assert_eq!(state.assets.len(), 0);
    }

    #[test]
    fn test_executor_redo() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        let asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        let cmd = Box::new(TestAddAssetCommand {
            asset: asset.clone(),
        });

        executor.execute(cmd, &mut state).unwrap();
        executor.undo(&mut state).unwrap();
        assert_eq!(state.assets.len(), 0);

        executor.redo(&mut state).unwrap();
        assert_eq!(state.assets.len(), 1);
    }

    #[test]
    fn test_executor_undo_nothing() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        let result = executor.undo(&mut state);
        assert!(matches!(result, Err(CoreError::NothingToUndo)));
    }

    #[test]
    fn test_executor_redo_nothing() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        let result = executor.redo(&mut state);
        assert!(matches!(result, Err(CoreError::NothingToRedo)));
    }

    #[test]
    fn test_executor_clears_redo_on_new_command() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        let asset1 = Asset::new_video("a.mp4", "/a.mp4", VideoInfo::default());
        let asset2 = Asset::new_video("b.mp4", "/b.mp4", VideoInfo::default());

        let cmd1 = Box::new(TestAddAssetCommand { asset: asset1 });
        let cmd2 = Box::new(TestAddAssetCommand { asset: asset2 });

        executor.execute(cmd1, &mut state).unwrap();
        executor.undo(&mut state).unwrap();
        assert!(executor.can_redo());

        // New command should clear redo stack
        executor.execute(cmd2, &mut state).unwrap();
        assert!(!executor.can_redo());
    }

    #[test]
    fn test_executor_execute_without_history_does_not_affect_undo_redo() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        let asset1 = Asset::new_video("a.mp4", "/a.mp4", VideoInfo::default());
        let asset2 = Asset::new_video("b.mp4", "/b.mp4", VideoInfo::default());

        executor
            .execute(Box::new(TestAddAssetCommand { asset: asset1 }), &mut state)
            .unwrap();
        executor.undo(&mut state).unwrap();
        assert_eq!(executor.undo_count(), 0);
        assert_eq!(executor.redo_count(), 1);

        // Background/system update should not clear redo, and should not add to undo history.
        executor
            .execute_without_history(Box::new(TestAddAssetCommand { asset: asset2 }), &mut state)
            .unwrap();

        assert_eq!(executor.undo_count(), 0);
        assert_eq!(executor.redo_count(), 1);
        assert!(executor.can_redo());
        assert_eq!(state.assets.len(), 1);
    }

    #[test]
    fn test_executor_can_undo_redo() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        assert!(!executor.can_undo());
        assert!(!executor.can_redo());

        let asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        let cmd = Box::new(TestAddAssetCommand { asset });

        executor.execute(cmd, &mut state).unwrap();
        assert!(executor.can_undo());
        assert!(!executor.can_redo());

        executor.undo(&mut state).unwrap();
        assert!(!executor.can_undo());
        assert!(executor.can_redo());
    }

    #[test]
    fn test_executor_history_count() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        for i in 0..5 {
            let asset = Asset::new_video(
                &format!("video_{}.mp4", i),
                &format!("/video_{}.mp4", i),
                VideoInfo::default(),
            );
            let cmd = Box::new(TestAddAssetCommand { asset });
            executor.execute(cmd, &mut state).unwrap();
        }

        assert_eq!(executor.undo_count(), 5);
        assert_eq!(executor.redo_count(), 0);

        executor.undo(&mut state).unwrap();
        executor.undo(&mut state).unwrap();

        assert_eq!(executor.undo_count(), 3);
        assert_eq!(executor.redo_count(), 2);
    }

    #[test]
    fn test_executor_max_history() {
        let mut executor = CommandExecutor::new().with_max_history(3);
        let mut state = ProjectState::new("Test");

        for i in 0..10 {
            let asset = Asset::new_video(
                &format!("video_{}.mp4", i),
                &format!("/video_{}.mp4", i),
                VideoInfo::default(),
            );
            let cmd = Box::new(TestAddAssetCommand { asset });
            executor.execute(cmd, &mut state).unwrap();
        }

        assert_eq!(executor.undo_count(), 3);
    }

    #[test]
    fn test_executor_clear_history() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        let asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        let cmd = Box::new(TestAddAssetCommand { asset });

        executor.execute(cmd, &mut state).unwrap();
        executor.undo(&mut state).unwrap();

        assert!(executor.can_redo());

        executor.clear_history();

        assert!(!executor.can_undo());
        assert!(!executor.can_redo());
    }

    #[test]
    fn test_executor_last_command_type() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        assert!(executor.last_command_type().is_none());

        let asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        let cmd = Box::new(TestAddAssetCommand { asset });

        executor.execute(cmd, &mut state).unwrap();
        assert_eq!(executor.last_command_type(), Some("AddAsset".to_string()));

        executor.undo(&mut state).unwrap();
        assert_eq!(
            executor.last_undone_command_type(),
            Some("AddAsset".to_string())
        );
    }

    #[test]
    fn test_type_name_to_op_kind() {
        assert_eq!(
            CommandExecutor::type_name_to_op_kind("InsertClip"),
            OpKind::ClipAdd
        );
        assert_eq!(
            CommandExecutor::type_name_to_op_kind("SplitClip"),
            OpKind::ClipSplit
        );
        assert_eq!(
            CommandExecutor::type_name_to_op_kind("ImportAsset"),
            OpKind::AssetImport
        );
        assert_eq!(
            CommandExecutor::type_name_to_op_kind("UnknownCommand"),
            OpKind::Batch
        );
    }

    // =========================================================================
    // Ops Log Integration Tests
    // =========================================================================

    #[test]
    fn test_executor_with_ops_log() {
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let ops_path = temp_dir.path().join("ops.jsonl");
        let ops_log = OpsLog::new(&ops_path);

        let mut executor = CommandExecutor::with_ops_log(ops_log);
        let mut state = ProjectState::new("Test");

        // Execute commands
        let asset1 = Asset::new_video("video1.mp4", "/video1.mp4", VideoInfo::default());
        let cmd1 = Box::new(TestAddAssetCommand {
            asset: asset1.clone(),
        });
        executor.execute(cmd1, &mut state).unwrap();

        let asset2 = Asset::new_video("video2.mp4", "/video2.mp4", VideoInfo::default());
        let cmd2 = Box::new(TestAddAssetCommand {
            asset: asset2.clone(),
        });
        executor.execute(cmd2, &mut state).unwrap();

        // Verify ops log has the operations
        let ops_log = OpsLog::new(&ops_path);
        let result = ops_log.read_all().unwrap();
        assert_eq!(result.operations.len(), 2);
        assert_eq!(result.operations[0].kind, OpKind::AssetImport);
        assert_eq!(result.operations[1].kind, OpKind::AssetImport);
    }

    #[test]
    fn test_executor_ops_log_persistence() {
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let ops_path = temp_dir.path().join("ops.jsonl");

        // First session: create executor and execute commands
        {
            let ops_log = OpsLog::new(&ops_path);
            let mut executor = CommandExecutor::with_ops_log(ops_log);
            let mut state = ProjectState::new("Test");

            let asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
            let cmd = Box::new(TestAddAssetCommand {
                asset: asset.clone(),
            });
            executor.execute(cmd, &mut state).unwrap();
        }

        // Second session: verify ops log persisted
        let ops_log = OpsLog::new(&ops_path);
        let result = ops_log.read_all().unwrap();
        assert_eq!(result.operations.len(), 1);
        assert_eq!(result.operations[0].kind, OpKind::AssetImport);
    }

    #[test]
    fn test_executor_ops_log_replay_roundtrip_for_basic_timeline_ops() {
        let temp_dir = TempDir::new().unwrap();
        let ops_path = temp_dir.path().join("ops.jsonl");

        let mut executor = CommandExecutor::with_ops_log(OpsLog::new(&ops_path));
        let mut state = ProjectState::new_empty("Test");

        // Create a sequence with default tracks.
        executor
            .execute(
                Box::new(CreateSequenceCommand::new("Main", "1080p")),
                &mut state,
            )
            .unwrap();

        let seq_id = state.active_sequence_id.clone().unwrap();
        let track_id = state.sequences[&seq_id].tracks[0].id.clone();

        // Import an asset with a known duration.
        let asset_path = temp_dir.path().join("test.mp4");
        std::fs::write(&asset_path, b"test").unwrap();
        let asset_uri = asset_path.to_string_lossy().to_string();

        let import_cmd = ImportAssetCommand::new("test.mp4", &asset_uri).with_duration(30.0);
        executor
            .execute(Box::new(import_cmd.clone()), &mut state)
            .unwrap();
        let asset_id = import_cmd.asset_id().to_string();

        // Insert a short clip so we can move/trim/split without overlap.
        let insert =
            InsertClipCommand::new(&seq_id, &track_id, &asset_id, 0.0).with_source_range(0.0, 5.0);
        let insert_result = executor.execute(Box::new(insert), &mut state).unwrap();
        let clip_id = insert_result.created_ids[0].clone();

        // Move the clip.
        executor
            .execute(
                Box::new(MoveClipCommand::new_simple(&seq_id, &clip_id, 10.0)),
                &mut state,
            )
            .unwrap();

        // Trim and ripple on timeline.
        executor
            .execute(
                Box::new(
                    TrimClipCommand::new_simple(&seq_id, &clip_id)
                        .with_source_in(1.0)
                        .with_source_out(4.0)
                        .with_timeline_in(12.0),
                ),
                &mut state,
            )
            .unwrap();

        // Split inside the trimmed clip range: [12, 15).
        let split_result = executor
            .execute(
                Box::new(SplitClipCommand::new(&seq_id, &track_id, &clip_id, 13.0)),
                &mut state,
            )
            .unwrap();
        let new_clip_id = split_result.created_ids[0].clone();

        // Replay.
        let ops_log = OpsLog::new(&ops_path);
        let replayed = ProjectState::from_ops_log(&ops_log, ProjectMeta::new("Test")).unwrap();

        // Ensure operations are present in the log (sanity).
        let ops = ops_log.read_all().unwrap().operations;
        assert_eq!(ops.len(), 6);
        assert_eq!(ops[0].kind, OpKind::SequenceCreate);
        assert_eq!(ops[1].kind, OpKind::AssetImport);
        assert_eq!(ops[2].kind, OpKind::ClipAdd);
        assert_eq!(ops[3].kind, OpKind::ClipMove);
        assert_eq!(ops[4].kind, OpKind::ClipTrim);
        assert_eq!(ops[5].kind, OpKind::ClipSplit);

        // Verify clip state matches after replay.
        let replayed_track = replayed
            .sequences
            .get(&seq_id)
            .and_then(|s| s.get_track(&track_id))
            .unwrap();

        let first = replayed_track.get_clip(&clip_id).unwrap();
        let second = replayed_track.get_clip(&new_clip_id).unwrap();

        assert_eq!(first.place.timeline_in_sec, 12.0);
        assert_eq!(first.place.duration_sec, 1.0);
        assert_eq!(first.range.source_in_sec, 1.0);
        assert_eq!(first.range.source_out_sec, 2.0);

        assert_eq!(second.place.timeline_in_sec, 13.0);
        assert_eq!(second.place.duration_sec, 2.0);
        assert_eq!(second.range.source_in_sec, 2.0);
        assert_eq!(second.range.source_out_sec, 4.0);

        // Ensure deterministic ordering after replay.
        let ordered: Vec<_> = replayed_track.clips.iter().map(|c| c.id.clone()).collect();
        assert_eq!(ordered, vec![clip_id, new_clip_id]);
    }

    #[test]
    fn test_executor_multiple_undo_redo_cycle() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        // Execute 3 commands
        for i in 0..3 {
            let asset = Asset::new_video(
                &format!("video_{}.mp4", i),
                &format!("/video_{}.mp4", i),
                VideoInfo::default(),
            );
            let cmd = Box::new(TestAddAssetCommand { asset });
            executor.execute(cmd, &mut state).unwrap();
        }

        assert_eq!(state.assets.len(), 3);

        // Undo all
        executor.undo(&mut state).unwrap();
        executor.undo(&mut state).unwrap();
        executor.undo(&mut state).unwrap();
        assert_eq!(state.assets.len(), 0);

        // Redo all
        executor.redo(&mut state).unwrap();
        executor.redo(&mut state).unwrap();
        executor.redo(&mut state).unwrap();
        assert_eq!(state.assets.len(), 3);
    }

    #[test]
    fn test_executor_undo_preserves_data() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        // Add asset with specific data
        let asset = Asset::new_video("unique_name.mp4", "/unique_path.mp4", VideoInfo::default())
            .with_file_size(12345)
            .with_hash("abc123");
        let asset_id = asset.id.clone();

        let cmd = Box::new(TestAddAssetCommand {
            asset: asset.clone(),
        });
        executor.execute(cmd, &mut state).unwrap();

        // Verify asset is in state
        let stored_asset = state.assets.get(&asset_id).unwrap();
        assert_eq!(stored_asset.name, "unique_name.mp4");
        assert_eq!(stored_asset.file_size, 12345);

        // Undo
        executor.undo(&mut state).unwrap();
        assert!(state.assets.is_empty());

        // Redo
        executor.redo(&mut state).unwrap();

        // Verify asset data is preserved
        let restored_asset = state.assets.get(&asset_id).unwrap();
        assert_eq!(restored_asset.name, "unique_name.mp4");
        assert_eq!(restored_asset.file_size, 12345);
        assert_eq!(restored_asset.hash, "abc123");
    }

    #[test]
    fn test_executor_remove_with_undo() {
        let mut executor = CommandExecutor::new();
        let mut state = ProjectState::new("Test");

        // Add asset
        let asset = Asset::new_video("video.mp4", "/video.mp4", VideoInfo::default());
        let asset_id = asset.id.clone();
        let add_cmd = Box::new(TestAddAssetCommand { asset });
        executor.execute(add_cmd, &mut state).unwrap();

        // Remove asset
        let remove_cmd = Box::new(TestRemoveAssetCommand::new(&asset_id));
        executor.execute(remove_cmd, &mut state).unwrap();
        assert!(state.assets.is_empty());

        // Undo remove - should restore asset
        executor.undo(&mut state).unwrap();
        assert_eq!(state.assets.len(), 1);
        assert!(state.assets.contains_key(&asset_id));

        // Redo remove - should remove asset again
        executor.redo(&mut state).unwrap();
        assert!(state.assets.is_empty());
    }
}

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
            max_history_size: 100,
        }
    }

    /// Creates a command executor with an ops log for persistence
    pub fn with_ops_log(ops_log: OpsLog) -> Self {
        Self {
            ops_log: Some(ops_log),
            undo_stack: VecDeque::new(),
            redo_stack: VecDeque::new(),
            max_history_size: 100,
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
        mut command: Box<dyn Command>,
        state: &mut ProjectState,
    ) -> CoreResult<CommandResult> {
        // Get type name and json before executing (for logging)
        let type_name = command.type_name().to_string();
        let json_data = command.to_json();

        // Execute the command (needs &mut self)
        let result = command.execute(state)?;

        // Log the operation if persistence is enabled
        if let Some(ops_log) = &self.ops_log {
            let operation = Operation::new(Self::type_name_to_op_kind(&type_name), json_data);
            ops_log.append(&operation)?;
        }

        // Clear redo stack when a new command is executed
        self.redo_stack.clear();

        // Add to undo stack
        let entry = HistoryEntry::new(command, result.clone());
        self.undo_stack.push_back(entry);

        // Trim history if needed
        while self.undo_stack.len() > self.max_history_size {
            self.undo_stack.pop_front();
        }

        // Mark state as dirty
        state.is_dirty = true;

        Ok(result)
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

        state.is_dirty = true;

        Ok(())
    }

    /// Redoes the last undone command
    pub fn redo(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let entry = self.redo_stack.pop_back().ok_or(CoreError::NothingToRedo)?;

        // Re-execute command (redo uses &mut self)
        let result = {
            let mut command = entry
                .command
                .lock()
                .map_err(|_| CoreError::Internal("Failed to lock command for redo".into()))?;
            command.redo(state)?
        };

        // Move back to undo stack with updated result
        let new_entry = HistoryEntry {
            op_id: result.op_id.clone(),
            command: entry.command, // Reuse the Arc<Mutex<...>>
            result: result.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        self.undo_stack.push_back(new_entry);

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
            "CreateSequence" => OpKind::SequenceCreate,
            "UpdateSequence" => OpKind::SequenceUpdate,
            "RemoveSequence" => OpKind::SequenceRemove,
            "CreateProject" => OpKind::ProjectCreate,
            "UpdateProjectSettings" => OpKind::ProjectSettings,
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

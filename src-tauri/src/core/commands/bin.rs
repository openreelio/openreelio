//! Bin (Folder) Commands
//!
//! Commands for managing bins (folders) in the project.
//! Supports create, remove, rename, move, and color update operations.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::core::{
    bins::{validate_bin_name, Bin, BinColor},
    project::ProjectState,
    BinId, CoreError, CoreResult,
};

use super::traits::{Command, CommandResult};

// =============================================================================
// CreateBinCommand
// =============================================================================

/// Creates a new bin (folder)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBinCommand {
    name: String,
    parent_id: Option<BinId>,
    color: BinColor,
    /// Generated bin ID (set after execution)
    #[serde(skip)]
    created_bin_id: Option<BinId>,
}

impl CreateBinCommand {
    pub fn new(name: &str, parent_id: Option<&str>, color: Option<BinColor>) -> Self {
        Self {
            name: name.to_string(),
            parent_id: parent_id.map(|s| s.to_string()),
            color: color.unwrap_or_default(),
            created_bin_id: None,
        }
    }
}

impl Command for CreateBinCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Validate bin name
        validate_bin_name(&self.name).map_err(|e| CoreError::InvalidCommand(e.to_string()))?;

        // Verify parent exists if specified
        if let Some(ref parent_id) = self.parent_id {
            if !parent_id.is_empty() && !state.bins.contains_key(parent_id) {
                return Err(CoreError::NotFound(format!(
                    "Parent bin not found: {}",
                    parent_id
                )));
            }
        }

        // Create the bin
        let mut bin = Bin::new(&self.name).with_color(self.color.clone());
        if let Some(ref parent_id) = self.parent_id {
            if !parent_id.is_empty() {
                bin = bin.with_parent(parent_id);
            }
        }

        self.created_bin_id = Some(bin.id.clone());
        let bin_id = bin.id.clone();

        // Insert into state
        state.bins.insert(bin.id.clone(), bin);

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id).with_created_id(&bin_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(ref bin_id) = self.created_bin_id {
            state.bins.remove(bin_id);
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "CreateBin"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(json!({}))
    }
}

// =============================================================================
// RemoveBinCommand
// =============================================================================

/// Removes a bin and all its contents
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveBinCommand {
    bin_id: BinId,
    /// Stored bin data for undo
    #[serde(skip)]
    removed_bin: Option<Bin>,
    /// Stored descendant bins for undo
    #[serde(skip)]
    removed_descendants: Vec<Bin>,
    /// Assets that were moved to root
    #[serde(skip)]
    orphaned_assets: Vec<(String, Option<String>)>, // (asset_id, original_bin_id)
}

impl RemoveBinCommand {
    pub fn new(bin_id: &str) -> Self {
        Self {
            bin_id: bin_id.to_string(),
            removed_bin: None,
            removed_descendants: vec![],
            orphaned_assets: vec![],
        }
    }
}

impl Command for RemoveBinCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Verify bin exists
        let bin = state
            .bins
            .get(&self.bin_id)
            .ok_or_else(|| CoreError::NotFound(format!("Bin not found: {}", self.bin_id)))?
            .clone();

        self.removed_bin = Some(bin);

        // Find all descendants
        let mut descendants = Vec::new();
        let mut to_check = vec![self.bin_id.clone()];

        while let Some(current_id) = to_check.pop() {
            for (id, b) in &state.bins {
                if b.parent_id.as_deref() == Some(&current_id) && *id != self.bin_id {
                    descendants.push(b.clone());
                    to_check.push(id.clone());
                }
            }
        }

        self.removed_descendants = descendants.clone();

        // Collect affected assets
        let descendant_ids: Vec<_> = descendants.iter().map(|b| b.id.clone()).collect();
        for asset in state.assets.values_mut() {
            if let Some(ref asset_bin_id) = asset.bin_id {
                if asset_bin_id == &self.bin_id || descendant_ids.contains(asset_bin_id) {
                    self.orphaned_assets
                        .push((asset.id.clone(), asset.bin_id.clone()));
                    asset.bin_id = None;
                }
            }
        }

        // Remove bin and descendants
        state.bins.remove(&self.bin_id);
        for desc in &descendants {
            state.bins.remove(&desc.id);
        }

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id).with_deleted_id(&self.bin_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        // Restore bin
        if let Some(ref bin) = self.removed_bin {
            state.bins.insert(bin.id.clone(), bin.clone());
        }

        // Restore descendants
        for desc in &self.removed_descendants {
            state.bins.insert(desc.id.clone(), desc.clone());
        }

        // Restore asset bin associations
        for (asset_id, original_bin_id) in &self.orphaned_assets {
            if let Some(asset) = state.assets.get_mut(asset_id) {
                asset.bin_id = original_bin_id.clone();
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RemoveBin"
    }

    fn to_json(&self) -> serde_json::Value {
        json!({ "binId": self.bin_id })
    }
}

// =============================================================================
// RenameBinCommand
// =============================================================================

/// Renames a bin
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBinCommand {
    bin_id: BinId,
    new_name: String,
    #[serde(skip)]
    old_name: Option<String>,
}

impl RenameBinCommand {
    pub fn new(bin_id: &str, new_name: &str) -> Self {
        Self {
            bin_id: bin_id.to_string(),
            new_name: new_name.to_string(),
            old_name: None,
        }
    }
}

impl Command for RenameBinCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Validate new name
        validate_bin_name(&self.new_name).map_err(|e| CoreError::InvalidCommand(e.to_string()))?;

        // Verify bin exists and rename
        let bin = state
            .bins
            .get_mut(&self.bin_id)
            .ok_or_else(|| CoreError::NotFound(format!("Bin not found: {}", self.bin_id)))?;

        self.old_name = Some(bin.name.clone());
        bin.rename(&self.new_name);

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let (Some(bin), Some(old_name)) = (state.bins.get_mut(&self.bin_id), &self.old_name) {
            bin.rename(old_name);
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RenameBin"
    }

    fn to_json(&self) -> serde_json::Value {
        json!({
            "binId": self.bin_id,
            "name": self.new_name,
        })
    }
}

// =============================================================================
// MoveBinCommand
// =============================================================================

/// Moves a bin to a new parent
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveBinCommand {
    bin_id: BinId,
    new_parent_id: Option<BinId>,
    #[serde(skip)]
    old_parent_id: Option<BinId>,
}

impl MoveBinCommand {
    pub fn new(bin_id: &str, new_parent_id: Option<&str>) -> Self {
        Self {
            bin_id: bin_id.to_string(),
            new_parent_id: new_parent_id.map(|s| s.to_string()),
            old_parent_id: None,
        }
    }
}

impl Command for MoveBinCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Verify bin exists
        if !state.bins.contains_key(&self.bin_id) {
            return Err(CoreError::NotFound(format!(
                "Bin not found: {}",
                self.bin_id
            )));
        }

        // Check for circular reference
        if crate::core::bins::would_create_cycle(
            &self.bin_id,
            self.new_parent_id.as_deref(),
            &state.bins,
        ) {
            return Err(CoreError::InvalidCommand(
                "Cannot move bin: would create circular reference".to_string(),
            ));
        }

        // Store old parent and update
        let bin = state.bins.get_mut(&self.bin_id).unwrap();
        self.old_parent_id = bin.parent_id.clone();
        bin.move_to(self.new_parent_id.clone());

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(bin) = state.bins.get_mut(&self.bin_id) {
            bin.move_to(self.old_parent_id.clone());
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "MoveBin"
    }

    fn to_json(&self) -> serde_json::Value {
        json!({
            "binId": self.bin_id,
            "parentId": self.new_parent_id,
        })
    }
}

// =============================================================================
// SetBinColorCommand
// =============================================================================

/// Updates a bin's color
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBinColorCommand {
    bin_id: BinId,
    color: BinColor,
    #[serde(skip)]
    old_color: Option<BinColor>,
}

impl SetBinColorCommand {
    pub fn new(bin_id: &str, color: BinColor) -> Self {
        Self {
            bin_id: bin_id.to_string(),
            color,
            old_color: None,
        }
    }

    pub fn from_string(bin_id: &str, color_str: &str) -> CoreResult<Self> {
        let color: BinColor = serde_json::from_value(json!(color_str.to_lowercase()))
            .map_err(|_| CoreError::InvalidCommand(format!("Invalid color: {}", color_str)))?;
        Ok(Self {
            bin_id: bin_id.to_string(),
            color,
            old_color: None,
        })
    }
}

impl Command for SetBinColorCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Verify bin exists
        let bin = state
            .bins
            .get_mut(&self.bin_id)
            .ok_or_else(|| CoreError::NotFound(format!("Bin not found: {}", self.bin_id)))?;

        self.old_color = Some(bin.color.clone());
        bin.color = self.color.clone();

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let (Some(bin), Some(old_color)) = (state.bins.get_mut(&self.bin_id), &self.old_color) {
            bin.color = old_color.clone();
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetBinColor"
    }

    fn to_json(&self) -> serde_json::Value {
        json!({
            "binId": self.bin_id,
            "color": self.color,
        })
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_state() -> ProjectState {
        ProjectState::new_empty("Test Project")
    }

    #[test]
    fn test_create_bin_command() {
        let mut state = create_test_state();
        let mut cmd = CreateBinCommand::new("Test Bin", None, None);

        let result = cmd.execute(&mut state);
        assert!(result.is_ok());

        let result = result.unwrap();
        assert!(!result.created_ids.is_empty());
        assert!(result.created_ids[0].starts_with("bin_"));
        assert_eq!(state.bins.len(), 1);
    }

    #[test]
    fn test_create_bin_with_parent() {
        let mut state = create_test_state();

        // Create parent first
        let mut parent_cmd = CreateBinCommand::new("Parent Bin", None, None);
        let parent_result = parent_cmd.execute(&mut state).unwrap();
        let parent_id = &parent_result.created_ids[0];

        // Create child
        let mut child_cmd =
            CreateBinCommand::new("Child Bin", Some(parent_id), Some(BinColor::Blue));
        let child_result = child_cmd.execute(&mut state);
        assert!(child_result.is_ok());

        assert_eq!(state.bins.len(), 2);
    }

    #[test]
    fn test_create_bin_invalid_name() {
        let mut state = create_test_state();
        let mut cmd = CreateBinCommand::new("", None, None);

        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_remove_bin_command() {
        let mut state = create_test_state();

        // Create a bin
        let mut create_cmd = CreateBinCommand::new("Test Bin", None, None);
        let create_result = create_cmd.execute(&mut state).unwrap();
        let bin_id = &create_result.created_ids[0];

        // Remove it
        let mut remove_cmd = RemoveBinCommand::new(bin_id);
        let result = remove_cmd.execute(&mut state);
        assert!(result.is_ok());
        assert!(state.bins.is_empty());

        // Undo removal
        remove_cmd.undo(&mut state).unwrap();
        assert_eq!(state.bins.len(), 1);
    }

    #[test]
    fn test_remove_bin_not_found() {
        let mut state = create_test_state();
        let mut cmd = RemoveBinCommand::new("nonexistent_bin");

        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_rename_bin_command() {
        let mut state = create_test_state();

        // Create a bin
        let mut create_cmd = CreateBinCommand::new("Original Name", None, None);
        let create_result = create_cmd.execute(&mut state).unwrap();
        let bin_id = &create_result.created_ids[0];

        // Rename it
        let mut rename_cmd = RenameBinCommand::new(bin_id, "New Name");
        rename_cmd.execute(&mut state).unwrap();

        assert_eq!(state.bins.get(bin_id).unwrap().name, "New Name");

        // Undo rename
        rename_cmd.undo(&mut state).unwrap();
        assert_eq!(state.bins.get(bin_id).unwrap().name, "Original Name");
    }

    #[test]
    fn test_move_bin_command() {
        let mut state = create_test_state();

        // Create two bins
        let mut bin1_cmd = CreateBinCommand::new("Bin 1", None, None);
        let bin1_result = bin1_cmd.execute(&mut state).unwrap();
        let bin1_id = &bin1_result.created_ids[0];

        let mut bin2_cmd = CreateBinCommand::new("Bin 2", None, None);
        let bin2_result = bin2_cmd.execute(&mut state).unwrap();
        let bin2_id = &bin2_result.created_ids[0];

        // Move bin2 under bin1
        let mut move_cmd = MoveBinCommand::new(bin2_id, Some(bin1_id));
        move_cmd.execute(&mut state).unwrap();

        assert_eq!(
            state.bins.get(bin2_id).unwrap().parent_id,
            Some(bin1_id.clone())
        );

        // Undo move
        move_cmd.undo(&mut state).unwrap();
        assert!(state.bins.get(bin2_id).unwrap().parent_id.is_none());
    }

    #[test]
    fn test_move_bin_circular_reference() {
        let mut state = create_test_state();

        // Create parent and child
        let mut parent_cmd = CreateBinCommand::new("Parent", None, None);
        let parent_result = parent_cmd.execute(&mut state).unwrap();
        let parent_id = &parent_result.created_ids[0];

        let mut child_cmd = CreateBinCommand::new("Child", Some(parent_id), None);
        let child_result = child_cmd.execute(&mut state).unwrap();
        let child_id = &child_result.created_ids[0];

        // Try to move parent under child (circular)
        let mut move_cmd = MoveBinCommand::new(parent_id, Some(child_id));
        let result = move_cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_bin_color_command() {
        let mut state = create_test_state();

        // Create a bin
        let mut create_cmd = CreateBinCommand::new("Test Bin", None, None);
        let create_result = create_cmd.execute(&mut state).unwrap();
        let bin_id = &create_result.created_ids[0];

        // Set color
        let mut color_cmd = SetBinColorCommand::new(bin_id, BinColor::Red);
        color_cmd.execute(&mut state).unwrap();

        assert_eq!(state.bins.get(bin_id).unwrap().color, BinColor::Red);

        // Undo
        color_cmd.undo(&mut state).unwrap();
        assert_eq!(state.bins.get(bin_id).unwrap().color, BinColor::Gray);
    }

    #[test]
    fn test_set_bin_color_from_string() {
        let cmd = SetBinColorCommand::from_string("bin_test", "blue");
        assert!(cmd.is_ok());
        assert_eq!(cmd.unwrap().color, BinColor::Blue);
    }

    #[test]
    fn test_set_bin_color_invalid_string() {
        let cmd = SetBinColorCommand::from_string("bin_test", "invalid_color");
        assert!(cmd.is_err());
    }
}

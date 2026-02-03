//! Project-level commands.
//!
//! These commands mutate project metadata through the command/executor pipeline
//! so the changes are recorded in the ops log (event sourcing).

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult},
    project::ProjectState,
    CoreError, CoreResult,
};

// =============================================================================
// UpdateProjectSettingsCommand
// =============================================================================

/// Updates project metadata (name/description/author).
///
/// Note: This only supports setting values (not clearing Option fields) because
/// the replay handler (`apply_project_settings`) only applies `as_str()` fields.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectSettingsCommand {
    /// New project name (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// New project description (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// New author name (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,

    /// Previous name (for undo)
    #[serde(skip)]
    previous_name: Option<String>,
    /// Previous description (for undo)
    #[serde(skip)]
    previous_description: Option<Option<String>>,
    /// Previous author (for undo)
    #[serde(skip)]
    previous_author: Option<Option<String>>,
}

impl UpdateProjectSettingsCommand {
    /// Creates an empty project settings update.
    ///
    /// At least one field must be set before execution.
    pub fn new() -> Self {
        Self {
            name: None,
            description: None,
            author: None,
            previous_name: None,
            previous_description: None,
            previous_author: None,
        }
    }

    /// Sets a new project name.
    pub fn with_name(mut self, name: &str) -> Self {
        self.name = Some(name.to_string());
        self
    }

    /// Sets a new project description.
    pub fn with_description(mut self, description: &str) -> Self {
        self.description = Some(description.to_string());
        self
    }

    /// Sets a new author name.
    pub fn with_author(mut self, author: &str) -> Self {
        self.author = Some(author.to_string());
        self
    }
}

impl Default for UpdateProjectSettingsCommand {
    fn default() -> Self {
        Self::new()
    }
}

impl Command for UpdateProjectSettingsCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if self.name.is_none() && self.description.is_none() && self.author.is_none() {
            return Err(CoreError::InvalidCommand(
                "UpdateProjectSettings requires at least one field".to_string(),
            ));
        }

        if let Some(name) = &self.name {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Err(CoreError::InvalidCommand(
                    "Project name cannot be empty".to_string(),
                ));
            }
        }

        // Store previous values for undo (first execution only, but safe to overwrite on redo).
        self.previous_name = Some(state.meta.name.clone());
        self.previous_description = Some(state.meta.description.clone());
        self.previous_author = Some(state.meta.author.clone());

        if let Some(name) = &self.name {
            state.meta.name = name.trim().to_string();
        }
        if let Some(description) = &self.description {
            state.meta.description = Some(description.to_string());
        }
        if let Some(author) = &self.author {
            state.meta.author = Some(author.to_string());
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(previous_name) = &self.previous_name {
            state.meta.name = previous_name.clone();
        }
        if let Some(previous_description) = &self.previous_description {
            state.meta.description = previous_description.clone();
        }
        if let Some(previous_author) = &self.previous_author {
            state.meta.author = previous_author.clone();
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "UpdateProjectSettings"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_else(|_| serde_json::json!({}))
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        commands::CommandExecutor,
        project::{OpKind, OpsLog, ProjectState},
    };
    use tempfile::TempDir;

    #[test]
    fn test_update_project_settings_updates_state() {
        let mut state = ProjectState::new("Original");
        let mut executor = CommandExecutor::new();

        let cmd = UpdateProjectSettingsCommand::new()
            .with_name("Updated")
            .with_description("Desc")
            .with_author("Author");

        executor.execute(Box::new(cmd), &mut state).unwrap();

        assert_eq!(state.meta.name, "Updated");
        assert_eq!(state.meta.description.as_deref(), Some("Desc"));
        assert_eq!(state.meta.author.as_deref(), Some("Author"));
        assert!(state.is_dirty);
    }

    #[test]
    fn test_update_project_settings_is_persisted_as_project_settings_op() {
        let temp_dir = TempDir::new().unwrap();
        let ops_path = temp_dir.path().join("ops.jsonl");

        let mut state = ProjectState::new("Original");
        let mut executor = CommandExecutor::with_ops_log(OpsLog::new(&ops_path));

        let cmd = UpdateProjectSettingsCommand::new().with_name("Updated");
        let result = executor.execute(Box::new(cmd), &mut state).unwrap();

        let persisted = OpsLog::new(&ops_path).last().unwrap().unwrap();
        assert_eq!(persisted.id, result.op_id);
        assert_eq!(persisted.kind, OpKind::ProjectSettings);
        assert_eq!(persisted.payload["name"].as_str(), Some("Updated"));
    }

    #[test]
    fn test_update_project_settings_validates_empty_name() {
        let mut state = ProjectState::new("Original");
        let mut executor = CommandExecutor::new();

        let cmd = UpdateProjectSettingsCommand::new().with_name("   ");
        let err = executor.execute(Box::new(cmd), &mut state).unwrap_err();

        let msg = format!("{err}");
        assert!(msg.contains("cannot be empty"));
        assert_eq!(state.meta.name, "Original");
    }
}

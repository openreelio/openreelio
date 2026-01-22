//! EditScript Executor Module
//!
//! Executes AI-generated EditScripts against the project state.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::edit_script::{EditCommand, EditScript};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Execution Result
// =============================================================================

/// Result of executing an EditScript
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionResult {
    /// Whether all commands executed successfully
    pub success: bool,
    /// Number of commands executed
    pub commands_executed: usize,
    /// Total number of commands
    pub total_commands: usize,
    /// Individual command results
    pub command_results: Vec<CommandResult>,
    /// Operations created (for undo)
    pub operation_ids: Vec<String>,
    /// Error message if failed
    pub error_message: Option<String>,
}

impl ExecutionResult {
    /// Creates a successful result
    pub fn success(commands_executed: usize, operation_ids: Vec<String>) -> Self {
        Self {
            success: true,
            commands_executed,
            total_commands: commands_executed,
            command_results: Vec::new(),
            operation_ids,
            error_message: None,
        }
    }

    /// Creates a partial failure result
    pub fn partial(
        executed: usize,
        total: usize,
        error: String,
        operation_ids: Vec<String>,
    ) -> Self {
        Self {
            success: false,
            commands_executed: executed,
            total_commands: total,
            command_results: Vec::new(),
            operation_ids,
            error_message: Some(error),
        }
    }

    /// Creates a failure result
    pub fn failure(error: String) -> Self {
        Self {
            success: false,
            commands_executed: 0,
            total_commands: 0,
            command_results: Vec::new(),
            operation_ids: Vec::new(),
            error_message: Some(error),
        }
    }
}

/// Result of executing a single command
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    /// Command index
    pub index: usize,
    /// Command type
    pub command_type: String,
    /// Whether successful
    pub success: bool,
    /// Operation ID if created
    pub operation_id: Option<String>,
    /// Error message if failed
    pub error: Option<String>,
}

// =============================================================================
// Validation Result
// =============================================================================

/// Result of validating an EditScript
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    /// Whether the script is valid
    pub is_valid: bool,
    /// Validation errors
    pub errors: Vec<ValidationError>,
    /// Validation warnings
    pub warnings: Vec<ValidationWarning>,
    /// Estimated execution time in seconds
    pub estimated_time_secs: Option<f64>,
}

impl ValidationResult {
    /// Creates a valid result
    pub fn valid() -> Self {
        Self {
            is_valid: true,
            errors: Vec::new(),
            warnings: Vec::new(),
            estimated_time_secs: None,
        }
    }

    /// Creates an invalid result with errors
    pub fn invalid(errors: Vec<ValidationError>) -> Self {
        Self {
            is_valid: false,
            errors,
            warnings: Vec::new(),
            estimated_time_secs: None,
        }
    }

    /// Adds a warning
    pub fn with_warning(mut self, warning: ValidationWarning) -> Self {
        self.warnings.push(warning);
        self
    }
}

/// A validation error
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    /// Command index (if applicable)
    pub command_index: Option<usize>,
    /// Error code
    pub code: String,
    /// Error message
    pub message: String,
}

impl ValidationError {
    /// Creates a new validation error
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            command_index: None,
            code: code.to_string(),
            message: message.to_string(),
        }
    }

    /// Creates an error for a specific command
    pub fn for_command(index: usize, code: &str, message: &str) -> Self {
        Self {
            command_index: Some(index),
            code: code.to_string(),
            message: message.to_string(),
        }
    }
}

/// A validation warning
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ValidationWarning {
    /// Command index (if applicable)
    pub command_index: Option<usize>,
    /// Warning code
    pub code: String,
    /// Warning message
    pub message: String,
}

impl ValidationWarning {
    /// Creates a new validation warning
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            command_index: None,
            code: code.to_string(),
            message: message.to_string(),
        }
    }
}

// =============================================================================
// EditScript Executor
// =============================================================================

/// Executor for AI-generated EditScripts
pub struct EditScriptExecutor {
    /// Whether to stop on first error
    pub stop_on_error: bool,
    /// Whether to validate before execution
    pub validate_first: bool,
}

impl EditScriptExecutor {
    /// Creates a new executor with default settings
    pub fn new() -> Self {
        Self {
            stop_on_error: true,
            validate_first: true,
        }
    }

    /// Sets whether to stop on first error
    pub fn with_stop_on_error(mut self, stop: bool) -> Self {
        self.stop_on_error = stop;
        self
    }

    /// Sets whether to validate before execution
    pub fn with_validation(mut self, validate: bool) -> Self {
        self.validate_first = validate;
        self
    }

    /// Validates an EditScript against project state
    pub fn validate(&self, script: &EditScript, context: &ExecutionContext) -> ValidationResult {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();

        // Check intent
        if script.intent.is_empty() {
            errors.push(ValidationError::new(
                "EMPTY_INTENT",
                "EditScript must have an intent",
            ));
        }

        // Check commands
        if script.commands.is_empty() {
            errors.push(ValidationError::new(
                "NO_COMMANDS",
                "EditScript must have at least one command",
            ));
        }

        // Validate each command
        for (i, cmd) in script.commands.iter().enumerate() {
            let cmd_errors = self.validate_command(cmd, i, context);
            errors.extend(cmd_errors);
        }

        // Check for high risk
        if script.has_high_risk() {
            warnings.push(ValidationWarning::new(
                "HIGH_RISK",
                "This script contains potentially risky operations (copyright/NSFW)",
            ));
        }

        // Check unfulfilled requirements
        for req in &script.requires {
            if !context
                .available_assets
                .iter()
                .any(|a| req.query.as_ref().map(|q| a.contains(q)).unwrap_or(false))
            {
                warnings.push(ValidationWarning::new(
                    "UNFULFILLED_REQUIREMENT",
                    &format!("Requirement {:?} may not be satisfied", req.kind),
                ));
            }
        }

        ValidationResult {
            is_valid: errors.is_empty(),
            errors,
            warnings,
            estimated_time_secs: Some(script.commands.len() as f64 * 0.1),
        }
    }

    /// Validates a single command
    fn validate_command(
        &self,
        cmd: &EditCommand,
        index: usize,
        context: &ExecutionContext,
    ) -> Vec<ValidationError> {
        let mut errors = Vec::new();

        match cmd.command_type.as_str() {
            "InsertClip" => {
                // Check required params
                if cmd.params.get("trackId").is_none() {
                    errors.push(ValidationError::for_command(
                        index,
                        "MISSING_TRACK_ID",
                        "InsertClip requires trackId",
                    ));
                }
                if cmd.params.get("assetId").is_none() {
                    errors.push(ValidationError::for_command(
                        index,
                        "MISSING_ASSET_ID",
                        "InsertClip requires assetId",
                    ));
                }
                if cmd.params.get("timelineStart").is_none() {
                    errors.push(ValidationError::for_command(
                        index,
                        "MISSING_TIMELINE_START",
                        "InsertClip requires timelineStart",
                    ));
                } else if let Some(value) = cmd.params.get("timelineStart") {
                    match value.as_f64() {
                        Some(t) if t.is_finite() && t >= 0.0 => {}
                        Some(_) => {
                            errors.push(ValidationError::for_command(
                                index,
                                "INVALID_TIMELINE_START",
                                "InsertClip timelineStart must be a finite, non-negative number",
                            ));
                        }
                        None => {
                            errors.push(ValidationError::for_command(
                                index,
                                "INVALID_TIMELINE_START",
                                "InsertClip timelineStart must be a number",
                            ));
                        }
                    }
                }

                // Validate asset exists
                if let Some(asset_id) = cmd.params.get("assetId").and_then(|v| v.as_str()) {
                    if !context.available_assets.contains(&asset_id.to_string()) {
                        errors.push(ValidationError::for_command(
                            index,
                            "ASSET_NOT_FOUND",
                            &format!("Asset '{}' not found in project", asset_id),
                        ));
                    }
                }

                // Validate track exists
                if let Some(track_id) = cmd.params.get("trackId").and_then(|v| v.as_str()) {
                    if !context.available_tracks.contains(&track_id.to_string()) {
                        errors.push(ValidationError::for_command(
                            index,
                            "TRACK_NOT_FOUND",
                            &format!("Track '{}' not found in project", track_id),
                        ));
                    }
                }
            }
            "SplitClip" | "DeleteClip" | "TrimClip" | "MoveClip" => {
                // Check clipId
                if cmd.params.get("clipId").is_none() {
                    errors.push(ValidationError::for_command(
                        index,
                        "MISSING_CLIP_ID",
                        &format!("{} requires clipId", cmd.command_type),
                    ));
                }

                // Validate clip exists
                if let Some(clip_id) = cmd.params.get("clipId").and_then(|v| v.as_str()) {
                    if !context.available_clips.contains(&clip_id.to_string()) {
                        errors.push(ValidationError::for_command(
                            index,
                            "CLIP_NOT_FOUND",
                            &format!("Clip '{}' not found in project", clip_id),
                        ));
                    }
                }

                // Command-specific validation
                match cmd.command_type.as_str() {
                    "SplitClip" => {
                        if cmd.params.get("atTimelineSec").is_none() {
                            errors.push(ValidationError::for_command(
                                index,
                                "MISSING_SPLIT_POINT",
                                "SplitClip requires atTimelineSec",
                            ));
                        }
                    }
                    "MoveClip" => {
                        if cmd.params.get("newStart").is_none() {
                            errors.push(ValidationError::for_command(
                                index,
                                "MISSING_NEW_START",
                                "MoveClip requires newStart",
                            ));
                        }
                    }
                    _ => {}
                }
            }
            "" => {
                errors.push(ValidationError::for_command(
                    index,
                    "EMPTY_COMMAND_TYPE",
                    "Command type cannot be empty",
                ));
            }
            _ => {
                // Unknown command type is allowed but warned about in gateway
            }
        }

        errors
    }

    /// Converts an EditCommand to a project command
    pub fn command_to_project_command(
        &self,
        cmd: &EditCommand,
    ) -> CoreResult<Box<dyn std::any::Any + Send>> {
        match cmd.command_type.as_str() {
            "InsertClip" => {
                let track_id = cmd
                    .params
                    .get("trackId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        CoreError::ValidationError("InsertClip missing trackId".to_string())
                    })?;
                let asset_id = cmd
                    .params
                    .get("assetId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        CoreError::ValidationError("InsertClip missing assetId".to_string())
                    })?;
                let timeline_start = cmd
                    .params
                    .get("timelineStart")
                    .and_then(|v| v.as_f64())
                    .ok_or_else(|| {
                        CoreError::ValidationError("InsertClip missing timelineStart".to_string())
                    })?;

                if !timeline_start.is_finite() || timeline_start < 0.0 {
                    return Err(CoreError::ValidationError(
                        "InsertClip timelineStart must be a finite, non-negative number"
                            .to_string(),
                    ));
                }

                // Return command info for IPC layer to construct actual command
                Ok(Box::new(InsertClipInfo {
                    track_id: track_id.to_string(),
                    asset_id: asset_id.to_string(),
                    timeline_start,
                }))
            }
            "SplitClip" => {
                let clip_id = cmd
                    .params
                    .get("clipId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        CoreError::ValidationError("SplitClip missing clipId".to_string())
                    })?;
                let at_sec = cmd
                    .params
                    .get("atTimelineSec")
                    .and_then(|v| v.as_f64())
                    .ok_or_else(|| {
                        CoreError::ValidationError("SplitClip missing atTimelineSec".to_string())
                    })?;

                Ok(Box::new(SplitClipInfo {
                    clip_id: clip_id.to_string(),
                    at_timeline_sec: at_sec,
                }))
            }
            "DeleteClip" => {
                let clip_id = cmd
                    .params
                    .get("clipId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        CoreError::ValidationError("DeleteClip missing clipId".to_string())
                    })?;

                Ok(Box::new(DeleteClipInfo {
                    clip_id: clip_id.to_string(),
                }))
            }
            "TrimClip" => {
                let clip_id = cmd
                    .params
                    .get("clipId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        CoreError::ValidationError("TrimClip missing clipId".to_string())
                    })?;
                let new_start = cmd.params.get("newStart").and_then(|v| v.as_f64());
                let new_end = cmd.params.get("newEnd").and_then(|v| v.as_f64());

                Ok(Box::new(TrimClipInfo {
                    clip_id: clip_id.to_string(),
                    new_start,
                    new_end,
                }))
            }
            "MoveClip" => {
                let clip_id = cmd
                    .params
                    .get("clipId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        CoreError::ValidationError("MoveClip missing clipId".to_string())
                    })?;
                let new_start = cmd
                    .params
                    .get("newStart")
                    .and_then(|v| v.as_f64())
                    .ok_or_else(|| {
                        CoreError::ValidationError("MoveClip missing newStart".to_string())
                    })?;
                let new_track_id = cmd
                    .params
                    .get("newTrackId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                Ok(Box::new(MoveClipInfo {
                    clip_id: clip_id.to_string(),
                    new_start,
                    new_track_id,
                }))
            }
            other => Err(CoreError::ValidationError(format!(
                "Unknown command type: {}",
                other
            ))),
        }
    }
}

impl Default for EditScriptExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Execution Context
// =============================================================================

/// Context for EditScript execution
#[derive(Clone, Debug, Default)]
pub struct ExecutionContext {
    /// Available asset IDs
    pub available_assets: Vec<String>,
    /// Available track IDs
    pub available_tracks: Vec<String>,
    /// Available clip IDs
    pub available_clips: Vec<String>,
    /// Timeline duration
    pub timeline_duration: f64,
    /// Active sequence ID
    pub active_sequence_id: Option<String>,
}

impl ExecutionContext {
    /// Creates a new empty context
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds available assets
    pub fn with_assets(mut self, assets: Vec<String>) -> Self {
        self.available_assets = assets;
        self
    }

    /// Adds available tracks
    pub fn with_tracks(mut self, tracks: Vec<String>) -> Self {
        self.available_tracks = tracks;
        self
    }

    /// Adds available clips
    pub fn with_clips(mut self, clips: Vec<String>) -> Self {
        self.available_clips = clips;
        self
    }
}

// =============================================================================
// Command Info Types (for IPC layer)
// =============================================================================

/// Info for InsertClip command
#[derive(Clone, Debug)]
pub struct InsertClipInfo {
    pub track_id: String,
    pub asset_id: String,
    pub timeline_start: f64,
}

/// Info for SplitClip command
#[derive(Clone, Debug)]
pub struct SplitClipInfo {
    pub clip_id: String,
    pub at_timeline_sec: f64,
}

/// Info for DeleteClip command
#[derive(Clone, Debug)]
pub struct DeleteClipInfo {
    pub clip_id: String,
}

/// Info for TrimClip command
#[derive(Clone, Debug)]
pub struct TrimClipInfo {
    pub clip_id: String,
    pub new_start: Option<f64>,
    pub new_end: Option<f64>,
}

/// Info for MoveClip command
#[derive(Clone, Debug)]
pub struct MoveClipInfo {
    pub clip_id: String,
    pub new_start: f64,
    pub new_track_id: Option<String>,
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ai::edit_script::EditCommand;

    #[test]
    fn test_execution_result_success() {
        let result = ExecutionResult::success(5, vec!["op1".to_string(), "op2".to_string()]);

        assert!(result.success);
        assert_eq!(result.commands_executed, 5);
        assert_eq!(result.operation_ids.len(), 2);
        assert!(result.error_message.is_none());
    }

    #[test]
    fn test_execution_result_failure() {
        let result = ExecutionResult::failure("Something went wrong".to_string());

        assert!(!result.success);
        assert_eq!(result.commands_executed, 0);
        assert_eq!(
            result.error_message,
            Some("Something went wrong".to_string())
        );
    }

    #[test]
    fn test_execution_result_partial() {
        let result = ExecutionResult::partial(
            3,
            5,
            "Failed at command 4".to_string(),
            vec!["op1".to_string()],
        );

        assert!(!result.success);
        assert_eq!(result.commands_executed, 3);
        assert_eq!(result.total_commands, 5);
    }

    #[test]
    fn test_validation_error_creation() {
        let error = ValidationError::new("TEST_ERROR", "Test message");
        assert!(error.command_index.is_none());
        assert_eq!(error.code, "TEST_ERROR");

        let cmd_error = ValidationError::for_command(2, "CMD_ERROR", "Command error");
        assert_eq!(cmd_error.command_index, Some(2));
    }

    #[test]
    fn test_executor_validate_empty_script() {
        let executor = EditScriptExecutor::new();
        let script = EditScript::new("");
        let context = ExecutionContext::new();

        let result = executor.validate(&script, &context);

        assert!(!result.is_valid);
        assert!(result.errors.iter().any(|e| e.code == "EMPTY_INTENT"));
        assert!(result.errors.iter().any(|e| e.code == "NO_COMMANDS"));
    }

    #[test]
    fn test_executor_validate_valid_script() {
        let executor = EditScriptExecutor::new();
        let script = EditScript::new("Add clip")
            .add_command(EditCommand::insert_clip("track_1", "asset_1", 0.0));
        let context = ExecutionContext::new()
            .with_assets(vec!["asset_1".to_string()])
            .with_tracks(vec!["track_1".to_string()]);

        let result = executor.validate(&script, &context);

        assert!(result.is_valid);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_executor_validate_missing_asset() {
        let executor = EditScriptExecutor::new();
        let script = EditScript::new("Add clip").add_command(EditCommand::insert_clip(
            "track_1",
            "asset_unknown",
            0.0,
        ));
        let context = ExecutionContext::new()
            .with_assets(vec!["asset_1".to_string()])
            .with_tracks(vec!["track_1".to_string()]);

        let result = executor.validate(&script, &context);

        assert!(!result.is_valid);
        assert!(result.errors.iter().any(|e| e.code == "ASSET_NOT_FOUND"));
    }

    #[test]
    fn test_executor_validate_missing_params() {
        let executor = EditScriptExecutor::new();
        let script = EditScript::new("Test")
            .add_command(EditCommand::new("InsertClip", serde_json::json!({})));
        let context = ExecutionContext::new();

        let result = executor.validate(&script, &context);

        assert!(!result.is_valid);
        assert!(result.errors.iter().any(|e| e.code == "MISSING_TRACK_ID"));
        assert!(result.errors.iter().any(|e| e.code == "MISSING_ASSET_ID"));
        assert!(result
            .errors
            .iter()
            .any(|e| e.code == "MISSING_TIMELINE_START"));
    }

    #[test]
    fn test_command_to_project_command_insert() {
        let executor = EditScriptExecutor::new();
        let cmd = EditCommand::insert_clip("track_1", "asset_1", 5.0);

        let result = executor.command_to_project_command(&cmd).unwrap();
        let info = result.downcast::<InsertClipInfo>().unwrap();

        assert_eq!(info.track_id, "track_1");
        assert_eq!(info.asset_id, "asset_1");
        assert_eq!(info.timeline_start, 5.0);
    }

    #[test]
    fn test_command_to_project_command_insert_requires_timeline_start() {
        let executor = EditScriptExecutor::new();
        let cmd = EditCommand::new(
            "InsertClip",
            serde_json::json!({
                "trackId": "track_1",
                "assetId": "asset_1"
            }),
        );

        let result = executor.command_to_project_command(&cmd);
        assert!(result.is_err());
    }

    #[test]
    fn test_command_to_project_command_split() {
        let executor = EditScriptExecutor::new();
        let cmd = EditCommand::split_clip("clip_1", 10.0);

        let result = executor.command_to_project_command(&cmd).unwrap();
        let info = result.downcast::<SplitClipInfo>().unwrap();

        assert_eq!(info.clip_id, "clip_1");
        assert_eq!(info.at_timeline_sec, 10.0);
    }

    #[test]
    fn test_command_to_project_command_unknown() {
        let executor = EditScriptExecutor::new();
        let cmd = EditCommand::new("UnknownCommand", serde_json::json!({}));

        let result = executor.command_to_project_command(&cmd);
        assert!(result.is_err());
    }

    #[test]
    fn test_execution_context_builder() {
        let context = ExecutionContext::new()
            .with_assets(vec!["a1".to_string(), "a2".to_string()])
            .with_tracks(vec!["t1".to_string()])
            .with_clips(vec!["c1".to_string()]);

        assert_eq!(context.available_assets.len(), 2);
        assert_eq!(context.available_tracks.len(), 1);
        assert_eq!(context.available_clips.len(), 1);
    }
}

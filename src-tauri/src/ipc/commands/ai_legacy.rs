//! AI operations commands
//!
//! Tauri IPC commands for AI intent analysis, edit script generation/execution,
//! provider configuration, unified agent chat, and raw completions.

use specta::Type;
use tauri::State;

use crate::core::CoreError;
use crate::ipc::payloads::CommandPayload;
use crate::ipc::serialize_to_json_string;
use crate::AppState;

// =============================================================================
// AI DTOs
// =============================================================================

/// Context information for AI intent analysis.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AIContextDto {
    /// Current playhead position in seconds
    pub playhead_position: f64,
    /// IDs of currently selected clips
    pub selected_clips: Vec<String>,
    /// IDs of currently selected tracks
    pub selected_tracks: Vec<String>,
    /// Nearby transcript text for context
    pub transcript_context: Option<String>,
    /// Timeline duration in seconds
    pub timeline_duration: Option<f64>,
    /// Available asset IDs
    #[serde(default)]
    pub asset_ids: Vec<String>,
    /// Available track IDs
    #[serde(default)]
    pub track_ids: Vec<String>,
    /// Preferred output language for assistant responses
    pub preferred_language: Option<String>,
}

/// AI-generated edit script containing commands to execute.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditScriptDto {
    /// Original user intent/prompt
    pub intent: String,
    /// List of edit commands to execute
    pub commands: Vec<EditCommandDto>,
    /// External requirements (assets to fetch, etc.)
    pub requires: Vec<RequirementDto>,
    /// QC rules to apply after execution
    pub qc_rules: Vec<String>,
    /// Risk assessment for the edit
    pub risk: RiskAssessmentDto,
    /// Human-readable explanation of the edit
    pub explanation: String,
    /// Preview plan for the edit
    pub preview_plan: Option<PreviewPlanDto>,
}

/// Preview plan for an EditScript.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPlanDto {
    /// Time ranges to preview
    pub ranges: Vec<PreviewRangeDto>,
    /// Whether full render is needed
    pub full_render: bool,
}

/// A time range for preview.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRangeDto {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
}

/// A single edit command within an EditScript.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditCommandDto {
    /// Command type (e.g., "InsertClip", "SplitClip")
    pub command_type: String,
    /// Command parameters as JSON
    pub params: serde_json::Value,
    /// Human-readable description of what this command does
    pub description: Option<String>,
}

/// External requirement for an EditScript (e.g., asset to fetch).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RequirementDto {
    /// Requirement type (e.g., "assetSearch", "assetGenerate")
    pub kind: String,
    /// Search query or generation prompt
    pub query: Option<String>,
    /// Provider to use (e.g., "unsplash", "pexels")
    pub provider: Option<String>,
    /// Additional parameters
    pub params: Option<serde_json::Value>,
}

/// Risk assessment for an AI-generated edit.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RiskAssessmentDto {
    /// Copyright risk level ("none", "low", "medium", "high")
    pub copyright: String,
    /// NSFW risk level ("none", "possible", "likely")
    pub nsfw: String,
}

/// AI proposal awaiting user approval.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDto {
    /// Unique proposal ID
    pub id: String,
    /// The edit script to be applied
    pub edit_script: EditScriptDto,
    /// Current status ("pending", "applied", "rejected")
    pub status: String,
    /// ISO 8601 creation timestamp
    pub created_at: String,
    /// Job ID for preview generation (if any)
    pub preview_job_id: Option<String>,
    /// Operation IDs if proposal was applied
    pub applied_op_ids: Option<Vec<String>>,
}

/// Result of applying an EditScript.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEditScriptResult {
    /// Whether all commands were applied successfully
    pub success: bool,
    /// Operation IDs of successfully applied commands
    pub applied_op_ids: Vec<String>,
    /// Error messages for failed commands
    pub errors: Vec<String>,
}

/// Result of validating an EditScript.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResultDto {
    /// Whether the EditScript is valid
    pub is_valid: bool,
    /// Critical issues that prevent execution
    pub issues: Vec<String>,
    /// Non-critical warnings
    pub warnings: Vec<String>,
}

// =============================================================================
// AI Provider DTOs
// =============================================================================

/// AI provider status DTO
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatusDto {
    /// Provider type (openai, anthropic, local)
    pub provider_type: Option<String>,
    /// Whether a provider is configured
    pub is_configured: bool,
    /// Whether the provider is available
    pub is_available: bool,
    /// Current model being used
    pub current_model: Option<String>,
    /// Available models for this provider
    pub available_models: Vec<String>,
    /// Error message if any
    pub error_message: Option<String>,
}

/// AI provider configuration DTO
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigDto {
    /// Provider type: "openai", "anthropic", or "local"
    pub provider_type: String,
    /// API key (for cloud providers)
    pub api_key: Option<String>,
    /// Base URL (for custom endpoints or local models)
    pub base_url: Option<String>,
    /// Model to use
    pub model: Option<String>,
}

// =============================================================================
// Unified Agent Chat DTOs
// =============================================================================

/// Message for conversation history
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessageDto {
    /// Role: user, assistant, or system
    pub role: String,
    /// Message content
    pub content: String,
}

/// AI response with optional actions
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AIResponseDto {
    /// Conversational response text
    pub message: String,
    /// Edit actions to execute (if any)
    pub actions: Option<Vec<EditActionDto>>,
    /// Whether user confirmation is needed
    pub needs_confirmation: Option<bool>,
    /// AI's understanding of the intent
    pub intent: Option<AIIntentDto>,
}

/// Edit action from AI
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditActionDto {
    /// Command type
    pub command_type: String,
    /// Command parameters as JSON
    pub params: serde_json::Value,
    /// Human-readable description
    pub description: Option<String>,
}

/// AI intent classification
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AIIntentDto {
    /// Intent type: chat, edit, query, clarify
    #[serde(rename = "type")]
    pub intent_type: String,
    /// Confidence score
    pub confidence: f32,
}

// =============================================================================
// Raw Completion DTOs
// =============================================================================

/// Options for raw AI completion (no AIResponse parsing).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AICompletionOptionsDto {
    /// System prompt override
    pub system_prompt: Option<String>,
    /// Model override
    pub model: Option<String>,
    /// Max tokens
    pub max_tokens: Option<u32>,
    /// Temperature
    pub temperature: Option<f32>,
    /// Whether to enable JSON mode (provider-dependent)
    pub json_mode: Option<bool>,
}

/// Token usage for a raw completion.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AICompletionUsageDto {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// Raw completion response from the configured provider.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AICompletionResponseDto {
    pub text: String,
    pub model: String,
    pub usage: AICompletionUsageDto,
    pub finish_reason: String,
}

// =============================================================================
// Connection Test DTOs
// =============================================================================

/// Error codes for connection test failures
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionErrorCode {
    /// No provider configured
    NotConfigured,
    /// Invalid API key or authentication failed
    InvalidCredentials,
    /// Rate limit exceeded
    RateLimited,
    /// Network error (timeout, DNS, connection refused)
    NetworkError,
    /// Provider service unavailable
    ServiceUnavailable,
    /// Unknown error
    Unknown,
}

/// Result of a connection test
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    /// Whether the connection test succeeded
    pub success: bool,
    /// Provider type that was tested
    pub provider: String,
    /// Model name that was tested
    pub model: String,
    /// Latency in milliseconds (only present on success)
    pub latency_ms: Option<u64>,
    /// Human-readable message
    pub message: String,
    /// Error code (only present on failure)
    pub error_code: Option<ConnectionErrorCode>,
    /// Detailed error message (only present on failure)
    pub error_details: Option<String>,
}

impl ConnectionTestResult {
    fn success(provider: String, model: String, latency_ms: u64) -> Self {
        Self {
            success: true,
            provider: provider.clone(),
            model: model.clone(),
            latency_ms: Some(latency_ms),
            message: format!("Successfully connected to {} ({}ms)", provider, latency_ms),
            error_code: None,
            error_details: None,
        }
    }

    fn failure(
        provider: String,
        model: String,
        code: ConnectionErrorCode,
        details: String,
    ) -> Self {
        let message = match &code {
            ConnectionErrorCode::NotConfigured => "No AI provider configured".to_string(),
            ConnectionErrorCode::InvalidCredentials => {
                "Invalid API key or authentication failed".to_string()
            }
            ConnectionErrorCode::RateLimited => {
                "Rate limit exceeded, please try again later".to_string()
            }
            ConnectionErrorCode::NetworkError => {
                "Network error - check your internet connection".to_string()
            }
            ConnectionErrorCode::ServiceUnavailable => {
                "AI service is temporarily unavailable".to_string()
            }
            ConnectionErrorCode::Unknown => format!("Connection failed: {}", details),
        };

        Self {
            success: false,
            provider,
            model,
            latency_ms: None,
            message,
            error_code: Some(code),
            error_details: Some(details),
        }
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Helper function to parse natural language intent into EditScript
fn parse_intent_to_script(
    intent: &str,
    asset_ids: &[String],
    track_ids: &[String],
    timeline_duration: f64,
    context: &AIContextDto,
) -> Result<crate::core::ai::EditScript, String> {
    use crate::core::ai::{EditCommand, EditScript, RiskAssessment};

    let intent_lower = intent.to_lowercase();
    let mut script = EditScript::new(intent);

    // Pattern: "Cut/trim the first X seconds"
    if (intent_lower.contains("cut")
        || intent_lower.contains("trim")
        || intent_lower.contains("\u{c798}\u{b77c}"))
        && (intent_lower.contains("first")
            || intent_lower.contains("\u{c55e}")
            || intent_lower.contains("\u{cc98}\u{c74c}"))
    {
        // Extract seconds using regex-like pattern
        let seconds = extract_seconds(&intent_lower).unwrap_or(5.0);

        if let Some(clip_id) = context.selected_clips.first() {
            // Split at the specified time, then delete the first part
            let explanation = format!(
                "This will split the clip at {} seconds. You may then delete the first segment.",
                seconds
            );
            script = script
                .add_command(
                    EditCommand::split_clip(clip_id, seconds)
                        .with_description(&format!("Split clip at {} seconds", seconds)),
                )
                .with_explanation(&explanation);
        } else if !track_ids.is_empty() {
            script = script.with_explanation("Please select a clip first, then try again.");
        }
    }
    // Pattern: "Add/Insert clip at X seconds"
    else if (intent_lower.contains("add")
        || intent_lower.contains("insert")
        || intent_lower.contains("\u{cd94}\u{ac00}"))
        && (intent_lower.contains("clip") || intent_lower.contains("\u{d074}\u{b9bd}"))
    {
        let at_time = extract_seconds(&intent_lower).unwrap_or(timeline_duration);

        if let (Some(asset_id), Some(track_id)) = (asset_ids.first(), track_ids.first()) {
            let explanation = format!(
                "Inserting clip from first available asset at {} seconds on the first track.",
                at_time
            );
            script = script
                .add_command(EditCommand::insert_clip(track_id, asset_id, at_time))
                .with_explanation(&explanation);
        } else {
            script = script.with_explanation("No assets or tracks available. Import media first.");
        }
    }
    // Pattern: "Delete/Remove the selected clip(s)"
    else if (intent_lower.contains("delete")
        || intent_lower.contains("remove")
        || intent_lower.contains("\u{c0ad}\u{c81c}"))
        && (intent_lower.contains("clip")
            || intent_lower.contains("\u{d074}\u{b9bd}")
            || intent_lower.contains("selected"))
    {
        if context.selected_clips.is_empty() {
            script = script.with_explanation("No clips selected. Please select clips to delete.");
        } else {
            for clip_id in &context.selected_clips {
                script = script.add_command(
                    EditCommand::delete_clip(clip_id)
                        .with_description(&format!("Delete clip {}", clip_id)),
                );
            }
            let explanation = format!(
                "Deleting {} selected clip(s).",
                context.selected_clips.len()
            );
            script = script.with_explanation(&explanation);
        }
    }
    // Pattern: "Move clip to X seconds"
    else if (intent_lower.contains("move") || intent_lower.contains("\u{c774}\u{b3d9}"))
        && (intent_lower.contains("clip") || intent_lower.contains("\u{d074}\u{b9bd}"))
    {
        let to_time = extract_seconds(&intent_lower).unwrap_or(0.0);

        if let Some(clip_id) = context.selected_clips.first() {
            let explanation = format!("Moving selected clip to {} seconds.", to_time);
            script = script
                .add_command(
                    EditCommand::move_clip(clip_id, to_time, None)
                        .with_description(&format!("Move clip to {} seconds", to_time)),
                )
                .with_explanation(&explanation);
        } else {
            script = script.with_explanation("Please select a clip to move.");
        }
    }
    // Default: Return explanation that we couldn't parse the intent
    else {
        let explanation = format!(
            "I couldn't understand the command '{}'. Try commands like:\n\
            - 'Cut the first 5 seconds'\n\
            - 'Add clip at 10 seconds'\n\
            - 'Delete selected clips'\n\
            - 'Move clip to 5 seconds'",
            intent
        );
        script = script.with_explanation(&explanation);
    }

    script.risk = RiskAssessment::low();
    Ok(script)
}

/// Helper function to extract seconds from a string
fn extract_seconds(text: &str) -> Option<f64> {
    // Simple pattern: look for numbers followed by optional "s", "sec", "seconds", "\u{cd08}"
    let re_patterns = [
        r"(\d+(?:\.\d+)?)\s*(?:s|sec|seconds|\x{cd08})",
        r"(\d+(?:\.\d+)?)\s+second",
        r"first\s+(\d+(?:\.\d+)?)",
        r"\x{c55e}\s*(\d+(?:\.\d+)?)",
        r"(\d+(?:\.\d+)?)\s*\x{cd08}",
    ];

    for pattern in &re_patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(caps) = re.captures(text) {
                if let Some(num_str) = caps.get(1) {
                    if let Ok(num) = num_str.as_str().parse::<f64>() {
                        return Some(num);
                    }
                }
            }
        }
    }

    // Fallback: just find any number
    if let Ok(re) = regex::Regex::new(r"(\d+(?:\.\d+)?)") {
        if let Some(caps) = re.captures(text) {
            if let Some(num_str) = caps.get(1) {
                if let Ok(num) = num_str.as_str().parse::<f64>() {
                    return Some(num);
                }
            }
        }
    }

    None
}

/// Helper function to find which track contains a clip
fn find_track_for_clip(
    project: &crate::ActiveProject,
    sequence_id: &str,
    clip_id: &str,
) -> Result<String, String> {
    let sequence = project
        .state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?;

    for track in &sequence.tracks {
        if track.clips.iter().any(|c| c.id == clip_id) {
            return Ok(track.id.clone());
        }
    }

    Err(format!("Clip {} not found in sequence", clip_id))
}

/// Categorize error message into an error code
fn categorize_error(error: &str) -> ConnectionErrorCode {
    let error_lower = error.to_lowercase();

    if error_lower.contains("401")
        || error_lower.contains("unauthorized")
        || error_lower.contains("invalid") && error_lower.contains("key")
    {
        ConnectionErrorCode::InvalidCredentials
    } else if error_lower.contains("429")
        || error_lower.contains("rate") && error_lower.contains("limit")
    {
        ConnectionErrorCode::RateLimited
    } else if error_lower.contains("timeout")
        || error_lower.contains("network")
        || error_lower.contains("connection")
        || error_lower.contains("dns")
    {
        ConnectionErrorCode::NetworkError
    } else if error_lower.contains("503")
        || error_lower.contains("502")
        || error_lower.contains("unavailable")
    {
        ConnectionErrorCode::ServiceUnavailable
    } else {
        ConnectionErrorCode::Unknown
    }
}

// =============================================================================
// AI Intent / EditScript Commands
// =============================================================================

/// Analyzes user intent and generates an EditScript
#[tauri::command]
#[specta::specta]
pub async fn analyze_intent(
    intent: String,
    context: AIContextDto,
    state: State<'_, AppState>,
) -> Result<EditScriptDto, String> {
    #[allow(unused_imports)]
    use crate::core::ai::{EditCommand, EditScript};

    // Validate input
    if intent.trim().is_empty() {
        return Err("Intent cannot be empty".to_string());
    }

    // Get project state for context enrichment
    let (asset_ids, track_ids, timeline_duration) = {
        let guard = state.project.lock().await;

        if let Some(project) = guard.as_ref() {
            let asset_ids: Vec<String> = project.state.assets.keys().cloned().collect();
            let (track_ids, duration) = if let Some(seq_id) = &project.state.active_sequence_id {
                if let Some(seq) = project.state.sequences.get(seq_id) {
                    let tracks: Vec<String> = seq.tracks.iter().map(|t| t.id.clone()).collect();
                    let dur = seq.duration();
                    (tracks, dur)
                } else {
                    (vec![], 0.0)
                }
            } else {
                (vec![], 0.0)
            };
            (asset_ids, track_ids, duration)
        } else {
            (vec![], vec![], 0.0)
        }
    };

    // Parse the intent using pattern matching for common video editing commands
    let script =
        parse_intent_to_script(&intent, &asset_ids, &track_ids, timeline_duration, &context)?;

    let requires = script
        .requires
        .into_iter()
        .map(|r| {
            Ok(RequirementDto {
                kind: serialize_to_json_string(&r.kind)
                    .map_err(|e| format!("Failed to serialize requirement kind: {e}"))?,
                query: r.query,
                provider: r.provider,
                params: r.params,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let copyright = serialize_to_json_string(&script.risk.copyright)
        .map_err(|e| format!("Failed to serialize risk.copyright: {e}"))?;
    let nsfw = serialize_to_json_string(&script.risk.nsfw)
        .map_err(|e| format!("Failed to serialize risk.nsfw: {e}"))?;

    Ok(EditScriptDto {
        intent: script.intent,
        commands: script
            .commands
            .into_iter()
            .map(|cmd| EditCommandDto {
                command_type: cmd.command_type,
                params: cmd.params,
                description: cmd.description,
            })
            .collect(),
        requires,
        qc_rules: script.qc_rules,
        risk: RiskAssessmentDto { copyright, nsfw },
        explanation: script.explanation,
        preview_plan: script.preview_plan.map(|p| PreviewPlanDto {
            ranges: p
                .ranges
                .into_iter()
                .map(|r| PreviewRangeDto {
                    start_sec: r.start_sec,
                    end_sec: r.end_sec,
                })
                .collect(),
            full_render: p.full_render,
        }),
    })
}

/// Creates a Proposal from an EditScript and stores it for review
#[tauri::command]
#[specta::specta]
pub async fn create_proposal(
    edit_script: EditScriptDto,
    state: State<'_, AppState>,
) -> Result<ProposalDto, String> {
    let proposal_id = ulid::Ulid::new().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();

    // For now, store proposal in-memory (could be persisted to project state later)
    let proposal = ProposalDto {
        id: proposal_id.clone(),
        edit_script,
        status: "pending".to_string(),
        created_at,
        preview_job_id: None,
        applied_op_ids: None,
    };

    // Validate the script has commands
    if proposal.edit_script.commands.is_empty() {
        return Err("EditScript must have at least one command".to_string());
    }

    // Verify project is open
    let guard = state.project.lock().await;
    guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    Ok(proposal)
}

/// Applies an EditScript by executing its commands
#[tauri::command]
#[specta::specta]
pub async fn apply_edit_script(
    edit_script: EditScriptDto,
    state: State<'_, AppState>,
) -> Result<ApplyEditScriptResult, String> {
    use crate::core::commands::{
        AddEffectCommand, AddMarkerCommand, AddMaskCommand, AddTextClipCommand, AddTrackCommand,
        CreateCaptionCommand, CreateFolderCommand, CreateSequenceCommand, DeleteCaptionCommand,
        DeleteFileCommand, InsertClipCommand, MoveClipCommand, MoveFileCommand, RemoveAssetCommand,
        RemoveClipCommand, RemoveEffectCommand, RemoveMarkerCommand, RemoveMaskCommand,
        RemoveTextClipCommand, RemoveTrackCommand, RenameFileCommand, RenameTrackCommand,
        ReorderTracksCommand, SetClipAudioCommand, SetClipBlendModeCommand, SetClipMuteCommand,
        SetClipSpeedCommand, SetClipTransformCommand, SetTrackBlendModeCommand, SplitClipCommand,
        ToggleTrackLockCommand, ToggleTrackMuteCommand, ToggleTrackVisibilityCommand,
        TrimClipCommand, UpdateEffectCommand, UpdateMaskCommand, UpdateTextCommand,
    };

    let mut guard = state.project.lock().await;

    let project = guard
        .as_mut()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let mut applied_op_ids: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // Get active sequence ID
    let sequence_id = project
        .state
        .active_sequence_id
        .clone()
        .ok_or_else(|| "No active sequence".to_string())?;

    // Helper for time validation (defined once, used in loop)
    let validate_time_sec = |field: &str, value: f64| -> Result<(), String> {
        if value.is_finite() && value >= 0.0 {
            Ok(())
        } else {
            Err(format!(
                "Invalid {field}: must be a finite, non-negative number"
            ))
        }
    };

    // Execute each command in order
    for cmd in &edit_script.commands {
        let mut payload = cmd.params.clone();
        let Some(obj) = payload.as_object_mut() else {
            errors.push(format!(
                "Invalid params for {}: expected JSON object",
                cmd.command_type
            ));
            continue;
        };

        let needs_sequence_id = matches!(
            cmd.command_type.as_str(),
            "InsertClip"
                | "SplitClip"
                | "DeleteClip"
                | "RemoveClip"
                | "TrimClip"
                | "MoveClip"
                | "SetClipMute"
                | "SetClipAudio"
                | "SetClipSpeed"
                | "setClipSpeed"
                | "CreateTrack"
                | "createTrack"
                | "AddTrack"
                | "addTrack"
                | "RemoveTrack"
                | "removeTrack"
                | "deleteTrack"
                | "DeleteTrack"
                | "RenameTrack"
                | "renameTrack"
                | "ToggleTrackMute"
                | "toggleTrackMute"
                | "ToggleTrackLock"
                | "toggleTrackLock"
                | "ToggleTrackVisibility"
                | "toggleTrackVisibility"
                | "UpdateCaption"
                | "CreateCaption"
                | "DeleteCaption"
                | "AddMarker"
                | "addMarker"
                | "RemoveMarker"
                | "removeMarker"
                | "DeleteMarker"
                | "deleteMarker"
                | "ReorderTracks"
                | "reorderTracks"
        );
        if needs_sequence_id && !obj.contains_key("sequenceId") {
            obj.insert(
                "sequenceId".to_string(),
                serde_json::json!(sequence_id.clone()),
            );
        }

        let sequence_id_for_cmd = obj
            .get("sequenceId")
            .and_then(|v| v.as_str())
            .unwrap_or(sequence_id.as_str())
            .to_string();

        // Some AI scripts omit trackId (they identify clips only). Inject it from current state.
        let needs_track_id = matches!(
            cmd.command_type.as_str(),
            "SplitClip"
                | "SetClipTransform"
                | "SetClipMute"
                | "SetClipAudio"
                | "SetClipSpeed"
                | "setClipSpeed"
                | "DeleteClip"
                | "RemoveClip"
                | "TrimClip"
                | "MoveClip"
                | "UpdateCaption"
                | "CreateCaption"
                | "DeleteCaption"
        );
        if needs_track_id && !obj.contains_key("trackId") {
            if let Some(clip_id) = obj.get("clipId").and_then(|v| v.as_str()) {
                let track_id = match find_track_for_clip(project, &sequence_id_for_cmd, clip_id) {
                    Ok(id) => id,
                    Err(e) => {
                        errors.push(e);
                        continue;
                    }
                };
                obj.insert("trackId".to_string(), serde_json::json!(track_id));
            }
        }

        let typed_command = match CommandPayload::parse(cmd.command_type.clone(), payload) {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!(
                    "Command parse failed ({}): {}",
                    cmd.command_type, e
                ));
                continue;
            }
        };

        let command: Box<dyn crate::core::commands::Command> = match typed_command {
            CommandPayload::InsertClip(p) => {
                if let Err(e) = validate_time_sec("timelineStart", p.timeline_start) {
                    errors.push(format!("Command validation failed (InsertClip): {e}"));
                    continue;
                }
                Box::new(InsertClipCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.asset_id,
                    p.timeline_start,
                ))
            }
            CommandPayload::RemoveClip(p) => Box::new(RemoveClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
            )),
            CommandPayload::MoveClip(p) => {
                if let Err(e) = validate_time_sec("newTimelineIn", p.new_timeline_in) {
                    errors.push(format!("Command validation failed (MoveClip): {e}"));
                    continue;
                }
                Box::new(MoveClipCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.new_timeline_in,
                    p.new_track_id,
                ))
            }
            CommandPayload::TrimClip(p) => {
                if let Some(t) = p.new_source_in {
                    if let Err(e) = validate_time_sec("newSourceIn", t) {
                        errors.push(format!("Command validation failed (TrimClip): {e}"));
                        continue;
                    }
                }
                if let Some(t) = p.new_source_out {
                    if let Err(e) = validate_time_sec("newSourceOut", t) {
                        errors.push(format!("Command validation failed (TrimClip): {e}"));
                        continue;
                    }
                }
                if let Some(t) = p.new_timeline_in {
                    if let Err(e) = validate_time_sec("newTimelineIn", t) {
                        errors.push(format!("Command validation failed (TrimClip): {e}"));
                        continue;
                    }
                }
                Box::new(TrimClipCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.new_source_in,
                    p.new_source_out,
                    p.new_timeline_in,
                ))
            }
            CommandPayload::SplitClip(p) => {
                if let Err(e) = validate_time_sec("splitTime", p.split_time) {
                    errors.push(format!("Command validation failed (SplitClip): {e}"));
                    continue;
                }
                Box::new(SplitClipCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.split_time,
                ))
            }
            CommandPayload::SetClipTransform(p) => Box::new(SetClipTransformCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.transform,
            )),
            CommandPayload::SetClipSpeed(p) => Box::new(SetClipSpeedCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.speed,
                p.reverse,
            )),
            CommandPayload::SetClipMute(p) => Box::new(SetClipMuteCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.muted,
            )),
            CommandPayload::SetClipAudio(p) => Box::new(SetClipAudioCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.volume_db,
                p.pan,
                p.muted,
                p.fade_in_sec,
                p.fade_out_sec,
            )),
            CommandPayload::SetTrackBlendMode(p) => Box::new(SetTrackBlendModeCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.blend_mode,
            )),
            CommandPayload::SetClipBlendMode(p) => Box::new(SetClipBlendModeCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.blend_mode,
            )),
            CommandPayload::ImportAsset(p) => Box::new(
                crate::core::commands::ImportAssetCommand::new(&p.name, &p.uri),
            ),
            CommandPayload::RemoveAsset(p) => Box::new(RemoveAssetCommand::new(&p.asset_id)),
            CommandPayload::CreateSequence(p) => Box::new(CreateSequenceCommand::new(
                &p.name,
                &p.format.unwrap_or_else(|| "1080p".to_string()),
            )),
            CommandPayload::CreateTrack(p) => {
                let mut track_cmd = AddTrackCommand::new(&p.sequence_id, &p.name, p.kind);
                if let Some(position) = p.position {
                    track_cmd = track_cmd.at_position(position);
                }
                Box::new(track_cmd)
            }
            CommandPayload::RemoveTrack(p) => {
                Box::new(RemoveTrackCommand::new(&p.sequence_id, &p.track_id))
            }
            CommandPayload::RenameTrack(p) => Box::new(RenameTrackCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.new_name,
            )),
            CommandPayload::ToggleTrackMute(p) => Box::new(ToggleTrackMuteCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.muted,
            )),
            CommandPayload::ToggleTrackLock(p) => Box::new(ToggleTrackLockCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.locked,
            )),
            CommandPayload::ToggleTrackVisibility(p) => Box::new(
                ToggleTrackVisibilityCommand::new(&p.sequence_id, &p.track_id, p.visible),
            ),
            CommandPayload::CreateCaption(p) => Box::new(
                CreateCaptionCommand::new(&p.sequence_id, &p.track_id, p.start_sec, p.end_sec)
                    .with_text(p.text)
                    .with_style(p.style)
                    .with_position(p.position),
            ),
            CommandPayload::DeleteCaption(p) => Box::new(DeleteCaptionCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.caption_id,
            )),
            CommandPayload::UpdateCaption(p) => Box::new(
                crate::core::commands::UpdateCaptionCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.caption_id,
                )
                .with_text(p.text)
                .with_time_range(p.start_sec, p.end_sec)
                .with_style(p.style)
                .with_position(p.position),
            ),
            CommandPayload::ReorderTracks(p) => {
                Box::new(ReorderTracksCommand::new(&p.sequence_id, p.new_order))
            }
            CommandPayload::AddEffect(p) => {
                let mut cmd =
                    AddEffectCommand::new(&p.sequence_id, &p.track_id, &p.clip_id, p.effect_type);
                for (key, value) in p.params {
                    cmd = cmd.with_param(key, value);
                }
                if let Some(pos) = p.position {
                    cmd = cmd.at_position(pos);
                }
                Box::new(cmd)
            }
            CommandPayload::RemoveEffect(p) => Box::new(RemoveEffectCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                &p.effect_id,
            )),
            CommandPayload::UpdateEffect(p) => {
                let mut cmd = UpdateEffectCommand::new(&p.effect_id);
                for (key, value) in p.params {
                    cmd = cmd.with_param(key, value);
                }
                if let Some(enabled) = p.enabled {
                    cmd = cmd.set_enabled(enabled);
                }
                Box::new(cmd)
            }
            // Mask commands
            CommandPayload::AddMask(p) => {
                let mut cmd = AddMaskCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    &p.effect_id,
                    p.shape,
                );
                if let Some(name) = p.name {
                    cmd = cmd.with_name(name);
                }
                if p.feather > 0.0 {
                    cmd = cmd.with_feather(p.feather);
                }
                if p.inverted {
                    cmd = cmd.inverted();
                }
                Box::new(cmd)
            }
            CommandPayload::UpdateMask(p) => {
                let mut cmd = UpdateMaskCommand::new(&p.effect_id, &p.mask_id);
                if let Some(shape) = p.shape {
                    cmd = cmd.with_shape(shape);
                }
                if let Some(name) = p.name {
                    cmd = cmd.with_name(name);
                }
                if let Some(feather) = p.feather {
                    cmd = cmd.with_feather(feather);
                }
                if let Some(opacity) = p.opacity {
                    cmd = cmd.with_opacity(opacity);
                }
                if let Some(expansion) = p.expansion {
                    cmd = cmd.with_expansion(expansion);
                }
                if let Some(inverted) = p.inverted {
                    cmd = cmd.with_inverted(inverted);
                }
                if let Some(blend_mode) = p.blend_mode {
                    cmd = cmd.with_blend_mode(blend_mode);
                }
                if let Some(enabled) = p.enabled {
                    cmd = cmd.with_enabled(enabled);
                }
                if let Some(locked) = p.locked {
                    cmd = cmd.with_locked(locked);
                }
                Box::new(cmd)
            }
            CommandPayload::RemoveMask(p) => {
                Box::new(RemoveMaskCommand::new(&p.effect_id, &p.mask_id))
            }
            // Marker commands
            CommandPayload::AddMarker(p) => {
                let mut cmd = AddMarkerCommand::new(&p.sequence_id, p.time_sec, &p.label);
                if let Some(color) = p.color {
                    cmd = cmd.with_color(color);
                }
                if let Some(marker_type) = p.marker_type {
                    cmd = cmd.with_marker_type(marker_type);
                }
                Box::new(cmd)
            }
            CommandPayload::RemoveMarker(p) => {
                Box::new(RemoveMarkerCommand::new(&p.sequence_id, &p.marker_id))
            }
            // Text clip commands
            CommandPayload::AddTextClip(p) => Box::new(AddTextClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.timeline_in,
                p.duration,
                p.text_data,
            )),
            CommandPayload::UpdateTextClip(p) => Box::new(UpdateTextCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.text_data,
            )),
            CommandPayload::RemoveTextClip(p) => Box::new(RemoveTextClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
            )),
            // Filesystem commands
            CommandPayload::CreateFolder(p) => Box::new(CreateFolderCommand::new(
                &p.relative_path,
                project.path.clone(),
            )),
            CommandPayload::RenameFile(p) => Box::new(RenameFileCommand::new(
                &p.old_relative_path,
                &p.new_name,
                project.path.clone(),
            )),
            CommandPayload::MoveFile(p) => Box::new(MoveFileCommand::new(
                &p.source_path,
                &p.dest_folder_path,
                project.path.clone(),
            )),
            CommandPayload::DeleteFile(p) => Box::new(DeleteFileCommand::new(
                &p.relative_path,
                project.path.clone(),
            )),
        };

        match project.executor.execute(command, &mut project.state) {
            Ok(result) => {
                applied_op_ids.push(result.op_id);
            }
            Err(e) => {
                errors.push(format!("Command execution failed: {}", e));
            }
        }
    }

    Ok(ApplyEditScriptResult {
        success: errors.is_empty(),
        applied_op_ids,
        errors,
    })
}

/// Validates an EditScript without executing
#[tauri::command]
#[specta::specta]
pub async fn validate_edit_script(
    edit_script: EditScriptDto,
    state: State<'_, AppState>,
) -> Result<ValidationResultDto, String> {
    let guard = state.project.lock().await;

    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    let mut issues: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // Check for empty commands
    if edit_script.commands.is_empty() {
        issues.push("EditScript has no commands".to_string());
    }

    // Validate each command
    for (i, cmd) in edit_script.commands.iter().enumerate() {
        if !cmd.params.is_object() {
            issues.push(format!(
                "{} command {} has invalid params: expected JSON object",
                cmd.command_type, i
            ));
            continue;
        }

        match cmd.command_type.as_str() {
            "InsertClip" => {
                if cmd.params.get("trackId").is_none() {
                    issues.push(format!("InsertClip command {} missing trackId", i));
                }
                if cmd.params.get("assetId").is_none() {
                    issues.push(format!("InsertClip command {} missing assetId", i));
                } else if let Some(asset_id) = cmd.params.get("assetId").and_then(|v| v.as_str()) {
                    if !project.state.assets.contains_key(asset_id) {
                        warnings.push(format!("Asset {} not found in project", asset_id));
                    }
                }
                if let Some(v) = cmd.params.get("timelineStart").and_then(|v| v.as_f64()) {
                    if !v.is_finite() || v < 0.0 {
                        issues.push(format!(
                            "InsertClip command {} has invalid timelineStart: must be finite and non-negative",
                            i
                        ));
                    }
                }
            }
            "SplitClip" | "DeleteClip" | "TrimClip" | "MoveClip" | "SetClipSpeed"
            | "setClipSpeed" | "changeClipSpeed" => {
                if cmd.params.get("clipId").is_none() {
                    issues.push(format!("{} command {} missing clipId", cmd.command_type, i));
                }
                if cmd.command_type == "SetClipSpeed"
                    || cmd.command_type == "setClipSpeed"
                    || cmd.command_type == "changeClipSpeed"
                {
                    match cmd.params.get("speed").and_then(|v| v.as_f64()) {
                        Some(v) if v.is_finite() && v > 0.0 => {}
                        Some(_) => {
                            issues.push(format!(
                                "SetClipSpeed command {} has invalid speed: must be finite and > 0",
                                i
                            ));
                        }
                        None => {
                            issues.push(format!("SetClipSpeed command {} missing speed", i));
                        }
                    }
                }
            }
            "SetTrackBlendMode" | "setTrackBlendMode" => {
                if cmd.params.get("trackId").is_none() {
                    issues.push(format!("SetTrackBlendMode command {} missing trackId", i));
                }
                if cmd.params.get("blendMode").is_none() {
                    issues.push(format!("SetTrackBlendMode command {} missing blendMode", i));
                }
            }
            "SetClipBlendMode" | "setClipBlendMode" => {
                if cmd.params.get("trackId").is_none() {
                    issues.push(format!("SetClipBlendMode command {} missing trackId", i));
                }
                if cmd.params.get("clipId").is_none() {
                    issues.push(format!("SetClipBlendMode command {} missing clipId", i));
                }
                if cmd.params.get("blendMode").is_none() {
                    issues.push(format!("SetClipBlendMode command {} missing blendMode", i));
                }
            }
            "CreateTrack" | "createTrack" | "AddTrack" | "addTrack" => {
                if cmd.params.get("kind").is_none() {
                    issues.push(format!("CreateTrack command {} missing kind", i));
                }
                if cmd.params.get("name").is_none() {
                    issues.push(format!("CreateTrack command {} missing name", i));
                }
            }
            "RemoveTrack" | "removeTrack" | "deleteTrack" | "DeleteTrack" => {
                if cmd.params.get("trackId").is_none() {
                    issues.push(format!("RemoveTrack command {} missing trackId", i));
                }
            }
            "RenameTrack" | "renameTrack" => {
                if cmd.params.get("trackId").is_none() {
                    issues.push(format!("RenameTrack command {} missing trackId", i));
                }
                if cmd.params.get("newName").is_none() {
                    issues.push(format!("RenameTrack command {} missing newName", i));
                }
            }
            "ToggleTrackMute" | "toggleTrackMute" => {
                if cmd.params.get("trackId").is_none() {
                    issues.push(format!("ToggleTrackMute command {} missing trackId", i));
                }
                if cmd.params.get("muted").is_none() {
                    issues.push(format!("ToggleTrackMute command {} missing muted", i));
                }
            }
            "ToggleTrackLock" | "toggleTrackLock" => {
                if cmd.params.get("trackId").is_none() {
                    issues.push(format!("ToggleTrackLock command {} missing trackId", i));
                }
                if cmd.params.get("locked").is_none() {
                    issues.push(format!("ToggleTrackLock command {} missing locked", i));
                }
            }
            "ToggleTrackVisibility" | "toggleTrackVisibility" => {
                if cmd.params.get("trackId").is_none() {
                    issues.push(format!(
                        "ToggleTrackVisibility command {} missing trackId",
                        i
                    ));
                }
                if cmd.params.get("visible").is_none() {
                    issues.push(format!(
                        "ToggleTrackVisibility command {} missing visible",
                        i
                    ));
                }
            }
            "AddMarker" | "addMarker" => {
                if cmd.params.get("timeSec").is_none() {
                    issues.push(format!("AddMarker command {} missing timeSec", i));
                } else if let Some(v) = cmd.params.get("timeSec") {
                    match v.as_f64() {
                        Some(n) if !n.is_finite() || n < 0.0 => {
                            issues.push(format!(
                                "AddMarker command {} has invalid timeSec: must be finite and non-negative",
                                i
                            ));
                        }
                        None => {
                            issues.push(format!("AddMarker command {} has non-numeric timeSec", i));
                        }
                        _ => {} // valid
                    }
                }
                if cmd.params.get("label").is_none() {
                    issues.push(format!("AddMarker command {} missing label", i));
                }
            }
            "RemoveMarker" | "removeMarker" | "DeleteMarker" | "deleteMarker" => {
                if cmd.params.get("markerId").is_none() {
                    issues.push(format!("RemoveMarker command {} missing markerId", i));
                }
            }
            _ => {
                issues.push(format!("Unknown command type: {}", cmd.command_type));
            }
        }
    }

    // Check risk levels
    match edit_script.risk.copyright.as_str() {
        "none" | "low" | "medium" | "high" => {}
        other => issues.push(format!("Invalid risk.copyright value: {}", other)),
    }
    match edit_script.risk.nsfw.as_str() {
        "none" | "possible" | "likely" => {}
        other => issues.push(format!("Invalid risk.nsfw value: {}", other)),
    }

    if edit_script.risk.copyright == "high" {
        warnings.push("High copyright risk detected".to_string());
    }
    if edit_script.risk.nsfw == "likely" {
        warnings.push("High NSFW risk detected".to_string());
    }

    Ok(ValidationResultDto {
        is_valid: issues.is_empty(),
        issues,
        warnings,
    })
}

// =============================================================================
// AI Provider Commands
// =============================================================================

/// Configures an AI provider
#[tauri::command]
#[specta::specta]
pub async fn configure_ai_provider(
    config: ProviderConfigDto,
    state: State<'_, AppState>,
) -> Result<ProviderStatusDto, String> {
    use crate::core::ai::{create_provider, ProviderConfig, ProviderRuntimeStatus, ProviderType};

    fn validate_base_url(url: &str, allow_http: bool) -> Result<(), String> {
        let url = url.trim();
        if url.is_empty() {
            return Err("Base URL cannot be empty".to_string());
        }

        if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("Base URL contains invalid whitespace/control characters".to_string());
        }

        let is_http = url.starts_with("http://");
        let is_https = url.starts_with("https://");
        if !is_http && !is_https {
            return Err("Base URL must start with http:// or https://".to_string());
        }
        if is_http && !allow_http {
            return Err("Base URL must use https:// for cloud providers".to_string());
        }

        Ok(())
    }

    let provider_type: ProviderType = config.provider_type.parse().map_err(|e: String| e)?;
    let requested_api_key = config.api_key.clone();
    let requested_base_url = config.base_url.clone();
    let requested_model = config.model.clone();

    let provider_config = match provider_type {
        ProviderType::OpenAI => {
            let api_key = config
                .api_key
                .ok_or_else(|| "API key is required for OpenAI".to_string())?;
            let mut cfg = ProviderConfig::openai(&api_key);
            if let Some(model) = &config.model {
                cfg = cfg.with_model(model);
            }
            if let Some(url) = &config.base_url {
                validate_base_url(url, false)?;
                cfg = cfg.with_base_url(url);
            }
            cfg
        }
        ProviderType::Anthropic => {
            let api_key = config
                .api_key
                .ok_or_else(|| "API key is required for Anthropic".to_string())?;
            let mut cfg = ProviderConfig::anthropic(&api_key);
            if let Some(model) = &config.model {
                cfg = cfg.with_model(model);
            }
            if let Some(url) = &config.base_url {
                validate_base_url(url, false)?;
                cfg = cfg.with_base_url(url);
            }
            cfg
        }
        ProviderType::Gemini => {
            let api_key = config
                .api_key
                .ok_or_else(|| "API key is required for Gemini".to_string())?;
            let mut cfg = ProviderConfig::gemini(&api_key);
            if let Some(model) = &config.model {
                cfg = cfg.with_model(model);
            }
            if let Some(url) = &config.base_url {
                validate_base_url(url, false)?;
                cfg = cfg.with_base_url(url);
            }
            cfg
        }
        ProviderType::Local => {
            let mut cfg = ProviderConfig::local(config.base_url.as_deref());
            if let Some(url) = &config.base_url {
                validate_base_url(url, true)?;
            }
            if let Some(model) = &config.model {
                cfg = cfg.with_model(model);
            }
            cfg
        }
    };

    // Create the provider
    let provider = create_provider(provider_config).map_err(|e| e.to_ipc_error())?;

    // Run a real connectivity/auth check.
    let provider_name = provider.name().to_string();
    let is_configured = provider.is_available();
    let (is_available, error_message) = match provider.health_check().await {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e.to_string())),
    };

    // Get available models based on provider type
    let available_models = match provider_type {
        ProviderType::OpenAI => crate::core::ai::OpenAIProvider::available_models(),
        ProviderType::Anthropic => crate::core::ai::AnthropicProvider::available_models(),
        ProviderType::Gemini => crate::core::ai::GeminiProvider::available_models(),
        ProviderType::Local => crate::core::ai::LocalProvider::common_models(),
    };

    // Set the provider on the gateway with cached status
    let gateway = state.ai_gateway.lock().await;
    gateway
        .set_provider_boxed_with_status(
            provider,
            ProviderRuntimeStatus {
                provider_type: Some(provider_type.to_string()),
                is_configured,
                is_available,
                current_model: requested_model.clone(),
                available_models: available_models.clone(),
                error_message: error_message.clone(),
            },
        )
        .await;

    let streaming_base_url = requested_base_url.unwrap_or_else(|| match provider_type {
        ProviderType::OpenAI => crate::core::ai::OpenAIProvider::DEFAULT_BASE_URL.to_string(),
        ProviderType::Anthropic => crate::core::ai::AnthropicProvider::DEFAULT_BASE_URL.to_string(),
        ProviderType::Gemini => crate::core::ai::GeminiProvider::DEFAULT_BASE_URL.to_string(),
        ProviderType::Local => crate::core::ai::LocalProvider::DEFAULT_BASE_URL.to_string(),
    });

    let streaming_model = requested_model
        .clone()
        .unwrap_or_else(|| match provider_type {
            ProviderType::OpenAI => "gpt-5.2".to_string(),
            ProviderType::Anthropic => "claude-sonnet-4-5-20251015".to_string(),
            ProviderType::Gemini => "gemini-3-flash-preview".to_string(),
            ProviderType::Local => "llama3.2".to_string(),
        });

    crate::core::ai::set_streaming_provider_config(crate::core::ai::StreamingProviderConfig {
        provider_type,
        api_key: if provider_type == ProviderType::Local {
            String::new()
        } else {
            requested_api_key.unwrap_or_default()
        },
        base_url: streaming_base_url,
        model: streaming_model,
    })
    .await;

    tracing::info!(
        "Configured AI provider: {} (configured: {}, available: {})",
        provider_name,
        is_configured,
        is_available
    );

    Ok(ProviderStatusDto {
        provider_type: Some(provider_type.to_string()),
        is_configured,
        is_available,
        current_model: requested_model,
        available_models,
        error_message,
    })
}

/// Gets the current AI provider status
#[tauri::command]
#[specta::specta]
pub async fn get_ai_provider_status(
    state: State<'_, AppState>,
) -> Result<ProviderStatusDto, String> {
    let gateway = state.ai_gateway.lock().await;
    let status = gateway.provider_status().await;

    Ok(ProviderStatusDto {
        provider_type: status.provider_type,
        is_configured: status.is_configured,
        is_available: status.is_available,
        current_model: status.current_model,
        available_models: status.available_models,
        error_message: status.error_message,
    })
}

/// Clears the current AI provider
#[tauri::command]
#[specta::specta]
pub async fn clear_ai_provider(state: State<'_, AppState>) -> Result<(), String> {
    let gateway = state.ai_gateway.lock().await;
    gateway.clear_provider().await;
    crate::core::ai::clear_streaming_provider_config().await;

    tracing::info!("Cleared AI provider");
    Ok(())
}

/// Syncs AI provider configuration from settings and encrypted vault
///
/// This command:
/// 1. Reads the primary provider from settings
/// 2. Retrieves the corresponding API key from the encrypted credential vault
/// 3. Configures the AI provider with these credentials
///
/// The API key never leaves the backend, maintaining security.
#[tauri::command]
#[specta::specta]
pub async fn sync_ai_from_vault(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ProviderStatusDto, String> {
    use crate::core::ai::{create_provider, ProviderConfig, ProviderRuntimeStatus, ProviderType};
    use crate::core::credentials::CredentialType;
    use crate::core::settings::SettingsManager;

    // Load settings to get the configured provider
    let app_data_dir = super::system::get_app_data_dir(&app)?;
    let settings_manager = SettingsManager::new(app_data_dir.clone());
    let settings = settings_manager.load();
    crate::core::ai::clear_streaming_provider_config().await;

    let provider_type = settings.ai.primary_provider;
    let model = settings.ai.primary_model.clone();

    tracing::info!(
        "Syncing AI provider from vault: {:?} with model {}",
        provider_type,
        model
    );

    // Get credential type for this provider
    let credential_type = match provider_type {
        crate::core::settings::ProviderType::OpenAI => Some(CredentialType::OpenaiApiKey),
        crate::core::settings::ProviderType::Anthropic => Some(CredentialType::AnthropicApiKey),
        crate::core::settings::ProviderType::Gemini => Some(CredentialType::GoogleApiKey),
        crate::core::settings::ProviderType::Local => None,
    };

    // Convert settings ProviderType to AI ProviderType
    let ai_provider_type = match provider_type {
        crate::core::settings::ProviderType::OpenAI => ProviderType::OpenAI,
        crate::core::settings::ProviderType::Anthropic => ProviderType::Anthropic,
        crate::core::settings::ProviderType::Gemini => ProviderType::Gemini,
        crate::core::settings::ProviderType::Local => ProviderType::Local,
    };

    // Get API key from vault (if needed)
    let api_key = if let Some(cred_type) = credential_type {
        let vault_path = app_data_dir.join("credentials.vault");

        if !vault_path.exists() {
            tracing::warn!("Credential vault does not exist, provider not configured");
            return Ok(ProviderStatusDto {
                provider_type: Some(ai_provider_type.to_string()),
                is_configured: false,
                is_available: false,
                current_model: Some(model),
                available_models: vec![],
                error_message: Some(
                    "No API key configured. Please set your API key in Settings.".to_string(),
                ),
            });
        }

        let mut guard = state.credential_vault.lock().await;
        if guard.is_none() {
            *guard = Some(
                crate::core::credentials::CredentialVault::new(vault_path)
                    .map_err(|e| format!("Failed to initialize credential vault: {}", e))?,
            );
        }
        let vault = guard
            .as_ref()
            .ok_or_else(|| "Credential vault unavailable".to_string())?;

        // Check if credential exists
        if !vault.exists(cred_type).await {
            tracing::warn!("No API key found in vault for provider {:?}", provider_type);
            return Ok(ProviderStatusDto {
                provider_type: Some(ai_provider_type.to_string()),
                is_configured: false,
                is_available: false,
                current_model: Some(model),
                available_models: vec![],
                error_message: Some(
                    "No API key configured. Please set your API key in Settings.".to_string(),
                ),
            });
        }

        // Retrieve the API key
        Some(
            vault
                .retrieve(cred_type)
                .await
                .map_err(|e| format!("Failed to retrieve credential: {}", e))?,
        )
    } else {
        None
    };

    let streaming_api_key = api_key.clone().unwrap_or_default();
    let streaming_base_url = match ai_provider_type {
        ProviderType::OpenAI => crate::core::ai::OpenAIProvider::DEFAULT_BASE_URL.to_string(),
        ProviderType::Anthropic => crate::core::ai::AnthropicProvider::DEFAULT_BASE_URL.to_string(),
        ProviderType::Gemini => crate::core::ai::GeminiProvider::DEFAULT_BASE_URL.to_string(),
        ProviderType::Local => settings
            .ai
            .ollama_url
            .clone()
            .unwrap_or_else(|| crate::core::ai::LocalProvider::DEFAULT_BASE_URL.to_string()),
    };

    // Build provider config
    let provider_config = match ai_provider_type {
        ProviderType::OpenAI => {
            let key = api_key.ok_or_else(|| "API key required for OpenAI".to_string())?;
            ProviderConfig::openai(&key).with_model(&model)
        }
        ProviderType::Anthropic => {
            let key = api_key.ok_or_else(|| "API key required for Anthropic".to_string())?;
            ProviderConfig::anthropic(&key).with_model(&model)
        }
        ProviderType::Gemini => {
            let key = api_key.ok_or_else(|| "API key required for Gemini".to_string())?;
            ProviderConfig::gemini(&key).with_model(&model)
        }
        ProviderType::Local => {
            let base_url = settings
                .ai
                .ollama_url
                .as_deref()
                .unwrap_or("http://localhost:11434");
            ProviderConfig::local(Some(base_url)).with_model(&model)
        }
    };

    // Create the provider
    let provider = create_provider(provider_config).map_err(|e| e.to_ipc_error())?;

    // Run a real connectivity/auth check
    let provider_name = provider.name().to_string();
    let is_configured = provider.is_available();
    let (is_available, error_message) = match provider.health_check().await {
        Ok(()) => (true, None),
        Err(e) => (false, Some(e.to_string())),
    };

    // Get available models based on provider type
    let available_models = match ai_provider_type {
        ProviderType::OpenAI => crate::core::ai::OpenAIProvider::available_models(),
        ProviderType::Anthropic => crate::core::ai::AnthropicProvider::available_models(),
        ProviderType::Gemini => crate::core::ai::GeminiProvider::available_models(),
        ProviderType::Local => crate::core::ai::LocalProvider::common_models(),
    };

    // Set the provider on the gateway with cached status
    let gateway = state.ai_gateway.lock().await;
    gateway
        .set_provider_boxed_with_status(
            provider,
            ProviderRuntimeStatus {
                provider_type: Some(ai_provider_type.to_string()),
                is_configured,
                is_available,
                current_model: Some(model.clone()),
                available_models: available_models.clone(),
                error_message: error_message.clone(),
            },
        )
        .await;

    crate::core::ai::set_streaming_provider_config(crate::core::ai::StreamingProviderConfig {
        provider_type: ai_provider_type,
        api_key: if ai_provider_type == ProviderType::Local {
            String::new()
        } else {
            streaming_api_key
        },
        base_url: streaming_base_url,
        model: model.clone(),
    })
    .await;

    tracing::info!(
        "Synced AI provider from vault: {} (configured: {}, available: {})",
        provider_name,
        is_configured,
        is_available
    );

    Ok(ProviderStatusDto {
        provider_type: Some(ai_provider_type.to_string()),
        is_configured,
        is_available,
        current_model: Some(model),
        available_models,
        error_message,
    })
}

// =============================================================================
// Unified Agent Chat
// =============================================================================

/// Chat with AI using conversation history (unified agent mode)
///
/// This endpoint supports natural conversation and optional edit commands.
/// The AI will decide whether to respond conversationally or execute edits.
#[tauri::command]
#[specta::specta]
pub async fn chat_with_ai(
    messages: Vec<ConversationMessageDto>,
    context: AIContextDto,
    state: State<'_, AppState>,
) -> Result<AIResponseDto, String> {
    use crate::core::ai::{ConversationMessage, EditContext};

    let gateway = state.ai_gateway.lock().await;

    if !gateway.is_configured().await {
        return Err("No AI provider configured. Configure an AI provider in Settings.".to_string());
    }

    // Convert DTOs to internal types
    let conversation_messages: Vec<ConversationMessage> = messages
        .into_iter()
        .map(|m| ConversationMessage {
            role: m.role,
            content: m.content,
        })
        .collect();

    // Build edit context
    let edit_context = EditContext::new()
        .with_duration(context.timeline_duration.unwrap_or(0.0))
        .with_assets(context.asset_ids.clone())
        .with_tracks(context.track_ids.clone())
        .with_selection(context.selected_clips.clone())
        .with_playhead(context.playhead_position)
        .with_preferred_language(context.preferred_language.clone());

    // Chat with AI
    let response = gateway
        .chat(conversation_messages, &edit_context)
        .await
        .map_err(|e| e.to_ipc_error())?;

    // Convert to DTO
    Ok(AIResponseDto {
        message: response.message,
        actions: response.actions.map(|actions| {
            actions
                .into_iter()
                .map(|a| EditActionDto {
                    command_type: a.command_type,
                    params: a.params,
                    description: a.description,
                })
                .collect()
        }),
        needs_confirmation: response.needs_confirmation,
        intent: response.intent.map(|i| AIIntentDto {
            intent_type: match i.intent_type {
                crate::core::ai::AIIntentType::Chat => "chat".to_string(),
                crate::core::ai::AIIntentType::Edit => "edit".to_string(),
                crate::core::ai::AIIntentType::Query => "query".to_string(),
                crate::core::ai::AIIntentType::Clarify => "clarify".to_string(),
            },
            confidence: i.confidence,
        }),
    })
}

/// Perform a raw completion using the configured AI provider.
///
/// Unlike `chat_with_ai`, this does not apply the unified-agent system prompt and does not parse
/// the output into an `AIResponse`. This is intended for the frontend agentic engine, which
/// supplies its own prompts and schemas.
#[tauri::command]
#[specta::specta]
pub async fn complete_with_ai_raw(
    messages: Vec<ConversationMessageDto>,
    options: Option<AICompletionOptionsDto>,
    state: State<'_, AppState>,
) -> Result<AICompletionResponseDto, String> {
    use crate::core::ai::provider::{CompletionRequest, ConversationMessage, FinishReason};

    let gateway = state.ai_gateway.lock().await;

    if !gateway.is_configured().await {
        return Err("No AI provider configured. Configure an AI provider in Settings.".to_string());
    }

    if messages.is_empty() {
        return Err("At least one message is required.".to_string());
    }

    let mut system_parts: Vec<String> = Vec::new();
    let mut conversation_messages: Vec<ConversationMessage> = Vec::new();

    for msg in messages {
        if msg.role.to_lowercase() == "system" {
            system_parts.push(msg.content);
        } else {
            conversation_messages.push(ConversationMessage {
                role: msg.role,
                content: msg.content,
            });
        }
    }

    if conversation_messages.is_empty() {
        return Err("At least one non-system message is required.".to_string());
    }

    let mut request = CompletionRequest::with_conversation(conversation_messages);

    if let Some(opts) = options {
        if let Some(system_prompt) = opts.system_prompt {
            system_parts.insert(0, system_prompt);
        }
        if let Some(model) = opts.model {
            request = request.with_model(&model);
        }
        if let Some(max_tokens) = opts.max_tokens {
            request = request.with_max_tokens(max_tokens);
        }
        if let Some(temperature) = opts.temperature {
            request = request.with_temperature(temperature);
        }
        if opts.json_mode.unwrap_or(false) {
            request = request.with_json_mode();
        }
    }

    if !system_parts.is_empty() {
        request = request.with_system(&system_parts.join("\n\n"));
    }

    let response = gateway
        .complete_raw(request)
        .await
        .map_err(|e| e.to_ipc_error())?;

    Ok(AICompletionResponseDto {
        text: response.text,
        model: response.model,
        usage: AICompletionUsageDto {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
        },
        finish_reason: match response.finish_reason {
            FinishReason::Stop => "stop".to_string(),
            FinishReason::Length => "length".to_string(),
            FinishReason::ContentFilter => "content_filter".to_string(),
            FinishReason::ToolCalls => "tool_calls".to_string(),
        },
    })
}

/// Tests the AI connection by making a simple request with detailed results
#[tauri::command]
#[specta::specta]
pub async fn test_ai_connection(
    state: State<'_, AppState>,
) -> Result<ConnectionTestResult, String> {
    let gateway = state.ai_gateway.lock().await;

    if !gateway.is_configured().await {
        return Ok(ConnectionTestResult::failure(
            "none".to_string(),
            "none".to_string(),
            ConnectionErrorCode::NotConfigured,
            "No AI provider is configured".to_string(),
        ));
    }

    let status = gateway.provider_status().await;
    let provider_name = status
        .provider_type
        .unwrap_or_else(|| "unknown".to_string());
    let model_name = status
        .current_model
        .unwrap_or_else(|| "unknown".to_string());

    // Measure latency with timeout
    let start = std::time::Instant::now();
    let timeout_duration = std::time::Duration::from_secs(10);

    let health_result = tokio::time::timeout(timeout_duration, gateway.health_check()).await;
    let latency_ms = start.elapsed().as_millis() as u64;

    match health_result {
        Ok(Ok(())) => {
            gateway.update_provider_status(true, None).await;
            tracing::info!(
                "AI provider health check succeeded: {} ({}) in {}ms",
                provider_name,
                model_name,
                latency_ms
            );
            Ok(ConnectionTestResult::success(
                provider_name,
                model_name,
                latency_ms,
            ))
        }
        Ok(Err(e)) => {
            let error_str = e.to_string();
            let error_code = categorize_error(&error_str);
            gateway
                .update_provider_status(false, Some(error_str.clone()))
                .await;
            tracing::warn!(
                "AI provider health check failed: {} ({}) - {:?}: {}",
                provider_name,
                model_name,
                error_code,
                error_str
            );
            Ok(ConnectionTestResult::failure(
                provider_name,
                model_name,
                error_code,
                error_str,
            ))
        }
        Err(_) => {
            let error_str = "Connection timed out after 10 seconds".to_string();
            gateway
                .update_provider_status(false, Some(error_str.clone()))
                .await;
            tracing::warn!(
                "AI provider health check timed out: {} ({})",
                provider_name,
                model_name
            );
            Ok(ConnectionTestResult::failure(
                provider_name,
                model_name,
                ConnectionErrorCode::NetworkError,
                error_str,
            ))
        }
    }
}

/// Generates an EditScript from natural language using the AI provider
#[tauri::command]
#[specta::specta]
pub async fn generate_edit_script_with_ai(
    intent: String,
    context: AIContextDto,
    state: State<'_, AppState>,
) -> Result<EditScriptDto, String> {
    use crate::core::ai::EditContext;

    let gateway = state.ai_gateway.lock().await;

    if !gateway.is_configured().await {
        return Err("No AI provider configured. Configure an AI provider in Settings.".to_string());
    }
    if !gateway.has_provider().await {
        return Err(
            "AI provider not reachable. Use 'Test connection' in Settings to verify connectivity."
                .to_string(),
        );
    }

    // Build the edit context
    let mut edit_context = EditContext::new()
        .with_duration(context.timeline_duration.unwrap_or(0.0))
        .with_assets(context.asset_ids.clone())
        .with_tracks(context.track_ids.clone())
        .with_selection(context.selected_clips.clone())
        .with_playhead(context.playhead_position);

    if let Some(ref transcript) = context.transcript_context {
        edit_context = edit_context.with_transcript(transcript);
    }

    // Generate edit script using the AI gateway
    let edit_script = gateway
        .generate_edit_script(&intent, &edit_context)
        .await
        .map_err(|e| e.to_ipc_error())?;

    // Convert to DTO
    let requires = edit_script
        .requires
        .into_iter()
        .map(|req| {
            Ok(RequirementDto {
                kind: serialize_to_json_string(&req.kind)
                    .map_err(|e| format!("Failed to serialize requirement kind: {e}"))?,
                query: req.query,
                provider: req.provider,
                params: req.params,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let copyright = serialize_to_json_string(&edit_script.risk.copyright)
        .map_err(|e| format!("Failed to serialize risk.copyright: {e}"))?;
    let nsfw = serialize_to_json_string(&edit_script.risk.nsfw)
        .map_err(|e| format!("Failed to serialize risk.nsfw: {e}"))?;

    Ok(EditScriptDto {
        intent: edit_script.intent,
        commands: edit_script
            .commands
            .into_iter()
            .map(|cmd| EditCommandDto {
                command_type: cmd.command_type,
                params: cmd.params,
                description: cmd.description,
            })
            .collect(),
        requires,
        qc_rules: edit_script.qc_rules,
        risk: RiskAssessmentDto { copyright, nsfw },
        explanation: edit_script.explanation,
        preview_plan: edit_script.preview_plan.map(|p| PreviewPlanDto {
            ranges: p
                .ranges
                .into_iter()
                .map(|r| PreviewRangeDto {
                    start_sec: r.start_sec,
                    end_sec: r.end_sec,
                })
                .collect(),
            full_render: p.full_render,
        }),
    })
}

/// Gets available AI models for a provider type
#[tauri::command]
#[specta::specta]
pub async fn get_available_ai_models(provider_type: String) -> Result<Vec<String>, String> {
    use crate::core::ai::ProviderType;

    let ptype: ProviderType = provider_type.parse().map_err(|e: String| e)?;

    let models = match ptype {
        ProviderType::OpenAI => crate::core::ai::OpenAIProvider::available_models(),
        ProviderType::Anthropic => crate::core::ai::AnthropicProvider::available_models(),
        ProviderType::Gemini => crate::core::ai::GeminiProvider::available_models(),
        ProviderType::Local => crate::core::ai::LocalProvider::common_models(),
    };

    Ok(models)
}

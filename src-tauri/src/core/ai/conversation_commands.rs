//! IPC Commands for AI Conversation Persistence
//!
//! Provides Tauri commands for managing AI conversation sessions, messages,
//! and message parts. These commands expose the ConversationDb layer to the
//! frontend via type-safe IPC (tauri-specta).

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::conversation::{
    AgentRunRow, CompactionRecordRow, ConversationDb, DelegationRecordRow, MessageRow,
    MessageWithParts, PartRow, PermissionDecisionRow, ResumeCheckpointRow, SessionRow,
};

// =============================================================================
// DTO Types (camelCase serialization for JavaScript consumption)
// =============================================================================

/// Summary of an AI conversation session, suitable for list views.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummaryDto {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub agent: String,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub message_count: i32,
    pub last_message_preview: Option<String>,
}

/// Full session with all its messages and parts.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionWithMessagesDto {
    pub session: SessionSummaryDto,
    pub messages: Vec<MessageDto>,
}

/// A single message within a conversation session.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub timestamp: i64,
    pub parts: Vec<PartDto>,
    pub usage_json: Option<String>,
    pub finish_reason: Option<String>,
}

/// A content part within a message (text, tool call, tool result, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PartDto {
    pub id: String,
    pub message_id: String,
    pub sort_order: i32,
    pub part_type: String,
    pub data_json: String,
    pub compacted_at: Option<i64>,
}

/// Input payload for saving a new message with its parts.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveMessageInput {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub timestamp: i64,
    pub parts: Vec<SavePartInput>,
    pub usage_json: Option<String>,
    pub finish_reason: Option<String>,
}

/// Input payload for a single message part within SaveMessageInput.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavePartInput {
    pub id: String,
    pub sort_order: i32,
    pub part_type: String,
    pub data_json: String,
}

/// Lineage metadata for an agent session kernel.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionLineageDto {
    pub parent_session_id: Option<String>,
    pub branch_from_session_id: Option<String>,
    pub root_session_id: String,
}

/// Agent session header aligned with the frontend session kernel vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionDto {
    pub id: String,
    pub project_id: String,
    pub sequence_id: Option<String>,
    pub title: String,
    pub status: String,
    pub runtime_kind: String,
    pub agent_profile_id: String,
    pub session_mode: String,
    pub lineage: AgentSessionLineageDto,
    pub current_run_id: Option<String>,
    pub current_plan_id: Option<String>,
    pub pending_approval_id: Option<String>,
    pub active_checkpoint_id: Option<String>,
    pub permission_state_version: i64,
    pub compaction_version: i64,
    pub resume_cursor_version: i64,
    pub latest_summary_message_id: Option<String>,
    pub last_compacted_at: Option<i64>,
    pub last_resumed_at: Option<i64>,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

/// Persisted orchestration run for an agent session.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunDto {
    pub id: String,
    pub session_id: String,
    pub runtime_kind: String,
    pub trigger: String,
    pub input_message_id: Option<String>,
    pub output_message_id: Option<String>,
    pub phase: String,
    pub iteration: i64,
    pub max_iterations: i64,
    pub tool_calls_used: i64,
    pub max_tool_calls: i64,
    pub planned_step_count: i64,
    pub completed_step_count: i64,
    pub trace_id: Option<String>,
    pub rollback_report_json: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    pub ended_at: Option<i64>,
}

/// Session kernel detail with run ledger.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionDetailDto {
    pub session: AgentSessionDto,
    pub runs: Vec<AgentRunDto>,
}

/// Input payload for creating an agent session kernel row.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentSessionInputDto {
    pub project_id: String,
    pub sequence_id: Option<String>,
    pub title: Option<String>,
    pub runtime_kind: Option<String>,
    pub agent_profile_id: Option<String>,
    pub session_mode: Option<String>,
    pub parent_session_id: Option<String>,
    pub branch_from_session_id: Option<String>,
    pub root_session_id: Option<String>,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub id: Option<String>,
}

/// Input payload for starting a new agent run.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StartAgentRunInput {
    pub session_id: String,
    pub runtime_kind: Option<String>,
    pub trigger: Option<String>,
    pub max_iterations: Option<i64>,
    pub max_tool_calls: Option<i64>,
    pub planned_step_count: Option<i64>,
    pub input_message_id: Option<String>,
    pub trace_id: Option<String>,
    pub id: Option<String>,
}

/// Input payload for updating an agent run phase and syncing session state.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentRunPhaseInput {
    pub run_id: String,
    pub phase: String,
    pub trace_id: Option<String>,
    pub tool_calls_used: Option<i64>,
    pub planned_step_count: Option<i64>,
    pub completed_step_count: Option<i64>,
    pub output_message_id: Option<String>,
    pub rollback_report_json: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub current_plan_id: Option<String>,
    pub pending_approval_id: Option<String>,
    pub active_checkpoint_id: Option<String>,
    pub permission_state_version: Option<i64>,
    pub compaction_version: Option<i64>,
    pub resume_cursor_version: Option<i64>,
    pub last_compacted_at: Option<i64>,
    pub last_resumed_at: Option<i64>,
    pub ended_at: Option<i64>,
}

/// Persisted delegation DTO aligned with the frontend session kernel vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DelegationRecordDto {
    pub id: String,
    pub parent_session_id: String,
    pub child_session_id: String,
    pub parent_run_id: String,
    pub agent_profile_id: String,
    pub delegated_goal: String,
    pub context_packet_json: String,
    pub allowed_tools_delta_json: Option<String>,
    pub permission_snapshot_json: Option<String>,
    pub status: String,
    pub merge_status: String,
    pub summary_message_id: Option<String>,
    pub result_json: Option<String>,
    pub error_message: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

/// Persisted permission decision DTO aligned with the frontend session kernel vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecisionDto {
    pub id: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub step_id: Option<String>,
    pub subject_type: String,
    pub subject: String,
    pub action: String,
    pub source: String,
    pub reason: Option<String>,
    pub created_at: i64,
}

/// Persisted compaction record DTO aligned with the frontend session kernel vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CompactionRecordDto {
    pub id: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub tier: String,
    pub trigger: String,
    pub summary_message_id: Option<String>,
    pub source_message_count: i64,
    pub retained_message_count: i64,
    pub estimated_tokens_saved: Option<i64>,
    pub continuation_summary_json: Option<String>,
    pub state_rehydration_json: Option<String>,
    pub created_at: i64,
}

/// Persisted resume checkpoint DTO aligned with the frontend session kernel vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCheckpointDto {
    pub id: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub checkpoint_kind: String,
    pub status: String,
    pub resume_cursor_json: String,
    pub session_state_json: String,
    pub pending_work_json: Option<String>,
    pub created_at: i64,
    pub consumed_at: Option<i64>,
}

/// Input payload for creating a delegation record.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateDelegationRecordInput {
    pub id: Option<String>,
    pub parent_session_id: String,
    pub child_session_id: String,
    pub parent_run_id: String,
    pub agent_profile_id: String,
    pub delegated_goal: String,
    pub context_packet_json: String,
    pub allowed_tools_delta_json: Option<String>,
    pub permission_snapshot_json: Option<String>,
    pub status: Option<String>,
    pub merge_status: Option<String>,
    pub summary_message_id: Option<String>,
    pub result_json: Option<String>,
    pub error_message: Option<String>,
    pub completed_at: Option<i64>,
}

/// Input payload for updating a delegation record.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDelegationRecordInput {
    pub id: String,
    pub status: Option<String>,
    pub merge_status: Option<String>,
    pub summary_message_id: Option<String>,
    pub result_json: Option<String>,
    pub error_message: Option<String>,
    pub completed_at: Option<i64>,
}

/// Input payload for recording a permission decision.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordPermissionDecisionInput {
    pub id: Option<String>,
    pub session_id: String,
    pub run_id: Option<String>,
    pub step_id: Option<String>,
    pub subject_type: String,
    pub subject: String,
    pub action: String,
    pub source: String,
    pub reason: Option<String>,
    pub created_at: Option<i64>,
}

/// Input payload for recording a compaction event.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordCompactionInput {
    pub id: Option<String>,
    pub session_id: String,
    pub run_id: Option<String>,
    pub tier: String,
    pub trigger: String,
    pub summary_message_id: Option<String>,
    pub source_message_count: i64,
    pub retained_message_count: i64,
    pub estimated_tokens_saved: Option<i64>,
    pub continuation_summary_json: Option<String>,
    pub state_rehydration_json: Option<String>,
    pub created_at: Option<i64>,
}

/// Input payload for creating a resume checkpoint.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateResumeCheckpointInput {
    pub id: Option<String>,
    pub session_id: String,
    pub run_id: Option<String>,
    pub checkpoint_kind: String,
    pub status: Option<String>,
    pub resume_cursor_json: String,
    pub session_state_json: String,
    pub pending_work_json: Option<String>,
    pub created_at: Option<i64>,
}

// =============================================================================
// Conversion helpers (domain row -> DTO)
// =============================================================================

impl From<&SessionRow> for SessionSummaryDto {
    fn from(row: &SessionRow) -> Self {
        Self {
            id: row.id.clone(),
            project_id: row.project_id.clone(),
            title: row.title.clone(),
            agent: row.agent.clone(),
            model_provider: row.model_provider.clone(),
            model_id: row.model_id.clone(),
            created_at: row.created_at,
            updated_at: row.updated_at,
            archived: row.archived,
            // Populated separately by the caller when available.
            message_count: 0,
            last_message_preview: None,
        }
    }
}

impl From<&SessionRow> for AgentSessionDto {
    fn from(row: &SessionRow) -> Self {
        Self {
            id: row.id.clone(),
            project_id: row.project_id.clone(),
            sequence_id: row.sequence_id.clone(),
            title: row.title.clone(),
            status: row.status.clone(),
            runtime_kind: row.runtime_kind.clone(),
            agent_profile_id: row.agent.clone(),
            session_mode: row.session_mode.clone(),
            lineage: AgentSessionLineageDto {
                parent_session_id: row.parent_session_id.clone(),
                branch_from_session_id: row.branch_from_session_id.clone(),
                root_session_id: row.root_session_id.clone(),
            },
            current_run_id: row.current_run_id.clone(),
            current_plan_id: row.current_plan_id.clone(),
            pending_approval_id: row.pending_approval_id.clone(),
            active_checkpoint_id: row.active_checkpoint_id.clone(),
            permission_state_version: row.permission_state_version,
            compaction_version: row.compaction_version,
            resume_cursor_version: row.resume_cursor_version,
            latest_summary_message_id: row.summary_message_id.clone(),
            last_compacted_at: row.last_compacted_at,
            last_resumed_at: row.last_resumed_at,
            model_provider: row.model_provider.clone(),
            model_id: row.model_id.clone(),
            created_at: row.created_at,
            updated_at: row.updated_at,
            completed_at: row.completed_at,
        }
    }
}

impl From<&AgentRunRow> for AgentRunDto {
    fn from(row: &AgentRunRow) -> Self {
        Self {
            id: row.id.clone(),
            session_id: row.session_id.clone(),
            runtime_kind: row.runtime_kind.clone(),
            trigger: row.trigger.clone(),
            input_message_id: row.input_message_id.clone(),
            output_message_id: row.output_message_id.clone(),
            phase: row.phase.clone(),
            iteration: row.iteration,
            max_iterations: row.max_iterations,
            tool_calls_used: row.tool_calls_used,
            max_tool_calls: row.max_tool_calls,
            planned_step_count: row.planned_step_count,
            completed_step_count: row.completed_step_count,
            trace_id: row.trace_id.clone(),
            rollback_report_json: row.rollback_report_json.clone(),
            error_code: row.error_code.clone(),
            error_message: row.error_message.clone(),
            started_at: row.started_at,
            updated_at: row.updated_at,
            ended_at: row.ended_at,
        }
    }
}

impl From<&DelegationRecordRow> for DelegationRecordDto {
    fn from(row: &DelegationRecordRow) -> Self {
        Self {
            id: row.id.clone(),
            parent_session_id: row.parent_session_id.clone(),
            child_session_id: row.child_session_id.clone(),
            parent_run_id: row.parent_run_id.clone(),
            agent_profile_id: row.agent_profile_id.clone(),
            delegated_goal: row.delegated_goal.clone(),
            context_packet_json: row.context_packet_json.clone(),
            allowed_tools_delta_json: row.allowed_tools_delta_json.clone(),
            permission_snapshot_json: row.permission_snapshot_json.clone(),
            status: row.status.clone(),
            merge_status: row.merge_status.clone(),
            summary_message_id: row.summary_message_id.clone(),
            result_json: row.result_json.clone(),
            error_message: row.error_message.clone(),
            created_at: row.created_at,
            updated_at: row.updated_at,
            completed_at: row.completed_at,
        }
    }
}

impl From<&PermissionDecisionRow> for PermissionDecisionDto {
    fn from(row: &PermissionDecisionRow) -> Self {
        Self {
            id: row.id.clone(),
            session_id: row.session_id.clone(),
            run_id: row.run_id.clone(),
            step_id: row.step_id.clone(),
            subject_type: row.subject_type.clone(),
            subject: row.subject.clone(),
            action: row.action.clone(),
            source: row.source.clone(),
            reason: row.reason.clone(),
            created_at: row.created_at,
        }
    }
}

impl From<&CompactionRecordRow> for CompactionRecordDto {
    fn from(row: &CompactionRecordRow) -> Self {
        Self {
            id: row.id.clone(),
            session_id: row.session_id.clone(),
            run_id: row.run_id.clone(),
            tier: row.tier.clone(),
            trigger: row.trigger.clone(),
            summary_message_id: row.summary_message_id.clone(),
            source_message_count: row.source_message_count,
            retained_message_count: row.retained_message_count,
            estimated_tokens_saved: row.estimated_tokens_saved,
            continuation_summary_json: row.continuation_summary_json.clone(),
            state_rehydration_json: row.state_rehydration_json.clone(),
            created_at: row.created_at,
        }
    }
}

impl From<&ResumeCheckpointRow> for ResumeCheckpointDto {
    fn from(row: &ResumeCheckpointRow) -> Self {
        Self {
            id: row.id.clone(),
            session_id: row.session_id.clone(),
            run_id: row.run_id.clone(),
            checkpoint_kind: row.checkpoint_kind.clone(),
            status: row.status.clone(),
            resume_cursor_json: row.resume_cursor_json.clone(),
            session_state_json: row.session_state_json.clone(),
            pending_work_json: row.pending_work_json.clone(),
            created_at: row.created_at,
            consumed_at: row.consumed_at,
        }
    }
}

impl From<&PartRow> for PartDto {
    fn from(row: &PartRow) -> Self {
        Self {
            id: row.id.clone(),
            message_id: row.message_id.clone(),
            sort_order: row.sort_order,
            part_type: row.part_type.clone(),
            data_json: row.data_json.clone(),
            compacted_at: row.compacted_at,
        }
    }
}

impl From<&MessageWithParts> for MessageDto {
    fn from(mwp: &MessageWithParts) -> Self {
        Self {
            id: mwp.message.id.clone(),
            session_id: mwp.message.session_id.clone(),
            role: mwp.message.role.clone(),
            timestamp: mwp.message.timestamp,
            parts: mwp.parts.iter().map(PartDto::from).collect(),
            usage_json: mwp.message.usage_json.clone(),
            finish_reason: mwp.message.finish_reason.clone(),
        }
    }
}

fn is_terminal_run_phase(phase: &str) -> bool {
    matches!(phase, "completed" | "failed" | "aborted")
}

fn derive_session_status_from_run_phase(phase: &str) -> &'static str {
    match phase {
        "awaiting_approval" => "awaiting_approval",
        "completed" => "completed",
        "failed" => "failed",
        "aborted" => "aborted",
        _ => "running",
    }
}

fn is_terminal_delegation_status(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn resolve_session_mode(
    requested_mode: Option<String>,
    parent_session_id: Option<&str>,
    branch_from_session_id: Option<&str>,
) -> String {
    if parent_session_id.is_some() {
        "child".to_string()
    } else if branch_from_session_id.is_some() {
        "branch".to_string()
    } else {
        requested_mode.unwrap_or_else(|| "primary".to_string())
    }
}

fn resolve_root_session_id(
    db: &ConversationDb,
    session_id: &str,
    explicit_root_session_id: Option<String>,
    parent_session_id: Option<&str>,
    branch_from_session_id: Option<&str>,
) -> Result<String, String> {
    let ancestor_id = parent_session_id.or(branch_from_session_id);

    if let Some(ancestor_id) = ancestor_id {
        let ancestor = db
            .get_session(ancestor_id)
            .map_err(|e| format!("Failed to resolve ancestor session {ancestor_id}: {e}"))?;
        let derived_root = ancestor.root_session_id;

        if let Some(explicit) = explicit_root_session_id {
            if explicit != derived_root {
                return Err(format!(
                    "Explicit root_session_id '{explicit}' conflicts with ancestor-derived root '{derived_root}'"
                ));
            }
        }

        return Ok(derived_root);
    }

    Ok(explicit_root_session_id.unwrap_or_else(|| session_id.to_string()))
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn extract_preview_text(data_json: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(data_json) {
        Ok(value) => value,
        Err(_) => return data_json.to_string(),
    };

    if let Some(content) = parsed.get("content").and_then(|v| v.as_str()) {
        return content.to_string();
    }
    if let Some(text) = parsed.get("text").and_then(|v| v.as_str()) {
        return text.to_string();
    }
    if let Some(raw) = parsed.as_str() {
        return raw.to_string();
    }

    data_json.to_string()
}

fn build_last_message_preview(parts: &[PartRow]) -> Option<String> {
    let text_part = parts.iter().find(|p| p.part_type == "text")?;
    let preview = extract_preview_text(&text_part.data_json);
    let normalized = preview.split_whitespace().collect::<Vec<_>>().join(" ");
    let normalized = if normalized.is_empty() {
        preview.trim().to_string()
    } else {
        normalized
    };

    if normalized.is_empty() {
        None
    } else {
        Some(truncate_preview(&normalized, 120))
    }
}

// =============================================================================
// Global conversation database (lazy-initialized singleton)
// =============================================================================

/// Global conversation database instance.
/// Initialized when the first AI session command is called.
static CONVERSATION_DB: OnceLock<Mutex<ConversationDb>> = OnceLock::new();
static CONVERSATION_DB_INIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Returns a reference to the lazily-initialized conversation database.
///
/// On first call the database file (`ai_conversations.db`) is created inside the
/// platform-specific application data directory. Subsequent calls return the same
/// instance without re-opening the file.
fn get_or_init_db(app: &tauri::AppHandle) -> Result<&'static Mutex<ConversationDb>, String> {
    if let Some(db) = CONVERSATION_DB.get() {
        return Ok(db);
    }

    let _guard = CONVERSATION_DB_INIT_LOCK
        .lock()
        .map_err(|_| "Failed to lock conversation database initializer".to_string())?;

    if let Some(db) = CONVERSATION_DB.get() {
        return Ok(db);
    }

    let app_data = super::get_app_data_dir(app)?;
    std::fs::create_dir_all(&app_data)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    let db_path = app_data.join("ai_conversations.db");
    let db = ConversationDb::create(&db_path)
        .map_err(|e| format!("Failed to open conversation database: {e}"))?;

    // Do not cache transient initialization failures forever. A startup race
    // should not permanently brick AI session creation for the rest of the app run.
    let _ = CONVERSATION_DB.set(Mutex::new(db));

    CONVERSATION_DB
        .get()
        .ok_or_else(|| "Failed to initialize conversation database".to_string())
}

// =============================================================================
// IPC Commands
// =============================================================================

/// Creates a new AI conversation session for the given project.
///
/// Returns the newly created session as a `SessionSummaryDto`.
#[tauri::command]
#[specta::specta]
pub async fn create_ai_session(
    app: tauri::AppHandle,
    project_id: String,
    agent: Option<String>,
    model_provider: Option<String>,
    model_id: Option<String>,
) -> Result<SessionSummaryDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let session_id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let agent_value = agent.unwrap_or_else(|| "default".to_string());

    let row = SessionRow {
        id: session_id.clone(),
        project_id,
        title: "New conversation".to_string(),
        agent: agent_value,
        model_provider,
        model_id,
        runtime_kind: "tpao".to_string(),
        session_mode: "primary".to_string(),
        status: "idle".to_string(),
        parent_session_id: None,
        branch_from_session_id: None,
        root_session_id: session_id,
        sequence_id: None,
        current_run_id: None,
        current_plan_id: None,
        pending_approval_id: None,
        active_checkpoint_id: None,
        permission_state_version: 0,
        compaction_version: 0,
        resume_cursor_version: 0,
        last_compacted_at: None,
        last_resumed_at: None,
        created_at: now,
        updated_at: now,
        completed_at: None,
        archived: false,
        summary_message_id: None,
    };

    db.insert_session(&row)
        .map_err(|e| format!("Failed to create AI session: {e}"))?;

    Ok(SessionSummaryDto::from(&row))
}

/// Creates an agent session kernel row on top of the shared conversation database.
#[tauri::command]
#[specta::specta]
pub async fn create_agent_session(
    app: tauri::AppHandle,
    input: CreateAgentSessionInputDto,
) -> Result<AgentSessionDto, String> {
    if input.parent_session_id.is_some() && input.branch_from_session_id.is_some() {
        return Err(
            "create_agent_session does not allow both parentSessionId and branchFromSessionId"
                .to_string(),
        );
    }

    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let session_id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = chrono::Utc::now().timestamp_millis();
    let parent_session_id = input.parent_session_id.clone();
    let branch_from_session_id = input.branch_from_session_id.clone();
    let root_session_id = resolve_root_session_id(
        &db,
        &session_id,
        input.root_session_id.clone(),
        parent_session_id.as_deref(),
        branch_from_session_id.as_deref(),
    )?;

    let row = SessionRow {
        id: session_id,
        project_id: input.project_id,
        sequence_id: input.sequence_id,
        title: input
            .title
            .unwrap_or_else(|| "New Agent Session".to_string()),
        runtime_kind: input.runtime_kind.unwrap_or_else(|| "tpao".to_string()),
        agent: input
            .agent_profile_id
            .unwrap_or_else(|| "editor".to_string()),
        session_mode: resolve_session_mode(
            input.session_mode,
            parent_session_id.as_deref(),
            branch_from_session_id.as_deref(),
        ),
        status: "idle".to_string(),
        parent_session_id,
        branch_from_session_id,
        root_session_id,
        current_run_id: None,
        current_plan_id: None,
        pending_approval_id: None,
        active_checkpoint_id: None,
        permission_state_version: 0,
        compaction_version: 0,
        resume_cursor_version: 0,
        last_compacted_at: None,
        last_resumed_at: None,
        model_provider: input.model_provider,
        model_id: input.model_id,
        created_at: now,
        updated_at: now,
        completed_at: None,
        archived: false,
        summary_message_id: None,
    };

    db.insert_session(&row)
        .map_err(|e| format!("Failed to create agent session: {e}"))?;

    Ok(AgentSessionDto::from(&row))
}

/// Returns the session kernel header together with the persisted run ledger.
#[tauri::command]
#[specta::specta]
pub async fn get_agent_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<AgentSessionDetailDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let session = db
        .get_session(&session_id)
        .map_err(|e| format!("Failed to get agent session: {e}"))?;
    let runs = db
        .list_runs_for_session(&session_id)
        .map_err(|e| format!("Failed to list agent runs for session {session_id}: {e}"))?;

    Ok(AgentSessionDetailDto {
        session: AgentSessionDto::from(&session),
        runs: runs.iter().map(AgentRunDto::from).collect(),
    })
}

/// Starts a new run and atomically marks the owning session as active.
#[tauri::command]
#[specta::specta]
pub async fn start_agent_run(
    app: tauri::AppHandle,
    input: StartAgentRunInput,
) -> Result<AgentRunDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let session = db
        .get_session(&input.session_id)
        .map_err(|e| format!("Failed to get agent session before starting run: {e}"))?;

    let now = chrono::Utc::now().timestamp_millis();
    let run = AgentRunRow {
        id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        session_id: input.session_id,
        runtime_kind: input
            .runtime_kind
            .unwrap_or_else(|| session.runtime_kind.clone()),
        trigger: input.trigger.unwrap_or_else(|| "user".to_string()),
        phase: "initializing".to_string(),
        iteration: 0,
        max_iterations: input.max_iterations.unwrap_or(20),
        tool_calls_used: 0,
        max_tool_calls: input.max_tool_calls.unwrap_or(50),
        planned_step_count: input.planned_step_count.unwrap_or(0),
        completed_step_count: 0,
        input_message_id: input.input_message_id,
        output_message_id: None,
        trace_id: input.trace_id,
        rollback_report_json: None,
        error_code: None,
        error_message: None,
        started_at: now,
        updated_at: now,
        ended_at: None,
    };

    db.start_run(&run, "running")
        .map_err(|e| format!("Failed to start agent run: {e}"))?;

    Ok(AgentRunDto::from(&run))
}

/// Advances an agent run phase and keeps the session header in sync.
#[tauri::command]
#[specta::specta]
pub async fn update_agent_run_phase(
    app: tauri::AppHandle,
    input: UpdateAgentRunPhaseInput,
) -> Result<AgentRunDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let mut run = db
        .get_run(&input.run_id)
        .map_err(|e| format!("Failed to load agent run {}: {e}", input.run_id))?;
    let mut session = db
        .get_session(&run.session_id)
        .map_err(|e| format!("Failed to load agent session {}: {e}", run.session_id))?;

    let now = chrono::Utc::now().timestamp_millis();
    run.phase = input.phase;
    run.updated_at = now;

    if let Some(trace_id) = input.trace_id {
        run.trace_id = Some(trace_id);
    }
    if let Some(tool_calls_used) = input.tool_calls_used {
        run.tool_calls_used = tool_calls_used;
    }
    if let Some(planned_step_count) = input.planned_step_count {
        run.planned_step_count = planned_step_count;
    }
    if let Some(completed_step_count) = input.completed_step_count {
        run.completed_step_count = completed_step_count;
    }
    if let Some(output_message_id) = input.output_message_id {
        run.output_message_id = Some(output_message_id);
    }
    if let Some(rollback_report_json) = input.rollback_report_json {
        run.rollback_report_json = Some(rollback_report_json);
    }
    if let Some(error_code) = input.error_code {
        run.error_code = Some(error_code);
    }
    if let Some(error_message) = input.error_message {
        run.error_message = Some(error_message);
    }

    if is_terminal_run_phase(&run.phase) {
        run.ended_at = Some(input.ended_at.unwrap_or(now));
    }

    session.runtime_kind = run.runtime_kind.clone();
    session.status = derive_session_status_from_run_phase(&run.phase).to_string();
    session.updated_at = run.updated_at;
    session.current_run_id = if is_terminal_run_phase(&run.phase) {
        None
    } else {
        Some(run.id.clone())
    };

    if let Some(current_plan_id) = input.current_plan_id {
        session.current_plan_id = Some(current_plan_id);
    }
    if let Some(active_checkpoint_id) = input.active_checkpoint_id {
        session.active_checkpoint_id = Some(active_checkpoint_id);
    }
    if let Some(permission_state_version) = input.permission_state_version {
        session.permission_state_version = permission_state_version;
    }
    if let Some(compaction_version) = input.compaction_version {
        session.compaction_version = compaction_version;
    }
    if let Some(resume_cursor_version) = input.resume_cursor_version {
        session.resume_cursor_version = resume_cursor_version;
    }
    if let Some(last_compacted_at) = input.last_compacted_at {
        session.last_compacted_at = Some(last_compacted_at);
    }
    if let Some(last_resumed_at) = input.last_resumed_at {
        session.last_resumed_at = Some(last_resumed_at);
    }

    if run.phase == "awaiting_approval" {
        session.pending_approval_id = input.pending_approval_id;
    } else if is_terminal_run_phase(&run.phase) {
        session.current_plan_id = None;
        session.pending_approval_id = None;
        session.active_checkpoint_id = None;
        session.completed_at = run.ended_at;
    } else {
        session.pending_approval_id = None;
        session.completed_at = None;
    }

    db.update_session_and_run(&session, &run)
        .map_err(|e| format!("Failed to update agent run phase: {e}"))?;

    Ok(AgentRunDto::from(&run))
}

/// Creates a delegation record linking a parent run/session to a child session.
#[tauri::command]
#[specta::specta]
pub async fn create_agent_delegation_record(
    app: tauri::AppHandle,
    input: CreateDelegationRecordInput,
) -> Result<DelegationRecordDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    db.get_session(&input.parent_session_id)
        .map_err(|e| format!("Failed to validate parent session: {e}"))?;
    db.get_session(&input.child_session_id)
        .map_err(|e| format!("Failed to validate child session: {e}"))?;
    let parent_run = db
        .get_run(&input.parent_run_id)
        .map_err(|e| format!("Failed to validate parent run: {e}"))?;
    if parent_run.session_id != input.parent_session_id {
        return Err("parentRunId does not belong to parentSessionId".to_string());
    }

    let now = chrono::Utc::now().timestamp_millis();
    let row = DelegationRecordRow {
        id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        parent_session_id: input.parent_session_id,
        child_session_id: input.child_session_id,
        parent_run_id: input.parent_run_id,
        agent_profile_id: input.agent_profile_id,
        delegated_goal: input.delegated_goal,
        context_packet_json: input.context_packet_json,
        allowed_tools_delta_json: input.allowed_tools_delta_json,
        permission_snapshot_json: input.permission_snapshot_json,
        status: input.status.unwrap_or_else(|| "requested".to_string()),
        merge_status: input.merge_status.unwrap_or_else(|| "pending".to_string()),
        summary_message_id: input.summary_message_id,
        result_json: input.result_json,
        error_message: input.error_message,
        created_at: now,
        updated_at: now,
        completed_at: input.completed_at,
    };

    db.insert_delegation(&row)
        .map_err(|e| format!("Failed to create delegation record: {e}"))?;

    Ok(DelegationRecordDto::from(&row))
}

/// Updates a delegation record as work progresses or merges back.
#[tauri::command]
#[specta::specta]
pub async fn update_agent_delegation_record(
    app: tauri::AppHandle,
    input: UpdateDelegationRecordInput,
) -> Result<DelegationRecordDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let mut row = db
        .get_delegation(&input.id)
        .map_err(|e| format!("Failed to load delegation record {}: {e}", input.id))?;
    let now = chrono::Utc::now().timestamp_millis();

    if let Some(status) = input.status {
        row.status = status;
    }
    if let Some(merge_status) = input.merge_status {
        row.merge_status = merge_status;
    }
    if let Some(summary_message_id) = input.summary_message_id {
        row.summary_message_id = Some(summary_message_id);
    }
    if let Some(result_json) = input.result_json {
        row.result_json = Some(result_json);
    }
    if let Some(error_message) = input.error_message {
        row.error_message = Some(error_message);
    }

    row.updated_at = now;
    if is_terminal_delegation_status(&row.status) {
        row.completed_at = Some(input.completed_at.unwrap_or(now));
    }

    db.update_delegation(&row)
        .map_err(|e| format!("Failed to update delegation record: {e}"))?;

    Ok(DelegationRecordDto::from(&row))
}

/// Lists delegation records that touch the given session.
#[tauri::command]
#[specta::specta]
pub async fn list_agent_delegation_records(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Vec<DelegationRecordDto>, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let rows = db
        .list_delegations_for_session(&session_id)
        .map_err(|e| format!("Failed to list delegation records: {e}"))?;

    Ok(rows.iter().map(DelegationRecordDto::from).collect())
}

/// Records a permission or approval decision and bumps the session permission version.
#[tauri::command]
#[specta::specta]
pub async fn record_agent_permission_decision(
    app: tauri::AppHandle,
    input: RecordPermissionDecisionInput,
) -> Result<PermissionDecisionDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let mut session = db
        .get_session(&input.session_id)
        .map_err(|e| format!("Failed to load session {}: {e}", input.session_id))?;
    let now = chrono::Utc::now().timestamp_millis();
    let created_at = input.created_at.unwrap_or(now);
    let row = PermissionDecisionRow {
        id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        session_id: input.session_id,
        run_id: input.run_id,
        step_id: input.step_id,
        subject_type: input.subject_type,
        subject: input.subject,
        action: input.action,
        source: input.source,
        reason: input.reason,
        created_at,
    };

    session.permission_state_version += 1;
    session.updated_at = created_at;

    db.insert_permission_decision_and_update_session(&session, &row)
        .map_err(|e| format!("Failed to record permission decision: {e}"))?;

    Ok(PermissionDecisionDto::from(&row))
}

/// Lists persisted permission decisions for a session.
#[tauri::command]
#[specta::specta]
pub async fn list_agent_permission_decisions(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Vec<PermissionDecisionDto>, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let rows = db
        .list_permission_decisions_for_session(&session_id)
        .map_err(|e| format!("Failed to list permission decisions: {e}"))?;

    Ok(rows.iter().map(PermissionDecisionDto::from).collect())
}

/// Records a compaction event and synchronizes session compaction metadata.
#[tauri::command]
#[specta::specta]
pub async fn record_agent_compaction(
    app: tauri::AppHandle,
    input: RecordCompactionInput,
) -> Result<CompactionRecordDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let mut session = db
        .get_session(&input.session_id)
        .map_err(|e| format!("Failed to load session {}: {e}", input.session_id))?;
    let now = chrono::Utc::now().timestamp_millis();
    let created_at = input.created_at.unwrap_or(now);
    let summary_message_id = input.summary_message_id.clone();
    let row = CompactionRecordRow {
        id: input.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        session_id: input.session_id,
        run_id: input.run_id,
        tier: input.tier,
        trigger: input.trigger,
        summary_message_id: input.summary_message_id,
        source_message_count: input.source_message_count,
        retained_message_count: input.retained_message_count,
        estimated_tokens_saved: input.estimated_tokens_saved,
        continuation_summary_json: input.continuation_summary_json,
        state_rehydration_json: input.state_rehydration_json,
        created_at,
    };

    session.compaction_version += 1;
    session.last_compacted_at = Some(created_at);
    session.updated_at = created_at;
    if summary_message_id.is_some() {
        session.summary_message_id = summary_message_id;
    }

    db.insert_compaction_and_update_session(&session, &row)
        .map_err(|e| format!("Failed to record compaction: {e}"))?;

    Ok(CompactionRecordDto::from(&row))
}

/// Lists persisted compaction records for a session.
#[tauri::command]
#[specta::specta]
pub async fn list_agent_compactions(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Vec<CompactionRecordDto>, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let rows = db
        .list_compactions_for_session(&session_id)
        .map_err(|e| format!("Failed to list compactions: {e}"))?;

    Ok(rows.iter().map(CompactionRecordDto::from).collect())
}

/// Creates a durable resume checkpoint and updates the session cursor metadata.
#[tauri::command]
#[specta::specta]
pub async fn create_agent_resume_checkpoint(
    app: tauri::AppHandle,
    input: CreateResumeCheckpointInput,
) -> Result<ResumeCheckpointDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let mut session = db
        .get_session(&input.session_id)
        .map_err(|e| format!("Failed to load session {}: {e}", input.session_id))?;
    let now = chrono::Utc::now().timestamp_millis();
    let created_at = input.created_at.unwrap_or(now);
    let status = input.status.unwrap_or_else(|| "active".to_string());
    let checkpoint_id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let row = ResumeCheckpointRow {
        id: checkpoint_id.clone(),
        session_id: input.session_id,
        run_id: input.run_id,
        checkpoint_kind: input.checkpoint_kind,
        status: status.clone(),
        resume_cursor_json: input.resume_cursor_json,
        session_state_json: input.session_state_json,
        pending_work_json: input.pending_work_json,
        created_at,
        consumed_at: None,
    };

    if status == "active" {
        session.active_checkpoint_id = Some(checkpoint_id);
    }
    session.resume_cursor_version += 1;
    session.updated_at = created_at;

    db.insert_resume_checkpoint_and_update_session(&session, &row)
        .map_err(|e| format!("Failed to create resume checkpoint: {e}"))?;

    Ok(ResumeCheckpointDto::from(&row))
}

/// Marks a resume checkpoint as consumed and updates session resume metadata.
#[tauri::command]
#[specta::specta]
pub async fn consume_agent_resume_checkpoint(
    app: tauri::AppHandle,
    checkpoint_id: String,
) -> Result<ResumeCheckpointDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let mut checkpoint = db
        .get_resume_checkpoint(&checkpoint_id)
        .map_err(|e| format!("Failed to load resume checkpoint {}: {e}", checkpoint_id))?;

    if checkpoint.status != "active" {
        return Err(format!(
            "Resume checkpoint {} is not active (current status: {})",
            checkpoint_id, checkpoint.status
        ));
    }

    let mut session = db
        .get_session(&checkpoint.session_id)
        .map_err(|e| format!("Failed to load session {}: {e}", checkpoint.session_id))?;
    let now = chrono::Utc::now().timestamp_millis();

    checkpoint.status = "consumed".to_string();
    checkpoint.consumed_at = Some(now);
    if session.active_checkpoint_id.as_deref() == Some(checkpoint.id.as_str()) {
        session.active_checkpoint_id = None;
    }
    session.last_resumed_at = Some(now);
    session.resume_cursor_version += 1;
    session.updated_at = now;

    db.update_resume_checkpoint_and_update_session(&session, &checkpoint)
        .map_err(|e| format!("Failed to consume resume checkpoint: {e}"))?;

    Ok(ResumeCheckpointDto::from(&checkpoint))
}

/// Lists persisted resume checkpoints for a session.
#[tauri::command]
#[specta::specta]
pub async fn list_agent_resume_checkpoints(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Vec<ResumeCheckpointDto>, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let rows = db
        .list_resume_checkpoints_for_session(&session_id)
        .map_err(|e| format!("Failed to list resume checkpoints: {e}"))?;

    Ok(rows.iter().map(ResumeCheckpointDto::from).collect())
}

/// Lists all conversation sessions for a project, ordered by most recently updated.
#[tauri::command]
#[specta::specta]
pub async fn list_ai_sessions(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Vec<SessionSummaryDto>, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let sessions = db
        .list_sessions(&project_id)
        .map_err(|e| format!("Failed to list AI sessions: {e}"))?;

    let mut dtos: Vec<SessionSummaryDto> = Vec::with_capacity(sessions.len());
    for session in &sessions {
        let mut dto = SessionSummaryDto::from(session);

        // Enrich with message count and last message preview.
        let messages = db
            .list_messages(&session.id)
            .map_err(|e| format!("Failed to list messages for session {}: {e}", session.id))?;

        dto.message_count = messages.len() as i32;
        dto.last_message_preview = messages
            .last()
            .and_then(|mwp| build_last_message_preview(&mwp.parts));

        dtos.push(dto);
    }

    Ok(dtos)
}

/// Retrieves a full conversation session with all messages and parts.
#[tauri::command]
#[specta::specta]
pub async fn get_ai_session(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<SessionWithMessagesDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let session = db
        .get_session(&session_id)
        .map_err(|e| format!("Failed to get AI session: {e}"))?;

    let messages = db
        .list_messages(&session_id)
        .map_err(|e| format!("Failed to list messages for session {session_id}: {e}"))?;

    let mut dto = SessionSummaryDto::from(&session);
    dto.message_count = messages.len() as i32;
    dto.last_message_preview = messages
        .last()
        .and_then(|mwp| build_last_message_preview(&mwp.parts));

    let message_dtos: Vec<MessageDto> = messages.iter().map(MessageDto::from).collect();

    Ok(SessionWithMessagesDto {
        session: dto,
        messages: message_dtos,
    })
}

/// Saves a message and all its parts to the database in a single transaction.
#[tauri::command]
#[specta::specta]
pub async fn save_ai_message(
    app: tauri::AppHandle,
    input: SaveMessageInput,
) -> Result<MessageDto, String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let message_row = MessageRow {
        id: input.id.clone(),
        session_id: input.session_id.clone(),
        role: input.role.clone(),
        timestamp: input.timestamp,
        usage_json: input.usage_json.clone(),
        finish_reason: input.finish_reason.clone(),
    };

    let part_rows: Vec<PartRow> = input
        .parts
        .iter()
        .map(|p| PartRow {
            id: p.id.clone(),
            message_id: input.id.clone(),
            session_id: input.session_id.clone(),
            sort_order: p.sort_order,
            part_type: p.part_type.clone(),
            data_json: p.data_json.clone(),
            compacted_at: None,
        })
        .collect();

    db.save_message_with_parts(&message_row, &part_rows)
        .map_err(|e| format!("Failed to save AI message: {e}"))?;

    // Also update the session's updated_at timestamp.
    let now = chrono::Utc::now().timestamp_millis();
    db.touch_session(&input.session_id, now)
        .map_err(|e| format!("Failed to update session timestamp: {e}"))?;

    let parts_dto: Vec<PartDto> = part_rows.iter().map(PartDto::from).collect();

    Ok(MessageDto {
        id: input.id,
        session_id: input.session_id,
        role: input.role,
        timestamp: input.timestamp,
        parts: parts_dto,
        usage_json: input.usage_json,
        finish_reason: input.finish_reason,
    })
}

/// Updates the JSON data of a single message part.
#[tauri::command]
#[specta::specta]
pub async fn update_ai_part(
    app: tauri::AppHandle,
    part_id: String,
    data_json: String,
) -> Result<(), String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    db.update_part_data(&part_id, &data_json)
        .map_err(|e| format!("Failed to update AI part: {e}"))?;

    Ok(())
}

/// Marks the given parts as compacted (summarized / compressed).
///
/// This is used by the context window management system to indicate that
/// older message parts have been folded into a summary, reducing token usage
/// while preserving conversation continuity.
#[tauri::command]
#[specta::specta]
pub async fn mark_parts_compacted(
    app: tauri::AppHandle,
    part_ids: Vec<String>,
) -> Result<(), String> {
    if part_ids.is_empty() {
        return Ok(());
    }

    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    let now = chrono::Utc::now().timestamp_millis();
    db.mark_parts_compacted(&part_ids, now)
        .map_err(|e| format!("Failed to mark parts as compacted: {e}"))?;

    Ok(())
}

/// Permanently deletes an AI conversation session and all its messages/parts.
#[tauri::command]
#[specta::specta]
pub async fn delete_ai_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    db.delete_session(&session_id)
        .map_err(|e| format!("Failed to delete AI session: {e}"))?;

    Ok(())
}

/// Archives an AI conversation session (soft delete).
///
/// Archived sessions are hidden from the default session list but can still be
/// restored. This preserves conversation history for auditing and review.
#[tauri::command]
#[specta::specta]
pub async fn archive_ai_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    db.archive_session(&session_id)
        .map_err(|e| format!("Failed to archive AI session: {e}"))?;

    Ok(())
}

/// Updates the title of an AI conversation session.
///
/// Typically called after the first few messages to auto-generate a descriptive
/// title, or when the user manually renames the conversation.
#[tauri::command]
#[specta::specta]
pub async fn update_ai_session_title(
    app: tauri::AppHandle,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let db_mutex = get_or_init_db(&app)?;
    let db = db_mutex.lock().await;

    db.update_session_title(&session_id, &title)
        .map_err(|e| format!("Failed to update AI session title: {e}"))?;

    let now = chrono::Utc::now().timestamp_millis();
    db.touch_session(&session_id, now)
        .map_err(|e| format!("Failed to update session timestamp: {e}"))?;

    Ok(())
}

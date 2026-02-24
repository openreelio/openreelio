//! IPC Commands for AI Conversation Persistence
//!
//! Provides Tauri commands for managing AI conversation sessions, messages,
//! and message parts. These commands expose the ConversationDb layer to the
//! frontend via type-safe IPC (tauri-specta).

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::conversation::{ConversationDb, MessageRow, MessageWithParts, PartRow, SessionRow};

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
static CONVERSATION_DB: OnceLock<Result<Mutex<ConversationDb>, String>> = OnceLock::new();

/// Returns a reference to the lazily-initialized conversation database.
///
/// On first call the database file (`ai_conversations.db`) is created inside the
/// platform-specific application data directory. Subsequent calls return the same
/// instance without re-opening the file.
fn get_or_init_db(app: &tauri::AppHandle) -> Result<&'static Mutex<ConversationDb>, String> {
    let result = CONVERSATION_DB.get_or_init(|| {
        let init = || -> Result<Mutex<ConversationDb>, String> {
            let app_data = super::get_app_data_dir(app)?;
            std::fs::create_dir_all(&app_data)
                .map_err(|e| format!("Failed to create app data dir: {e}"))?;
            let db_path = app_data.join("ai_conversations.db");
            let db = ConversationDb::create(&db_path)
                .map_err(|e| format!("Failed to open conversation database: {e}"))?;
            Ok(Mutex::new(db))
        };
        init()
    });
    result.as_ref().map_err(|e| e.clone())
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
        id: session_id,
        project_id,
        title: "New conversation".to_string(),
        agent: agent_value,
        model_provider,
        model_id,
        created_at: now,
        updated_at: now,
        archived: false,
        summary_message_id: None,
    };

    db.insert_session(&row)
        .map_err(|e| format!("Failed to create AI session: {e}"))?;

    Ok(SessionSummaryDto::from(&row))
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

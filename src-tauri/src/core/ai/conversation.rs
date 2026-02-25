//! Conversation Persistence Module
//!
//! SQLite-based storage for AI conversation sessions, messages, and content parts.
//! Enables full conversation history, context replay, and compaction for the
//! agentic engine.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::core::{CoreError, CoreResult};

// =============================================================================
// Row Types
// =============================================================================

/// A persisted AI conversation session.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub agent: String,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub summary_message_id: Option<String>,
}

/// A single message within a conversation session.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub timestamp: i64,
    pub usage_json: Option<String>,
    pub finish_reason: Option<String>,
}

/// A content part belonging to a message (text, tool call, tool result, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PartRow {
    pub id: String,
    pub message_id: String,
    pub session_id: String,
    pub sort_order: i32,
    pub part_type: String,
    pub data_json: String,
    pub compacted_at: Option<i64>,
}

/// A message together with all of its content parts.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MessageWithParts {
    pub message: MessageRow,
    pub parts: Vec<PartRow>,
}

// =============================================================================
// Conversation Database
// =============================================================================

/// SQLite-backed store for AI conversation history.
///
/// Each conversation is a *session* that belongs to a project. Sessions contain
/// an ordered sequence of messages, and each message is composed of one or more
/// typed *parts* (text, tool calls, tool results, etc.). Parts can be
/// independently compacted to keep the active context window small while
/// preserving full history on disk.
pub struct ConversationDb {
    conn: Connection,
}

impl ConversationDb {
    /// Creates a new conversation database at the given file path.
    ///
    /// If the file already exists it will be opened and the schema will be
    /// applied idempotently (using `CREATE TABLE IF NOT EXISTS`).
    pub fn create<P: AsRef<Path>>(path: P) -> CoreResult<Self> {
        let conn = Connection::open(path).map_err(|e| {
            CoreError::Internal(format!("Failed to create conversation database: {}", e))
        })?;

        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Opens an existing conversation database.
    pub fn open<P: AsRef<Path>>(path: P) -> CoreResult<Self> {
        let conn = Connection::open(path).map_err(|e| {
            CoreError::Internal(format!("Failed to open conversation database: {}", e))
        })?;

        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Creates an in-memory database (primarily for testing).
    pub fn in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory().map_err(|e| {
            CoreError::Internal(format!("Failed to create in-memory database: {}", e))
        })?;

        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Applies the schema and pragmas.
    fn init_schema(&self) -> CoreResult<()> {
        self.conn
            .execute_batch(
                r#"
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;

                CREATE TABLE IF NOT EXISTS ai_sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT 'New Chat',
                    agent TEXT NOT NULL DEFAULT 'editor',
                    model_provider TEXT,
                    model_id TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    summary_message_id TEXT
                );

                CREATE TABLE IF NOT EXISTS ai_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
                    timestamp INTEGER NOT NULL,
                    usage_json TEXT,
                    finish_reason TEXT,
                    FOREIGN KEY(session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS ai_parts (
                    id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    part_type TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    compacted_at INTEGER,
                    FOREIGN KEY(message_id) REFERENCES ai_messages(id) ON DELETE CASCADE,
                    FOREIGN KEY(session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_ai_sessions_project
                    ON ai_sessions(project_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_messages_session
                    ON ai_messages(session_id, timestamp);
                CREATE INDEX IF NOT EXISTS idx_ai_parts_message
                    ON ai_parts(message_id, sort_order);
                "#,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to initialize schema: {}", e)))?;

        Ok(())
    }

    // =========================================================================
    // Session CRUD
    // =========================================================================

    /// Inserts a new conversation session.
    pub fn create_session(
        &self,
        id: &str,
        project_id: &str,
        agent: &str,
        model_provider: Option<&str>,
        model_id: Option<&str>,
    ) -> CoreResult<()> {
        let now = now_millis();
        self.conn
            .execute(
                r#"INSERT INTO ai_sessions
                    (id, project_id, agent, model_provider, model_id, created_at, updated_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
                params![id, project_id, agent, model_provider, model_id, now, now],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to create session: {}", e)))?;

        Ok(())
    }

    /// Retrieves a single session by its id.
    pub fn get_session(&self, session_id: &str) -> CoreResult<SessionRow> {
        self.conn
            .query_row(
                r#"SELECT id, project_id, title, agent, model_provider, model_id,
                          created_at, updated_at, archived, summary_message_id
                   FROM ai_sessions WHERE id = ?1"#,
                params![session_id],
                |row| {
                    Ok(SessionRow {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        title: row.get(2)?,
                        agent: row.get(3)?,
                        model_provider: row.get(4)?,
                        model_id: row.get(5)?,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                        archived: row.get::<_, i32>(8)? != 0,
                        summary_message_id: row.get(9)?,
                    })
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    CoreError::NotFound(format!("Session not found: {}", session_id))
                }
                other => CoreError::Internal(format!("Failed to get session: {}", other)),
            })
    }

    /// Lists all non-archived sessions for a project, most recently updated first.
    pub fn list_sessions(&self, project_id: &str) -> CoreResult<Vec<SessionRow>> {
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT id, project_id, title, agent, model_provider, model_id,
                          created_at, updated_at, archived, summary_message_id
                   FROM ai_sessions
                   WHERE project_id = ?1 AND archived = 0
                   ORDER BY updated_at DESC"#,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to prepare list sessions: {}", e)))?;

        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok(SessionRow {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    title: row.get(2)?,
                    agent: row.get(3)?,
                    model_provider: row.get(4)?,
                    model_id: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    archived: row.get::<_, i32>(8)? != 0,
                    summary_message_id: row.get(9)?,
                })
            })
            .map_err(|e| CoreError::Internal(format!("Failed to list sessions: {}", e)))?;

        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(
                row.map_err(|e| CoreError::Internal(format!("Failed to read session row: {}", e)))?,
            );
        }
        Ok(sessions)
    }

    /// Updates the title of a session and bumps `updated_at`.
    pub fn update_session_title(&self, session_id: &str, title: &str) -> CoreResult<()> {
        let now = now_millis();
        let affected = self
            .conn
            .execute(
                "UPDATE ai_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![title, now, session_id],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update session title: {}", e)))?;

        if affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }
        Ok(())
    }

    /// Marks a session as archived (soft delete). Archived sessions are
    /// excluded from `list_sessions` but remain queryable by id.
    pub fn archive_session(&self, session_id: &str) -> CoreResult<()> {
        let now = now_millis();
        let affected = self
            .conn
            .execute(
                "UPDATE ai_sessions SET archived = 1, updated_at = ?1 WHERE id = ?2",
                params![now, session_id],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to archive session: {}", e)))?;

        if affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }
        Ok(())
    }

    /// Permanently deletes a session and all related messages/parts (cascade).
    pub fn delete_session(&self, session_id: &str) -> CoreResult<()> {
        let affected = self
            .conn
            .execute("DELETE FROM ai_sessions WHERE id = ?1", params![session_id])
            .map_err(|e| CoreError::Internal(format!("Failed to delete session: {}", e)))?;

        if affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }
        Ok(())
    }

    // =========================================================================
    // Message CRUD
    // =========================================================================

    /// Persists a message record. The caller is responsible for generating a
    /// unique `id` (e.g. via `uuid::Uuid::new_v4()`).
    pub fn save_message(
        &self,
        id: &str,
        session_id: &str,
        role: &str,
        timestamp: i64,
        usage_json: Option<&str>,
        finish_reason: Option<&str>,
    ) -> CoreResult<()> {
        self.conn
            .execute(
                r#"INSERT INTO ai_messages (id, session_id, role, timestamp, usage_json, finish_reason)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
                params![id, session_id, role, timestamp, usage_json, finish_reason],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to save message: {}", e)))?;

        // Bump the session's updated_at timestamp
        self.conn
            .execute(
                "UPDATE ai_sessions SET updated_at = ?1 WHERE id = ?2",
                params![timestamp, session_id],
            )
            .map_err(|e| {
                CoreError::Internal(format!("Failed to update session timestamp: {}", e))
            })?;

        Ok(())
    }

    /// Returns all messages for a session ordered by timestamp ascending.
    pub fn get_messages(&self, session_id: &str) -> CoreResult<Vec<MessageRow>> {
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT id, session_id, role, timestamp, usage_json, finish_reason
                   FROM ai_messages
                   WHERE session_id = ?1
                   ORDER BY timestamp ASC"#,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to prepare get messages: {}", e)))?;

        let rows = stmt
            .query_map(params![session_id], |row| {
                Ok(MessageRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    timestamp: row.get(3)?,
                    usage_json: row.get(4)?,
                    finish_reason: row.get(5)?,
                })
            })
            .map_err(|e| CoreError::Internal(format!("Failed to get messages: {}", e)))?;

        let mut messages = Vec::new();
        for row in rows {
            messages.push(
                row.map_err(|e| CoreError::Internal(format!("Failed to read message row: {}", e)))?,
            );
        }
        Ok(messages)
    }

    /// Deletes a single message and its parts (cascade).
    pub fn delete_message(&self, message_id: &str) -> CoreResult<()> {
        let affected = self
            .conn
            .execute("DELETE FROM ai_messages WHERE id = ?1", params![message_id])
            .map_err(|e| CoreError::Internal(format!("Failed to delete message: {}", e)))?;

        if affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Message not found: {}",
                message_id
            )));
        }
        Ok(())
    }

    // =========================================================================
    // Parts CRUD
    // =========================================================================

    /// Persists a content part for a message.
    pub fn save_part(
        &self,
        id: &str,
        message_id: &str,
        session_id: &str,
        sort_order: i32,
        part_type: &str,
        data_json: &str,
    ) -> CoreResult<()> {
        self.conn
            .execute(
                r#"INSERT INTO ai_parts
                    (id, message_id, session_id, sort_order, part_type, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
                params![id, message_id, session_id, sort_order, part_type, data_json],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to save part: {}", e)))?;

        Ok(())
    }

    /// Returns all parts for a message ordered by `sort_order` ascending.
    pub fn get_parts(&self, message_id: &str) -> CoreResult<Vec<PartRow>> {
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT id, message_id, session_id, sort_order, part_type, data_json, compacted_at
                   FROM ai_parts
                   WHERE message_id = ?1
                   ORDER BY sort_order ASC"#,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to prepare get parts: {}", e)))?;

        let rows = stmt
            .query_map(params![message_id], |row| {
                Ok(PartRow {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    session_id: row.get(2)?,
                    sort_order: row.get(3)?,
                    part_type: row.get(4)?,
                    data_json: row.get(5)?,
                    compacted_at: row.get(6)?,
                })
            })
            .map_err(|e| CoreError::Internal(format!("Failed to get parts: {}", e)))?;

        let mut parts = Vec::new();
        for row in rows {
            parts.push(
                row.map_err(|e| CoreError::Internal(format!("Failed to read part row: {}", e)))?,
            );
        }
        Ok(parts)
    }

    /// Replaces the `data_json` payload of an existing part.
    pub fn update_part_data(&self, part_id: &str, data_json: &str) -> CoreResult<()> {
        let affected = self
            .conn
            .execute(
                "UPDATE ai_parts SET data_json = ?1 WHERE id = ?2",
                params![data_json, part_id],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update part data: {}", e)))?;

        if affected == 0 {
            return Err(CoreError::NotFound(format!("Part not found: {}", part_id)));
        }
        Ok(())
    }

    /// Marks multiple parts as compacted at the given timestamp. Compacted
    /// parts can be excluded from the active context window while remaining
    /// available for full history replay.
    pub fn mark_parts_compacted(&self, part_ids: &[String], compacted_at: i64) -> CoreResult<()> {
        if part_ids.is_empty() {
            return Ok(());
        }

        // Build a parameterized IN clause. rusqlite does not natively support
        // binding a slice to IN, so we construct placeholders manually.
        let placeholders: Vec<String> =
            (0..part_ids.len()).map(|i| format!("?{}", i + 2)).collect();
        let sql = format!(
            "UPDATE ai_parts SET compacted_at = ?1 WHERE id IN ({})",
            placeholders.join(", ")
        );

        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| CoreError::Internal(format!("Failed to prepare compaction: {}", e)))?;

        // Bind the timestamp as parameter 1, then each part id.
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> =
            Vec::with_capacity(1 + part_ids.len());
        param_values.push(Box::new(compacted_at));
        for pid in part_ids {
            param_values.push(Box::new(pid.clone()));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|v| v.as_ref()).collect();

        stmt.execute(param_refs.as_slice())
            .map_err(|e| CoreError::Internal(format!("Failed to mark parts compacted: {}", e)))?;

        Ok(())
    }

    // =========================================================================
    // Bulk / convenience
    // =========================================================================

    /// Inserts a session from a pre-populated `SessionRow`.
    ///
    /// This is a convenience wrapper around `create_session` for callers that
    /// already have a fully-constructed row.
    pub fn insert_session(&self, row: &SessionRow) -> CoreResult<()> {
        self.conn
            .execute(
                r#"INSERT INTO ai_sessions
                    (id, project_id, title, agent, model_provider, model_id,
                     created_at, updated_at, archived, summary_message_id)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
                params![
                    row.id,
                    row.project_id,
                    row.title,
                    row.agent,
                    row.model_provider,
                    row.model_id,
                    row.created_at,
                    row.updated_at,
                    row.archived as i32,
                    row.summary_message_id,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to insert session: {}", e)))?;
        Ok(())
    }

    /// Updates the `updated_at` timestamp of a session.
    pub fn touch_session(&self, session_id: &str, updated_at: i64) -> CoreResult<()> {
        let affected = self
            .conn
            .execute(
                "UPDATE ai_sessions SET updated_at = ?1 WHERE id = ?2",
                params![updated_at, session_id],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to touch session: {}", e)))?;

        if affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                session_id
            )));
        }
        Ok(())
    }

    /// Saves a message and all its parts in a single transaction.
    pub fn save_message_with_parts(
        &self,
        message: &MessageRow,
        parts: &[PartRow],
    ) -> CoreResult<()> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| CoreError::Internal(format!("Failed to begin transaction: {}", e)))?;

        tx.execute(
            r#"INSERT INTO ai_messages (id, session_id, role, timestamp, usage_json, finish_reason)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
            params![
                message.id,
                message.session_id,
                message.role,
                message.timestamp,
                message.usage_json,
                message.finish_reason,
            ],
        )
        .map_err(|e| CoreError::Internal(format!("Failed to save message: {}", e)))?;

        for part in parts {
            tx.execute(
                r#"INSERT INTO ai_parts
                    (id, message_id, session_id, sort_order, part_type, data_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
                params![
                    part.id,
                    part.message_id,
                    part.session_id,
                    part.sort_order,
                    part.part_type,
                    part.data_json,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to save part: {}", e)))?;
        }

        tx.commit()
            .map_err(|e| CoreError::Internal(format!("Failed to commit transaction: {}", e)))?;
        Ok(())
    }

    /// Returns all messages for a session, each bundled with its parts.
    pub fn list_messages(&self, session_id: &str) -> CoreResult<Vec<MessageWithParts>> {
        let messages = self.get_messages(session_id)?;
        let mut result = Vec::with_capacity(messages.len());
        for msg in messages {
            let parts = self.get_parts(&msg.id)?;
            result.push(MessageWithParts {
                message: msg,
                parts,
            });
        }
        Ok(result)
    }

    /// Loads a session together with all its messages and their parts in a
    /// single logical operation.
    pub fn get_session_with_messages(
        &self,
        session_id: &str,
    ) -> CoreResult<(SessionRow, Vec<MessageWithParts>)> {
        let session = self.get_session(session_id)?;
        let messages = self.get_messages(session_id)?;

        let mut result: Vec<MessageWithParts> = Vec::with_capacity(messages.len());
        for msg in messages {
            let parts = self.get_parts(&msg.id)?;
            result.push(MessageWithParts {
                message: msg,
                parts,
            });
        }

        Ok((session, result))
    }
}

// =============================================================================
// Helpers
// =============================================================================

/// Returns the current time as Unix milliseconds.
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // Schema / lifecycle
    // -------------------------------------------------------------------------

    #[test]
    fn test_in_memory_database_creation() {
        let db = ConversationDb::in_memory().unwrap();
        // Schema applied successfully; listing an empty project should return no rows
        let sessions = db.list_sessions("proj-1").unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_file_based_database_creation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.db");

        let db = ConversationDb::create(&path).unwrap();
        let sessions = db.list_sessions("proj-1").unwrap();
        assert!(sessions.is_empty());
        assert!(path.exists());

        // Re-open and verify schema is intact
        drop(db);
        let db2 = ConversationDb::open(&path).unwrap();
        let sessions2 = db2.list_sessions("proj-1").unwrap();
        assert!(sessions2.is_empty());
    }

    // -------------------------------------------------------------------------
    // Session CRUD
    // -------------------------------------------------------------------------

    #[test]
    fn test_create_and_get_session() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", Some("openai"), Some("gpt-4o"))
            .unwrap();

        let s = db.get_session("s1").unwrap();
        assert_eq!(s.id, "s1");
        assert_eq!(s.project_id, "proj-1");
        assert_eq!(s.title, "New Chat");
        assert_eq!(s.agent, "editor");
        assert_eq!(s.model_provider.as_deref(), Some("openai"));
        assert_eq!(s.model_id.as_deref(), Some("gpt-4o"));
        assert!(!s.archived);
        assert!(s.summary_message_id.is_none());
        assert!(s.created_at > 0);
        assert_eq!(s.created_at, s.updated_at);
    }

    #[test]
    fn test_create_session_with_no_model() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "assistant", None, None)
            .unwrap();

        let s = db.get_session("s1").unwrap();
        assert!(s.model_provider.is_none());
        assert!(s.model_id.is_none());
    }

    #[test]
    fn test_get_session_not_found() {
        let db = ConversationDb::in_memory().unwrap();
        let err = db.get_session("nonexistent").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)));
    }

    #[test]
    fn test_list_sessions_ordering_and_filtering() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();
        db.create_session("s2", "proj-1", "editor", None, None)
            .unwrap();
        db.create_session("s3", "proj-2", "editor", None, None)
            .unwrap();

        // Touch s1 to make it more recent
        db.update_session_title("s1", "Updated title").unwrap();

        let sessions = db.list_sessions("proj-1").unwrap();
        assert_eq!(sessions.len(), 2);
        // Most recently updated first
        assert_eq!(sessions[0].id, "s1");
        assert_eq!(sessions[1].id, "s2");
    }

    #[test]
    fn test_update_session_title() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        let before = db.get_session("s1").unwrap();
        db.update_session_title("s1", "My Chat").unwrap();
        let after = db.get_session("s1").unwrap();

        assert_eq!(after.title, "My Chat");
        assert!(after.updated_at >= before.updated_at);
    }

    #[test]
    fn test_update_session_title_not_found() {
        let db = ConversationDb::in_memory().unwrap();
        let err = db.update_session_title("nonexistent", "title").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)));
    }

    #[test]
    fn test_archive_session() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        db.archive_session("s1").unwrap();

        // Archived sessions are excluded from list
        let sessions = db.list_sessions("proj-1").unwrap();
        assert!(sessions.is_empty());

        // But still retrievable by id
        let s = db.get_session("s1").unwrap();
        assert!(s.archived);
    }

    #[test]
    fn test_archive_session_not_found() {
        let db = ConversationDb::in_memory().unwrap();
        let err = db.archive_session("nonexistent").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)));
    }

    #[test]
    fn test_delete_session() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        db.delete_session("s1").unwrap();

        let err = db.get_session("s1").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)));
    }

    #[test]
    fn test_delete_session_not_found() {
        let db = ConversationDb::in_memory().unwrap();
        let err = db.delete_session("nonexistent").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)));
    }

    #[test]
    fn test_delete_session_cascades_messages_and_parts() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();
        db.save_message("m1", "s1", "user", 1000, None, None)
            .unwrap();
        db.save_part("p1", "m1", "s1", 0, "text", r#"{"text":"hi"}"#)
            .unwrap();

        db.delete_session("s1").unwrap();

        // Messages and parts should be gone
        let messages = db.get_messages("s1").unwrap();
        assert!(messages.is_empty());
        let parts = db.get_parts("m1").unwrap();
        assert!(parts.is_empty());
    }

    // -------------------------------------------------------------------------
    // Message CRUD
    // -------------------------------------------------------------------------

    #[test]
    fn test_save_and_get_messages() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        db.save_message("m1", "s1", "user", 1000, None, None)
            .unwrap();
        db.save_message(
            "m2",
            "s1",
            "assistant",
            2000,
            Some(r#"{"input":100,"output":50}"#),
            Some("stop"),
        )
        .unwrap();

        let messages = db.get_messages("s1").unwrap();
        assert_eq!(messages.len(), 2);

        assert_eq!(messages[0].id, "m1");
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].timestamp, 1000);
        assert!(messages[0].usage_json.is_none());
        assert!(messages[0].finish_reason.is_none());

        assert_eq!(messages[1].id, "m2");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].timestamp, 2000);
        assert_eq!(
            messages[1].usage_json.as_deref(),
            Some(r#"{"input":100,"output":50}"#)
        );
        assert_eq!(messages[1].finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn test_save_message_bumps_session_updated_at() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        let before = db.get_session("s1").unwrap().updated_at;
        db.save_message("m1", "s1", "user", before + 5000, None, None)
            .unwrap();
        let after = db.get_session("s1").unwrap().updated_at;

        assert!(after > before);
    }

    #[test]
    fn test_get_messages_empty_session() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        let messages = db.get_messages("s1").unwrap();
        assert!(messages.is_empty());
    }

    #[test]
    fn test_delete_message() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();
        db.save_message("m1", "s1", "user", 1000, None, None)
            .unwrap();

        db.delete_message("m1").unwrap();

        let messages = db.get_messages("s1").unwrap();
        assert!(messages.is_empty());
    }

    #[test]
    fn test_delete_message_not_found() {
        let db = ConversationDb::in_memory().unwrap();
        let err = db.delete_message("nonexistent").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)));
    }

    #[test]
    fn test_delete_message_cascades_parts() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();
        db.save_message("m1", "s1", "user", 1000, None, None)
            .unwrap();
        db.save_part("p1", "m1", "s1", 0, "text", r#"{"text":"hello"}"#)
            .unwrap();
        db.save_part("p2", "m1", "s1", 1, "text", r#"{"text":"world"}"#)
            .unwrap();

        db.delete_message("m1").unwrap();

        let parts = db.get_parts("m1").unwrap();
        assert!(parts.is_empty());
    }

    // -------------------------------------------------------------------------
    // Parts CRUD
    // -------------------------------------------------------------------------

    #[test]
    fn test_save_and_get_parts() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();
        db.save_message("m1", "s1", "assistant", 1000, None, None)
            .unwrap();

        db.save_part("p1", "m1", "s1", 0, "text", r#"{"text":"Hello"}"#)
            .unwrap();
        db.save_part(
            "p2",
            "m1",
            "s1",
            1,
            "tool_call",
            r#"{"name":"split_clip","args":{}}"#,
        )
        .unwrap();

        let parts = db.get_parts("m1").unwrap();
        assert_eq!(parts.len(), 2);

        assert_eq!(parts[0].id, "p1");
        assert_eq!(parts[0].message_id, "m1");
        assert_eq!(parts[0].session_id, "s1");
        assert_eq!(parts[0].sort_order, 0);
        assert_eq!(parts[0].part_type, "text");
        assert!(parts[0].compacted_at.is_none());

        assert_eq!(parts[1].id, "p2");
        assert_eq!(parts[1].sort_order, 1);
        assert_eq!(parts[1].part_type, "tool_call");
    }

    #[test]
    fn test_get_parts_ordered_by_sort_order() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();
        db.save_message("m1", "s1", "assistant", 1000, None, None)
            .unwrap();

        // Insert out of order
        db.save_part("p3", "m1", "s1", 2, "text", r#"{"text":"c"}"#)
            .unwrap();
        db.save_part("p1", "m1", "s1", 0, "text", r#"{"text":"a"}"#)
            .unwrap();
        db.save_part("p2", "m1", "s1", 1, "text", r#"{"text":"b"}"#)
            .unwrap();

        let parts = db.get_parts("m1").unwrap();
        assert_eq!(parts[0].id, "p1");
        assert_eq!(parts[1].id, "p2");
        assert_eq!(parts[2].id, "p3");
    }

    #[test]
    fn test_update_part_data() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();
        db.save_message("m1", "s1", "user", 1000, None, None)
            .unwrap();
        db.save_part("p1", "m1", "s1", 0, "text", r#"{"text":"old"}"#)
            .unwrap();

        db.update_part_data("p1", r#"{"text":"new"}"#).unwrap();

        let parts = db.get_parts("m1").unwrap();
        assert_eq!(parts[0].data_json, r#"{"text":"new"}"#);
    }

    #[test]
    fn test_update_part_data_not_found() {
        let db = ConversationDb::in_memory().unwrap();
        let err = db
            .update_part_data("nonexistent", r#"{"text":"x"}"#)
            .unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)));
    }

    #[test]
    fn test_mark_parts_compacted() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();
        db.save_message("m1", "s1", "assistant", 1000, None, None)
            .unwrap();
        db.save_part("p1", "m1", "s1", 0, "text", r#"{"text":"a"}"#)
            .unwrap();
        db.save_part("p2", "m1", "s1", 1, "text", r#"{"text":"b"}"#)
            .unwrap();
        db.save_part("p3", "m1", "s1", 2, "text", r#"{"text":"c"}"#)
            .unwrap();

        let compact_time = 999_999;
        db.mark_parts_compacted(&["p1".to_string(), "p2".to_string()], compact_time)
            .unwrap();

        let parts = db.get_parts("m1").unwrap();
        assert_eq!(parts[0].compacted_at, Some(compact_time));
        assert_eq!(parts[1].compacted_at, Some(compact_time));
        assert!(parts[2].compacted_at.is_none());
    }

    #[test]
    fn test_mark_parts_compacted_empty_slice() {
        let db = ConversationDb::in_memory().unwrap();
        // Should be a no-op, not an error
        db.mark_parts_compacted(&[], 1000).unwrap();
    }

    // -------------------------------------------------------------------------
    // Convenience: get_session_with_messages
    // -------------------------------------------------------------------------

    #[test]
    fn test_get_session_with_messages() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session(
            "s1",
            "proj-1",
            "editor",
            Some("anthropic"),
            Some("claude-3"),
        )
        .unwrap();

        db.save_message("m1", "s1", "user", 1000, None, None)
            .unwrap();
        db.save_part("p1", "m1", "s1", 0, "text", r#"{"text":"Hello"}"#)
            .unwrap();

        db.save_message("m2", "s1", "assistant", 2000, None, Some("stop"))
            .unwrap();
        db.save_part("p2", "m2", "s1", 0, "text", r#"{"text":"Hi!"}"#)
            .unwrap();
        db.save_part("p3", "m2", "s1", 1, "tool_call", r#"{"name":"analyze"}"#)
            .unwrap();

        let (session, messages) = db.get_session_with_messages("s1").unwrap();

        assert_eq!(session.id, "s1");
        assert_eq!(session.model_provider.as_deref(), Some("anthropic"));

        assert_eq!(messages.len(), 2);

        assert_eq!(messages[0].message.id, "m1");
        assert_eq!(messages[0].parts.len(), 1);
        assert_eq!(messages[0].parts[0].part_type, "text");

        assert_eq!(messages[1].message.id, "m2");
        assert_eq!(messages[1].parts.len(), 2);
        assert_eq!(messages[1].parts[0].part_type, "text");
        assert_eq!(messages[1].parts[1].part_type, "tool_call");
    }

    #[test]
    fn test_get_session_with_messages_empty() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        let (session, messages) = db.get_session_with_messages("s1").unwrap();
        assert_eq!(session.id, "s1");
        assert!(messages.is_empty());
    }

    #[test]
    fn test_get_session_with_messages_not_found() {
        let db = ConversationDb::in_memory().unwrap();
        let err = db.get_session_with_messages("nonexistent").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)));
    }

    // -------------------------------------------------------------------------
    // Role constraint
    // -------------------------------------------------------------------------

    #[test]
    fn test_invalid_role_rejected() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        let result = db.save_message("m1", "s1", "invalid_role", 1000, None, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_system_role_accepted() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        db.save_message("m1", "s1", "system", 1000, None, None)
            .unwrap();
        let messages = db.get_messages("s1").unwrap();
        assert_eq!(messages[0].role, "system");
    }

    // -------------------------------------------------------------------------
    // Multi-project isolation
    // -------------------------------------------------------------------------

    #[test]
    fn test_sessions_isolated_by_project() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();
        db.create_session("s2", "proj-2", "editor", None, None)
            .unwrap();

        let proj1 = db.list_sessions("proj-1").unwrap();
        let proj2 = db.list_sessions("proj-2").unwrap();

        assert_eq!(proj1.len(), 1);
        assert_eq!(proj1[0].id, "s1");
        assert_eq!(proj2.len(), 1);
        assert_eq!(proj2[0].id, "s2");
    }
}

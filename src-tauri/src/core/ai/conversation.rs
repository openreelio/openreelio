//! Conversation Persistence Module
//!
//! SQLite-based storage for AI conversation sessions, messages, and content parts.
//! Enables full conversation history, context replay, and compaction for the
//! agentic engine.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
    pub runtime_kind: String,
    pub session_mode: String,
    pub status: String,
    pub parent_session_id: Option<String>,
    pub branch_from_session_id: Option<String>,
    pub root_session_id: String,
    pub sequence_id: Option<String>,
    pub current_run_id: Option<String>,
    pub current_plan_id: Option<String>,
    pub pending_approval_id: Option<String>,
    pub active_checkpoint_id: Option<String>,
    pub permission_state_version: i64,
    pub compaction_version: i64,
    pub resume_cursor_version: i64,
    pub last_compacted_at: Option<i64>,
    pub last_resumed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    pub archived: bool,
    pub summary_message_id: Option<String>,
}

/// A single orchestration run belonging to an agent session.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRow {
    pub id: String,
    pub session_id: String,
    pub runtime_kind: String,
    pub trigger: String,
    pub phase: String,
    pub iteration: i64,
    pub max_iterations: i64,
    pub tool_calls_used: i64,
    pub max_tool_calls: i64,
    pub planned_step_count: i64,
    pub completed_step_count: i64,
    pub input_message_id: Option<String>,
    pub output_message_id: Option<String>,
    pub trace_id: Option<String>,
    pub rollback_report_json: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    pub ended_at: Option<i64>,
}

/// A persisted delegation relationship between parent and child sessions.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DelegationRecordRow {
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

/// A persisted permission or approval decision for a session.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecisionRow {
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

/// A persisted compaction record for a session.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CompactionRecordRow {
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

/// A durable resume checkpoint for safe recovery boundaries.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCheckpointRow {
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

const SESSION_SELECT_COLUMNS: &str = r#"id, project_id, title, agent, model_provider, model_id,
    runtime_kind, session_mode, status, parent_session_id, branch_from_session_id,
    root_session_id, sequence_id, current_run_id, current_plan_id, pending_approval_id,
    active_checkpoint_id, permission_state_version, compaction_version,
    resume_cursor_version, last_compacted_at, last_resumed_at, created_at, updated_at,
    completed_at, archived, summary_message_id"#;

const RUN_SELECT_COLUMNS: &str = r#"id, session_id, runtime_kind, trigger, phase, iteration,
    max_iterations, tool_calls_used, max_tool_calls, planned_step_count,
    completed_step_count, input_message_id, output_message_id, trace_id,
    rollback_report_json, error_code, error_message, started_at, updated_at, ended_at"#;

const DELEGATION_SELECT_COLUMNS: &str = r#"id, parent_session_id, child_session_id,
    parent_run_id, agent_profile_id, delegated_goal, context_packet_json,
    allowed_tools_delta_json, permission_snapshot_json, status, merge_status,
    summary_message_id, result_json, error_message, created_at, updated_at, completed_at"#;

const PERMISSION_DECISION_SELECT_COLUMNS: &str = r#"id, session_id, run_id, step_id,
    subject_type, subject, action, source, reason, created_at"#;

const COMPACTION_SELECT_COLUMNS: &str = r#"id, session_id, run_id, tier, trigger,
    summary_message_id, source_message_count, retained_message_count,
    estimated_tokens_saved, continuation_summary_json, state_rehydration_json, created_at"#;

const RESUME_CHECKPOINT_SELECT_COLUMNS: &str = r#"id, session_id, run_id, checkpoint_kind,
    status, resume_cursor_json, session_state_json, pending_work_json, created_at, consumed_at"#;

fn session_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        agent: row.get(3)?,
        model_provider: row.get(4)?,
        model_id: row.get(5)?,
        runtime_kind: row.get(6)?,
        session_mode: row.get(7)?,
        status: row.get(8)?,
        parent_session_id: row.get(9)?,
        branch_from_session_id: row.get(10)?,
        root_session_id: row.get(11)?,
        sequence_id: row.get(12)?,
        current_run_id: row.get(13)?,
        current_plan_id: row.get(14)?,
        pending_approval_id: row.get(15)?,
        active_checkpoint_id: row.get(16)?,
        permission_state_version: row.get(17)?,
        compaction_version: row.get(18)?,
        resume_cursor_version: row.get(19)?,
        last_compacted_at: row.get(20)?,
        last_resumed_at: row.get(21)?,
        created_at: row.get(22)?,
        updated_at: row.get(23)?,
        completed_at: row.get(24)?,
        archived: row.get::<_, i32>(25)? != 0,
        summary_message_id: row.get(26)?,
    })
}

fn agent_run_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRunRow> {
    Ok(AgentRunRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        runtime_kind: row.get(2)?,
        trigger: row.get(3)?,
        phase: row.get(4)?,
        iteration: row.get(5)?,
        max_iterations: row.get(6)?,
        tool_calls_used: row.get(7)?,
        max_tool_calls: row.get(8)?,
        planned_step_count: row.get(9)?,
        completed_step_count: row.get(10)?,
        input_message_id: row.get(11)?,
        output_message_id: row.get(12)?,
        trace_id: row.get(13)?,
        rollback_report_json: row.get(14)?,
        error_code: row.get(15)?,
        error_message: row.get(16)?,
        started_at: row.get(17)?,
        updated_at: row.get(18)?,
        ended_at: row.get(19)?,
    })
}

fn delegation_record_row_from_sql(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<DelegationRecordRow> {
    Ok(DelegationRecordRow {
        id: row.get(0)?,
        parent_session_id: row.get(1)?,
        child_session_id: row.get(2)?,
        parent_run_id: row.get(3)?,
        agent_profile_id: row.get(4)?,
        delegated_goal: row.get(5)?,
        context_packet_json: row.get(6)?,
        allowed_tools_delta_json: row.get(7)?,
        permission_snapshot_json: row.get(8)?,
        status: row.get(9)?,
        merge_status: row.get(10)?,
        summary_message_id: row.get(11)?,
        result_json: row.get(12)?,
        error_message: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        completed_at: row.get(16)?,
    })
}

fn permission_decision_row_from_sql(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<PermissionDecisionRow> {
    Ok(PermissionDecisionRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        run_id: row.get(2)?,
        step_id: row.get(3)?,
        subject_type: row.get(4)?,
        subject: row.get(5)?,
        action: row.get(6)?,
        source: row.get(7)?,
        reason: row.get(8)?,
        created_at: row.get(9)?,
    })
}

fn compaction_record_row_from_sql(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<CompactionRecordRow> {
    Ok(CompactionRecordRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        run_id: row.get(2)?,
        tier: row.get(3)?,
        trigger: row.get(4)?,
        summary_message_id: row.get(5)?,
        source_message_count: row.get(6)?,
        retained_message_count: row.get(7)?,
        estimated_tokens_saved: row.get(8)?,
        continuation_summary_json: row.get(9)?,
        state_rehydration_json: row.get(10)?,
        created_at: row.get(11)?,
    })
}

fn resume_checkpoint_row_from_sql(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ResumeCheckpointRow> {
    Ok(ResumeCheckpointRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        run_id: row.get(2)?,
        checkpoint_kind: row.get(3)?,
        status: row.get(4)?,
        resume_cursor_json: row.get(5)?,
        session_state_json: row.get(6)?,
        pending_work_json: row.get(7)?,
        created_at: row.get(8)?,
        consumed_at: row.get(9)?,
    })
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
                    runtime_kind TEXT NOT NULL DEFAULT 'tpao',
                    session_mode TEXT NOT NULL DEFAULT 'primary',
                    status TEXT NOT NULL DEFAULT 'idle',
                    parent_session_id TEXT,
                    branch_from_session_id TEXT,
                    root_session_id TEXT NOT NULL,
                    sequence_id TEXT,
                    current_run_id TEXT,
                    current_plan_id TEXT,
                    pending_approval_id TEXT,
                    active_checkpoint_id TEXT,
                    permission_state_version INTEGER NOT NULL DEFAULT 0,
                    compaction_version INTEGER NOT NULL DEFAULT 0,
                    resume_cursor_version INTEGER NOT NULL DEFAULT 0,
                    last_compacted_at INTEGER,
                    last_resumed_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    completed_at INTEGER,
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

                CREATE TABLE IF NOT EXISTS ai_runs (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    runtime_kind TEXT NOT NULL DEFAULT 'tpao',
                    trigger TEXT NOT NULL DEFAULT 'user',
                    phase TEXT NOT NULL DEFAULT 'initializing',
                    iteration INTEGER NOT NULL DEFAULT 0,
                    max_iterations INTEGER NOT NULL DEFAULT 20,
                    tool_calls_used INTEGER NOT NULL DEFAULT 0,
                    max_tool_calls INTEGER NOT NULL DEFAULT 50,
                    planned_step_count INTEGER NOT NULL DEFAULT 0,
                    completed_step_count INTEGER NOT NULL DEFAULT 0,
                    input_message_id TEXT,
                    output_message_id TEXT,
                    trace_id TEXT,
                    rollback_report_json TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    started_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    ended_at INTEGER,
                    FOREIGN KEY(session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS ai_delegations (
                    id TEXT PRIMARY KEY,
                    parent_session_id TEXT NOT NULL,
                    child_session_id TEXT NOT NULL,
                    parent_run_id TEXT NOT NULL,
                    agent_profile_id TEXT NOT NULL,
                    delegated_goal TEXT NOT NULL,
                    context_packet_json TEXT NOT NULL,
                    allowed_tools_delta_json TEXT,
                    permission_snapshot_json TEXT,
                    status TEXT NOT NULL DEFAULT 'requested',
                    merge_status TEXT NOT NULL DEFAULT 'pending',
                    summary_message_id TEXT,
                    result_json TEXT,
                    error_message TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    FOREIGN KEY(parent_session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
                    FOREIGN KEY(child_session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
                    FOREIGN KEY(parent_run_id) REFERENCES ai_runs(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS ai_permission_decisions (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    run_id TEXT,
                    step_id TEXT,
                    subject_type TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    action TEXT NOT NULL,
                    source TEXT NOT NULL,
                    reason TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
                    FOREIGN KEY(run_id) REFERENCES ai_runs(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS ai_compactions (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    run_id TEXT,
                    tier TEXT NOT NULL,
                    trigger TEXT NOT NULL,
                    summary_message_id TEXT,
                    source_message_count INTEGER NOT NULL,
                    retained_message_count INTEGER NOT NULL,
                    estimated_tokens_saved INTEGER,
                    continuation_summary_json TEXT,
                    state_rehydration_json TEXT,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
                    FOREIGN KEY(run_id) REFERENCES ai_runs(id) ON DELETE SET NULL,
                    FOREIGN KEY(summary_message_id) REFERENCES ai_messages(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS ai_resume_checkpoints (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    run_id TEXT,
                    checkpoint_kind TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    resume_cursor_json TEXT NOT NULL,
                    session_state_json TEXT NOT NULL,
                    pending_work_json TEXT,
                    created_at INTEGER NOT NULL,
                    consumed_at INTEGER,
                    FOREIGN KEY(session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
                    FOREIGN KEY(run_id) REFERENCES ai_runs(id) ON DELETE SET NULL
                );

                CREATE INDEX IF NOT EXISTS idx_ai_sessions_project
                    ON ai_sessions(project_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_messages_session
                    ON ai_messages(session_id, timestamp);
                CREATE INDEX IF NOT EXISTS idx_ai_parts_message
                    ON ai_parts(message_id, sort_order);
                CREATE INDEX IF NOT EXISTS idx_ai_runs_session
                    ON ai_runs(session_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_runs_session_phase
                    ON ai_runs(session_id, phase, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_delegations_parent_session
                    ON ai_delegations(parent_session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_delegations_child_session
                    ON ai_delegations(child_session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_permission_decisions_session
                    ON ai_permission_decisions(session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_compactions_session
                    ON ai_compactions(session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_resume_checkpoints_session
                    ON ai_resume_checkpoints(session_id, created_at DESC);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_resume_checkpoints_single_active
                    ON ai_resume_checkpoints(session_id)
                    WHERE status = 'active';
                "#,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to initialize schema: {}", e)))?;

        self.ensure_ai_session_columns()?;
        self.backfill_ai_session_kernel_fields()?;
        self.conn
            .execute_batch(
                r#"
                CREATE INDEX IF NOT EXISTS idx_ai_sessions_root
                    ON ai_sessions(root_session_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_sessions_parent
                    ON ai_sessions(parent_session_id, updated_at DESC);
                "#,
            )
            .map_err(|e| {
                CoreError::Internal(format!("Failed to initialize agent session indexes: {}", e))
            })?;

        Ok(())
    }

    fn ensure_ai_session_columns(&self) -> CoreResult<()> {
        self.ensure_table_columns(
            "ai_sessions",
            &[
                ("runtime_kind", "runtime_kind TEXT NOT NULL DEFAULT 'tpao'"),
                (
                    "session_mode",
                    "session_mode TEXT NOT NULL DEFAULT 'primary'",
                ),
                ("status", "status TEXT NOT NULL DEFAULT 'idle'"),
                ("parent_session_id", "parent_session_id TEXT"),
                ("branch_from_session_id", "branch_from_session_id TEXT"),
                ("root_session_id", "root_session_id TEXT"),
                ("sequence_id", "sequence_id TEXT"),
                ("current_run_id", "current_run_id TEXT"),
                ("current_plan_id", "current_plan_id TEXT"),
                ("pending_approval_id", "pending_approval_id TEXT"),
                ("active_checkpoint_id", "active_checkpoint_id TEXT"),
                (
                    "permission_state_version",
                    "permission_state_version INTEGER NOT NULL DEFAULT 0",
                ),
                (
                    "compaction_version",
                    "compaction_version INTEGER NOT NULL DEFAULT 0",
                ),
                (
                    "resume_cursor_version",
                    "resume_cursor_version INTEGER NOT NULL DEFAULT 0",
                ),
                ("last_compacted_at", "last_compacted_at INTEGER"),
                ("last_resumed_at", "last_resumed_at INTEGER"),
                ("completed_at", "completed_at INTEGER"),
            ],
        )
    }

    fn ensure_table_columns(&self, table: &str, columns: &[(&str, &str)]) -> CoreResult<()> {
        let existing_columns = self.read_table_columns(table)?;

        for (column_name, column_definition) in columns {
            if existing_columns.contains(*column_name) {
                continue;
            }

            let sql = format!("ALTER TABLE {table} ADD COLUMN {column_definition}");
            self.conn.execute(&sql, []).map_err(|e| {
                CoreError::Internal(format!(
                    "Failed to add column {column_name} to {table}: {e}"
                ))
            })?;
        }

        Ok(())
    }

    fn read_table_columns(&self, table: &str) -> CoreResult<HashSet<String>> {
        let pragma = format!("PRAGMA table_info({table})");
        let mut stmt = self
            .conn
            .prepare(&pragma)
            .map_err(|e| CoreError::Internal(format!("Failed to inspect {table}: {}", e)))?;

        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| CoreError::Internal(format!("Failed to inspect {table}: {}", e)))?;

        let mut columns = HashSet::new();
        for row in rows {
            columns.insert(row.map_err(|e| {
                CoreError::Internal(format!("Failed to read {table} columns: {}", e))
            })?);
        }

        Ok(columns)
    }

    fn backfill_ai_session_kernel_fields(&self) -> CoreResult<()> {
        self.conn
            .execute(
                r#"
                UPDATE ai_sessions
                   SET runtime_kind = COALESCE(NULLIF(runtime_kind, ''), 'tpao'),
                       session_mode = COALESCE(NULLIF(session_mode, ''), 'primary'),
                       status = COALESCE(NULLIF(status, ''), 'idle'),
                       root_session_id = COALESCE(NULLIF(root_session_id, ''), id)
                 WHERE runtime_kind IS NULL
                    OR runtime_kind = ''
                    OR session_mode IS NULL
                    OR session_mode = ''
                    OR status IS NULL
                    OR status = ''
                    OR root_session_id IS NULL
                    OR root_session_id = ''
                "#,
                [],
            )
            .map_err(|e| {
                CoreError::Internal(format!(
                    "Failed to backfill agent session kernel fields: {}",
                    e
                ))
            })?;

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
        let row = SessionRow {
            id: id.to_string(),
            project_id: project_id.to_string(),
            title: "New Chat".to_string(),
            agent: agent.to_string(),
            model_provider: model_provider.map(str::to_string),
            model_id: model_id.map(str::to_string),
            runtime_kind: "tpao".to_string(),
            session_mode: "primary".to_string(),
            status: "idle".to_string(),
            parent_session_id: None,
            branch_from_session_id: None,
            root_session_id: id.to_string(),
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

        self.insert_session(&row)
    }

    /// Retrieves a single session by its id.
    pub fn get_session(&self, session_id: &str) -> CoreResult<SessionRow> {
        let sql = format!("SELECT {SESSION_SELECT_COLUMNS} FROM ai_sessions WHERE id = ?1");
        self.conn
            .query_row(&sql, params![session_id], session_row_from_sql)
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    CoreError::NotFound(format!("Session not found: {}", session_id))
                }
                other => CoreError::Internal(format!("Failed to get session: {}", other)),
            })
    }

    /// Lists all non-archived sessions for a project, most recently updated first.
    pub fn list_sessions(&self, project_id: &str) -> CoreResult<Vec<SessionRow>> {
        let sql = format!(
            "SELECT {SESSION_SELECT_COLUMNS} FROM ai_sessions \
             WHERE project_id = ?1 AND archived = 0 \
             ORDER BY updated_at DESC"
        );
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| CoreError::Internal(format!("Failed to prepare list sessions: {}", e)))?;

        let rows = stmt
            .query_map(params![project_id], session_row_from_sql)
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
                     runtime_kind, session_mode, status, parent_session_id,
                     branch_from_session_id, root_session_id, sequence_id,
                     current_run_id, current_plan_id, pending_approval_id,
                     active_checkpoint_id, permission_state_version,
                     compaction_version, resume_cursor_version,
                     last_compacted_at, last_resumed_at, created_at, updated_at,
                     completed_at, archived, summary_message_id)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                           ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
                           ?23, ?24, ?25, ?26, ?27)"#,
                params![
                    &row.id,
                    &row.project_id,
                    &row.title,
                    &row.agent,
                    &row.model_provider,
                    &row.model_id,
                    &row.runtime_kind,
                    &row.session_mode,
                    &row.status,
                    &row.parent_session_id,
                    &row.branch_from_session_id,
                    &row.root_session_id,
                    &row.sequence_id,
                    &row.current_run_id,
                    &row.current_plan_id,
                    &row.pending_approval_id,
                    &row.active_checkpoint_id,
                    row.permission_state_version,
                    row.compaction_version,
                    row.resume_cursor_version,
                    row.last_compacted_at,
                    row.last_resumed_at,
                    row.created_at,
                    row.updated_at,
                    row.completed_at,
                    row.archived as i32,
                    &row.summary_message_id,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to insert session: {}", e)))?;
        Ok(())
    }

    /// Replaces an existing session row with the caller-provided orchestration state.
    pub fn update_session(&self, row: &SessionRow) -> CoreResult<()> {
        let affected = self
            .conn
            .execute(
                r#"UPDATE ai_sessions
                      SET project_id = ?2,
                          title = ?3,
                          agent = ?4,
                          model_provider = ?5,
                          model_id = ?6,
                          runtime_kind = ?7,
                          session_mode = ?8,
                          status = ?9,
                          parent_session_id = ?10,
                          branch_from_session_id = ?11,
                          root_session_id = ?12,
                          sequence_id = ?13,
                          current_run_id = ?14,
                          current_plan_id = ?15,
                          pending_approval_id = ?16,
                          active_checkpoint_id = ?17,
                          permission_state_version = ?18,
                          compaction_version = ?19,
                          resume_cursor_version = ?20,
                          last_compacted_at = ?21,
                          last_resumed_at = ?22,
                          created_at = ?23,
                          updated_at = ?24,
                          completed_at = ?25,
                          archived = ?26,
                          summary_message_id = ?27
                    WHERE id = ?1"#,
                params![
                    &row.id,
                    &row.project_id,
                    &row.title,
                    &row.agent,
                    &row.model_provider,
                    &row.model_id,
                    &row.runtime_kind,
                    &row.session_mode,
                    &row.status,
                    &row.parent_session_id,
                    &row.branch_from_session_id,
                    &row.root_session_id,
                    &row.sequence_id,
                    &row.current_run_id,
                    &row.current_plan_id,
                    &row.pending_approval_id,
                    &row.active_checkpoint_id,
                    row.permission_state_version,
                    row.compaction_version,
                    row.resume_cursor_version,
                    row.last_compacted_at,
                    row.last_resumed_at,
                    row.created_at,
                    row.updated_at,
                    row.completed_at,
                    row.archived as i32,
                    &row.summary_message_id,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update session: {}", e)))?;

        if affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                row.id
            )));
        }

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

    /// Inserts a new run row.
    pub fn insert_run(&self, row: &AgentRunRow) -> CoreResult<()> {
        self.conn
            .execute(
                r#"INSERT INTO ai_runs
                    (id, session_id, runtime_kind, trigger, phase, iteration,
                     max_iterations, tool_calls_used, max_tool_calls,
                     planned_step_count, completed_step_count, input_message_id,
                     output_message_id, trace_id, rollback_report_json,
                     error_code, error_message, started_at, updated_at, ended_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                           ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"#,
                params![
                    &row.id,
                    &row.session_id,
                    &row.runtime_kind,
                    &row.trigger,
                    &row.phase,
                    row.iteration,
                    row.max_iterations,
                    row.tool_calls_used,
                    row.max_tool_calls,
                    row.planned_step_count,
                    row.completed_step_count,
                    &row.input_message_id,
                    &row.output_message_id,
                    &row.trace_id,
                    &row.rollback_report_json,
                    &row.error_code,
                    &row.error_message,
                    row.started_at,
                    row.updated_at,
                    row.ended_at,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to insert run: {}", e)))?;

        Ok(())
    }

    /// Retrieves a single run by its id.
    pub fn get_run(&self, run_id: &str) -> CoreResult<AgentRunRow> {
        let sql = format!("SELECT {RUN_SELECT_COLUMNS} FROM ai_runs WHERE id = ?1");
        self.conn
            .query_row(&sql, params![run_id], agent_run_row_from_sql)
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    CoreError::NotFound(format!("Run not found: {}", run_id))
                }
                other => CoreError::Internal(format!("Failed to get run: {}", other)),
            })
    }

    /// Lists all runs for a session, newest first.
    pub fn list_runs_for_session(&self, session_id: &str) -> CoreResult<Vec<AgentRunRow>> {
        let sql = format!(
            "SELECT {RUN_SELECT_COLUMNS} FROM ai_runs \
             WHERE session_id = ?1 ORDER BY started_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| {
            CoreError::Internal(format!("Failed to prepare list runs for session: {}", e))
        })?;

        let rows = stmt
            .query_map(params![session_id], agent_run_row_from_sql)
            .map_err(|e| CoreError::Internal(format!("Failed to list runs: {}", e)))?;

        let mut runs = Vec::new();
        for row in rows {
            runs.push(
                row.map_err(|e| CoreError::Internal(format!("Failed to read run row: {}", e)))?,
            );
        }

        Ok(runs)
    }

    /// Starts a run and atomically marks the owning session as running.
    pub fn start_run(&self, row: &AgentRunRow, session_status: &str) -> CoreResult<()> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| CoreError::Internal(format!("Failed to begin transaction: {}", e)))?;

        tx.execute(
            r#"INSERT INTO ai_runs
                (id, session_id, runtime_kind, trigger, phase, iteration,
                 max_iterations, tool_calls_used, max_tool_calls,
                 planned_step_count, completed_step_count, input_message_id,
                 output_message_id, trace_id, rollback_report_json,
                 error_code, error_message, started_at, updated_at, ended_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"#,
            params![
                &row.id,
                &row.session_id,
                &row.runtime_kind,
                &row.trigger,
                &row.phase,
                row.iteration,
                row.max_iterations,
                row.tool_calls_used,
                row.max_tool_calls,
                row.planned_step_count,
                row.completed_step_count,
                &row.input_message_id,
                &row.output_message_id,
                &row.trace_id,
                &row.rollback_report_json,
                &row.error_code,
                &row.error_message,
                row.started_at,
                row.updated_at,
                row.ended_at,
            ],
        )
        .map_err(|e| CoreError::Internal(format!("Failed to insert run: {}", e)))?;

        let affected = tx
            .execute(
                r#"UPDATE ai_sessions
                      SET current_run_id = ?1,
                          runtime_kind = ?2,
                          status = ?3,
                          updated_at = ?4,
                          completed_at = NULL
                    WHERE id = ?5"#,
                params![
                    &row.id,
                    &row.runtime_kind,
                    session_status,
                    row.updated_at,
                    &row.session_id,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update session state: {}", e)))?;

        if affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                row.session_id
            )));
        }

        tx.commit()
            .map_err(|e| CoreError::Internal(format!("Failed to commit transaction: {}", e)))?;

        Ok(())
    }

    /// Updates an existing run and synchronizes the owning session in one transaction.
    pub fn update_session_and_run(
        &self,
        session: &SessionRow,
        run: &AgentRunRow,
    ) -> CoreResult<()> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| CoreError::Internal(format!("Failed to begin transaction: {}", e)))?;

        let run_affected = tx
            .execute(
                r#"UPDATE ai_runs
                      SET session_id = ?2,
                          runtime_kind = ?3,
                          trigger = ?4,
                          phase = ?5,
                          iteration = ?6,
                          max_iterations = ?7,
                          tool_calls_used = ?8,
                          max_tool_calls = ?9,
                          planned_step_count = ?10,
                          completed_step_count = ?11,
                          input_message_id = ?12,
                          output_message_id = ?13,
                          trace_id = ?14,
                          rollback_report_json = ?15,
                          error_code = ?16,
                          error_message = ?17,
                          started_at = ?18,
                          updated_at = ?19,
                          ended_at = ?20
                    WHERE id = ?1"#,
                params![
                    &run.id,
                    &run.session_id,
                    &run.runtime_kind,
                    &run.trigger,
                    &run.phase,
                    run.iteration,
                    run.max_iterations,
                    run.tool_calls_used,
                    run.max_tool_calls,
                    run.planned_step_count,
                    run.completed_step_count,
                    &run.input_message_id,
                    &run.output_message_id,
                    &run.trace_id,
                    &run.rollback_report_json,
                    &run.error_code,
                    &run.error_message,
                    run.started_at,
                    run.updated_at,
                    run.ended_at,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update run: {}", e)))?;

        if run_affected == 0 {
            return Err(CoreError::NotFound(format!("Run not found: {}", run.id)));
        }

        let session_affected = tx
            .execute(
                r#"UPDATE ai_sessions
                      SET project_id = ?2,
                          title = ?3,
                          agent = ?4,
                          model_provider = ?5,
                          model_id = ?6,
                          runtime_kind = ?7,
                          session_mode = ?8,
                          status = ?9,
                          parent_session_id = ?10,
                          branch_from_session_id = ?11,
                          root_session_id = ?12,
                          sequence_id = ?13,
                          current_run_id = ?14,
                          current_plan_id = ?15,
                          pending_approval_id = ?16,
                          active_checkpoint_id = ?17,
                          permission_state_version = ?18,
                          compaction_version = ?19,
                          resume_cursor_version = ?20,
                          last_compacted_at = ?21,
                          last_resumed_at = ?22,
                          created_at = ?23,
                          updated_at = ?24,
                          completed_at = ?25,
                          archived = ?26,
                          summary_message_id = ?27
                    WHERE id = ?1"#,
                params![
                    &session.id,
                    &session.project_id,
                    &session.title,
                    &session.agent,
                    &session.model_provider,
                    &session.model_id,
                    &session.runtime_kind,
                    &session.session_mode,
                    &session.status,
                    &session.parent_session_id,
                    &session.branch_from_session_id,
                    &session.root_session_id,
                    &session.sequence_id,
                    &session.current_run_id,
                    &session.current_plan_id,
                    &session.pending_approval_id,
                    &session.active_checkpoint_id,
                    session.permission_state_version,
                    session.compaction_version,
                    session.resume_cursor_version,
                    session.last_compacted_at,
                    session.last_resumed_at,
                    session.created_at,
                    session.updated_at,
                    session.completed_at,
                    session.archived as i32,
                    &session.summary_message_id,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update session: {}", e)))?;

        if session_affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                session.id
            )));
        }

        tx.commit()
            .map_err(|e| CoreError::Internal(format!("Failed to commit transaction: {}", e)))?;

        Ok(())
    }

    /// Inserts a delegation record.
    pub fn insert_delegation(&self, row: &DelegationRecordRow) -> CoreResult<()> {
        self.conn
            .execute(
                r#"INSERT INTO ai_delegations
                    (id, parent_session_id, child_session_id, parent_run_id,
                     agent_profile_id, delegated_goal, context_packet_json,
                     allowed_tools_delta_json, permission_snapshot_json, status,
                     merge_status, summary_message_id, result_json, error_message,
                     created_at, updated_at, completed_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                           ?13, ?14, ?15, ?16, ?17)"#,
                params![
                    &row.id,
                    &row.parent_session_id,
                    &row.child_session_id,
                    &row.parent_run_id,
                    &row.agent_profile_id,
                    &row.delegated_goal,
                    &row.context_packet_json,
                    &row.allowed_tools_delta_json,
                    &row.permission_snapshot_json,
                    &row.status,
                    &row.merge_status,
                    &row.summary_message_id,
                    &row.result_json,
                    &row.error_message,
                    row.created_at,
                    row.updated_at,
                    row.completed_at,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to insert delegation: {}", e)))?;

        Ok(())
    }

    /// Retrieves a delegation record by id.
    pub fn get_delegation(&self, delegation_id: &str) -> CoreResult<DelegationRecordRow> {
        let sql = format!("SELECT {DELEGATION_SELECT_COLUMNS} FROM ai_delegations WHERE id = ?1");
        self.conn
            .query_row(&sql, params![delegation_id], delegation_record_row_from_sql)
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    CoreError::NotFound(format!("Delegation not found: {}", delegation_id))
                }
                other => CoreError::Internal(format!("Failed to get delegation: {}", other)),
            })
    }

    /// Lists delegation records touching the given session.
    pub fn list_delegations_for_session(
        &self,
        session_id: &str,
    ) -> CoreResult<Vec<DelegationRecordRow>> {
        let sql = format!(
            "SELECT {DELEGATION_SELECT_COLUMNS} FROM ai_delegations \
             WHERE parent_session_id = ?1 OR child_session_id = ?1 \
             ORDER BY created_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| {
            CoreError::Internal(format!("Failed to prepare list delegations: {}", e))
        })?;

        let rows = stmt
            .query_map(params![session_id], delegation_record_row_from_sql)
            .map_err(|e| CoreError::Internal(format!("Failed to list delegations: {}", e)))?;

        let mut delegations = Vec::new();
        for row in rows {
            delegations.push(row.map_err(|e| {
                CoreError::Internal(format!("Failed to read delegation row: {}", e))
            })?);
        }

        Ok(delegations)
    }

    /// Replaces an existing delegation record.
    pub fn update_delegation(&self, row: &DelegationRecordRow) -> CoreResult<()> {
        let affected = self
            .conn
            .execute(
                r#"UPDATE ai_delegations
                      SET parent_session_id = ?2,
                          child_session_id = ?3,
                          parent_run_id = ?4,
                          agent_profile_id = ?5,
                          delegated_goal = ?6,
                          context_packet_json = ?7,
                          allowed_tools_delta_json = ?8,
                          permission_snapshot_json = ?9,
                          status = ?10,
                          merge_status = ?11,
                          summary_message_id = ?12,
                          result_json = ?13,
                          error_message = ?14,
                          created_at = ?15,
                          updated_at = ?16,
                          completed_at = ?17
                    WHERE id = ?1"#,
                params![
                    &row.id,
                    &row.parent_session_id,
                    &row.child_session_id,
                    &row.parent_run_id,
                    &row.agent_profile_id,
                    &row.delegated_goal,
                    &row.context_packet_json,
                    &row.allowed_tools_delta_json,
                    &row.permission_snapshot_json,
                    &row.status,
                    &row.merge_status,
                    &row.summary_message_id,
                    &row.result_json,
                    &row.error_message,
                    row.created_at,
                    row.updated_at,
                    row.completed_at,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update delegation: {}", e)))?;

        if affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Delegation not found: {}",
                row.id
            )));
        }

        Ok(())
    }

    /// Lists permission decisions for a session, newest first.
    pub fn list_permission_decisions_for_session(
        &self,
        session_id: &str,
    ) -> CoreResult<Vec<PermissionDecisionRow>> {
        let sql = format!(
            "SELECT {PERMISSION_DECISION_SELECT_COLUMNS} FROM ai_permission_decisions \
             WHERE session_id = ?1 ORDER BY created_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| {
            CoreError::Internal(format!(
                "Failed to prepare list permission decisions: {}",
                e
            ))
        })?;

        let rows = stmt
            .query_map(params![session_id], permission_decision_row_from_sql)
            .map_err(|e| {
                CoreError::Internal(format!("Failed to list permission decisions: {}", e))
            })?;

        let mut decisions = Vec::new();
        for row in rows {
            decisions.push(row.map_err(|e| {
                CoreError::Internal(format!("Failed to read permission decision row: {}", e))
            })?);
        }

        Ok(decisions)
    }

    /// Inserts a permission decision and synchronizes session version state.
    pub fn insert_permission_decision_and_update_session(
        &self,
        session: &SessionRow,
        decision: &PermissionDecisionRow,
    ) -> CoreResult<()> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| CoreError::Internal(format!("Failed to begin transaction: {}", e)))?;

        tx.execute(
            r#"INSERT INTO ai_permission_decisions
                (id, session_id, run_id, step_id, subject_type, subject, action, source, reason, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
            params![
                &decision.id,
                &decision.session_id,
                &decision.run_id,
                &decision.step_id,
                &decision.subject_type,
                &decision.subject,
                &decision.action,
                &decision.source,
                &decision.reason,
                decision.created_at,
            ],
        )
        .map_err(|e| {
            CoreError::Internal(format!("Failed to insert permission decision: {}", e))
        })?;

        let session_affected = tx
            .execute(
                r#"UPDATE ai_sessions
                      SET project_id = ?2,
                          title = ?3,
                          agent = ?4,
                          model_provider = ?5,
                          model_id = ?6,
                          runtime_kind = ?7,
                          session_mode = ?8,
                          status = ?9,
                          parent_session_id = ?10,
                          branch_from_session_id = ?11,
                          root_session_id = ?12,
                          sequence_id = ?13,
                          current_run_id = ?14,
                          current_plan_id = ?15,
                          pending_approval_id = ?16,
                          active_checkpoint_id = ?17,
                          permission_state_version = ?18,
                          compaction_version = ?19,
                          resume_cursor_version = ?20,
                          last_compacted_at = ?21,
                          last_resumed_at = ?22,
                          created_at = ?23,
                          updated_at = ?24,
                          completed_at = ?25,
                          archived = ?26,
                          summary_message_id = ?27
                    WHERE id = ?1"#,
                params![
                    &session.id,
                    &session.project_id,
                    &session.title,
                    &session.agent,
                    &session.model_provider,
                    &session.model_id,
                    &session.runtime_kind,
                    &session.session_mode,
                    &session.status,
                    &session.parent_session_id,
                    &session.branch_from_session_id,
                    &session.root_session_id,
                    &session.sequence_id,
                    &session.current_run_id,
                    &session.current_plan_id,
                    &session.pending_approval_id,
                    &session.active_checkpoint_id,
                    session.permission_state_version,
                    session.compaction_version,
                    session.resume_cursor_version,
                    session.last_compacted_at,
                    session.last_resumed_at,
                    session.created_at,
                    session.updated_at,
                    session.completed_at,
                    session.archived as i32,
                    &session.summary_message_id,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update session: {}", e)))?;

        if session_affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                session.id
            )));
        }

        tx.commit()
            .map_err(|e| CoreError::Internal(format!("Failed to commit transaction: {}", e)))?;

        Ok(())
    }

    /// Lists compaction records for a session, newest first.
    pub fn list_compactions_for_session(
        &self,
        session_id: &str,
    ) -> CoreResult<Vec<CompactionRecordRow>> {
        let sql = format!(
            "SELECT {COMPACTION_SELECT_COLUMNS} FROM ai_compactions \
             WHERE session_id = ?1 ORDER BY created_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| {
            CoreError::Internal(format!("Failed to prepare list compactions: {}", e))
        })?;

        let rows = stmt
            .query_map(params![session_id], compaction_record_row_from_sql)
            .map_err(|e| CoreError::Internal(format!("Failed to list compactions: {}", e)))?;

        let mut compactions = Vec::new();
        for row in rows {
            compactions.push(row.map_err(|e| {
                CoreError::Internal(format!("Failed to read compaction row: {}", e))
            })?);
        }

        Ok(compactions)
    }

    /// Inserts a compaction record and synchronizes session compaction metadata.
    pub fn insert_compaction_and_update_session(
        &self,
        session: &SessionRow,
        compaction: &CompactionRecordRow,
    ) -> CoreResult<()> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| CoreError::Internal(format!("Failed to begin transaction: {}", e)))?;

        tx.execute(
            r#"INSERT INTO ai_compactions
                (id, session_id, run_id, tier, trigger, summary_message_id,
                 source_message_count, retained_message_count, estimated_tokens_saved,
                 continuation_summary_json, state_rehydration_json, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"#,
            params![
                &compaction.id,
                &compaction.session_id,
                &compaction.run_id,
                &compaction.tier,
                &compaction.trigger,
                &compaction.summary_message_id,
                compaction.source_message_count,
                compaction.retained_message_count,
                compaction.estimated_tokens_saved,
                &compaction.continuation_summary_json,
                &compaction.state_rehydration_json,
                compaction.created_at,
            ],
        )
        .map_err(|e| CoreError::Internal(format!("Failed to insert compaction: {}", e)))?;

        let session_affected = tx
            .execute(
                r#"UPDATE ai_sessions
                      SET project_id = ?2,
                          title = ?3,
                          agent = ?4,
                          model_provider = ?5,
                          model_id = ?6,
                          runtime_kind = ?7,
                          session_mode = ?8,
                          status = ?9,
                          parent_session_id = ?10,
                          branch_from_session_id = ?11,
                          root_session_id = ?12,
                          sequence_id = ?13,
                          current_run_id = ?14,
                          current_plan_id = ?15,
                          pending_approval_id = ?16,
                          active_checkpoint_id = ?17,
                          permission_state_version = ?18,
                          compaction_version = ?19,
                          resume_cursor_version = ?20,
                          last_compacted_at = ?21,
                          last_resumed_at = ?22,
                          created_at = ?23,
                          updated_at = ?24,
                          completed_at = ?25,
                          archived = ?26,
                          summary_message_id = ?27
                    WHERE id = ?1"#,
                params![
                    &session.id,
                    &session.project_id,
                    &session.title,
                    &session.agent,
                    &session.model_provider,
                    &session.model_id,
                    &session.runtime_kind,
                    &session.session_mode,
                    &session.status,
                    &session.parent_session_id,
                    &session.branch_from_session_id,
                    &session.root_session_id,
                    &session.sequence_id,
                    &session.current_run_id,
                    &session.current_plan_id,
                    &session.pending_approval_id,
                    &session.active_checkpoint_id,
                    session.permission_state_version,
                    session.compaction_version,
                    session.resume_cursor_version,
                    session.last_compacted_at,
                    session.last_resumed_at,
                    session.created_at,
                    session.updated_at,
                    session.completed_at,
                    session.archived as i32,
                    &session.summary_message_id,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update session: {}", e)))?;

        if session_affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                session.id
            )));
        }

        tx.commit()
            .map_err(|e| CoreError::Internal(format!("Failed to commit transaction: {}", e)))?;

        Ok(())
    }

    /// Lists resume checkpoints for a session, newest first.
    pub fn list_resume_checkpoints_for_session(
        &self,
        session_id: &str,
    ) -> CoreResult<Vec<ResumeCheckpointRow>> {
        let sql = format!(
            "SELECT {RESUME_CHECKPOINT_SELECT_COLUMNS} FROM ai_resume_checkpoints \
             WHERE session_id = ?1 ORDER BY created_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| {
            CoreError::Internal(format!("Failed to prepare list resume checkpoints: {}", e))
        })?;

        let rows = stmt
            .query_map(params![session_id], resume_checkpoint_row_from_sql)
            .map_err(|e| {
                CoreError::Internal(format!("Failed to list resume checkpoints: {}", e))
            })?;

        let mut checkpoints = Vec::new();
        for row in rows {
            checkpoints.push(row.map_err(|e| {
                CoreError::Internal(format!("Failed to read resume checkpoint row: {}", e))
            })?);
        }

        Ok(checkpoints)
    }

    /// Retrieves a resume checkpoint by id.
    pub fn get_resume_checkpoint(&self, checkpoint_id: &str) -> CoreResult<ResumeCheckpointRow> {
        let sql = format!(
            "SELECT {RESUME_CHECKPOINT_SELECT_COLUMNS} FROM ai_resume_checkpoints WHERE id = ?1"
        );
        self.conn
            .query_row(&sql, params![checkpoint_id], resume_checkpoint_row_from_sql)
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    CoreError::NotFound(format!("Resume checkpoint not found: {}", checkpoint_id))
                }
                other => CoreError::Internal(format!("Failed to get resume checkpoint: {}", other)),
            })
    }

    /// Inserts a resume checkpoint and synchronizes session resume state.
    pub fn insert_resume_checkpoint_and_update_session(
        &self,
        session: &SessionRow,
        checkpoint: &ResumeCheckpointRow,
    ) -> CoreResult<()> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| CoreError::Internal(format!("Failed to begin transaction: {}", e)))?;

        tx.execute(
            r#"INSERT INTO ai_resume_checkpoints
                (id, session_id, run_id, checkpoint_kind, status, resume_cursor_json,
                 session_state_json, pending_work_json, created_at, consumed_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
            params![
                &checkpoint.id,
                &checkpoint.session_id,
                &checkpoint.run_id,
                &checkpoint.checkpoint_kind,
                &checkpoint.status,
                &checkpoint.resume_cursor_json,
                &checkpoint.session_state_json,
                &checkpoint.pending_work_json,
                checkpoint.created_at,
                checkpoint.consumed_at,
            ],
        )
        .map_err(|e| CoreError::Internal(format!("Failed to insert resume checkpoint: {}", e)))?;

        let session_affected = tx
            .execute(
                r#"UPDATE ai_sessions
                      SET project_id = ?2,
                          title = ?3,
                          agent = ?4,
                          model_provider = ?5,
                          model_id = ?6,
                          runtime_kind = ?7,
                          session_mode = ?8,
                          status = ?9,
                          parent_session_id = ?10,
                          branch_from_session_id = ?11,
                          root_session_id = ?12,
                          sequence_id = ?13,
                          current_run_id = ?14,
                          current_plan_id = ?15,
                          pending_approval_id = ?16,
                          active_checkpoint_id = ?17,
                          permission_state_version = ?18,
                          compaction_version = ?19,
                          resume_cursor_version = ?20,
                          last_compacted_at = ?21,
                          last_resumed_at = ?22,
                          created_at = ?23,
                          updated_at = ?24,
                          completed_at = ?25,
                          archived = ?26,
                          summary_message_id = ?27
                    WHERE id = ?1"#,
                params![
                    &session.id,
                    &session.project_id,
                    &session.title,
                    &session.agent,
                    &session.model_provider,
                    &session.model_id,
                    &session.runtime_kind,
                    &session.session_mode,
                    &session.status,
                    &session.parent_session_id,
                    &session.branch_from_session_id,
                    &session.root_session_id,
                    &session.sequence_id,
                    &session.current_run_id,
                    &session.current_plan_id,
                    &session.pending_approval_id,
                    &session.active_checkpoint_id,
                    session.permission_state_version,
                    session.compaction_version,
                    session.resume_cursor_version,
                    session.last_compacted_at,
                    session.last_resumed_at,
                    session.created_at,
                    session.updated_at,
                    session.completed_at,
                    session.archived as i32,
                    &session.summary_message_id,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update session: {}", e)))?;

        if session_affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                session.id
            )));
        }

        tx.commit()
            .map_err(|e| CoreError::Internal(format!("Failed to commit transaction: {}", e)))?;

        Ok(())
    }

    /// Updates a resume checkpoint row and synchronizes session resume state.
    pub fn update_resume_checkpoint_and_update_session(
        &self,
        session: &SessionRow,
        checkpoint: &ResumeCheckpointRow,
    ) -> CoreResult<()> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| CoreError::Internal(format!("Failed to begin transaction: {}", e)))?;

        let checkpoint_affected = tx
            .execute(
                r#"UPDATE ai_resume_checkpoints
                      SET session_id = ?2,
                          run_id = ?3,
                          checkpoint_kind = ?4,
                          status = ?5,
                          resume_cursor_json = ?6,
                          session_state_json = ?7,
                          pending_work_json = ?8,
                          created_at = ?9,
                          consumed_at = ?10
                    WHERE id = ?1"#,
                params![
                    &checkpoint.id,
                    &checkpoint.session_id,
                    &checkpoint.run_id,
                    &checkpoint.checkpoint_kind,
                    &checkpoint.status,
                    &checkpoint.resume_cursor_json,
                    &checkpoint.session_state_json,
                    &checkpoint.pending_work_json,
                    checkpoint.created_at,
                    checkpoint.consumed_at,
                ],
            )
            .map_err(|e| {
                CoreError::Internal(format!("Failed to update resume checkpoint: {}", e))
            })?;

        if checkpoint_affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Resume checkpoint not found: {}",
                checkpoint.id
            )));
        }

        let session_affected = tx
            .execute(
                r#"UPDATE ai_sessions
                      SET project_id = ?2,
                          title = ?3,
                          agent = ?4,
                          model_provider = ?5,
                          model_id = ?6,
                          runtime_kind = ?7,
                          session_mode = ?8,
                          status = ?9,
                          parent_session_id = ?10,
                          branch_from_session_id = ?11,
                          root_session_id = ?12,
                          sequence_id = ?13,
                          current_run_id = ?14,
                          current_plan_id = ?15,
                          pending_approval_id = ?16,
                          active_checkpoint_id = ?17,
                          permission_state_version = ?18,
                          compaction_version = ?19,
                          resume_cursor_version = ?20,
                          last_compacted_at = ?21,
                          last_resumed_at = ?22,
                          created_at = ?23,
                          updated_at = ?24,
                          completed_at = ?25,
                          archived = ?26,
                          summary_message_id = ?27
                    WHERE id = ?1"#,
                params![
                    &session.id,
                    &session.project_id,
                    &session.title,
                    &session.agent,
                    &session.model_provider,
                    &session.model_id,
                    &session.runtime_kind,
                    &session.session_mode,
                    &session.status,
                    &session.parent_session_id,
                    &session.branch_from_session_id,
                    &session.root_session_id,
                    &session.sequence_id,
                    &session.current_run_id,
                    &session.current_plan_id,
                    &session.pending_approval_id,
                    &session.active_checkpoint_id,
                    session.permission_state_version,
                    session.compaction_version,
                    session.resume_cursor_version,
                    session.last_compacted_at,
                    session.last_resumed_at,
                    session.created_at,
                    session.updated_at,
                    session.completed_at,
                    session.archived as i32,
                    &session.summary_message_id,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to update session: {}", e)))?;

        if session_affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Session not found: {}",
                session.id
            )));
        }

        tx.commit()
            .map_err(|e| CoreError::Internal(format!("Failed to commit transaction: {}", e)))?;

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
        assert_eq!(s.runtime_kind, "tpao");
        assert_eq!(s.session_mode, "primary");
        assert_eq!(s.status, "idle");
        assert!(s.parent_session_id.is_none());
        assert!(s.branch_from_session_id.is_none());
        assert_eq!(s.root_session_id, "s1");
        assert!(s.sequence_id.is_none());
        assert!(s.current_run_id.is_none());
        assert!(s.current_plan_id.is_none());
        assert!(s.pending_approval_id.is_none());
        assert!(s.active_checkpoint_id.is_none());
        assert_eq!(s.permission_state_version, 0);
        assert_eq!(s.compaction_version, 0);
        assert_eq!(s.resume_cursor_version, 0);
        assert!(s.last_compacted_at.is_none());
        assert!(s.last_resumed_at.is_none());
        assert!(!s.archived);
        assert!(s.summary_message_id.is_none());
        assert!(s.created_at > 0);
        assert_eq!(s.created_at, s.updated_at);
        assert!(s.completed_at.is_none());
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
    fn test_open_existing_database_backfills_agent_session_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy-conversation.db");

        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys=ON;

            CREATE TABLE ai_sessions (
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

            CREATE TABLE ai_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
                timestamp INTEGER NOT NULL,
                usage_json TEXT,
                finish_reason TEXT,
                FOREIGN KEY(session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE ai_parts (
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
            "#,
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO ai_sessions
                (id, project_id, title, agent, model_provider, model_id, created_at, updated_at, archived, summary_message_id)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
            params![
                "legacy-session",
                "proj-legacy",
                "Legacy Chat",
                "editor",
                "openai",
                "gpt-4o",
                100_i64,
                100_i64,
                0_i32,
                Option::<String>::None,
            ],
        )
        .unwrap();
        drop(conn);

        let db = ConversationDb::open(&path).unwrap();
        let session = db.get_session("legacy-session").unwrap();

        assert_eq!(session.runtime_kind, "tpao");
        assert_eq!(session.session_mode, "primary");
        assert_eq!(session.status, "idle");
        assert_eq!(session.root_session_id, "legacy-session");
        assert_eq!(session.permission_state_version, 0);
        assert_eq!(session.compaction_version, 0);
        assert_eq!(session.resume_cursor_version, 0);
    }

    #[test]
    fn test_start_run_and_complete_run_syncs_session_state() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", Some("openai"), Some("gpt-4o"))
            .unwrap();

        let run = AgentRunRow {
            id: "run-1".to_string(),
            session_id: "s1".to_string(),
            runtime_kind: "tpao".to_string(),
            trigger: "user".to_string(),
            phase: "initializing".to_string(),
            iteration: 0,
            max_iterations: 20,
            tool_calls_used: 0,
            max_tool_calls: 50,
            planned_step_count: 2,
            completed_step_count: 0,
            input_message_id: Some("m-user".to_string()),
            output_message_id: None,
            trace_id: Some("trace-1".to_string()),
            rollback_report_json: None,
            error_code: None,
            error_message: None,
            started_at: 1_000,
            updated_at: 1_000,
            ended_at: None,
        };

        db.start_run(&run, "running").unwrap();

        let mut session = db.get_session("s1").unwrap();
        let mut persisted_run = db.get_run("run-1").unwrap();

        assert_eq!(session.current_run_id.as_deref(), Some("run-1"));
        assert_eq!(session.status, "running");
        assert_eq!(session.runtime_kind, "tpao");
        assert_eq!(persisted_run.phase, "initializing");

        persisted_run.phase = "completed".to_string();
        persisted_run.completed_step_count = 2;
        persisted_run.output_message_id = Some("m-assistant".to_string());
        persisted_run.updated_at = 2_000;
        persisted_run.ended_at = Some(2_000);

        session.current_run_id = None;
        session.status = "completed".to_string();
        session.updated_at = 2_000;
        session.completed_at = Some(2_000);

        db.update_session_and_run(&session, &persisted_run).unwrap();

        let session = db.get_session("s1").unwrap();
        let persisted_run = db.get_run("run-1").unwrap();

        assert!(session.current_run_id.is_none());
        assert_eq!(session.status, "completed");
        assert_eq!(session.completed_at, Some(2_000));
        assert_eq!(persisted_run.phase, "completed");
        assert_eq!(persisted_run.completed_step_count, 2);
        assert_eq!(
            persisted_run.output_message_id.as_deref(),
            Some("m-assistant")
        );
        assert_eq!(persisted_run.ended_at, Some(2_000));
    }

    #[test]
    fn test_insert_and_update_delegation_record() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("parent", "proj-1", "editor", None, None)
            .unwrap();
        db.create_session("child", "proj-1", "planner", None, None)
            .unwrap();

        let run = AgentRunRow {
            id: "run-parent".to_string(),
            session_id: "parent".to_string(),
            runtime_kind: "tpao".to_string(),
            trigger: "user".to_string(),
            phase: "executing".to_string(),
            iteration: 0,
            max_iterations: 20,
            tool_calls_used: 0,
            max_tool_calls: 50,
            planned_step_count: 1,
            completed_step_count: 0,
            input_message_id: None,
            output_message_id: None,
            trace_id: None,
            rollback_report_json: None,
            error_code: None,
            error_message: None,
            started_at: 100,
            updated_at: 100,
            ended_at: None,
        };
        db.start_run(&run, "running").unwrap();

        let mut delegation = DelegationRecordRow {
            id: "delegation-1".to_string(),
            parent_session_id: "parent".to_string(),
            child_session_id: "child".to_string(),
            parent_run_id: "run-parent".to_string(),
            agent_profile_id: "planner".to_string(),
            delegated_goal: "Analyze the sequence".to_string(),
            context_packet_json: r#"{"goal":"Analyze the sequence"}"#.to_string(),
            allowed_tools_delta_json: None,
            permission_snapshot_json: Some(r#"{"scope":"narrow"}"#.to_string()),
            status: "requested".to_string(),
            merge_status: "pending".to_string(),
            summary_message_id: None,
            result_json: None,
            error_message: None,
            created_at: 100,
            updated_at: 100,
            completed_at: None,
        };

        db.insert_delegation(&delegation).unwrap();

        let parent_rows = db.list_delegations_for_session("parent").unwrap();
        let child_rows = db.list_delegations_for_session("child").unwrap();
        assert_eq!(parent_rows.len(), 1);
        assert_eq!(child_rows.len(), 1);

        delegation.status = "completed".to_string();
        delegation.merge_status = "merged".to_string();
        delegation.summary_message_id = Some("summary-1".to_string());
        delegation.result_json = Some(r#"{"ok":true}"#.to_string());
        delegation.updated_at = 200;
        delegation.completed_at = Some(200);

        db.update_delegation(&delegation).unwrap();

        let updated = db.get_delegation("delegation-1").unwrap();
        assert_eq!(updated.status, "completed");
        assert_eq!(updated.merge_status, "merged");
        assert_eq!(updated.summary_message_id.as_deref(), Some("summary-1"));
        assert_eq!(updated.result_json.as_deref(), Some(r#"{"ok":true}"#));
        assert_eq!(updated.completed_at, Some(200));
    }

    #[test]
    fn test_insert_permission_decision_updates_session_version() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        let mut session = db.get_session("s1").unwrap();
        session.permission_state_version += 1;
        session.updated_at = 1234;

        let decision = PermissionDecisionRow {
            id: "decision-1".to_string(),
            session_id: "s1".to_string(),
            run_id: None,
            step_id: Some("step-1".to_string()),
            subject_type: "tool".to_string(),
            subject: "timeline.clip.delete".to_string(),
            action: "ask".to_string(),
            source: "interactive_approval".to_string(),
            reason: Some("Destructive operation".to_string()),
            created_at: 1234,
        };

        db.insert_permission_decision_and_update_session(&session, &decision)
            .unwrap();

        let decisions = db.list_permission_decisions_for_session("s1").unwrap();
        let session = db.get_session("s1").unwrap();
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].subject, "timeline.clip.delete");
        assert_eq!(session.permission_state_version, 1);
        assert_eq!(session.updated_at, 1234);
    }

    #[test]
    fn test_insert_compaction_updates_session_metadata() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();
        db.save_message("summary-message", "s1", "system", 1500, None, None)
            .unwrap();

        let mut session = db.get_session("s1").unwrap();
        session.compaction_version += 1;
        session.last_compacted_at = Some(2000);
        session.summary_message_id = Some("summary-message".to_string());
        session.updated_at = 2000;

        let compaction = CompactionRecordRow {
            id: "compaction-1".to_string(),
            session_id: "s1".to_string(),
            run_id: None,
            tier: "summary".to_string(),
            trigger: "auto".to_string(),
            summary_message_id: Some("summary-message".to_string()),
            source_message_count: 12,
            retained_message_count: 4,
            estimated_tokens_saved: Some(3000),
            continuation_summary_json: Some(r#"{"summary":"trimmed"}"#.to_string()),
            state_rehydration_json: Some(r#"{"resume":"cursor"}"#.to_string()),
            created_at: 2000,
        };

        db.insert_compaction_and_update_session(&session, &compaction)
            .unwrap();

        let rows = db.list_compactions_for_session("s1").unwrap();
        let session = db.get_session("s1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tier, "summary");
        assert_eq!(session.compaction_version, 1);
        assert_eq!(session.last_compacted_at, Some(2000));
        assert_eq!(
            session.summary_message_id.as_deref(),
            Some("summary-message")
        );
    }

    #[test]
    fn test_resume_checkpoint_lifecycle_updates_session_metadata() {
        let db = ConversationDb::in_memory().unwrap();
        db.create_session("s1", "proj-1", "editor", None, None)
            .unwrap();

        let mut session = db.get_session("s1").unwrap();
        session.active_checkpoint_id = Some("checkpoint-1".to_string());
        session.resume_cursor_version += 1;
        session.updated_at = 3000;

        let mut checkpoint = ResumeCheckpointRow {
            id: "checkpoint-1".to_string(),
            session_id: "s1".to_string(),
            run_id: None,
            checkpoint_kind: "safe_resume_point".to_string(),
            status: "active".to_string(),
            resume_cursor_json: r#"{"cursor":1}"#.to_string(),
            session_state_json: r#"{"phase":"executing"}"#.to_string(),
            pending_work_json: Some(r#"{"step":"s1"}"#.to_string()),
            created_at: 3000,
            consumed_at: None,
        };

        db.insert_resume_checkpoint_and_update_session(&session, &checkpoint)
            .unwrap();

        let session = db.get_session("s1").unwrap();
        assert_eq!(
            session.active_checkpoint_id.as_deref(),
            Some("checkpoint-1")
        );
        assert_eq!(session.resume_cursor_version, 1);

        let mut resumed_session = session.clone();
        resumed_session.active_checkpoint_id = None;
        resumed_session.last_resumed_at = Some(4000);
        resumed_session.resume_cursor_version += 1;
        resumed_session.updated_at = 4000;

        checkpoint.status = "consumed".to_string();
        checkpoint.consumed_at = Some(4000);

        db.update_resume_checkpoint_and_update_session(&resumed_session, &checkpoint)
            .unwrap();

        let session = db.get_session("s1").unwrap();
        let checkpoints = db.list_resume_checkpoints_for_session("s1").unwrap();
        assert!(session.active_checkpoint_id.is_none());
        assert_eq!(session.last_resumed_at, Some(4000));
        assert_eq!(session.resume_cursor_version, 2);
        assert_eq!(checkpoints[0].status, "consumed");
        assert_eq!(checkpoints[0].consumed_at, Some(4000));
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

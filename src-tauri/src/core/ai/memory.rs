//! Agent Memory Database
//!
//! SQLite-backed persistent storage for agent memory entries.
//! Supports categorized key-value storage with optional TTL expiration.

use rusqlite::{params, Connection};
use std::path::Path;

use crate::core::{CoreError, CoreResult};

// =============================================================================
// Types
// =============================================================================

/// A single agent memory entry.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub project_id: String,
    pub category: String,
    pub key: String,
    pub value: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<i64>,
}

// =============================================================================
// Database
// =============================================================================

/// SQLite-backed agent memory storage.
pub struct AgentMemoryDb {
    conn: Connection,
}

impl AgentMemoryDb {
    /// Create or open a database at the given path.
    pub fn create<P: AsRef<Path>>(path: P) -> CoreResult<Self> {
        let conn = Connection::open(path).map_err(|e| {
            CoreError::Internal(format!("Failed to open agent memory database: {}", e))
        })?;
        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Create an in-memory database (for testing).
    pub fn in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory().map_err(|e| {
            CoreError::Internal(format!("Failed to create in-memory database: {}", e))
        })?;
        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> CoreResult<()> {
        self.conn
            .execute_batch(
                r#"
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;

                CREATE TABLE IF NOT EXISTS agent_memory (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    category TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    ttl_seconds INTEGER
                );

                CREATE INDEX IF NOT EXISTS idx_agent_memory_project_category
                    ON agent_memory(project_id, category);
                CREATE INDEX IF NOT EXISTS idx_agent_memory_key
                    ON agent_memory(project_id, key);
                "#,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to initialize schema: {}", e)))?;
        Ok(())
    }

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    /// Save (upsert) a memory entry. If an entry with the same project_id,
    /// category, and key exists, it is replaced.
    pub fn save(
        &self,
        id: &str,
        project_id: &str,
        category: &str,
        key: &str,
        value: &str,
        ttl_seconds: Option<i64>,
    ) -> CoreResult<()> {
        let now = now_millis();
        self.conn
            .execute(
                r#"INSERT INTO agent_memory
                    (id, project_id, category, key, value, created_at, updated_at, ttl_seconds)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                   ON CONFLICT(id) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at,
                    ttl_seconds = excluded.ttl_seconds"#,
                params![id, project_id, category, key, value, now, now, ttl_seconds],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to save memory entry: {}", e)))?;
        Ok(())
    }

    /// Get entries by project ID and category, excluding expired TTL entries.
    pub fn get_by_category(
        &self,
        project_id: &str,
        category: &str,
    ) -> CoreResult<Vec<MemoryEntry>> {
        let now = now_millis();
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT id, project_id, category, key, value, created_at, updated_at, ttl_seconds
                   FROM agent_memory
                   WHERE project_id = ?1 AND category = ?2
                     AND (ttl_seconds IS NULL OR (updated_at + ttl_seconds * 1000) > ?3)
                   ORDER BY updated_at DESC"#,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to prepare query: {}", e)))?;

        let rows = stmt
            .query_map(params![project_id, category, now], |row| {
                Ok(MemoryEntry {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    category: row.get(2)?,
                    key: row.get(3)?,
                    value: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    ttl_seconds: row.get(7)?,
                })
            })
            .map_err(|e| CoreError::Internal(format!("Failed to query entries: {}", e)))?;

        let mut entries = Vec::new();
        for row in rows {
            entries
                .push(row.map_err(|e| CoreError::Internal(format!("Failed to read row: {}", e)))?);
        }
        Ok(entries)
    }

    /// Delete a single entry by ID.
    pub fn delete(&self, id: &str) -> CoreResult<()> {
        let affected = self
            .conn
            .execute("DELETE FROM agent_memory WHERE id = ?1", params![id])
            .map_err(|e| CoreError::Internal(format!("Failed to delete entry: {}", e)))?;

        if affected == 0 {
            return Err(CoreError::NotFound(format!(
                "Memory entry not found: {}",
                id
            )));
        }
        Ok(())
    }

    /// Clear all entries for a project, optionally filtered by category.
    pub fn clear(&self, project_id: &str, category: Option<&str>) -> CoreResult<usize> {
        let affected = if let Some(cat) = category {
            self.conn
                .execute(
                    "DELETE FROM agent_memory WHERE project_id = ?1 AND category = ?2",
                    params![project_id, cat],
                )
                .map_err(|e| CoreError::Internal(format!("Failed to clear entries: {}", e)))?
        } else {
            self.conn
                .execute(
                    "DELETE FROM agent_memory WHERE project_id = ?1",
                    params![project_id],
                )
                .map_err(|e| CoreError::Internal(format!("Failed to clear entries: {}", e)))?
        };
        Ok(affected)
    }
}

// =============================================================================
// Helpers
// =============================================================================

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

    #[test]
    fn save_and_get_by_category() {
        let db = AgentMemoryDb::in_memory().unwrap();
        db.save("m1", "proj-1", "operation", "last_op", "split_clip", None)
            .unwrap();
        db.save("m2", "proj-1", "operation", "prev_op", "trim_clip", None)
            .unwrap();
        db.save("m3", "proj-1", "preference", "theme", "dark", None)
            .unwrap();

        let ops = db.get_by_category("proj-1", "operation").unwrap();
        assert_eq!(ops.len(), 2);
        assert!(ops.iter().any(|e| e.key == "last_op"));
        assert!(ops.iter().any(|e| e.key == "prev_op"));

        let prefs = db.get_by_category("proj-1", "preference").unwrap();
        assert_eq!(prefs.len(), 1);
        assert_eq!(prefs[0].value, "dark");
    }

    #[test]
    fn upsert_replaces_value() {
        let db = AgentMemoryDb::in_memory().unwrap();
        db.save("m1", "proj-1", "operation", "key", "v1", None)
            .unwrap();
        db.save("m1", "proj-1", "operation", "key", "v2", None)
            .unwrap();

        let entries = db.get_by_category("proj-1", "operation").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].value, "v2");
    }

    #[test]
    fn ttl_filter_excludes_expired() {
        let db = AgentMemoryDb::in_memory().unwrap();
        // Insert with very short TTL
        let past = now_millis() - 10_000; // 10 seconds ago
        db.conn
            .execute(
                r#"INSERT INTO agent_memory
                    (id, project_id, category, key, value, created_at, updated_at, ttl_seconds)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
                params![
                    "m1",
                    "proj-1",
                    "operation",
                    "old",
                    "expired",
                    past,
                    past,
                    5i64
                ],
            )
            .unwrap();

        // Insert without TTL (never expires)
        db.save("m2", "proj-1", "operation", "new", "fresh", None)
            .unwrap();

        let entries = db.get_by_category("proj-1", "operation").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "new");
    }

    #[test]
    fn delete_entry() {
        let db = AgentMemoryDb::in_memory().unwrap();
        db.save("m1", "proj-1", "operation", "key", "val", None)
            .unwrap();

        db.delete("m1").unwrap();

        let entries = db.get_by_category("proj-1", "operation").unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn delete_not_found() {
        let db = AgentMemoryDb::in_memory().unwrap();
        let err = db.delete("nonexistent").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)));
    }

    #[test]
    fn clear_by_category() {
        let db = AgentMemoryDb::in_memory().unwrap();
        db.save("m1", "proj-1", "operation", "k1", "v1", None)
            .unwrap();
        db.save("m2", "proj-1", "preference", "k2", "v2", None)
            .unwrap();

        let cleared = db.clear("proj-1", Some("operation")).unwrap();
        assert_eq!(cleared, 1);

        let ops = db.get_by_category("proj-1", "operation").unwrap();
        assert!(ops.is_empty());

        let prefs = db.get_by_category("proj-1", "preference").unwrap();
        assert_eq!(prefs.len(), 1);
    }

    #[test]
    fn clear_all_for_project() {
        let db = AgentMemoryDb::in_memory().unwrap();
        db.save("m1", "proj-1", "operation", "k1", "v1", None)
            .unwrap();
        db.save("m2", "proj-1", "preference", "k2", "v2", None)
            .unwrap();
        db.save("m3", "proj-2", "operation", "k3", "v3", None)
            .unwrap();

        let cleared = db.clear("proj-1", None).unwrap();
        assert_eq!(cleared, 2);

        // proj-2 untouched
        let entries = db.get_by_category("proj-2", "operation").unwrap();
        assert_eq!(entries.len(), 1);
    }
}

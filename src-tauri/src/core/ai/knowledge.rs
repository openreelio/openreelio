//! Knowledge Base Persistence Module
//!
//! SQLite-based storage for cross-session AI knowledge entries.
//! Stores learned conventions, user preferences, corrections, and patterns
//! that enable the AI to improve over time per project.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::core::{CoreError, CoreResult};

// =============================================================================
// Row Types
// =============================================================================

/// A single knowledge entry learned from AI interactions.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRow {
    pub id: String,
    pub project_id: String,
    pub category: String,
    pub content: String,
    pub source_session_id: Option<String>,
    pub created_at: i64,
    pub relevance_score: f64,
}

// =============================================================================
// Knowledge Database
// =============================================================================

/// SQLite-backed store for AI knowledge entries.
///
/// Each entry belongs to a project and has a category (convention, preference,
/// correction, pattern) and a relevance score for ranking.
pub struct KnowledgeDb {
    conn: Connection,
}

impl KnowledgeDb {
    /// Creates a new knowledge database at the given file path.
    pub fn create<P: AsRef<Path>>(path: P) -> CoreResult<Self> {
        let conn = Connection::open(path).map_err(|e| {
            CoreError::Internal(format!("Failed to create knowledge database: {}", e))
        })?;

        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Opens an existing knowledge database.
    pub fn open<P: AsRef<Path>>(path: P) -> CoreResult<Self> {
        let conn = Connection::open(path).map_err(|e| {
            CoreError::Internal(format!("Failed to open knowledge database: {}", e))
        })?;

        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Creates an in-memory database (primarily for testing).
    pub fn in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory().map_err(|e| {
            CoreError::Internal(format!(
                "Failed to create in-memory knowledge database: {}",
                e
            ))
        })?;

        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Applies the schema.
    fn init_schema(&self) -> CoreResult<()> {
        self.conn
            .execute_batch(
                r#"
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;

                CREATE TABLE IF NOT EXISTS ai_knowledge (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    category TEXT NOT NULL CHECK(category IN ('convention','preference','correction','pattern')),
                    content TEXT NOT NULL,
                    source_session_id TEXT,
                    created_at INTEGER NOT NULL,
                    relevance_score REAL NOT NULL DEFAULT 0.5
                );

                CREATE INDEX IF NOT EXISTS idx_ai_knowledge_project
                    ON ai_knowledge(project_id, relevance_score DESC);
                CREATE INDEX IF NOT EXISTS idx_ai_knowledge_category
                    ON ai_knowledge(project_id, category);
                "#,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to initialize knowledge schema: {}", e)))?;

        Ok(())
    }

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    /// Saves a new knowledge entry.
    pub fn save_entry(
        &self,
        id: &str,
        project_id: &str,
        category: &str,
        content: &str,
        source_session_id: Option<&str>,
        relevance_score: f64,
    ) -> CoreResult<()> {
        let now = now_millis();
        self.conn
            .execute(
                r#"INSERT INTO ai_knowledge
                    (id, project_id, category, content, source_session_id, created_at, relevance_score)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
                params![id, project_id, category, content, source_session_id, now, relevance_score],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to save knowledge entry: {}", e)))?;

        Ok(())
    }

    /// Queries knowledge entries for a project, filtered by category and relevance.
    pub fn query_entries(
        &self,
        project_id: &str,
        categories: Option<&[String]>,
        limit: usize,
        min_relevance: f64,
    ) -> CoreResult<Vec<KnowledgeRow>> {
        // Clamp limit to a safe maximum to prevent abuse
        let limit = limit.min(1000);

        // Build query dynamically based on category filter.
        // The LIMIT is passed as a bind parameter to avoid SQL interpolation.
        let (sql, bound_categories);
        if let Some(cats) = categories {
            // Category placeholders start at ?4 (after project_id, min_relevance, limit)
            let placeholders: Vec<String> = cats
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", i + 4))
                .collect();
            sql = format!(
                r#"SELECT id, project_id, category, content, source_session_id, created_at, relevance_score
                   FROM ai_knowledge
                   WHERE project_id = ?1 AND relevance_score >= ?2 AND category IN ({})
                   ORDER BY relevance_score DESC, created_at DESC
                   LIMIT ?3"#,
                placeholders.join(", "),
            );
            bound_categories = Some(cats.to_vec());
        } else {
            sql = r#"SELECT id, project_id, category, content, source_session_id, created_at, relevance_score
                   FROM ai_knowledge
                   WHERE project_id = ?1 AND relevance_score >= ?2
                   ORDER BY relevance_score DESC, created_at DESC
                   LIMIT ?3"#.to_string();
            bound_categories = None;
        }

        let mut stmt = self.conn.prepare(&sql).map_err(|e| {
            CoreError::Internal(format!("Failed to prepare knowledge query: {}", e))
        })?;

        let rows = if let Some(ref cats) = bound_categories {
            let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![
                Box::new(project_id.to_string()),
                Box::new(min_relevance),
                Box::new(limit as i64),
            ];
            for cat in cats {
                params_vec.push(Box::new(cat.clone()));
            }
            let params_refs: Vec<&dyn rusqlite::types::ToSql> =
                params_vec.iter().map(|p| p.as_ref()).collect();

            stmt.query_map(params_refs.as_slice(), map_knowledge_row)
                .map_err(|e| CoreError::Internal(format!("Failed to query knowledge: {}", e)))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| {
                    CoreError::Internal(format!("Failed to collect knowledge rows: {}", e))
                })?
        } else {
            stmt.query_map(
                params![project_id, min_relevance, limit as i64],
                map_knowledge_row,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to query knowledge: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| CoreError::Internal(format!("Failed to collect knowledge rows: {}", e)))?
        };

        Ok(rows)
    }

    /// Retrieves a single knowledge entry by its ID.
    pub fn get_entry_by_id(&self, entry_id: &str) -> CoreResult<Option<KnowledgeRow>> {
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT id, project_id, category, content, source_session_id, created_at, relevance_score
                   FROM ai_knowledge
                   WHERE id = ?1"#,
            )
            .map_err(|e| {
                CoreError::Internal(format!("Failed to prepare get_entry_by_id query: {}", e))
            })?;

        let mut rows = stmt
            .query_map(params![entry_id], map_knowledge_row)
            .map_err(|e| CoreError::Internal(format!("Failed to query knowledge entry: {}", e)))?;

        match rows.next() {
            Some(Ok(row)) => Ok(Some(row)),
            Some(Err(e)) => Err(CoreError::Internal(format!(
                "Failed to read knowledge entry: {}",
                e
            ))),
            None => Ok(None),
        }
    }

    /// Deletes a knowledge entry by ID.
    pub fn delete_entry(&self, entry_id: &str) -> CoreResult<()> {
        self.conn
            .execute("DELETE FROM ai_knowledge WHERE id = ?1", params![entry_id])
            .map_err(|e| CoreError::Internal(format!("Failed to delete knowledge entry: {}", e)))?;

        Ok(())
    }

    /// Lists all knowledge entries for a project.
    pub fn list_all(&self, project_id: &str, limit: usize) -> CoreResult<Vec<KnowledgeRow>> {
        self.query_entries(project_id, None, limit, 0.0)
    }
}

// =============================================================================
// Helpers
// =============================================================================

fn map_knowledge_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeRow> {
    Ok(KnowledgeRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        category: row.get(2)?,
        content: row.get(3)?,
        source_session_id: row.get(4)?,
        created_at: row.get(5)?,
        relevance_score: row.get(6)?,
    })
}

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
    fn test_create_and_query_entries() {
        let db = KnowledgeDb::in_memory().unwrap();

        db.save_entry("k1", "proj1", "preference", "Use warm tones", None, 0.8)
            .unwrap();
        db.save_entry(
            "k2",
            "proj1",
            "correction",
            "Prefer fade over cut",
            Some("s1"),
            1.0,
        )
        .unwrap();
        db.save_entry(
            "k3",
            "proj1",
            "pattern",
            "Always normalize audio",
            None,
            0.5,
        )
        .unwrap();

        let all = db.query_entries("proj1", None, 10, 0.0).unwrap();
        assert_eq!(all.len(), 3);
        // Should be ordered by relevance desc
        assert_eq!(all[0].id, "k2"); // 1.0
        assert_eq!(all[1].id, "k1"); // 0.8
        assert_eq!(all[2].id, "k3"); // 0.5
    }

    #[test]
    fn test_filter_by_category() {
        let db = KnowledgeDb::in_memory().unwrap();

        db.save_entry("k1", "proj1", "preference", "Warm tones", None, 0.8)
            .unwrap();
        db.save_entry("k2", "proj1", "correction", "Fade over cut", None, 1.0)
            .unwrap();

        let categories = vec!["correction".to_string()];
        let filtered = db
            .query_entries("proj1", Some(&categories), 10, 0.0)
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].category, "correction");
    }

    #[test]
    fn test_filter_by_relevance() {
        let db = KnowledgeDb::in_memory().unwrap();

        db.save_entry("k1", "proj1", "preference", "Low relevance", None, 0.2)
            .unwrap();
        db.save_entry("k2", "proj1", "preference", "High relevance", None, 0.9)
            .unwrap();

        let filtered = db.query_entries("proj1", None, 10, 0.5).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "k2");
    }

    #[test]
    fn test_delete_entry() {
        let db = KnowledgeDb::in_memory().unwrap();

        db.save_entry("k1", "proj1", "preference", "Something", None, 0.5)
            .unwrap();
        assert_eq!(db.list_all("proj1", 10).unwrap().len(), 1);

        db.delete_entry("k1").unwrap();
        assert_eq!(db.list_all("proj1", 10).unwrap().len(), 0);
    }

    #[test]
    fn test_project_isolation() {
        let db = KnowledgeDb::in_memory().unwrap();

        db.save_entry("k1", "proj1", "preference", "Proj1 pref", None, 0.8)
            .unwrap();
        db.save_entry("k2", "proj2", "preference", "Proj2 pref", None, 0.8)
            .unwrap();

        let proj1 = db.list_all("proj1", 10).unwrap();
        assert_eq!(proj1.len(), 1);
        assert_eq!(proj1[0].project_id, "proj1");
    }
}

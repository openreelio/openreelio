//! Index Database Module
//!
//! SQLite database for storing indexed media information.

use rusqlite::Connection;
use std::path::Path;

use crate::core::{CoreError, CoreResult};

// =============================================================================
// Index Database
// =============================================================================

/// SQLite database for media indexing
pub struct IndexDb {
    conn: Connection,
}

impl IndexDb {
    /// Creates a new index database at the specified path
    pub fn create<P: AsRef<Path>>(path: P) -> CoreResult<Self> {
        let conn = Connection::open(path)
            .map_err(|e| CoreError::Internal(format!("Failed to create index database: {}", e)))?;

        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Opens an existing index database
    pub fn open<P: AsRef<Path>>(path: P) -> CoreResult<Self> {
        let conn = Connection::open(path)
            .map_err(|e| CoreError::Internal(format!("Failed to open index database: {}", e)))?;

        Ok(Self { conn })
    }

    /// Creates an in-memory database (for testing)
    pub fn in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory().map_err(|e| {
            CoreError::Internal(format!("Failed to create in-memory database: {}", e))
        })?;

        let db = Self { conn };
        db.init_schema()?;
        Ok(db)
    }

    /// Initializes the database schema
    fn init_schema(&self) -> CoreResult<()> {
        self.conn
            .execute_batch(
                r#"
                -- Shots table: stores detected shots/scenes
                CREATE TABLE IF NOT EXISTS shots (
                    id TEXT PRIMARY KEY,
                    asset_id TEXT NOT NULL,
                    start_sec REAL NOT NULL,
                    end_sec REAL NOT NULL,
                    keyframe_path TEXT,
                    quality_score REAL,
                    tags TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                -- Transcripts table: stores ASR transcriptions
                CREATE TABLE IF NOT EXISTS transcripts (
                    id TEXT PRIMARY KEY,
                    asset_id TEXT NOT NULL,
                    start_sec REAL NOT NULL,
                    end_sec REAL NOT NULL,
                    text TEXT NOT NULL,
                    lang TEXT,
                    confidence REAL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                -- Embeddings table: stores vector embeddings
                CREATE TABLE IF NOT EXISTS embeddings (
                    id TEXT PRIMARY KEY,
                    ref_type TEXT NOT NULL,
                    ref_id TEXT NOT NULL,
                    model TEXT NOT NULL,
                    vector BLOB NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                -- Indexes for efficient queries
                CREATE INDEX IF NOT EXISTS idx_shots_asset ON shots(asset_id);
                CREATE INDEX IF NOT EXISTS idx_shots_time ON shots(asset_id, start_sec);
                CREATE INDEX IF NOT EXISTS idx_transcripts_asset ON transcripts(asset_id);
                CREATE INDEX IF NOT EXISTS idx_transcripts_time ON transcripts(asset_id, start_sec);
                CREATE INDEX IF NOT EXISTS idx_embeddings_ref ON embeddings(ref_type, ref_id);
                "#,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to initialize schema: {}", e)))?;

        Ok(())
    }

    /// Gets the underlying connection (for module-level access)
    pub(crate) fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Deletes all data for a specific asset
    pub fn delete_asset_data(&self, asset_id: &str) -> CoreResult<()> {
        // Delete shots
        self.conn
            .execute("DELETE FROM shots WHERE asset_id = ?", [asset_id])
            .map_err(|e| CoreError::Internal(format!("Failed to delete shots: {}", e)))?;

        // Delete transcripts
        self.conn
            .execute("DELETE FROM transcripts WHERE asset_id = ?", [asset_id])
            .map_err(|e| CoreError::Internal(format!("Failed to delete transcripts: {}", e)))?;

        // Delete embeddings (need to find ref_ids first)
        self.conn
            .execute(
                r#"
                DELETE FROM embeddings
                WHERE ref_id IN (
                    SELECT id FROM shots WHERE asset_id = ?
                    UNION
                    SELECT id FROM transcripts WHERE asset_id = ?
                )
                "#,
                [asset_id, asset_id],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to delete embeddings: {}", e)))?;

        Ok(())
    }

    /// Gets statistics about the index
    pub fn get_stats(&self) -> CoreResult<IndexStats> {
        let shot_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM shots", [], |row| row.get(0))
            .map_err(|e| CoreError::Internal(format!("Failed to get shot count: {}", e)))?;

        let transcript_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM transcripts", [], |row| row.get(0))
            .map_err(|e| CoreError::Internal(format!("Failed to get transcript count: {}", e)))?;

        let embedding_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM embeddings", [], |row| row.get(0))
            .map_err(|e| CoreError::Internal(format!("Failed to get embedding count: {}", e)))?;

        Ok(IndexStats {
            shot_count: shot_count as usize,
            transcript_count: transcript_count as usize,
            embedding_count: embedding_count as usize,
        })
    }
}

// =============================================================================
// Index Statistics
// =============================================================================

/// Statistics about the index database
#[derive(Clone, Debug, Default)]
pub struct IndexStats {
    pub shot_count: usize,
    pub transcript_count: usize,
    pub embedding_count: usize,
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_in_memory_db() {
        let db = IndexDb::in_memory().unwrap();
        let stats = db.get_stats().unwrap();

        assert_eq!(stats.shot_count, 0);
        assert_eq!(stats.transcript_count, 0);
        assert_eq!(stats.embedding_count, 0);
    }

    #[test]
    fn test_create_db_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_index.db");

        let db = IndexDb::create(&path).unwrap();
        let stats = db.get_stats().unwrap();

        assert_eq!(stats.shot_count, 0);
        assert!(path.exists());
    }

    #[test]
    fn test_open_existing_db() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test_index.db");

        // Create database
        {
            let _db = IndexDb::create(&path).unwrap();
        }

        // Open existing database
        let db = IndexDb::open(&path).unwrap();
        let stats = db.get_stats().unwrap();

        assert_eq!(stats.shot_count, 0);
    }

    #[test]
    fn test_delete_asset_data() {
        let db = IndexDb::in_memory().unwrap();

        // Insert test data
        db.connection()
            .execute(
                "INSERT INTO shots (id, asset_id, start_sec, end_sec) VALUES ('shot_1', 'asset_1', 0.0, 5.0)",
                [],
            )
            .unwrap();

        db.connection()
            .execute(
                "INSERT INTO transcripts (id, asset_id, start_sec, end_sec, text) VALUES ('tr_1', 'asset_1', 0.0, 5.0, 'Hello')",
                [],
            )
            .unwrap();

        // Verify data exists
        let stats = db.get_stats().unwrap();
        assert_eq!(stats.shot_count, 1);
        assert_eq!(stats.transcript_count, 1);

        // Delete asset data
        db.delete_asset_data("asset_1").unwrap();

        // Verify data is deleted
        let stats = db.get_stats().unwrap();
        assert_eq!(stats.shot_count, 0);
        assert_eq!(stats.transcript_count, 0);
    }
}

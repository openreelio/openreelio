//! Workspace Asset Index
//!
//! SQLite-backed index for tracking discovered workspace files.
//! Stores metadata about each file and its registration status as a project asset.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::core::assets::AssetKind;
use crate::core::CoreResult;

/// An entry in the workspace file index
#[derive(Debug, Clone)]
pub struct IndexEntry {
    /// Relative path within the project folder (forward slashes)
    pub relative_path: String,
    /// Detected asset kind
    pub kind: AssetKind,
    /// File size in bytes
    pub file_size: u64,
    /// Last modification time (Unix timestamp)
    pub modified_at: i64,
    /// Asset ID if registered as a project asset
    pub asset_id: Option<String>,
    /// When this entry was last indexed (Unix timestamp)
    pub indexed_at: i64,
    /// Whether metadata has been extracted (FFprobe, etc.)
    pub metadata_extracted: bool,
}

/// SQLite-backed asset index for workspace file tracking
pub struct AssetIndex {
    conn: Connection,
}

impl AssetIndex {
    /// Open or create the index database in the project's `.openreelio/` directory
    pub fn open(project_root: &Path) -> CoreResult<Self> {
        let db_dir = project_root.join(".openreelio");
        std::fs::create_dir_all(&db_dir)?;
        let db_path = db_dir.join("workspace_index.db");

        let conn = Connection::open(&db_path).map_err(|e| {
            crate::core::CoreError::Internal(format!("Failed to open workspace index: {}", e))
        })?;

        let index = Self { conn };
        index.initialize_schema()?;
        Ok(index)
    }

    /// Open an in-memory index (for testing)
    #[cfg(test)]
    pub fn open_in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory().map_err(|e| {
            crate::core::CoreError::Internal(format!("Failed to open in-memory index: {}", e))
        })?;
        let index = Self { conn };
        index.initialize_schema()?;
        Ok(index)
    }

    /// Create the database schema
    fn initialize_schema(&self) -> CoreResult<()> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS workspace_files (
                    relative_path TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    file_size INTEGER NOT NULL DEFAULT 0,
                    modified_at INTEGER NOT NULL DEFAULT 0,
                    asset_id TEXT,
                    indexed_at INTEGER NOT NULL DEFAULT 0,
                    metadata_extracted INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_workspace_files_asset_id
                    ON workspace_files(asset_id);
                CREATE INDEX IF NOT EXISTS idx_workspace_files_kind
                    ON workspace_files(kind);",
            )
            .map_err(|e| {
                crate::core::CoreError::Internal(format!(
                    "Failed to initialize workspace index schema: {}",
                    e
                ))
            })?;
        Ok(())
    }

    /// Insert or update a file entry
    pub fn upsert(&self, entry: &IndexEntry) -> CoreResult<()> {
        let kind_str = kind_to_string(&entry.kind);
        self.conn
            .execute(
                "INSERT INTO workspace_files
                    (relative_path, kind, file_size, modified_at, asset_id, indexed_at, metadata_extracted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(relative_path) DO UPDATE SET
                    kind = excluded.kind,
                    file_size = excluded.file_size,
                    modified_at = excluded.modified_at,
                    asset_id = COALESCE(excluded.asset_id, workspace_files.asset_id),
                    indexed_at = excluded.indexed_at,
                    metadata_extracted = CASE
                        WHEN excluded.modified_at != workspace_files.modified_at THEN 0
                        ELSE workspace_files.metadata_extracted
                    END",
                params![
                    entry.relative_path,
                    kind_str,
                    entry.file_size as i64,
                    entry.modified_at,
                    entry.asset_id,
                    entry.indexed_at,
                    entry.metadata_extracted as i32,
                ],
            )
            .map_err(|e| {
                crate::core::CoreError::Internal(format!(
                    "Failed to upsert workspace file: {}",
                    e
                ))
            })?;
        Ok(())
    }

    /// Remove a file entry by relative path
    pub fn remove(&self, relative_path: &str) -> CoreResult<()> {
        self.conn
            .execute(
                "DELETE FROM workspace_files WHERE relative_path = ?1",
                params![relative_path],
            )
            .map_err(|e| {
                crate::core::CoreError::Internal(format!("Failed to remove workspace file: {}", e))
            })?;
        Ok(())
    }

    /// Get a file entry by relative path
    pub fn get(&self, relative_path: &str) -> CoreResult<Option<IndexEntry>> {
        self.conn
            .query_row(
                "SELECT relative_path, kind, file_size, modified_at, asset_id, indexed_at, metadata_extracted
                 FROM workspace_files WHERE relative_path = ?1",
                params![relative_path],
                row_to_entry,
            )
            .optional()
            .map_err(|e| {
                crate::core::CoreError::Internal(format!(
                    "Failed to get workspace file: {}",
                    e
                ))
            })
    }

    /// Get all indexed files
    pub fn get_all(&self) -> CoreResult<Vec<IndexEntry>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT relative_path, kind, file_size, modified_at, asset_id, indexed_at, metadata_extracted
                 FROM workspace_files ORDER BY relative_path",
            )
            .map_err(|e| {
                crate::core::CoreError::Internal(format!(
                    "Failed to prepare get_all query: {}",
                    e
                ))
            })?;

        let entries = stmt
            .query_map([], row_to_entry)
            .map_err(|e| {
                crate::core::CoreError::Internal(format!("Failed to query workspace files: {}", e))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(entries)
    }

    /// Get files not yet registered as project assets
    pub fn get_unregistered(&self) -> CoreResult<Vec<IndexEntry>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT relative_path, kind, file_size, modified_at, asset_id, indexed_at, metadata_extracted
                 FROM workspace_files WHERE asset_id IS NULL ORDER BY relative_path",
            )
            .map_err(|e| {
                crate::core::CoreError::Internal(format!(
                    "Failed to prepare get_unregistered query: {}",
                    e
                ))
            })?;

        let entries = stmt
            .query_map([], row_to_entry)
            .map_err(|e| {
                crate::core::CoreError::Internal(format!(
                    "Failed to query unregistered files: {}",
                    e
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(entries)
    }

    /// Find an index entry by its registered asset ID
    pub fn get_by_asset_id(&self, asset_id: &str) -> CoreResult<Option<IndexEntry>> {
        self.conn
            .query_row(
                "SELECT relative_path, kind, file_size, modified_at, asset_id, indexed_at, metadata_extracted
                 FROM workspace_files WHERE asset_id = ?1",
                params![asset_id],
                row_to_entry,
            )
            .optional()
            .map_err(|e| {
                crate::core::CoreError::Internal(format!(
                    "Failed to get workspace file by asset_id: {}",
                    e
                ))
            })
    }

    /// Mark a file as registered with the given asset ID
    pub fn mark_registered(&self, relative_path: &str, asset_id: &str) -> CoreResult<()> {
        self.conn
            .execute(
                "UPDATE workspace_files SET asset_id = ?1 WHERE relative_path = ?2",
                params![asset_id, relative_path],
            )
            .map_err(|e| {
                crate::core::CoreError::Internal(format!(
                    "Failed to mark workspace file as registered: {}",
                    e
                ))
            })?;
        Ok(())
    }

    /// Clear registration for a file by relative path.
    pub fn unmark_registered(&self, relative_path: &str) -> CoreResult<()> {
        self.conn
            .execute(
                "UPDATE workspace_files SET asset_id = NULL WHERE relative_path = ?1",
                params![relative_path],
            )
            .map_err(|e| {
                crate::core::CoreError::Internal(format!(
                    "Failed to clear workspace file registration: {}",
                    e
                ))
            })?;
        Ok(())
    }

    /// Clear registration for any entry currently mapped to the given asset ID.
    pub fn unmark_registered_by_asset_id(&self, asset_id: &str) -> CoreResult<()> {
        self.conn
            .execute(
                "UPDATE workspace_files SET asset_id = NULL WHERE asset_id = ?1",
                params![asset_id],
            )
            .map_err(|e| {
                crate::core::CoreError::Internal(format!(
                    "Failed to clear workspace registration by asset_id: {}",
                    e
                ))
            })?;
        Ok(())
    }

    /// Clear all entries from the index
    pub fn clear(&self) -> CoreResult<()> {
        self.conn
            .execute("DELETE FROM workspace_files", [])
            .map_err(|e| {
                crate::core::CoreError::Internal(format!("Failed to clear workspace index: {}", e))
            })?;
        Ok(())
    }

    /// Get the total number of indexed files
    pub fn count(&self) -> CoreResult<usize> {
        self.conn
            .query_row("SELECT COUNT(*) FROM workspace_files", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|c| c as usize)
            .map_err(|e| {
                crate::core::CoreError::Internal(format!("Failed to count workspace files: {}", e))
            })
    }
}

/// Convert an AssetKind to a string for SQLite storage
fn kind_to_string(kind: &AssetKind) -> &'static str {
    match kind {
        AssetKind::Video => "video",
        AssetKind::Audio => "audio",
        AssetKind::Image => "image",
        AssetKind::Subtitle => "subtitle",
        AssetKind::Font => "font",
        AssetKind::EffectPreset => "effectPreset",
        AssetKind::MemePack => "memePack",
    }
}

/// Parse an AssetKind from a string
fn kind_from_string(s: &str) -> AssetKind {
    match s {
        "video" => AssetKind::Video,
        "audio" => AssetKind::Audio,
        "image" => AssetKind::Image,
        "subtitle" => AssetKind::Subtitle,
        "font" => AssetKind::Font,
        "effectPreset" => AssetKind::EffectPreset,
        "memePack" => AssetKind::MemePack,
        _ => AssetKind::Video, // Default fallback
    }
}

/// Convert a SQLite row to an IndexEntry
fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<IndexEntry> {
    Ok(IndexEntry {
        relative_path: row.get(0)?,
        kind: kind_from_string(&row.get::<_, String>(1)?),
        file_size: row.get::<_, i64>(2)? as u64,
        modified_at: row.get(3)?,
        asset_id: row.get(4)?,
        indexed_at: row.get(5)?,
        metadata_extracted: row.get::<_, i32>(6)? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(path: &str, kind: AssetKind) -> IndexEntry {
        IndexEntry {
            relative_path: path.to_string(),
            kind,
            file_size: 1024,
            modified_at: 1700000000,
            asset_id: None,
            indexed_at: 1700000001,
            metadata_extracted: false,
        }
    }

    #[test]
    fn test_upsert_and_get() {
        let idx = AssetIndex::open_in_memory().unwrap();
        let entry = make_entry("footage/clip.mp4", AssetKind::Video);

        idx.upsert(&entry).unwrap();
        let got = idx.get("footage/clip.mp4").unwrap().unwrap();

        assert_eq!(got.relative_path, "footage/clip.mp4");
        assert_eq!(got.kind, AssetKind::Video);
        assert_eq!(got.file_size, 1024);
        assert!(got.asset_id.is_none());
    }

    #[test]
    fn test_upsert_idempotent() {
        let idx = AssetIndex::open_in_memory().unwrap();
        let entry = make_entry("footage/clip.mp4", AssetKind::Video);

        idx.upsert(&entry).unwrap();
        idx.upsert(&entry).unwrap();

        assert_eq!(idx.count().unwrap(), 1);
    }

    #[test]
    fn test_upsert_preserves_asset_id() {
        let idx = AssetIndex::open_in_memory().unwrap();
        let entry = make_entry("footage/clip.mp4", AssetKind::Video);
        idx.upsert(&entry).unwrap();

        // Register the file
        idx.mark_registered("footage/clip.mp4", "asset-123")
            .unwrap();

        // Upsert again without asset_id — should preserve existing
        let updated = make_entry("footage/clip.mp4", AssetKind::Video);
        idx.upsert(&updated).unwrap();

        let got = idx.get("footage/clip.mp4").unwrap().unwrap();
        assert_eq!(got.asset_id, Some("asset-123".to_string()));
    }

    #[test]
    fn test_upsert_resets_metadata_on_modification_change() {
        let idx = AssetIndex::open_in_memory().unwrap();
        let mut entry = make_entry("footage/clip.mp4", AssetKind::Video);
        entry.metadata_extracted = true;
        idx.upsert(&entry).unwrap();

        // Change modified_at — should reset metadata_extracted
        let mut updated = make_entry("footage/clip.mp4", AssetKind::Video);
        updated.modified_at = 1700000999;
        idx.upsert(&updated).unwrap();

        let got = idx.get("footage/clip.mp4").unwrap().unwrap();
        assert!(!got.metadata_extracted);
    }

    #[test]
    fn test_remove() {
        let idx = AssetIndex::open_in_memory().unwrap();
        idx.upsert(&make_entry("a.mp4", AssetKind::Video)).unwrap();
        idx.upsert(&make_entry("b.mp4", AssetKind::Video)).unwrap();

        idx.remove("a.mp4").unwrap();

        assert!(idx.get("a.mp4").unwrap().is_none());
        assert!(idx.get("b.mp4").unwrap().is_some());
        assert_eq!(idx.count().unwrap(), 1);
    }

    #[test]
    fn test_get_nonexistent() {
        let idx = AssetIndex::open_in_memory().unwrap();
        assert!(idx.get("missing.mp4").unwrap().is_none());
    }

    #[test]
    fn test_get_all() {
        let idx = AssetIndex::open_in_memory().unwrap();
        idx.upsert(&make_entry("b.mp4", AssetKind::Video)).unwrap();
        idx.upsert(&make_entry("a.wav", AssetKind::Audio)).unwrap();
        idx.upsert(&make_entry("c.jpg", AssetKind::Image)).unwrap();

        let all = idx.get_all().unwrap();
        assert_eq!(all.len(), 3);
        // Should be sorted by relative_path
        assert_eq!(all[0].relative_path, "a.wav");
        assert_eq!(all[1].relative_path, "b.mp4");
        assert_eq!(all[2].relative_path, "c.jpg");
    }

    #[test]
    fn test_get_unregistered() {
        let idx = AssetIndex::open_in_memory().unwrap();
        idx.upsert(&make_entry("a.mp4", AssetKind::Video)).unwrap();
        idx.upsert(&make_entry("b.mp4", AssetKind::Video)).unwrap();
        idx.upsert(&make_entry("c.mp4", AssetKind::Video)).unwrap();

        idx.mark_registered("b.mp4", "asset-b").unwrap();

        let unreg = idx.get_unregistered().unwrap();
        assert_eq!(unreg.len(), 2);
        assert_eq!(unreg[0].relative_path, "a.mp4");
        assert_eq!(unreg[1].relative_path, "c.mp4");
    }

    #[test]
    fn test_get_by_asset_id() {
        let idx = AssetIndex::open_in_memory().unwrap();
        idx.upsert(&make_entry("clip.mp4", AssetKind::Video))
            .unwrap();
        idx.mark_registered("clip.mp4", "asset-xyz").unwrap();

        let found = idx.get_by_asset_id("asset-xyz").unwrap().unwrap();
        assert_eq!(found.relative_path, "clip.mp4");

        assert!(idx.get_by_asset_id("nonexistent").unwrap().is_none());
    }

    #[test]
    fn test_mark_registered() {
        let idx = AssetIndex::open_in_memory().unwrap();
        idx.upsert(&make_entry("clip.mp4", AssetKind::Video))
            .unwrap();

        idx.mark_registered("clip.mp4", "asset-123").unwrap();

        let got = idx.get("clip.mp4").unwrap().unwrap();
        assert_eq!(got.asset_id, Some("asset-123".to_string()));
    }

    #[test]
    fn test_unmark_registered() {
        let idx = AssetIndex::open_in_memory().unwrap();
        idx.upsert(&make_entry("clip.mp4", AssetKind::Video))
            .unwrap();
        idx.mark_registered("clip.mp4", "asset-123").unwrap();

        idx.unmark_registered("clip.mp4").unwrap();

        let got = idx.get("clip.mp4").unwrap().unwrap();
        assert!(got.asset_id.is_none());
    }

    #[test]
    fn test_unmark_registered_by_asset_id() {
        let idx = AssetIndex::open_in_memory().unwrap();
        idx.upsert(&make_entry("a.mp4", AssetKind::Video)).unwrap();
        idx.upsert(&make_entry("b.mp4", AssetKind::Video)).unwrap();
        idx.mark_registered("a.mp4", "asset-shared").unwrap();
        idx.mark_registered("b.mp4", "asset-shared").unwrap();

        idx.unmark_registered_by_asset_id("asset-shared").unwrap();

        assert!(idx.get("a.mp4").unwrap().unwrap().asset_id.is_none());
        assert!(idx.get("b.mp4").unwrap().unwrap().asset_id.is_none());
    }

    #[test]
    fn test_clear() {
        let idx = AssetIndex::open_in_memory().unwrap();
        idx.upsert(&make_entry("a.mp4", AssetKind::Video)).unwrap();
        idx.upsert(&make_entry("b.mp4", AssetKind::Video)).unwrap();

        idx.clear().unwrap();
        assert_eq!(idx.count().unwrap(), 0);
    }

    #[test]
    fn test_count() {
        let idx = AssetIndex::open_in_memory().unwrap();
        assert_eq!(idx.count().unwrap(), 0);

        idx.upsert(&make_entry("a.mp4", AssetKind::Video)).unwrap();
        assert_eq!(idx.count().unwrap(), 1);

        idx.upsert(&make_entry("b.wav", AssetKind::Audio)).unwrap();
        assert_eq!(idx.count().unwrap(), 2);
    }

    #[test]
    fn test_open_with_project_root() {
        let dir = tempfile::tempdir().unwrap();
        let idx = AssetIndex::open(dir.path()).unwrap();

        idx.upsert(&make_entry("test.mp4", AssetKind::Video))
            .unwrap();
        assert_eq!(idx.count().unwrap(), 1);

        // Verify the database file was created
        assert!(dir.path().join(".openreelio/workspace_index.db").exists());
    }

    #[test]
    fn test_kind_roundtrip() {
        let kinds = vec![
            AssetKind::Video,
            AssetKind::Audio,
            AssetKind::Image,
            AssetKind::Subtitle,
            AssetKind::Font,
            AssetKind::EffectPreset,
            AssetKind::MemePack,
        ];

        for kind in kinds {
            let s = kind_to_string(&kind);
            let roundtripped = kind_from_string(s);
            assert_eq!(kind, roundtripped, "Roundtrip failed for {}", s);
        }
    }

    #[test]
    fn test_scan_then_index_integration() {
        use super::super::scanner::WorkspaceScanner;

        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("footage")).unwrap();
        std::fs::write(dir.path().join("footage/a.mp4"), "v").unwrap();
        std::fs::write(dir.path().join("footage/b.wav"), "a").unwrap();

        let scanner = WorkspaceScanner::new(dir.path().to_path_buf());
        let idx = AssetIndex::open_in_memory().unwrap();

        let files = scanner.scan();
        let now = chrono::Utc::now().timestamp();

        for file in &files {
            let entry = IndexEntry {
                relative_path: file.relative_path.clone(),
                kind: file.kind.clone(),
                file_size: file.file_size,
                modified_at: file
                    .modified_at
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
                asset_id: None,
                indexed_at: now,
                metadata_extracted: false,
            };
            idx.upsert(&entry).unwrap();
        }

        assert_eq!(idx.count().unwrap(), 2);
        assert!(idx.get("footage/a.mp4").unwrap().is_some());
        assert!(idx.get("footage/b.wav").unwrap().is_some());
    }
}

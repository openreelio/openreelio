//! Operation Log Module
//!
//! Implements append-only event sourcing log for project operations.
//! The ops.jsonl file is the single source of truth for all project state.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::core::{CoreError, CoreResult, OpId};

// =============================================================================
// Operation Types
// =============================================================================

/// Operation kind enumeration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    // Asset operations
    AssetImport,
    AssetRemove,
    AssetUpdate,

    // Clip operations
    ClipAdd,
    ClipRemove,
    ClipMove,
    ClipTrim,
    ClipSplit,

    // Track operations
    TrackAdd,
    TrackRemove,
    TrackReorder,

    // Effect operations
    EffectAdd,
    EffectRemove,
    EffectUpdate,

    // Caption operations
    CaptionAdd,
    CaptionRemove,
    CaptionUpdate,

    // Sequence operations
    SequenceCreate,
    SequenceUpdate,
    SequenceRemove,

    // Project operations
    ProjectCreate,
    ProjectSettings,

    // Batch operations
    Batch,
}

/// Operation entry in the ops log
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    /// Unique operation ID (ULID)
    pub id: OpId,
    /// Kind of operation
    pub kind: OpKind,
    /// ISO 8601 timestamp
    pub timestamp: String,
    /// User who performed the operation (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// Operation payload (JSON value)
    pub payload: serde_json::Value,
    /// Previous operation ID for undo chain (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_op_id: Option<OpId>,
    /// Inverse operation for undo (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inverse: Option<Box<Operation>>,
}

impl Operation {
    /// Creates a new operation with generated ULID and current timestamp
    pub fn new(kind: OpKind, payload: serde_json::Value) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            kind,
            timestamp: Utc::now().to_rfc3339(),
            user: None,
            payload,
            prev_op_id: None,
            inverse: None,
        }
    }

    /// Creates a new operation with a specific ID (for testing or replay)
    pub fn with_id(id: &str, kind: OpKind, payload: serde_json::Value) -> Self {
        Self {
            id: id.to_string(),
            kind,
            timestamp: Utc::now().to_rfc3339(),
            user: None,
            payload,
            prev_op_id: None,
            inverse: None,
        }
    }

    /// Sets the user who performed this operation
    pub fn with_user(mut self, user: &str) -> Self {
        self.user = Some(user.to_string());
        self
    }

    /// Sets the previous operation ID for undo chain
    pub fn with_prev_op(mut self, prev_op_id: &str) -> Self {
        self.prev_op_id = Some(prev_op_id.to_string());
        self
    }

    /// Sets the inverse operation for undo
    pub fn with_inverse(mut self, inverse: Operation) -> Self {
        self.inverse = Some(Box::new(inverse));
        self
    }

    /// Parses timestamp as DateTime
    pub fn timestamp_as_datetime(&self) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(&self.timestamp)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    }
}

// =============================================================================
// Operation Log
// =============================================================================

/// Result of reading operations with error handling
#[derive(Debug)]
pub struct ReadResult {
    /// Successfully parsed operations
    pub operations: Vec<Operation>,
    /// Lines that failed to parse (line number, error message)
    pub errors: Vec<(usize, String)>,
}

/// Append-only operation log backed by a JSONL file
pub struct OpsLog {
    /// Path to the ops.jsonl file
    path: PathBuf,
}

impl OpsLog {
    /// Creates a new OpsLog instance for the given path
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    /// Returns the path to the ops.jsonl file
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Checks if the ops log file exists
    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    /// Creates the ops log file if it doesn't exist
    pub fn create_if_not_exists(&self) -> CoreResult<()> {
        if !self.exists() {
            // Create parent directories if needed
            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            File::create(&self.path)?;
        }
        Ok(())
    }

    /// Appends a single operation to the log
    pub fn append(&self, op: &Operation) -> CoreResult<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;

        let mut writer = BufWriter::new(file);
        let json = serde_json::to_string(op)?;
        writeln!(writer, "{}", json)?;
        writer.flush()?;

        Ok(())
    }

    /// Appends multiple operations to the log atomically
    pub fn append_batch(&self, ops: &[Operation]) -> CoreResult<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;

        let mut writer = BufWriter::new(file);
        for op in ops {
            let json = serde_json::to_string(op)?;
            writeln!(writer, "{}", json)?;
        }
        writer.flush()?;

        Ok(())
    }

    /// Reads all operations from the log, handling corrupted lines gracefully
    pub fn read_all(&self) -> CoreResult<ReadResult> {
        if !self.exists() {
            return Ok(ReadResult {
                operations: vec![],
                errors: vec![],
            });
        }

        let file = File::open(&self.path)?;
        let reader = BufReader::new(file);
        let mut operations = Vec::new();
        let mut errors = Vec::new();

        for (line_num, line_result) in reader.lines().enumerate() {
            let line_number = line_num + 1; // 1-indexed

            match line_result {
                Ok(line) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue; // Skip empty lines
                    }

                    match serde_json::from_str::<Operation>(trimmed) {
                        Ok(op) => operations.push(op),
                        Err(e) => {
                            errors.push((line_number, format!("JSON parse error: {}", e)));
                        }
                    }
                }
                Err(e) => {
                    errors.push((line_number, format!("IO error: {}", e)));
                }
            }
        }

        Ok(ReadResult { operations, errors })
    }

    /// Reads operations since a specific operation ID
    pub fn read_since(&self, since_op_id: &str) -> CoreResult<ReadResult> {
        let all = self.read_all()?;

        // Find the index of the operation with the given ID
        let start_index = all
            .operations
            .iter()
            .position(|op| op.id == since_op_id)
            .map(|i| i + 1) // Start from the next operation
            .unwrap_or(0); // If not found, return all operations

        Ok(ReadResult {
            operations: all.operations.into_iter().skip(start_index).collect(),
            errors: all.errors,
        })
    }

    /// Reads the last N operations
    pub fn read_last(&self, count: usize) -> CoreResult<Vec<Operation>> {
        let all = self.read_all()?;
        let ops = all.operations;
        let start = ops.len().saturating_sub(count);
        Ok(ops.into_iter().skip(start).collect())
    }

    /// Counts the total number of operations in the log
    pub fn count(&self) -> CoreResult<usize> {
        if !self.exists() {
            return Ok(0);
        }

        let file = File::open(&self.path)?;
        let reader = BufReader::new(file);
        let count = reader
            .lines()
            .filter_map(|l| l.ok())
            .filter(|l| !l.trim().is_empty())
            .count();

        Ok(count)
    }

    /// Gets the last operation in the log
    pub fn last(&self) -> CoreResult<Option<Operation>> {
        let ops = self.read_last(1)?;
        Ok(ops.into_iter().next())
    }

    /// Finds an operation by ID
    pub fn find_by_id(&self, op_id: &str) -> CoreResult<Option<Operation>> {
        let all = self.read_all()?;
        Ok(all.operations.into_iter().find(|op| op.id == op_id))
    }

    /// Compacts the log by rewriting only valid operations
    /// Returns the number of removed (corrupted) lines
    pub fn compact(&self) -> CoreResult<usize> {
        let read_result = self.read_all()?;
        let error_count = read_result.errors.len();

        if error_count == 0 {
            return Ok(0); // Nothing to compact
        }

        // Write to a temporary file first
        let temp_path = self.path.with_extension("jsonl.tmp");
        {
            let file = File::create(&temp_path)?;
            let mut writer = BufWriter::new(file);
            for op in &read_result.operations {
                let json = serde_json::to_string(op)?;
                writeln!(writer, "{}", json)?;
            }
            writer.flush()?;
        }

        // Replace the original file
        std::fs::rename(&temp_path, &self.path)?;

        Ok(error_count)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn create_test_ops_log() -> (OpsLog, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let ops_path = temp_dir.path().join("test_ops.jsonl");
        let ops_log = OpsLog::new(&ops_path);
        (ops_log, temp_dir)
    }

    #[test]
    fn test_ops_log_append_and_read() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Create test operations
        let op1 = Operation::with_id(
            "01H1234567890000000001",
            OpKind::AssetImport,
            serde_json::json!({
                "assetId": "asset_001",
                "name": "video.mp4",
                "path": "/path/to/video.mp4"
            }),
        );

        let op2 = Operation::with_id(
            "01H1234567890000000002",
            OpKind::ClipAdd,
            serde_json::json!({
                "clipId": "clip_001",
                "assetId": "asset_001",
                "trackId": "track_001"
            }),
        );

        // Append operations
        ops_log.append(&op1).unwrap();
        ops_log.append(&op2).unwrap();

        // Read all operations
        let result = ops_log.read_all().unwrap();
        assert_eq!(result.operations.len(), 2);
        assert!(result.errors.is_empty());

        // Verify operation data
        assert_eq!(result.operations[0].id, "01H1234567890000000001");
        assert_eq!(result.operations[0].kind, OpKind::AssetImport);
        assert_eq!(result.operations[1].id, "01H1234567890000000002");
        assert_eq!(result.operations[1].kind, OpKind::ClipAdd);
    }

    #[test]
    fn test_ops_log_read_since() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Create and append operations
        let ops = vec![
            Operation::with_id("op_001", OpKind::AssetImport, serde_json::json!({})),
            Operation::with_id("op_002", OpKind::ClipAdd, serde_json::json!({})),
            Operation::with_id("op_003", OpKind::ClipMove, serde_json::json!({})),
            Operation::with_id("op_004", OpKind::EffectAdd, serde_json::json!({})),
        ];

        ops_log.append_batch(&ops).unwrap();

        // Read since op_002
        let result = ops_log.read_since("op_002").unwrap();
        assert_eq!(result.operations.len(), 2);
        assert_eq!(result.operations[0].id, "op_003");
        assert_eq!(result.operations[1].id, "op_004");
    }

    #[test]
    fn test_ops_log_corrupted_line_handling() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Manually write mixed valid and invalid lines
        let content = r#"{"id":"op_001","kind":"asset_import","timestamp":"2024-01-01T00:00:00Z","payload":{}}
this is not valid json
{"id":"op_002","kind":"clip_add","timestamp":"2024-01-01T00:01:00Z","payload":{}}
{"broken": json without closing
{"id":"op_003","kind":"clip_move","timestamp":"2024-01-01T00:02:00Z","payload":{}}
"#;

        fs::write(ops_log.path(), content).unwrap();

        // Read all - should handle corrupted lines gracefully
        let result = ops_log.read_all().unwrap();

        // Should have 3 valid operations
        assert_eq!(result.operations.len(), 3);
        assert_eq!(result.operations[0].id, "op_001");
        assert_eq!(result.operations[1].id, "op_002");
        assert_eq!(result.operations[2].id, "op_003");

        // Should report 2 errors
        assert_eq!(result.errors.len(), 2);
        assert_eq!(result.errors[0].0, 2); // Line 2
        assert_eq!(result.errors[1].0, 4); // Line 4
    }

    #[test]
    fn test_ops_log_empty_file() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Create empty file
        ops_log.create_if_not_exists().unwrap();

        let result = ops_log.read_all().unwrap();
        assert!(result.operations.is_empty());
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_ops_log_nonexistent_file() {
        let temp_dir = TempDir::new().unwrap();
        let ops_path = temp_dir.path().join("nonexistent.jsonl");
        let ops_log = OpsLog::new(&ops_path);

        assert!(!ops_log.exists());

        let result = ops_log.read_all().unwrap();
        assert!(result.operations.is_empty());
    }

    #[test]
    fn test_ops_log_count() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        assert_eq!(ops_log.count().unwrap(), 0);

        let op = Operation::new(OpKind::AssetImport, serde_json::json!({}));
        ops_log.append(&op).unwrap();
        assert_eq!(ops_log.count().unwrap(), 1);

        let op2 = Operation::new(OpKind::ClipAdd, serde_json::json!({}));
        ops_log.append(&op2).unwrap();
        assert_eq!(ops_log.count().unwrap(), 2);
    }

    #[test]
    fn test_ops_log_last() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Empty log
        assert!(ops_log.last().unwrap().is_none());

        // Add operations
        let op1 = Operation::with_id("op_first", OpKind::AssetImport, serde_json::json!({}));
        let op2 = Operation::with_id("op_last", OpKind::ClipAdd, serde_json::json!({}));

        ops_log.append(&op1).unwrap();
        ops_log.append(&op2).unwrap();

        let last = ops_log.last().unwrap().unwrap();
        assert_eq!(last.id, "op_last");
    }

    #[test]
    fn test_ops_log_find_by_id() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        let ops = vec![
            Operation::with_id(
                "op_001",
                OpKind::AssetImport,
                serde_json::json!({"name": "first"}),
            ),
            Operation::with_id(
                "op_002",
                OpKind::ClipAdd,
                serde_json::json!({"name": "second"}),
            ),
            Operation::with_id(
                "op_003",
                OpKind::ClipMove,
                serde_json::json!({"name": "third"}),
            ),
        ];

        ops_log.append_batch(&ops).unwrap();

        // Find existing
        let found = ops_log.find_by_id("op_002").unwrap().unwrap();
        assert_eq!(found.id, "op_002");
        assert_eq!(found.payload["name"], "second");

        // Find non-existing
        assert!(ops_log.find_by_id("op_999").unwrap().is_none());
    }

    #[test]
    fn test_ops_log_read_last() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        let ops: Vec<Operation> = (1..=10)
            .map(|i| {
                Operation::with_id(
                    &format!("op_{:03}", i),
                    OpKind::AssetImport,
                    serde_json::json!({}),
                )
            })
            .collect();

        ops_log.append_batch(&ops).unwrap();

        // Read last 3
        let last_3 = ops_log.read_last(3).unwrap();
        assert_eq!(last_3.len(), 3);
        assert_eq!(last_3[0].id, "op_008");
        assert_eq!(last_3[1].id, "op_009");
        assert_eq!(last_3[2].id, "op_010");

        // Read more than available
        let last_20 = ops_log.read_last(20).unwrap();
        assert_eq!(last_20.len(), 10);
    }

    #[test]
    fn test_ops_log_compact() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Write mixed valid and invalid content
        let content = r#"{"id":"op_001","kind":"asset_import","timestamp":"2024-01-01T00:00:00Z","payload":{}}
invalid json line
{"id":"op_002","kind":"clip_add","timestamp":"2024-01-01T00:01:00Z","payload":{}}
another bad line
{"id":"op_003","kind":"clip_move","timestamp":"2024-01-01T00:02:00Z","payload":{}}
"#;

        fs::write(ops_log.path(), content).unwrap();

        // Compact
        let removed_count = ops_log.compact().unwrap();
        assert_eq!(removed_count, 2);

        // Verify compacted file
        let result = ops_log.read_all().unwrap();
        assert_eq!(result.operations.len(), 3);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn test_operation_creation() {
        let op = Operation::new(
            OpKind::ClipAdd,
            serde_json::json!({
                "clipId": "clip_123",
                "assetId": "asset_456"
            }),
        );

        assert!(!op.id.is_empty());
        assert_eq!(op.kind, OpKind::ClipAdd);
        assert!(op.user.is_none());
        assert!(op.prev_op_id.is_none());
        assert!(op.timestamp_as_datetime().is_some());
    }

    #[test]
    fn test_operation_builder_pattern() {
        let inverse_op =
            Operation::with_id("inverse_001", OpKind::ClipRemove, serde_json::json!({}));

        let op = Operation::with_id("op_main", OpKind::ClipAdd, serde_json::json!({}))
            .with_user("alice")
            .with_prev_op("op_prev")
            .with_inverse(inverse_op);

        assert_eq!(op.id, "op_main");
        assert_eq!(op.user, Some("alice".to_string()));
        assert_eq!(op.prev_op_id, Some("op_prev".to_string()));
        assert!(op.inverse.is_some());
        assert_eq!(op.inverse.as_ref().unwrap().id, "inverse_001");
    }

    #[test]
    fn test_operation_serialization() {
        let op = Operation::with_id(
            "op_test",
            OpKind::EffectAdd,
            serde_json::json!({
                "effectId": "effect_001",
                "type": "blur"
            }),
        )
        .with_user("bob");

        let json = serde_json::to_string(&op).unwrap();
        let parsed: Operation = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, "op_test");
        assert_eq!(parsed.kind, OpKind::EffectAdd);
        assert_eq!(parsed.user, Some("bob".to_string()));
        assert_eq!(parsed.payload["type"], "blur");
    }

    #[test]
    fn test_ops_log_batch_append() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        let ops = vec![
            Operation::with_id("batch_1", OpKind::AssetImport, serde_json::json!({})),
            Operation::with_id("batch_2", OpKind::ClipAdd, serde_json::json!({})),
            Operation::with_id("batch_3", OpKind::ClipMove, serde_json::json!({})),
        ];

        ops_log.append_batch(&ops).unwrap();

        let result = ops_log.read_all().unwrap();
        assert_eq!(result.operations.len(), 3);
        assert_eq!(result.operations[0].id, "batch_1");
        assert_eq!(result.operations[1].id, "batch_2");
        assert_eq!(result.operations[2].id, "batch_3");
    }

    #[test]
    fn test_ops_log_skip_empty_lines() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        let content = r#"{"id":"op_001","kind":"asset_import","timestamp":"2024-01-01T00:00:00Z","payload":{}}


{"id":"op_002","kind":"clip_add","timestamp":"2024-01-01T00:01:00Z","payload":{}}

"#;

        fs::write(ops_log.path(), content).unwrap();

        let result = ops_log.read_all().unwrap();
        assert_eq!(result.operations.len(), 2);
        assert!(result.errors.is_empty()); // Empty lines are not errors
    }
}

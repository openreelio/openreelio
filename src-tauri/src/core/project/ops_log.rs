//! Operation Log Module
//!
//! Implements append-only event sourcing log for project operations.
//! The ops.jsonl file is the single source of truth for all project state.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

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
    ClipUpdate,
    CompoundClipCreate,
    CompoundClipUnnest,
    ClipGroup,
    ClipUngroup,
    ClipLink,
    ClipUnlink,

    // Track operations
    TrackAdd,
    TrackRemove,
    TrackReorder,
    TrackUpdate,

    // Effect operations
    EffectAdd,
    EffectRemove,
    EffectUpdate,

    // Marker operations
    MarkerAdd,
    MarkerRemove,

    // Caption operations
    CaptionAdd,
    CaptionRemove,
    CaptionUpdate,

    // Text clip operations
    TextClipAdd,
    TextClipUpdate,
    TextClipRemove,

    // Sequence operations
    SequenceCreate,
    SequenceUpdate,
    SequenceRemove,

    // Project operations
    ProjectCreate,
    ProjectSettings,

    // Bin operations
    BinCreate,
    BinRemove,
    BinRename,
    BinMove,
    BinUpdateColor,

    // Workspace operations
    WorkspaceScan,

    // Filesystem operations
    FolderCreate,
    FileRename,
    FileMove,
    FileDelete,

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

/// Revision of `ops.jsonl` a guarded session believes is on disk.
///
/// Shared by every handle derived from one another via [`OpsLog::shared_handle`],
/// so an append made through the executor's handle advances the same watermark
/// the project's own handle checks.
///
/// The byte length is the discriminator: it is an `O(1)` stat, and because the
/// log is append-only any foreign write necessarily changes it. The operation
/// count is carried alongside purely so a rejection can report meaningful
/// numbers without rescanning the file on the happy path.
#[derive(Debug)]
struct SessionWatermark {
    /// Byte length `ops.jsonl` had after this session's last write or resync.
    expected_len: AtomicU64,
    /// Operation count corresponding to `expected_len`.
    expected_op_count: AtomicU64,
}

/// Append-only operation log backed by a JSONL file
pub struct OpsLog {
    /// Path to the ops.jsonl file
    path: PathBuf,
    /// Session watermark installed by [`OpsLog::begin_guarded_session`].
    ///
    /// `None` means this handle writes unguarded, which is the correct default
    /// for one-shot readers, replay helpers and tests. Only a handle that
    /// represents a live editing session (see [`crate::ActiveProject`]) opts in,
    /// because only such a session can be *stale* relative to the file.
    watermark: Option<Arc<SessionWatermark>>,
}

struct OpsLogLock(File);

impl Drop for OpsLogLock {
    fn drop(&mut self) {
        // Keep the handle alive for the lifetime of the guard. Locks are released on drop.
        let _ = &self.0;
    }
}

impl OpsLog {
    /// Creates a new OpsLog instance for the given path
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            watermark: None,
        }
    }

    /// Creates a second handle to the same log that shares this handle's
    /// session watermark.
    ///
    /// Use this whenever a component (for example [`crate::core::commands::CommandExecutor`])
    /// needs its own handle to a log that another component also writes to, so
    /// that every append performed by this session advances the same watermark
    /// and is never mistaken for an external edit.
    pub fn shared_handle(&self) -> Self {
        Self {
            path: self.path.clone(),
            watermark: self.watermark.as_ref().map(Arc::clone),
        }
    }

    // =========================================================================
    // External-change guard
    //
    // Every write to ops.jsonl in the product funnels through `append` /
    // `append_batch`, so enforcing the guard here covers all callers by
    // construction instead of relying on each of them to remember a check.
    // =========================================================================

    /// Starts guarding this handle family against writes made by other
    /// processes, using the log's current on-disk revision as the baseline.
    ///
    /// From this point on, [`OpsLog::append`] and [`OpsLog::append_batch`] fail
    /// with [`CoreError::ExternalChangeDetected`] when the file no longer
    /// matches what this session wrote, instead of interleaving this session's
    /// operations with the foreign ones.
    ///
    /// Handles that do not opt in keep appending unconditionally, which is what
    /// short-lived writers such as `openreelio-cli` invocations need.
    pub fn begin_guarded_session(&mut self) -> CoreResult<()> {
        let _lock = self.lock_shared()?;
        let len = self.on_disk_len()?;
        let count = self.count_unlocked()? as u64;
        self.watermark = Some(Arc::new(SessionWatermark {
            expected_len: AtomicU64::new(len),
            expected_op_count: AtomicU64::new(count),
        }));
        Ok(())
    }

    /// Reads every operation, archived ones included, and installs the session
    /// watermark from the same critical section.
    ///
    /// Opening a project needs both halves to describe the same revision of the
    /// log. Reading first and sampling the baseline afterwards (or the reverse)
    /// leaves a window in which another process can append: the freshly opened
    /// session would then start out already disagreeing with the file and report
    /// an external change that it had in fact just replayed.
    pub fn begin_guarded_session_reading_all(&mut self) -> CoreResult<ReadResult> {
        // Exclusive rather than shared: no other process may append between the
        // replay and the baseline sample.
        let _lock = self.lock_exclusive()?;

        let mut all_ops = Vec::new();
        let mut all_errors = Vec::new();

        let archive_result = self.read_archive()?;
        all_ops.extend(archive_result.operations);
        all_errors.extend(
            archive_result
                .errors
                .into_iter()
                .map(|(line, err)| (line, format!("[archive] {}", err))),
        );

        let current_result = self.read_all_unlocked()?;
        let archive_lines = all_ops.len();
        all_ops.extend(current_result.operations);
        all_errors.extend(
            current_result
                .errors
                .into_iter()
                .map(|(line, err)| (line + archive_lines, err)),
        );

        let len = self.on_disk_len()?;
        let count = self.count_unlocked()? as u64;
        self.watermark = Some(Arc::new(SessionWatermark {
            expected_len: AtomicU64::new(len),
            expected_op_count: AtomicU64::new(count),
        }));

        Ok(ReadResult {
            operations: all_ops,
            errors: all_errors,
        })
    }

    /// Whether this handle rejects appends made on top of foreign writes.
    pub fn is_guarded(&self) -> bool {
        self.watermark.is_some()
    }

    /// Number of operations a guarded session expects the log to contain.
    ///
    /// Returns `None` for unguarded handles, which hold no expectation at all.
    pub fn expected_op_count(&self) -> Option<u64> {
        self.watermark
            .as_ref()
            .map(|watermark| watermark.expected_op_count.load(Ordering::SeqCst))
    }

    /// Fails with [`CoreError::ExternalChangeDetected`] when the on-disk log no
    /// longer matches what this session wrote.
    ///
    /// Callers that mutate in-memory state before appending should call this
    /// first so a rejection leaves nothing half-applied. It is a no-op on
    /// unguarded handles.
    pub fn ensure_no_external_changes(&self) -> CoreResult<()> {
        if self.watermark.is_none() {
            return Ok(());
        }
        let _lock = self.lock_shared()?;
        self.verify_watermark_locked()
    }

    /// Byte length of the log, treating a missing file as empty.
    fn on_disk_len(&self) -> CoreResult<u64> {
        match std::fs::metadata(&self.path) {
            Ok(metadata) => Ok(metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(error) => Err(error.into()),
        }
    }

    /// Compares the on-disk log against the watermark. Requires a held lock.
    fn verify_watermark_locked(&self) -> CoreResult<()> {
        let Some(watermark) = self.watermark.as_ref() else {
            return Ok(());
        };

        let expected_len = watermark.expected_len.load(Ordering::SeqCst);
        let actual_len = self.on_disk_len()?;
        if actual_len == expected_len {
            return Ok(());
        }

        // Only the rejection path pays for an exact count; the numbers exist to
        // explain the conflict to the user, not to detect it.
        let expected_op_count = watermark.expected_op_count.load(Ordering::SeqCst) as usize;
        let on_disk_op_count = self.count_unlocked()?;
        tracing::warn!(
            expected_op_count,
            on_disk_op_count,
            expected_len,
            actual_len,
            ops_log = %self.path.display(),
            "External change detected in project ops log"
        );
        Err(CoreError::ExternalChangeDetected {
            expected_op_count,
            on_disk_op_count,
        })
    }

    /// Records that this session just wrote `appended_ops` operations.
    /// Requires a held lock so the sampled length reflects our own write.
    fn advance_watermark_locked(&self, appended_ops: u64) -> CoreResult<()> {
        let Some(watermark) = self.watermark.as_ref() else {
            return Ok(());
        };
        watermark
            .expected_len
            .store(self.on_disk_len()?, Ordering::SeqCst);
        watermark
            .expected_op_count
            .fetch_add(appended_ops, Ordering::SeqCst);
        Ok(())
    }

    /// Re-samples the watermark after this session deliberately rewrote the log
    /// (compaction), so its own rewrite is not mistaken for a foreign edit.
    /// Requires a held lock.
    fn resync_watermark_locked(&self) -> CoreResult<()> {
        let Some(watermark) = self.watermark.as_ref() else {
            return Ok(());
        };
        watermark
            .expected_len
            .store(self.on_disk_len()?, Ordering::SeqCst);
        watermark
            .expected_op_count
            .store(self.count_unlocked()? as u64, Ordering::SeqCst);
        Ok(())
    }

    /// Returns the path to the ops.jsonl file
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Checks if the ops log file exists
    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    fn lock_path(&self) -> PathBuf {
        let mut lock_path = self.path.clone();
        let file_name = self
            .path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "ops.jsonl".to_string());
        lock_path.set_file_name(format!("{file_name}.lock"));
        lock_path
    }

    fn lock_exclusive(&self) -> CoreResult<OpsLogLock> {
        let lock_path = self.lock_path();
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_path)?;
        // Use UFCS to avoid accidentally picking up newer std methods and violating MSRV.
        fs2::FileExt::lock_exclusive(&file)?;
        Ok(OpsLogLock(file))
    }

    fn lock_shared(&self) -> CoreResult<OpsLogLock> {
        let lock_path = self.lock_path();
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_path)?;
        // Use UFCS to avoid accidentally picking up newer std methods and violating MSRV.
        fs2::FileExt::lock_shared(&file)?;
        Ok(OpsLogLock(file))
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
    ///
    /// On a guarded handle (see [`OpsLog::begin_guarded_session`]) this fails
    /// with [`CoreError::ExternalChangeDetected`] when another process wrote to
    /// the log first. The check runs inside the same exclusive lock as the
    /// write, so no foreign append can slip in between the two.
    pub fn append(&self, op: &Operation) -> CoreResult<()> {
        tracing::debug!(op_id = %op.id, op_kind = ?op.kind, "Appending operation to ops log");
        let _lock = self.lock_exclusive()?;
        self.verify_watermark_locked()?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;

        let mut writer = BufWriter::new(file);
        let json = serde_json::to_string(op)?;
        writeln!(writer, "{}", json)?;
        writer.flush()?;

        // Best-effort durability: ensure the operation is on disk before returning.
        // ops.jsonl is the source of truth for event sourcing, so losing the tail
        // of the log on power loss can make snapshots diverge from history.
        writer.get_ref().sync_all()?;

        // Only count appends that reached disk; an inflated watermark would hide
        // a genuine external edit.
        self.advance_watermark_locked(1)?;

        Ok(())
    }

    /// Appends multiple operations to the log atomically
    ///
    /// Guarded handles reject foreign writes exactly as [`OpsLog::append`] does.
    pub fn append_batch(&self, ops: &[Operation]) -> CoreResult<()> {
        tracing::debug!(
            op_count = ops.len(),
            "Appending batch operations to ops log"
        );
        let _lock = self.lock_exclusive()?;
        self.verify_watermark_locked()?;
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

        // See `append` for durability rationale.
        writer.get_ref().sync_all()?;

        self.advance_watermark_locked(ops.len() as u64)?;

        Ok(())
    }

    /// Reads all operations from the log, handling corrupted lines gracefully
    pub fn read_all(&self) -> CoreResult<ReadResult> {
        // Prevent races with writers:
        // - Without a lock, a reader can observe a partially written JSON line (no trailing '\n')
        //   and treat it as corrupted.
        // - That creates false-positive "corruption" reports and can trigger unnecessary compaction.
        let _lock = self.lock_shared()?;
        let result = self.read_all_unlocked()?;
        if !result.errors.is_empty() {
            tracing::warn!(
                error_count = result.errors.len(),
                "Encountered parse/IO errors while reading ops log"
            );
        }
        Ok(result)
    }

    fn read_all_unlocked(&self) -> CoreResult<ReadResult> {
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
        let _lock = self.lock_shared()?;
        self.count_unlocked()
    }

    /// Counts operations without acquiring the lock. Requires a held lock.
    fn count_unlocked(&self) -> CoreResult<usize> {
        if !self.exists() {
            return Ok(0);
        }

        let file = File::open(&self.path)?;
        let reader = BufReader::new(file);
        let count = reader
            .lines()
            .map_while(Result::ok)
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
        let _lock = self.lock_exclusive()?;
        let read_result = self.read_all_unlocked()?;
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
        // This session rewrote the log on purpose; re-baseline so its own
        // rewrite is not reported as somebody else's edit.
        self.resync_watermark_locked()?;

        Ok(error_count)
    }

    /// Compacts the log by archiving old operations after a snapshot is saved.
    /// This keeps only operations after the given snapshot op_id.
    ///
    /// # Arguments
    /// * `snapshot_op_id` - The operation ID that the snapshot was created from
    ///
    /// # Returns
    /// The number of operations archived
    pub fn compact_after_snapshot(&self, snapshot_op_id: &str) -> CoreResult<usize> {
        let _lock = self.lock_exclusive()?;
        let read_result = self.read_all_unlocked()?;

        // Find the index of the snapshot operation
        let snapshot_index = read_result
            .operations
            .iter()
            .position(|op| op.id == snapshot_op_id);

        // If snapshot not found, keep all operations
        let Some(index) = snapshot_index else {
            return Ok(0);
        };

        // If there are no operations after snapshot, nothing to compact
        if index >= read_result.operations.len() - 1 {
            return Ok(0);
        }

        // Archive old operations to .archive file
        let archive_path = self.path.with_extension("jsonl.archive");
        let ops_to_archive = &read_result.operations[..=index];

        if !ops_to_archive.is_empty() {
            // Append to archive file
            let archive_file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&archive_path)?;

            let mut writer = BufWriter::new(archive_file);
            for op in ops_to_archive {
                let json = serde_json::to_string(op)?;
                writeln!(writer, "{}", json)?;
            }
            writer.flush()?;
        }

        // Keep only operations after snapshot
        let ops_to_keep = &read_result.operations[index + 1..];
        let archived_count = ops_to_archive.len();

        // Write new ops.jsonl with only recent operations
        let temp_path = self.path.with_extension("jsonl.tmp");
        {
            let file = File::create(&temp_path)?;
            let mut writer = BufWriter::new(file);
            for op in ops_to_keep {
                let json = serde_json::to_string(op)?;
                writeln!(writer, "{}", json)?;
            }
            writer.flush()?;
        }

        // Atomic rename
        std::fs::rename(&temp_path, &self.path)?;
        // See `compact`: compaction is a deliberate local rewrite.
        self.resync_watermark_locked()?;

        Ok(archived_count)
    }

    /// Checks if compaction is needed based on operation count threshold
    pub fn should_compact(&self, threshold: usize) -> CoreResult<bool> {
        let count = self.count()?;
        Ok(count >= threshold)
    }

    /// Auto-compacts if the operation count exceeds the threshold.
    /// Returns the number of archived operations, or 0 if no compaction was needed.
    ///
    /// # Arguments
    /// * `threshold` - The number of operations that triggers compaction
    /// * `snapshot_op_id` - The latest snapshot's operation ID
    pub fn auto_compact_if_needed(
        &self,
        threshold: usize,
        snapshot_op_id: &str,
    ) -> CoreResult<usize> {
        if !self.should_compact(threshold)? {
            return Ok(0);
        }

        self.compact_after_snapshot(snapshot_op_id)
    }

    /// Gets the archive file path
    pub fn archive_path(&self) -> PathBuf {
        self.path.with_extension("jsonl.archive")
    }

    /// Checks if archive file exists
    pub fn has_archive(&self) -> bool {
        self.archive_path().exists()
    }

    /// Reads archived operations
    pub fn read_archive(&self) -> CoreResult<ReadResult> {
        let archive_path = self.archive_path();
        if !archive_path.exists() {
            return Ok(ReadResult {
                operations: vec![],
                errors: vec![],
            });
        }

        let archive_log = OpsLog::new(&archive_path);
        archive_log.read_all()
    }

    /// Reads all operations including archived ones (for full history replay)
    pub fn read_all_with_archive(&self) -> CoreResult<ReadResult> {
        let mut all_ops = Vec::new();
        let mut all_errors = Vec::new();

        // Read archived operations first
        let archive_result = self.read_archive()?;
        all_ops.extend(archive_result.operations);
        all_errors.extend(
            archive_result
                .errors
                .into_iter()
                .map(|(line, err)| (line, format!("[archive] {}", err))),
        );

        // Read current operations
        let current_result = self.read_all()?;
        let archive_lines = all_ops.len();
        all_ops.extend(current_result.operations);
        all_errors.extend(
            current_result
                .errors
                .into_iter()
                .map(|(line, err)| (line + archive_lines, err)),
        );

        Ok(ReadResult {
            operations: all_ops,
            errors: all_errors,
        })
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    fn create_test_ops_log() -> (OpsLog, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let ops_path = temp_dir.path().join("test_ops.jsonl");
        let ops_log = OpsLog::new(&ops_path);
        (ops_log, temp_dir)
    }

    #[test]
    fn test_ops_log_concurrent_append_is_consistent() {
        let (ops_log, _temp_dir) = create_test_ops_log();
        let path = ops_log.path().to_path_buf();

        let threads = 8;
        let per_thread = 25;
        let mut handles = Vec::new();

        for t in 0..threads {
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                let log = OpsLog::new(&path);
                for i in 0..per_thread {
                    let op = Operation::new(
                        OpKind::AssetImport,
                        serde_json::json!({
                            "thread": t,
                            "i": i
                        }),
                    );
                    log.append(&op).expect("append should succeed");
                }
            }));
        }

        for handle in handles {
            handle.join().unwrap();
        }

        let result = ops_log.read_all().unwrap();
        assert!(result.errors.is_empty(), "expected no parse errors");
        assert_eq!(result.operations.len(), threads * per_thread);
    }

    #[test]
    fn test_ops_log_read_blocks_during_exclusive_write() {
        // Deterministic race test:
        // Hold the ops log lock while writing a partial JSON line, then complete it.
        // `read_all()` must not observe the partial line as corruption.
        let (ops_log, _temp_dir) = create_test_ops_log();
        ops_log.create_if_not_exists().unwrap();

        let path = ops_log.path().to_path_buf();
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();

        let writer = std::thread::spawn(move || {
            let log = OpsLog::new(&path);
            let _lock = log.lock_exclusive().unwrap();

            let mut file = OpenOptions::new().append(true).open(&path).unwrap();

            // Write a partial JSON line without a newline and keep the lock held.
            // If the reader isn't locked, it will likely treat this as a corrupted line.
            write!(file, "{{\"id\":\"op_partial\",\"kind\":\"asset_import\",\"timestamp\":\"2024-01-01T00:00:00Z\",\"payload\":{{}}").unwrap();
            file.flush().unwrap();
            started_tx.send(()).unwrap();

            // Give the reader a window to attempt a read.
            std::thread::sleep(std::time::Duration::from_millis(200));

            // Complete the JSON and terminate the line.
            writeln!(file, "}}").unwrap();
            file.flush().unwrap();
        });

        // Wait until the writer has written a partial line and is holding the exclusive lock.
        started_rx.recv().unwrap();

        // This should block until the writer releases the lock, then read a valid line.
        let result = ops_log.read_all().unwrap();
        assert!(
            result.errors.is_empty(),
            "expected no errors, got: {:?}",
            result.errors
        );
        assert_eq!(result.operations.len(), 1);
        assert_eq!(result.operations[0].id, "op_partial");

        writer.join().unwrap();
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

    // =========================================================================
    // External-change guard
    //
    // Feature: External edit safety
    //   As an editor who drives OpenReelio from both the GUI and openreelio-cli
    //   I want appends to stop at the log itself when another process wrote
    //   So that no mutation path can bypass the check by forgetting to call it
    // =========================================================================

    /// Scenario: an unguarded handle is the default and never blocks.
    #[test]
    fn should_append_unconditionally_on_an_unguarded_handle() {
        // Given a plain handle, as short-lived headless writers and tests use
        let (ops_log, _temp_dir) = create_test_ops_log();
        assert!(!ops_log.is_guarded());
        assert_eq!(ops_log.expected_op_count(), None);

        // When another writer appends underneath it
        OpsLog::new(ops_log.path())
            .append(&Operation::new(OpKind::AssetImport, serde_json::json!({})))
            .unwrap();

        // Then it still appends and reports no external change
        ops_log.ensure_no_external_changes().unwrap();
        ops_log
            .append(&Operation::new(OpKind::ClipAdd, serde_json::json!({})))
            .unwrap();
        assert_eq!(ops_log.count().unwrap(), 2);
    }

    /// Scenario: a guarded handle refuses to write on top of a foreign append.
    #[test]
    fn should_reject_appends_on_a_guarded_handle_after_a_foreign_write() {
        // Given a guarded session that has appended once
        let (mut ops_log, _temp_dir) = create_test_ops_log();
        ops_log.begin_guarded_session().unwrap();
        ops_log
            .append(&Operation::new(OpKind::AssetImport, serde_json::json!({})))
            .unwrap();
        ops_log.ensure_no_external_changes().unwrap();
        assert_eq!(ops_log.expected_op_count(), Some(1));

        // When another process appends
        OpsLog::new(ops_log.path())
            .append(&Operation::new(OpKind::ClipAdd, serde_json::json!({})))
            .unwrap();

        // Then both the pre-flight check and the append itself refuse
        assert!(matches!(
            ops_log.ensure_no_external_changes(),
            Err(CoreError::ExternalChangeDetected {
                expected_op_count: 1,
                on_disk_op_count: 2,
            })
        ));
        assert!(matches!(
            ops_log.append(&Operation::new(OpKind::ClipMove, serde_json::json!({}))),
            Err(CoreError::ExternalChangeDetected { .. })
        ));
        assert!(matches!(
            ops_log.append_batch(&[Operation::new(OpKind::ClipTrim, serde_json::json!({}))]),
            Err(CoreError::ExternalChangeDetected { .. })
        ));
        // And the foreign operation is still the only thing that landed
        assert_eq!(ops_log.count().unwrap(), 2);
    }

    /// Scenario: the executor's derived handle shares one watermark.
    #[test]
    fn should_share_the_guard_with_handles_derived_from_the_same_session() {
        // Given a guarded log and the handle the executor writes through
        let (mut ops_log, _temp_dir) = create_test_ops_log();
        ops_log.begin_guarded_session().unwrap();
        let executor_handle = ops_log.shared_handle();
        assert!(executor_handle.is_guarded());

        // When each handle appends, neither sees the other as external
        executor_handle
            .append(&Operation::new(OpKind::AssetImport, serde_json::json!({})))
            .unwrap();
        ops_log
            .append(&Operation::new(OpKind::ClipAdd, serde_json::json!({})))
            .unwrap();
        ops_log.ensure_no_external_changes().unwrap();
        executor_handle.ensure_no_external_changes().unwrap();

        // Then a foreign append stops both of them
        OpsLog::new(ops_log.path())
            .append(&Operation::new(OpKind::ClipMove, serde_json::json!({})))
            .unwrap();
        assert!(matches!(
            executor_handle.append(&Operation::new(OpKind::ClipTrim, serde_json::json!({}))),
            Err(CoreError::ExternalChangeDetected { .. })
        ));
        assert!(matches!(
            ops_log.ensure_no_external_changes(),
            Err(CoreError::ExternalChangeDetected { .. })
        ));
    }

    /// Scenario: opening a project baselines against the log it just replayed.
    #[test]
    fn should_baseline_the_guard_against_the_operations_it_replayed() {
        // Given a log another process already populated, part of it archived so
        // the replay has to read both files
        let (ops_log, _temp_dir) = create_test_ops_log();
        let ops: Vec<Operation> = (1..=5)
            .map(|i| {
                Operation::with_id(
                    &format!("op_{:03}", i),
                    OpKind::AssetImport,
                    serde_json::json!({}),
                )
            })
            .collect();
        ops_log.append_batch(&ops).unwrap();
        assert_eq!(ops_log.compact_after_snapshot("op_002").unwrap(), 2);

        // When a session opens it
        let mut session = OpsLog::new(ops_log.path());
        let read = session.begin_guarded_session_reading_all().unwrap();

        // Then the replay spans the archive, while the watermark tracks only the
        // live log the session will append to
        assert_eq!(read.operations.len(), 5);
        assert!(read.errors.is_empty());
        assert_eq!(session.expected_op_count(), Some(3));
        session.ensure_no_external_changes().unwrap();
        session
            .append(&Operation::new(OpKind::ClipMove, serde_json::json!({})))
            .unwrap();
        assert_eq!(session.expected_op_count(), Some(4));
    }

    /// Scenario: this session's own compaction is not a foreign edit.
    #[test]
    fn should_rebaseline_the_guard_after_this_session_compacts() {
        // Given a guarded session with several operations
        let (mut ops_log, _temp_dir) = create_test_ops_log();
        let ops: Vec<Operation> = (1..=6)
            .map(|i| {
                Operation::with_id(
                    &format!("op_{:03}", i),
                    OpKind::AssetImport,
                    serde_json::json!({}),
                )
            })
            .collect();
        ops_log.append_batch(&ops).unwrap();
        ops_log.begin_guarded_session().unwrap();

        // When it compacts its own log, which rewrites the file
        let archived = ops_log.compact_after_snapshot("op_003").unwrap();
        assert_eq!(archived, 3);

        // Then it keeps writing rather than accusing itself
        ops_log.ensure_no_external_changes().unwrap();
        assert_eq!(ops_log.expected_op_count(), Some(3));
        ops_log
            .append(&Operation::new(OpKind::ClipAdd, serde_json::json!({})))
            .unwrap();
        assert_eq!(ops_log.count().unwrap(), 4);
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

    #[test]
    fn test_ops_log_compact_after_snapshot() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Create operations
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

        // Compact after op_005 (simulating snapshot at op_005)
        let archived = ops_log.compact_after_snapshot("op_005").unwrap();
        assert_eq!(archived, 5); // op_001 to op_005 archived

        // Current ops should only have op_006 to op_010
        let result = ops_log.read_all().unwrap();
        assert_eq!(result.operations.len(), 5);
        assert_eq!(result.operations[0].id, "op_006");
        assert_eq!(result.operations[4].id, "op_010");

        // Archive should contain op_001 to op_005
        assert!(ops_log.has_archive());
        let archive_result = ops_log.read_archive().unwrap();
        assert_eq!(archive_result.operations.len(), 5);
        assert_eq!(archive_result.operations[0].id, "op_001");
        assert_eq!(archive_result.operations[4].id, "op_005");
    }

    #[test]
    fn test_ops_log_read_all_with_archive() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Create and compact operations
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
        ops_log.compact_after_snapshot("op_005").unwrap();

        // Add more operations
        let more_ops = vec![
            Operation::with_id("op_011", OpKind::ClipAdd, serde_json::json!({})),
            Operation::with_id("op_012", OpKind::ClipMove, serde_json::json!({})),
        ];
        ops_log.append_batch(&more_ops).unwrap();

        // Read all with archive should return all 12 operations in order
        let result = ops_log.read_all_with_archive().unwrap();
        assert_eq!(result.operations.len(), 12);
        assert_eq!(result.operations[0].id, "op_001");
        assert_eq!(result.operations[4].id, "op_005");
        assert_eq!(result.operations[5].id, "op_006");
        assert_eq!(result.operations[11].id, "op_012");
    }

    #[test]
    fn test_ops_log_should_compact() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Empty log should not compact
        assert!(!ops_log.should_compact(10).unwrap());

        // Add 5 operations
        let ops: Vec<Operation> = (1..=5)
            .map(|i| {
                Operation::with_id(
                    &format!("op_{:03}", i),
                    OpKind::AssetImport,
                    serde_json::json!({}),
                )
            })
            .collect();
        ops_log.append_batch(&ops).unwrap();

        // 5 ops < 10 threshold
        assert!(!ops_log.should_compact(10).unwrap());

        // 5 ops >= 5 threshold
        assert!(ops_log.should_compact(5).unwrap());
    }

    #[test]
    fn test_ops_log_auto_compact_if_needed() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        // Create 15 operations
        let ops: Vec<Operation> = (1..=15)
            .map(|i| {
                Operation::with_id(
                    &format!("op_{:03}", i),
                    OpKind::AssetImport,
                    serde_json::json!({}),
                )
            })
            .collect();
        ops_log.append_batch(&ops).unwrap();

        // Auto compact with threshold 10 and snapshot at op_010
        let archived = ops_log.auto_compact_if_needed(10, "op_010").unwrap();
        assert_eq!(archived, 10); // op_001 to op_010

        // Only op_011 to op_015 should remain
        let result = ops_log.read_all().unwrap();
        assert_eq!(result.operations.len(), 5);
        assert_eq!(result.operations[0].id, "op_011");
    }

    #[test]
    fn test_ops_log_compact_snapshot_not_found() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        let ops = vec![
            Operation::with_id("op_001", OpKind::AssetImport, serde_json::json!({})),
            Operation::with_id("op_002", OpKind::ClipAdd, serde_json::json!({})),
        ];
        ops_log.append_batch(&ops).unwrap();

        // Try to compact with non-existent snapshot ID
        let archived = ops_log.compact_after_snapshot("op_999").unwrap();
        assert_eq!(archived, 0); // Nothing archived

        // All operations should still be there
        let result = ops_log.read_all().unwrap();
        assert_eq!(result.operations.len(), 2);
    }

    #[test]
    fn test_ops_log_compact_at_end() {
        let (ops_log, _temp_dir) = create_test_ops_log();

        let ops = vec![
            Operation::with_id("op_001", OpKind::AssetImport, serde_json::json!({})),
            Operation::with_id("op_002", OpKind::ClipAdd, serde_json::json!({})),
        ];
        ops_log.append_batch(&ops).unwrap();

        // Compact at the last operation - nothing should be archived
        let archived = ops_log.compact_after_snapshot("op_002").unwrap();
        assert_eq!(archived, 0);

        // All operations should still be there
        let result = ops_log.read_all().unwrap();
        assert_eq!(result.operations.len(), 2);
    }
}

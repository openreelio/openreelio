//! Filesystem utilities.
//!
//! This module provides safe primitives for writing files in a crash-tolerant way.
//!
//! Why this exists:
//! - Snapshots (`snapshot.json`) and metadata (`project.json`) are critical to recoverability.
//! - A partial write (power loss, crash) must not leave the project unrecoverable.
//! - Windows semantics differ from Unix for rename-over-existing; we handle both.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::core::{CoreError, CoreResult};

/// Write bytes to `path` using an atomic replace pattern.
///
/// Implementation notes:
/// - Write to a sibling temporary file.
/// - Flush and sync the temp file.
/// - Swap into place by renaming.
/// - If the destination exists, it is first moved aside as a `.bak` file, then removed.
pub fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> CoreResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let tmp_path = tmp_path_for(path);
    {
        let file = File::create(&tmp_path)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(bytes)?;
        writer.flush()?;
        // Best-effort fsync. If it fails, we still surface the error.
        writer.get_ref().sync_all()?;
    }

    atomic_replace(path, &tmp_path)?;
    Ok(())
}

/// Write a JSON file atomically with pretty formatting.
pub fn atomic_write_json_pretty<T: serde::Serialize>(path: &Path, value: &T) -> CoreResult<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    atomic_write_bytes(path, &bytes)
}

fn tmp_path_for(path: &Path) -> PathBuf {
    let mut tmp = path.to_path_buf();
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "tmp".to_string());
    tmp.set_file_name(format!("{file_name}.tmp"));
    tmp
}

fn bak_path_for(path: &Path) -> PathBuf {
    let mut bak = path.to_path_buf();
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "bak".to_string());
    bak.set_file_name(format!("{file_name}.bak"));
    bak
}

fn atomic_replace(dest: &Path, src_tmp: &Path) -> CoreResult<()> {
    // Fast path: dest does not exist.
    if !dest.exists() {
        std::fs::rename(src_tmp, dest)?;
        return Ok(());
    }

    // Windows: rename-over-existing may fail depending on filesystem; use a backup swap.
    let bak = bak_path_for(dest);

    // Best-effort cleanup of stale backup.
    if bak.exists() {
        let _ = std::fs::remove_file(&bak);
    }

    std::fs::rename(dest, &bak)?;
    match std::fs::rename(src_tmp, dest) {
        Ok(()) => {
            let _ = std::fs::remove_file(&bak);
            Ok(())
        }
        Err(e) => {
            // Try to restore the old file.
            let _ = std::fs::rename(&bak, dest);
            let _ = std::fs::remove_file(src_tmp);
            Err(CoreError::IoError(e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn atomic_write_bytes_creates_and_replaces() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("file.json");

        atomic_write_bytes(&path, b"one").unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        assert_eq!(first, "one");

        atomic_write_bytes(&path, b"two").unwrap();
        let second = std::fs::read_to_string(&path).unwrap();
        assert_eq!(second, "two");
    }
}

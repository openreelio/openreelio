//! Filesystem utilities.
//!
//! This module provides safe primitives for writing files in a crash-tolerant way.
//!
//! Why this exists:
//! - Snapshots and metadata are critical to recoverability.
//! - A partial write (power loss, crash) must not leave the project unrecoverable.
//! - Windows semantics differ from Unix for rename-over-existing; we handle both.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::core::{CoreError, CoreResult};

// =============================================================================
// Path Validation Utilities
// =============================================================================

/// Validates that an identifier component is safe to use in file paths.
///
/// This prevents path traversal attacks by rejecting identifiers containing:
/// - Empty strings
/// - Path traversal sequences (`..`)
/// - Path separators (`/`, `\`)
/// - Drive letter indicators (`:`)
///
/// # Arguments
/// * `id` - The identifier to validate
/// * `label` - A descriptive label for error messages (e.g., "assetId", "sequenceId")
///
/// # Returns
/// * `Ok(())` if the identifier is safe
/// * `Err(String)` with a descriptive error message if validation fails
///
/// # Security
/// This function is critical for preventing path traversal attacks. Any identifier
/// that will be used as part of a file path MUST be validated through this function.
pub fn validate_path_id_component(id: &str, label: &str) -> Result<(), String> {
    // Check for empty or whitespace-only identifiers
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty or contains only whitespace"));
    }
    if trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
    {
        return Err(format!(
            "Invalid {label}: contains path traversal characters"
        ));
    }
    // Additional validation: reject control characters and null bytes
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(format!("Invalid {label}: contains control characters"));
    }
    Ok(())
}

/// Validates and resolves a local file path for input operations.
///
/// This function performs comprehensive validation:
/// - Rejects empty paths
/// - Rejects remote URLs (http://, https://)
/// - Requires absolute paths
/// - Verifies the file exists and is a regular file
///
/// # Arguments
/// * `path` - The path string to validate
/// * `label` - A descriptive label for error messages (e.g., "inputPath", "assetPath")
///
/// # Returns
/// * `Ok(PathBuf)` with the validated path
/// * `Err(String)` with a descriptive error message if validation fails
///
/// # Security
/// This function prevents SSRF attacks by rejecting URLs and ensures the path
/// points to an actual file on the local filesystem.
pub fn validate_local_input_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }

    // Prevent SSRF: reject remote URLs
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Err(format!("{label} must be a local file path, not a URL"));
    }

    // Reject other URL schemes that could be dangerous
    if lower.contains("://") {
        return Err(format!("{label} must be a local file path"));
    }

    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            pb.display()
        ));
    }

    // Prevent traversal tricks in user-provided absolute paths.
    // This is defense-in-depth for path-based allowlists (e.g. asset protocol scope).
    if pb.components().any(|c| {
        matches!(
            c,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return Err(format!("{label} must not contain '.' or '..' segments"));
    }

    // Check file existence and type
    let meta =
        std::fs::metadata(&pb).map_err(|_| format!("{label} file not found: {}", pb.display()))?;
    if !meta.is_file() {
        return Err(format!("{label} is not a file: {}", pb.display()));
    }

    // Best-effort normalization. Canonicalization can fail on some special filesystems
    // even when metadata succeeds; in that case we keep the validated absolute path.
    Ok(std::fs::canonicalize(&pb).unwrap_or(pb))
}

/// Validates and canonicalizes a project directory path.
///
/// This is used by IPC entry points that open projects to ensure:
/// - The path is non-empty
/// - The path is absolute
/// - The directory exists and looks like an OpenReelio project
///   (legacy root files or hidden `.openreelio/state` files, including snapshot-only recovery)
/// - The returned path is canonicalized to reduce ambiguity and avoid scope mismatches
pub fn validate_existing_project_dir(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }

    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            pb.display()
        ));
    }

    if !pb.exists() {
        return Err(format!("{label} not found: {}", pb.display()));
    }
    if !pb.is_dir() {
        return Err(format!("{label} must be a directory: {}", pb.display()));
    }

    // Require basic project shape to avoid opening an arbitrary directory.
    // Support both legacy root-level files and hidden state layout.
    let has_project_json = pb.join("project.json").exists();
    let has_ops_log = pb.join("ops.jsonl").exists();
    let has_snapshot = pb.join("snapshot.json").exists();
    let hidden_state_dir = pb.join(".openreelio").join("state");
    let has_hidden_project_json = hidden_state_dir.join("project.json").exists();
    let has_hidden_ops_log = hidden_state_dir.join("ops.jsonl").exists();
    let has_hidden_snapshot = hidden_state_dir.join("snapshot.json").exists();
    if !has_project_json
        && !has_ops_log
        && !has_snapshot
        && !has_hidden_project_json
        && !has_hidden_ops_log
        && !has_hidden_snapshot
    {
        return Err(format!(
            "{label} is not a valid OpenReelio project directory: {}",
            pb.display()
        ));
    }

    std::fs::canonicalize(&pb).map_err(|e| format!("Failed to resolve {label}: {e}"))
}

/// Returns a conservative set of directories the app is willing to write exports into.
///
/// Security model:
/// - IPC is a trust boundary; the renderer process (webview) could be compromised.
/// - For output paths coming from the frontend, we restrict writes to a small set of
///   user-owned directories + the current project directory.
pub fn default_export_allowed_roots(project_dir: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(project_dir.to_path_buf());

    // "dirs" is best-effort and may return None in sandboxed environments.
    if let Some(p) = dirs::desktop_dir() {
        roots.push(p);
    }
    if let Some(p) = dirs::download_dir() {
        roots.push(p);
    }
    if let Some(p) = dirs::document_dir() {
        roots.push(p);
    }
    if let Some(p) = dirs::video_dir() {
        roots.push(p);
    }

    roots
}

/// Async version of `validate_local_input_path`.
///
/// Uses tokio's async filesystem operations to avoid blocking the async runtime.
pub async fn validate_local_input_path_async(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Err(format!("{label} must be a local file path, not a URL"));
    }

    if lower.contains("://") {
        return Err(format!("{label} must be a local file path"));
    }

    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            pb.display()
        ));
    }

    if pb.components().any(|c| {
        matches!(
            c,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return Err(format!("{label} must not contain '.' or '..' segments"));
    }

    let meta = tokio::fs::metadata(&pb)
        .await
        .map_err(|_| format!("{label} file not found: {}", pb.display()))?;
    if !meta.is_file() {
        return Err(format!("{label} is not a file: {}", pb.display()));
    }

    // Best-effort normalization.
    let pb_clone = pb.clone();
    Ok(
        tokio::task::spawn_blocking(move || std::fs::canonicalize(&pb_clone).unwrap_or(pb_clone))
            .await
            .unwrap_or(pb),
    )
}

/// Validates an output path for write operations.
///
/// This function ensures:
/// - The path is absolute
/// - The parent directory exists or can be created
/// - The path doesn't point to a directory
///
/// # Arguments
/// * `path` - The output path string to validate
/// * `label` - A descriptive label for error messages
///
/// # Returns
/// * `Ok(PathBuf)` with the validated path
/// * `Err(String)` if validation fails
pub fn validate_output_path(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }

    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            pb.display()
        ));
    }

    // Ensure parent directory exists
    if let Some(parent) = pb.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create output directory: {}", e))?;
        }
    }

    // Don't allow overwriting a directory
    if pb.exists() && pb.is_dir() {
        return Err(format!("{label} points to a directory: {}", pb.display()));
    }

    Ok(pb)
}

fn validate_output_path_no_create(path: &str, label: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is empty"));
    }

    let pb = PathBuf::from(trimmed);
    if !pb.is_absolute() {
        return Err(format!(
            "{label} must be an absolute path: {}",
            pb.display()
        ));
    }

    // Prevent traversal tricks in scoped IPC paths. Normalizing absolute paths correctly across
    // platforms is subtle; for security, reject any `.`/`..` segments up front.
    if pb.components().any(|c| {
        matches!(
            c,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    }) {
        return Err(format!("{label} must not contain '.' or '..' segments"));
    }

    // Don't allow overwriting a directory
    if pb.exists() && pb.is_dir() {
        return Err(format!("{label} points to a directory: {}", pb.display()));
    }

    Ok(pb)
}

/// Validates an output path and enforces that it is within one of the allowed root directories.
///
/// This is a defense-in-depth control for IPC commands that accept an output path from the
/// frontend. Without this, a compromised renderer could write to arbitrary locations on disk.
pub fn validate_scoped_output_path(
    path: &str,
    label: &str,
    allowed_roots: &[&Path],
) -> Result<PathBuf, String> {
    let pb = validate_output_path_no_create(path, label)?;

    let parent = pb
        .parent()
        .ok_or_else(|| format!("{label} has no parent directory: {}", pb.display()))?;

    #[cfg(windows)]
    fn starts_with_path_case_insensitive(path: &Path, base: &Path) -> bool {
        use std::path::Component;

        let mut path_components = path.components();
        for base_component in base.components() {
            let Some(path_component) = path_components.next() else {
                return false;
            };

            let base_str = base_component.as_os_str().to_string_lossy();
            let path_str = path_component.as_os_str().to_string_lossy();

            // Compare case-insensitively for Windows. Use a component-wise comparison to avoid
            // prefix bugs like allowing `C:\root_evil` when `C:\root` is the allowed root.
            //
            // NOTE: `Component` does not expose a stable structural equality that is
            // case-insensitive, so we normalize to lowercase strings for safety.
            if base_str.to_ascii_lowercase() != path_str.to_ascii_lowercase() {
                return false;
            }

            // If the base is `RootDir` but the path isn't, we'll have returned false above.
            // For prefix components (drive letters), the string normalization above suffices.
            if matches!(base_component, Component::CurDir | Component::ParentDir) {
                // Canonical paths should not contain these, but treat them defensively.
                return false;
            }
        }
        true
    }

    // Avoid side-effects outside allowed roots: verify scope *before* creating parent directories.
    let is_allowed_lexical = allowed_roots.iter().any(|root| {
        #[cfg(windows)]
        {
            starts_with_path_case_insensitive(parent, root)
        }

        #[cfg(not(windows))]
        {
            parent.starts_with(root)
        }
    });

    if !is_allowed_lexical {
        let roots = allowed_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "{label} must be within an allowed directory. Allowed roots: {roots}. Got: {}",
            pb.display()
        ));
    }

    // At this point, `parent` is lexically under an allowed root, so creating it is safe.
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create output directory: {e}"))?;

    let parent_canon = std::fs::canonicalize(parent)
        .map_err(|e| format!("Failed to resolve {label} parent directory: {e}"))?;

    // Post-creation canonical check to defend against symlink and case/normalization surprises.
    let is_allowed_canon = allowed_roots.iter().any(|root| {
        let root_canon = std::fs::canonicalize(root).unwrap_or_else(|_| (*root).to_path_buf());

        #[cfg(windows)]
        {
            starts_with_path_case_insensitive(&parent_canon, &root_canon)
        }

        #[cfg(not(windows))]
        {
            parent_canon.starts_with(&root_canon)
        }
    });

    if !is_allowed_canon {
        let roots = allowed_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "{label} must be within an allowed directory. Allowed roots: {roots}. Got: {}",
            pb.display()
        ));
    }

    Ok(pb)
}

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

    #[test]
    fn test_validate_existing_project_dir_accepts_hidden_state_layout() {
        let dir = TempDir::new().unwrap();
        let state_dir = dir.path().join(".openreelio").join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("project.json"), "{}").unwrap();
        std::fs::write(state_dir.join("ops.jsonl"), "").unwrap();

        let project_path = dir.path().to_string_lossy().to_string();
        let result = validate_existing_project_dir(&project_path, "Project path");

        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_existing_project_dir_accepts_hidden_snapshot_only() {
        let dir = TempDir::new().unwrap();
        let state_dir = dir.path().join(".openreelio").join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("snapshot.json"), "{}").unwrap();

        let project_path = dir.path().to_string_lossy().to_string();
        let result = validate_existing_project_dir(&project_path, "Project path");

        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_existing_project_dir_accepts_legacy_layout() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("project.json"), "{}").unwrap();
        std::fs::write(dir.path().join("ops.jsonl"), "").unwrap();

        let project_path = dir.path().to_string_lossy().to_string();
        let result = validate_existing_project_dir(&project_path, "Project path");

        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_existing_project_dir_rejects_non_project_directory() {
        let dir = TempDir::new().unwrap();
        let project_path = dir.path().to_string_lossy().to_string();

        let result = validate_existing_project_dir(&project_path, "Project path");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("is not a valid OpenReelio project directory"));
    }

    // =========================================================================
    // Path Validation Tests
    // =========================================================================

    #[test]
    fn test_validate_path_id_component_valid() {
        assert!(validate_path_id_component("asset_001", "assetId").is_ok());
        assert!(validate_path_id_component("01HXYZ123ABC", "assetId").is_ok());
        assert!(validate_path_id_component("my-asset-name", "assetId").is_ok());
        assert!(validate_path_id_component("asset.with.dots", "assetId").is_ok());
    }

    #[test]
    fn test_validate_path_id_component_empty() {
        let result = validate_path_id_component("", "assetId");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn test_validate_path_id_component_path_traversal() {
        // Double dot traversal
        let result = validate_path_id_component("..", "assetId");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("path traversal"));

        // Embedded traversal
        let result = validate_path_id_component("foo/../bar", "assetId");
        assert!(result.is_err());

        // Hidden traversal with prefix
        let result = validate_path_id_component("prefix..", "assetId");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_path_id_component_path_separators() {
        // Forward slash
        let result = validate_path_id_component("foo/bar", "assetId");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("path traversal"));

        // Backslash
        let result = validate_path_id_component("foo\\bar", "assetId");
        assert!(result.is_err());

        // Drive letter (Windows)
        let result = validate_path_id_component("C:", "assetId");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_path_id_component_control_characters() {
        // Null byte
        let result = validate_path_id_component("foo\0bar", "assetId");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("control characters"));

        // Tab
        let result = validate_path_id_component("foo\tbar", "assetId");
        assert!(result.is_err());

        // Newline
        let result = validate_path_id_component("foo\nbar", "assetId");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_local_input_path_empty() {
        let result = validate_local_input_path("", "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));

        // Whitespace only
        let result = validate_local_input_path("   ", "inputPath");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_local_input_path_rejects_urls() {
        let result = validate_local_input_path("http://example.com/file.mp4", "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("local file path"));

        let result = validate_local_input_path("https://example.com/file.mp4", "inputPath");
        assert!(result.is_err());

        // Mixed case URL
        let result = validate_local_input_path("HTTP://example.com/file.mp4", "inputPath");
        assert!(result.is_err());

        // Other URL schemes
        let result = validate_local_input_path("file://localhost/file.mp4", "inputPath");
        assert!(result.is_err());

        let result = validate_local_input_path("ftp://server/file.mp4", "inputPath");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_local_input_path_requires_absolute() {
        let result = validate_local_input_path("relative/path/file.mp4", "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute path"));
    }

    #[test]
    fn test_validate_local_input_path_file_not_found() {
        // Use a path that definitely doesn't exist
        #[cfg(windows)]
        let path = "C:\\nonexistent\\path\\file.mp4";
        #[cfg(not(windows))]
        let path = "/nonexistent/path/file.mp4";

        let result = validate_local_input_path(path, "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_validate_local_input_path_directory_rejected() {
        let dir = TempDir::new().unwrap();
        let dir_path = dir.path().to_string_lossy().to_string();

        let result = validate_local_input_path(&dir_path, "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not a file"));
    }

    #[test]
    fn test_validate_local_input_path_valid_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.txt");
        std::fs::write(&file_path, "test content").unwrap();

        let path_str = file_path.to_string_lossy().to_string();
        let result = validate_local_input_path(&path_str, "inputPath");
        assert!(result.is_ok());
        let got = result.unwrap();
        let expected = std::fs::canonicalize(&file_path).unwrap_or(file_path);
        assert_eq!(got, expected);
    }

    #[test]
    fn test_validate_local_input_path_rejects_dot_segments() {
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let file_path = sub.join("file.txt");
        std::fs::write(&file_path, "test").unwrap();

        // Create an absolute path containing a parent-dir segment.
        let dotty = sub.join("..").join("sub").join("file.txt");
        let dotty_str = dotty.to_string_lossy().to_string();
        let result = validate_local_input_path(&dotty_str, "inputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("'.' or '..'"));
    }

    #[test]
    fn test_validate_output_path_empty() {
        let result = validate_output_path("", "outputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn test_validate_output_path_requires_absolute() {
        let result = validate_output_path("relative/path/output.mp4", "outputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("absolute path"));
    }

    #[test]
    fn test_validate_output_path_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let nested_path = dir.path().join("a").join("b").join("c").join("output.mp4");
        let path_str = nested_path.to_string_lossy().to_string();

        let result = validate_output_path(&path_str, "outputPath");
        assert!(result.is_ok());

        // Parent directories should have been created
        assert!(nested_path.parent().unwrap().exists());
    }

    #[test]
    fn test_validate_output_path_rejects_directory() {
        let dir = TempDir::new().unwrap();
        let dir_path = dir.path().to_string_lossy().to_string();

        let result = validate_output_path(&dir_path, "outputPath");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("directory"));
    }

    #[test]
    fn test_validate_output_path_allows_existing_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("existing.mp4");
        std::fs::write(&file_path, "existing content").unwrap();

        let path_str = file_path.to_string_lossy().to_string();
        let result = validate_output_path(&path_str, "outputPath");
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_scoped_output_path_allows_within_root() {
        let root = TempDir::new().unwrap();
        let nested = root
            .path()
            .join("openreelio")
            .join("frames")
            .join("out.png");
        let nested_str = nested.to_string_lossy().to_string();

        let result = validate_scoped_output_path(&nested_str, "outputPath", &[root.path()]);
        assert!(result.is_ok());
        assert!(nested.parent().unwrap().exists());
    }

    #[test]
    fn test_validate_scoped_output_path_rejects_outside_root() {
        let allowed_root = TempDir::new().unwrap();
        let outside_root = TempDir::new().unwrap();
        let out = outside_root.path().join("out.png");
        let out_str = out.to_string_lossy().to_string();

        let result = validate_scoped_output_path(&out_str, "outputPath", &[allowed_root.path()]);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("must be within an allowed directory"));
    }

    #[test]
    fn test_validate_scoped_output_path_does_not_create_dirs_outside_root() {
        let allowed_root = TempDir::new().unwrap();
        let outside_root = TempDir::new().unwrap();

        let outside_parent = outside_root.path().join("will_not_be_created");
        let out = outside_parent.join("out.png");
        let out_str = out.to_string_lossy().to_string();

        assert!(!outside_parent.exists());
        let result = validate_scoped_output_path(&out_str, "outputPath", &[allowed_root.path()]);
        assert!(result.is_err());
        assert!(
            !outside_parent.exists(),
            "validate_scoped_output_path must not create directories outside allowed roots"
        );
    }

    #[test]
    fn test_validate_scoped_output_path_allows_multiple_roots() {
        let root_a = TempDir::new().unwrap();
        let root_b = TempDir::new().unwrap();

        let out = root_b.path().join("b").join("out.png");
        let out_str = out.to_string_lossy().to_string();

        let result =
            validate_scoped_output_path(&out_str, "outputPath", &[root_a.path(), root_b.path()]);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_scoped_output_path_rejects_dotdot_segments() {
        let root = TempDir::new().unwrap();
        let out = root
            .path()
            .join("frames")
            .join("..")
            .join("evil")
            .join("out.png");
        let out_str = out.to_string_lossy().to_string();

        let result = validate_scoped_output_path(&out_str, "outputPath", &[root.path()]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must not contain '.' or '..'"));
    }

    #[test]
    fn test_validate_scoped_output_path_rejects_prefix_sibling_dir() {
        // Regression test: string-prefix checks can incorrectly allow paths like:
        // allowed root:   C:\...\root
        // output parent:  C:\...\root_evil
        // This must be rejected.
        let base = TempDir::new().unwrap();

        let allowed_root = base.path().join("root");
        let sibling = base.path().join("root_evil");
        std::fs::create_dir_all(&allowed_root).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();

        let out = sibling.join("out.png");
        let out_str = out.to_string_lossy().to_string();

        let result = validate_scoped_output_path(&out_str, "outputPath", &[&allowed_root]);
        assert!(
            result.is_err(),
            "expected output in prefix-sibling dir to be rejected"
        );
    }

    #[tokio::test]
    async fn test_validate_local_input_path_async_valid() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.txt");
        tokio::fs::write(&file_path, "test content").await.unwrap();

        let path_str = file_path.to_string_lossy().to_string();
        let result = validate_local_input_path_async(&path_str, "inputPath").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_validate_local_input_path_async_rejects_urls() {
        let result =
            validate_local_input_path_async("https://evil.com/malware.mp4", "inputPath").await;
        assert!(result.is_err());
    }

    // =========================================================================
    // Security Edge Case Tests
    // =========================================================================

    #[test]
    fn test_path_traversal_unicode_normalization() {
        // Some systems might normalize unicode differently
        // Test that we catch common bypass attempts
        let result = validate_path_id_component("foo\u{002F}bar", "assetId"); // Unicode forward slash
        assert!(result.is_err());
    }

    #[test]
    fn test_path_id_with_unicode() {
        // Valid unicode characters should be allowed
        assert!(validate_path_id_component("资产_001", "assetId").is_ok());
        assert!(validate_path_id_component("アセット", "assetId").is_ok());
        assert!(validate_path_id_component("asset_émoji_🎬", "assetId").is_ok());
    }

    #[test]
    fn test_path_validation_with_spaces() {
        // Spaces should be handled correctly
        let result = validate_local_input_path("  /some/path  ", "inputPath");
        // Should fail because file doesn't exist, not because of spaces
        assert!(result.is_err());
        assert!(!result.unwrap_err().contains("empty"));
    }
}

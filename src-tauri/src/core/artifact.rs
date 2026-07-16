//! Shared artifact helpers: SHA-256 verification and safe archive extraction.
//!
//! These helpers are used by both the FFmpeg bundler ([`crate::core::ffmpeg::bundler`])
//! and the managed external-runtime installer ([`crate::core::managed_runtime`]).
//! They live here — rather than behind the `bundled-ffmpeg` feature — so GUI
//! builds can verify checksums and extract `.tar.gz` runtime archives without
//! pulling in the entire bundler feature set.
//!
//! The extraction routines intentionally reject symlinks, hard links, and path
//! traversal so a malicious archive cannot escape the destination directory.

#![cfg(any(feature = "gui", feature = "bundled-ffmpeg"))]

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// Errors raised while verifying or extracting a downloaded artifact.
#[derive(Debug, thiserror::Error)]
pub enum ArtifactError {
    /// An underlying I/O failure.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// The archive could not be extracted safely.
    #[error("Extraction failed: {0}")]
    Extraction(String),
}

/// Convenience result alias for artifact operations.
pub type ArtifactResult<T> = Result<T, ArtifactError>;

/// Builds a blocking reqwest client for fetching release metadata and artifacts.
///
/// Every caller shares the OpenReelio runtime-manager `User-Agent` (which also
/// satisfies GitHub's UA requirement) and a short 20s TCP connect timeout.
/// `total_timeout` bounds the ENTIRE request/response (connect + headers + body
/// read): a large streaming download must pass a generous value (the
/// managed-runtime installer uses 10 min for a ~100 MB artifact on slow links) so
/// a stalled CDN can never block a `.read()` forever, while small metadata
/// fetches can pass a short one. Previously each call site set only
/// `connect_timeout`, leaving reads unbounded.
pub fn blocking_http_client(total_timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(format!(
            "OpenReelio/{} runtime-manager",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(Duration::from_secs(20))
        .timeout(total_timeout)
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))
}

/// Computes the lowercase hex SHA-256 digest of a file.
pub fn sha256_hex_file(path: &Path) -> ArtifactResult<String> {
    use sha2::{Digest, Sha256};

    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// Returns whether a file's SHA-256 matches `expected_hex` (case-insensitive).
pub fn verify_sha256(path: &Path, expected_hex: &str) -> ArtifactResult<bool> {
    let actual = sha256_hex_file(path)?;
    Ok(actual.eq_ignore_ascii_case(expected_hex.trim()))
}

/// Resolves the safe on-disk destination for an archive entry.
///
/// Rejects entries whose path escapes `output_root` (via `..`, absolute roots,
/// or drive prefixes) or that resolve to an empty path.
pub fn archive_entry_destination(output_root: &Path, entry_name: &Path) -> ArtifactResult<PathBuf> {
    let mut destination = output_root.to_path_buf();
    let mut saw_component = false;

    for component in entry_name.components() {
        match component {
            Component::Normal(segment) => {
                saw_component = true;
                destination.push(segment);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ArtifactError::Extraction(format!(
                    "Archive entry escapes extraction directory: {}",
                    entry_name.display()
                )));
            }
        }
    }

    if !saw_component {
        return Err(ArtifactError::Extraction(
            "Archive entry has an empty path".to_string(),
        ));
    }

    Ok(destination)
}

/// Rejects an extraction destination whose ancestry contains an existing symlink.
///
/// This closes a TOCTOU gap where a prior entry could plant a symlink that a
/// later entry would then follow outside `output_root`.
pub fn ensure_no_existing_symlink_in_destination(
    output_root: &Path,
    destination: &Path,
) -> ArtifactResult<()> {
    let relative = destination.strip_prefix(output_root).map_err(|_| {
        ArtifactError::Extraction(format!(
            "Archive entry escapes extraction directory: {}",
            destination.display()
        ))
    })?;

    let mut current = output_root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(segment) => current.push(segment),
            Component::CurDir => continue,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ArtifactError::Extraction(format!(
                    "Archive entry escapes extraction directory: {}",
                    destination.display()
                )));
            }
        }

        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ArtifactError::Extraction(format!(
                    "Archive destination contains a symlink: {}",
                    current.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(ArtifactError::Io(error)),
        }
    }

    Ok(())
}

/// Extracts all regular file/directory entries from a tar archive into `output`.
///
/// `format` is a human-readable label (e.g. `"tar.gz"`) used in error messages.
/// Link entries and unsupported entry types are rejected.
pub fn extract_tar_entries<R: Read>(
    mut archive: tar::Archive<R>,
    output: &Path,
    format: &str,
) -> ArtifactResult<()> {
    let output_root = output.canonicalize()?;

    for entry in archive
        .entries()
        .map_err(|error| ArtifactError::Extraction(format!("Failed to read {format}: {error}")))?
    {
        let mut entry = entry.map_err(|error| {
            ArtifactError::Extraction(format!("Failed to read {format} entry: {error}"))
        })?;
        let entry_type = entry.header().entry_type();

        if entry_type.is_gnu_longname()
            || entry_type.is_gnu_longlink()
            || entry_type.is_pax_global_extensions()
            || entry_type.is_pax_local_extensions()
        {
            continue;
        }

        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(ArtifactError::Extraction(format!(
                "Archive link entries are not allowed: {}",
                entry
                    .path()
                    .map(|path| path.display().to_string())
                    .unwrap_or_default()
            )));
        }

        if !entry_type.is_file() && !entry_type.is_dir() && !entry_type.is_contiguous() {
            return Err(ArtifactError::Extraction(format!(
                "Unsupported archive entry type in {format}: {entry_type:?}"
            )));
        }

        let entry_path = entry.path().map_err(|error| {
            ArtifactError::Extraction(format!("Failed to read {format} entry path: {error}"))
        })?;
        let destination = archive_entry_destination(&output_root, entry_path.as_ref())?;
        ensure_no_existing_symlink_in_destination(&output_root, &destination)?;

        if entry_type.is_dir() {
            std::fs::create_dir_all(&destination)?;
            continue;
        }

        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }

        entry.unpack(&destination).map_err(|error| {
            ArtifactError::Extraction(format!("Failed to extract {format} entry: {error}"))
        })?;
    }

    Ok(())
}

/// Extracts a gzip-compressed tarball (`.tar.gz`) into `output`.
pub fn extract_tar_gz(archive: &Path, output: &Path) -> ArtifactResult<()> {
    std::fs::create_dir_all(output)?;
    let file = File::open(archive)?;
    let decompressor = flate2::read::GzDecoder::new(file);
    extract_tar_entries(tar::Archive::new(decompressor), output, "tar.gz")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_known_sha256() {
        let temp = tempfile::tempdir().expect("temp dir");
        let file = temp.path().join("content.bin");
        std::fs::write(&file, b"test content").expect("write");

        // SHA-256 of "test content".
        let expected = "6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72";
        assert_eq!(sha256_hex_file(&file).expect("hash"), expected);
        assert!(verify_sha256(&file, expected).expect("verify"));
        assert!(verify_sha256(&file, &expected.to_ascii_uppercase()).expect("verify upper"));
        assert!(!verify_sha256(&file, "deadbeef").expect("verify mismatch"));
    }

    #[test]
    fn rejects_path_traversal_entries() {
        let temp = tempfile::tempdir().expect("temp dir");
        let result = archive_entry_destination(temp.path(), Path::new("../evil.txt"));
        assert!(matches!(result, Err(ArtifactError::Extraction(_))));
    }

    #[test]
    fn resolves_nested_entry_within_root() {
        let temp = tempfile::tempdir().expect("temp dir");
        let destination =
            archive_entry_destination(temp.path(), Path::new("nested/dir/file.bin")).expect("dest");
        assert!(destination.starts_with(temp.path()));
        assert!(destination.ends_with("nested/dir/file.bin"));
    }
}

//! In-app FFmpeg installer (managed install).
//!
//! Downloads platform-specific FFmpeg/FFprobe archives described by the
//! compile-time embedded `scripts/ffmpeg-sources.json` manifest, verifies
//! checksums when the manifest provides a checksum source, extracts the
//! binaries, sanity-runs them, and atomically installs them into the managed
//! install directory:
//!
//! ```text
//! {data_local}/openreelio/ffmpeg/bin/ffmpeg[.exe]
//! {data_local}/openreelio/ffmpeg/bin/ffprobe[.exe]
//! ```
//!
//! The directory derivation intentionally avoids the Tauri path API (mirroring
//! the whisper model directory in `captions::whisper::default_models_dir`) so
//! the CLI can reuse the same managed install later.
//!
//! Failure at any point leaves a previous managed install intact: all work
//! happens in a temporary staging directory that is removed on drop, and the
//! final placement is a per-file atomic rename.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;

#[cfg(feature = "gui")]
use std::path::Path;

/// Embedded FFmpeg download-source manifest (single source of truth shared
/// with `scripts/prepare-bundled-ffmpeg.mjs` and `build.rs`).
const FFMPEG_SOURCES_MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../scripts/ffmpeg-sources.json"
));

/// Number of download attempts per URL before falling through to the next URL.
#[cfg(feature = "gui")]
const DOWNLOAD_ATTEMPTS_PER_URL: usize = 3;
/// Delay between download retries of the same URL.
#[cfg(feature = "gui")]
const DOWNLOAD_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);
/// Total timeout for a single archive download (connect + headers + body).
#[cfg(feature = "gui")]
const DOWNLOAD_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
/// Read/download buffer size (1 MiB), matching the managed runtime installer.
#[cfg(feature = "gui")]
const DOWNLOAD_BUFFER_BYTES: usize = 1024 * 1024;

// =============================================================================
// Manifest model
// =============================================================================

/// Parsed `ffmpeg-sources.json` manifest.
#[derive(Debug, Deserialize)]
struct SourcesManifest {
    /// Download sources keyed by Rust target triple.
    targets: HashMap<String, TargetSources>,
}

/// Download sources for one target triple.
#[derive(Debug, Clone, Deserialize)]
pub struct TargetSources {
    /// Archives to download for this target.
    archives: Vec<ArchiveSource>,
}

/// One downloadable archive and the binaries it provides.
#[derive(Debug, Clone, Deserialize)]
struct ArchiveSource {
    /// Logical archive name (`ffmpeg` / `ffprobe`), used for progress labels.
    name: String,
    /// Archive format: `zip` or `tar.xz`.
    format: String,
    /// Local filename to store the download as.
    filename: String,
    /// Binary file names expected inside the archive.
    binaries: Vec<String>,
    /// Candidate download URLs in priority order (later entries are fallbacks).
    urls: Vec<DownloadSource>,
}

/// One candidate URL with its checksum source.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadSource {
    /// Absolute download URL.
    url: String,
    /// Pinned lowercase-hex SHA-256 digest, when known ahead of time.
    #[serde(default)]
    sha256: Option<String>,
    /// URL of a checksum sidecar file (bare digest or `digest  filename` lines).
    #[serde(default)]
    sha256_url: Option<String>,
    /// Suffix appended to the redirect-resolved final URL to locate the
    /// provider's checksum sidecar.
    #[serde(default)]
    sha256_sidecar: Option<String>,
}

// =============================================================================
// Public types
// =============================================================================

/// Stage of an in-progress FFmpeg install, surfaced to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FFmpegInstallStage {
    /// Streaming an archive to disk.
    Downloading,
    /// Verifying the archive checksum.
    Verifying,
    /// Extracting binaries from the archive.
    Extracting,
    /// Staging, sanity-running, and swapping binaries into place.
    Installing,
    /// Install finished successfully.
    Done,
}

impl FFmpegInstallStage {
    /// Stable lowercase identifier used in the Tauri progress payload.
    pub fn as_str(self) -> &'static str {
        match self {
            FFmpegInstallStage::Downloading => "downloading",
            FFmpegInstallStage::Verifying => "verifying",
            FFmpegInstallStage::Extracting => "extracting",
            FFmpegInstallStage::Installing => "installing",
            FFmpegInstallStage::Done => "done",
        }
    }
}

/// Progress update emitted while installing FFmpeg.
#[derive(Debug, Clone)]
pub struct FFmpegInstallProgress {
    /// Current install stage.
    pub stage: FFmpegInstallStage,
    /// Logical binary/archive name the stage applies to (`ffmpeg` / `ffprobe`).
    pub binary: String,
    /// Bytes downloaded so far for the current archive.
    pub downloaded_bytes: u64,
    /// Total bytes for the current archive, when the server advertised one.
    pub total_bytes: Option<u64>,
}

/// Outcome of a successful managed FFmpeg install.
#[derive(Debug, Clone)]
pub struct ManagedFFmpegInstall {
    /// Installed ffmpeg binary path.
    pub ffmpeg_path: PathBuf,
    /// Installed ffprobe binary path.
    pub ffprobe_path: PathBuf,
    /// Whether every downloaded archive passed SHA-256 verification.
    pub verified: bool,
}

// =============================================================================
// Platform mapping and directories
// =============================================================================

/// Maps the compile-time platform to the manifest's target-triple key.
pub fn current_target_triple() -> Result<&'static str, String> {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Ok("x86_64-pc-windows-msvc");
    }
    if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        return Ok("x86_64-apple-darwin");
    }
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Ok("aarch64-apple-darwin");
    }
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        return Ok("x86_64-unknown-linux-gnu");
    }
    Err(format!(
        "Automatic FFmpeg installation is not supported on this platform ({}-{}). \
         Please install FFmpeg manually.",
        std::env::consts::OS,
        std::env::consts::ARCH
    ))
}

/// Base directory for the managed FFmpeg install.
///
/// Uses the same `{data_local}/openreelio/...` convention as the whisper model
/// directory so the CLI can derive the identical path without an AppHandle.
pub fn managed_ffmpeg_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("openreelio")
        .join("ffmpeg")
}

/// Directory that holds the managed ffmpeg/ffprobe binaries.
pub fn managed_install_dir() -> PathBuf {
    managed_ffmpeg_root().join("bin")
}

/// Loads and parses the embedded manifest, selecting the given target triple.
fn load_target_sources(target: &str) -> Result<TargetSources, String> {
    let manifest: SourcesManifest = serde_json::from_str(FFMPEG_SOURCES_MANIFEST)
        .map_err(|error| format!("Failed to parse embedded FFmpeg source manifest: {error}"))?;
    let sources =
        manifest.targets.get(target).cloned().ok_or_else(|| {
            format!("The FFmpeg source manifest has no entry for target '{target}'.")
        })?;
    if sources.archives.is_empty() {
        return Err(format!(
            "The FFmpeg source manifest entry for '{target}' lists no archives."
        ));
    }
    for archive in &sources.archives {
        if archive.binaries.is_empty() || archive.urls.is_empty() {
            return Err(format!(
                "The FFmpeg source manifest archive '{}' is missing binaries or URLs.",
                archive.name
            ));
        }
    }
    Ok(sources)
}

/// Parses a checksum sidecar body into the digest for `source_url`.
///
/// Mirrors `parseSha256Sidecar` in `scripts/prepare-bundled-ffmpeg.mjs`:
/// `digest  filename` lines are matched against the manifest URL basename
/// (redirect targets often resolve to opaque object-storage paths), and a
/// bare single-digest sidecar applies to the download as a whole.
fn parse_sha256_sidecar(sidecar_text: &str, source_url: &str) -> Option<String> {
    let download_basename = source_url
        .split('?')
        .next()
        .unwrap_or(source_url)
        .rsplit('/')
        .next()
        .unwrap_or(source_url)
        .to_ascii_lowercase();

    let is_digest = |token: &str| token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit());

    let mut digests: Vec<String> = Vec::new();
    for line in sidecar_text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some(first) = tokens.first() else {
            continue;
        };
        if !is_digest(first) {
            continue;
        }

        // Match "digest  filename" lines against the downloaded file first.
        if tokens.len() > 1 {
            let file_token = tokens[tokens.len() - 1].trim_start_matches('*');
            let file_basename = file_token
                .rsplit('/')
                .next()
                .unwrap_or(file_token)
                .to_ascii_lowercase();
            if file_basename == download_basename {
                return Some((*first).to_ascii_lowercase());
            }
        }

        digests.push((*first).to_ascii_lowercase());
    }

    // A bare-digest sidecar (single digest, no matching filename) applies to
    // the download.
    if digests.len() == 1 {
        digests.pop()
    } else {
        None
    }
}

// =============================================================================
// Install flow (GUI builds only: requires reqwest/zip/xz2)
// =============================================================================

/// Downloads, verifies, extracts, and atomically installs FFmpeg + FFprobe
/// into [`managed_install_dir`], reporting progress via `on_progress`.
///
/// Returns the installed binary paths and whether every archive passed
/// checksum verification. On any failure the previous managed install (if
/// any) is left untouched and all partial downloads are cleaned up.
#[cfg(feature = "gui")]
pub fn install_managed_ffmpeg<F>(mut on_progress: F) -> Result<ManagedFFmpegInstall, String>
where
    F: FnMut(FFmpegInstallProgress),
{
    use crate::core::artifact;

    let target = current_target_triple()?;
    let sources = load_target_sources(target)?;

    let root = managed_ffmpeg_root();
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create FFmpeg install directory: {error}"))?;

    // Staging lives next to the final bin dir (same filesystem) so the final
    // placement can be an atomic rename. TempDir removes everything on drop,
    // which covers partial downloads on every failure path.
    let staging = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(&root)
        .map_err(|error| format!("Failed to create FFmpeg staging directory: {error}"))?;
    let stage_bin_dir = staging.path().join("bin");
    std::fs::create_dir_all(&stage_bin_dir)
        .map_err(|error| format!("Failed to create FFmpeg staging directory: {error}"))?;

    let client = artifact::blocking_http_client(DOWNLOAD_TOTAL_TIMEOUT)?;

    let mut all_verified = true;
    let mut staged: HashMap<String, PathBuf> = HashMap::new();

    for archive in &sources.archives {
        let archive_path = staging.path().join(&archive.filename);
        let (verified, downloaded_bytes, total_bytes) =
            download_and_verify_archive(&client, archive, &archive_path, &mut on_progress)?;
        all_verified = all_verified && verified;

        on_progress(FFmpegInstallProgress {
            stage: FFmpegInstallStage::Extracting,
            binary: archive.name.clone(),
            downloaded_bytes,
            total_bytes,
        });
        let extract_dir = staging.path().join(format!("{}-extracted", archive.name));
        extract_archive(&archive.format, &archive_path, &extract_dir)?;
        // The consumed archive is no longer needed; free the space early.
        let _ = std::fs::remove_file(&archive_path);

        on_progress(FFmpegInstallProgress {
            stage: FFmpegInstallStage::Installing,
            binary: archive.name.clone(),
            downloaded_bytes,
            total_bytes,
        });
        for binary_name in &archive.binaries {
            let found = find_binary_recursive(&extract_dir, binary_name).ok_or_else(|| {
                format!("Binary '{binary_name}' was not found in the downloaded archive.")
            })?;
            let staged_path = stage_bin_dir.join(binary_name);
            std::fs::rename(&found, &staged_path).or_else(|_| {
                std::fs::copy(&found, &staged_path)
                    .map(|_| ())
                    .map_err(|error| {
                        format!("Failed to stage FFmpeg binary '{binary_name}': {error}")
                    })
            })?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&staged_path, std::fs::Permissions::from_mode(0o755))
                    .map_err(|error| {
                        format!("Failed to mark '{binary_name}' executable: {error}")
                    })?;
            }

            // FFmpeg binaries use the single-dash `-version` flag.
            crate::core::managed_runtime::verify_runnable_with_arg(&staged_path, "-version")?;
            staged.insert(binary_name.clone(), staged_path);
        }
        let _ = std::fs::remove_dir_all(&extract_dir);
    }

    // All archives are staged and sanity-checked; swap into the final bin dir.
    let (ffmpeg_name, ffprobe_name) = super::get_bundled_binary_names();
    for required in [ffmpeg_name, ffprobe_name] {
        if !staged.contains_key(required) {
            return Err(format!(
                "The downloaded FFmpeg archives did not provide '{required}'."
            ));
        }
    }

    let install_dir = managed_install_dir();
    std::fs::create_dir_all(&install_dir)
        .map_err(|error| format!("Failed to create FFmpeg install directory: {error}"))?;
    for (binary_name, staged_path) in &staged {
        let destination = install_dir.join(binary_name);
        // `rename` replaces the destination atomically on unix; on Windows a
        // live destination must be removed first (mirrors managed_runtime).
        if cfg!(windows) && destination.exists() {
            std::fs::remove_file(&destination)
                .map_err(|error| format!("Failed to replace existing '{binary_name}': {error}"))?;
        }
        std::fs::rename(staged_path, &destination)
            .map_err(|error| format!("Failed to install FFmpeg binary '{binary_name}': {error}"))?;
    }

    on_progress(FFmpegInstallProgress {
        stage: FFmpegInstallStage::Done,
        binary: "ffmpeg".to_string(),
        downloaded_bytes: 0,
        total_bytes: None,
    });

    Ok(ManagedFFmpegInstall {
        ffmpeg_path: install_dir.join(ffmpeg_name),
        ffprobe_path: install_dir.join(ffprobe_name),
        verified: all_verified,
    })
}

/// Downloads one archive, trying each URL (with per-URL retries) until one
/// downloads and verifies. Returns `(verified, downloaded_bytes, total_bytes)`.
#[cfg(feature = "gui")]
fn download_and_verify_archive<F>(
    client: &reqwest::blocking::Client,
    archive: &ArchiveSource,
    destination: &Path,
    on_progress: &mut F,
) -> Result<(bool, u64, Option<u64>), String>
where
    F: FnMut(FFmpegInstallProgress),
{
    use crate::core::artifact;

    let part_path = destination.with_extension("part");
    let mut errors: Vec<String> = Vec::new();

    for source in &archive.urls {
        let download =
            download_url_with_retries(client, &source.url, &part_path, &archive.name, on_progress);
        let (final_url, downloaded_bytes, total_bytes) = match download {
            Ok(result) => result,
            Err(error) => {
                errors.push(format!("{}: {error}", source.url));
                let _ = std::fs::remove_file(&part_path);
                continue;
            }
        };

        on_progress(FFmpegInstallProgress {
            stage: FFmpegInstallStage::Verifying,
            binary: archive.name.clone(),
            downloaded_bytes,
            total_bytes,
        });

        let verified = match resolve_expected_sha256(client, source, &final_url) {
            Ok(Some(expected)) => match artifact::verify_sha256(&part_path, &expected) {
                Ok(true) => true,
                Ok(false) => {
                    errors.push(format!("{}: SHA-256 checksum mismatch", source.url));
                    let _ = std::fs::remove_file(&part_path);
                    continue;
                }
                Err(error) => {
                    errors.push(format!(
                        "{}: checksum computation failed: {error}",
                        source.url
                    ));
                    let _ = std::fs::remove_file(&part_path);
                    continue;
                }
            },
            Ok(None) => {
                tracing::warn!(
                    url = source.url,
                    "No checksum source in manifest; accepting unverified FFmpeg download"
                );
                false
            }
            Err(error) => {
                errors.push(format!("{}: {error}", source.url));
                let _ = std::fs::remove_file(&part_path);
                continue;
            }
        };

        std::fs::rename(&part_path, destination)
            .map_err(|error| format!("Failed to finalize downloaded archive: {error}"))?;
        return Ok((verified, downloaded_bytes, total_bytes));
    }

    Err(format!(
        "All download URLs failed for {}: {}",
        archive.name,
        errors.join("; ")
    ))
}

/// Streams one URL to `part_path` with up to [`DOWNLOAD_ATTEMPTS_PER_URL`]
/// attempts. Returns `(redirect_resolved_url, downloaded_bytes, total_bytes)`.
#[cfg(feature = "gui")]
fn download_url_with_retries<F>(
    client: &reqwest::blocking::Client,
    url: &str,
    part_path: &Path,
    binary_label: &str,
    on_progress: &mut F,
) -> Result<(String, u64, Option<u64>), String>
where
    F: FnMut(FFmpegInstallProgress),
{
    let mut last_error = String::new();
    for attempt in 1..=DOWNLOAD_ATTEMPTS_PER_URL {
        match stream_download(client, url, part_path, binary_label, on_progress) {
            Ok(result) => return Ok(result),
            Err(error) => {
                tracing::warn!(
                    url,
                    attempt,
                    error,
                    "FFmpeg archive download attempt failed"
                );
                last_error = error;
                let _ = std::fs::remove_file(part_path);
                if attempt < DOWNLOAD_ATTEMPTS_PER_URL {
                    std::thread::sleep(DOWNLOAD_RETRY_DELAY);
                }
            }
        }
    }
    Err(last_error)
}

/// Streams a single download attempt to `part_path`, reporting progress.
#[cfg(feature = "gui")]
fn stream_download<F>(
    client: &reqwest::blocking::Client,
    url: &str,
    part_path: &Path,
    binary_label: &str,
    on_progress: &mut F,
) -> Result<(String, u64, Option<u64>), String>
where
    F: FnMut(FFmpegInstallProgress),
{
    use std::io::{Read, Write};

    let mut response = client
        .get(url)
        .send()
        .map_err(|error| format!("Download request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Download request failed with HTTP status {}",
            response.status()
        ));
    }

    let final_url = response.url().to_string();
    let total_bytes = response.content_length();
    let mut output = std::fs::File::create(part_path)
        .map_err(|error| format!("Failed to create partial download file: {error}"))?;
    let mut downloaded_bytes = 0_u64;
    let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_BYTES];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Download failed: {error}"))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("Failed to write download: {error}"))?;
        downloaded_bytes += read as u64;
        on_progress(FFmpegInstallProgress {
            stage: FFmpegInstallStage::Downloading,
            binary: binary_label.to_string(),
            downloaded_bytes,
            total_bytes,
        });
    }

    if downloaded_bytes == 0 {
        return Err("Downloaded archive is empty.".to_string());
    }
    if let Some(expected) = total_bytes {
        if downloaded_bytes != expected {
            return Err(format!(
                "Downloaded {downloaded_bytes} bytes but expected {expected} bytes."
            ));
        }
    }
    output
        .sync_all()
        .map_err(|error| format!("Failed to flush download: {error}"))?;

    Ok((final_url, downloaded_bytes, total_bytes))
}

/// Resolves the expected SHA-256 digest for a download source, if any.
///
/// Returns `Ok(None)` when the manifest provides no checksum source at all
/// (the caller marks the install unverified instead of failing).
#[cfg(feature = "gui")]
fn resolve_expected_sha256(
    client: &reqwest::blocking::Client,
    source: &DownloadSource,
    final_url: &str,
) -> Result<Option<String>, String> {
    if let Some(pinned) = &source.sha256 {
        return Ok(Some(pinned.clone()));
    }

    let sidecar_url = if let Some(url) = &source.sha256_url {
        url.clone()
    } else if let Some(suffix) = &source.sha256_sidecar {
        format!("{final_url}{suffix}")
    } else {
        return Ok(None);
    };

    let response = client
        .get(&sidecar_url)
        .send()
        .map_err(|error| format!("Failed to fetch checksum sidecar {sidecar_url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch checksum sidecar {sidecar_url}: HTTP {}",
            response.status()
        ));
    }
    let body = response
        .text()
        .map_err(|error| format!("Failed to read checksum sidecar {sidecar_url}: {error}"))?;

    parse_sha256_sidecar(&body, &source.url)
        .map(Some)
        .ok_or_else(|| format!("No matching SHA-256 digest found in {sidecar_url}"))
}

/// Extracts an archive by manifest format (`zip` or `tar.xz`).
#[cfg(feature = "gui")]
fn extract_archive(format: &str, archive_path: &Path, output_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(output_dir)
        .map_err(|error| format!("Failed to create extraction directory: {error}"))?;
    match format {
        "zip" => extract_zip(archive_path, output_dir),
        "tar.xz" => extract_tar_xz(archive_path, output_dir),
        other => Err(format!("Unsupported archive format: {other}")),
    }
}

/// Safely extracts a zip archive (rejects symlinks and path traversal).
#[cfg(feature = "gui")]
fn extract_zip(archive_path: &Path, output_dir: &Path) -> Result<(), String> {
    use crate::core::artifact::{
        archive_entry_destination, ensure_no_existing_symlink_in_destination,
    };

    let file = std::fs::File::open(archive_path)
        .map_err(|error| format!("Failed to open archive: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Failed to open zip archive: {error}"))?;
    let output_root = output_dir
        .canonicalize()
        .map_err(|error| format!("Failed to resolve extraction directory: {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read zip entry: {error}"))?;

        if entry.is_symlink() {
            return Err(format!(
                "Archive symlink entries are not allowed: {}",
                entry.name()
            ));
        }

        let entry_name = entry.enclosed_name().ok_or_else(|| {
            format!(
                "Archive entry escapes extraction directory: {}",
                entry.name()
            )
        })?;
        let destination = archive_entry_destination(&output_root, &entry_name)
            .map_err(|error| error.to_string())?;
        ensure_no_existing_symlink_in_destination(&output_root, &destination)
            .map_err(|error| error.to_string())?;

        if entry.is_dir() {
            std::fs::create_dir_all(&destination)
                .map_err(|error| format!("Failed to create directory: {error}"))?;
            continue;
        }

        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create directory: {error}"))?;
        }
        let mut output_file = std::fs::File::create(&destination)
            .map_err(|error| format!("Failed to create extracted file: {error}"))?;
        std::io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("Failed to extract zip entry: {error}"))?;

        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(mode));
        }
    }

    Ok(())
}

/// Safely extracts a `.tar.xz` archive via the shared tar extraction helper.
#[cfg(feature = "gui")]
fn extract_tar_xz(archive_path: &Path, output_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path)
        .map_err(|error| format!("Failed to open archive: {error}"))?;
    let decompressor = xz2::read::XzDecoder::new(file);
    crate::core::artifact::extract_tar_entries(
        tar::Archive::new(decompressor),
        output_dir,
        "tar.xz",
    )
    .map_err(|error| error.to_string())
}

/// Recursively finds the first regular file whose name case-insensitively
/// matches `binary_name` (mirrors `findBinary` in the prepare script).
#[cfg(feature = "gui")]
fn find_binary_recursive(dir: &Path, binary_name: &str) -> Option<PathBuf> {
    for entry in walkdir::WalkDir::new(dir).follow_links(false) {
        let Ok(entry) = entry else {
            continue;
        };
        if entry.file_type().is_file()
            && entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(binary_name)
        {
            return Some(entry.path().to_path_buf());
        }
    }
    None
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_parses_and_covers_all_release_targets() {
        let manifest: SourcesManifest =
            serde_json::from_str(FFMPEG_SOURCES_MANIFEST).expect("manifest parses");

        for target in [
            "x86_64-pc-windows-msvc",
            "x86_64-apple-darwin",
            "aarch64-apple-darwin",
            "x86_64-unknown-linux-gnu",
        ] {
            let sources = manifest.targets.get(target).expect("target present");
            assert!(!sources.archives.is_empty(), "{target} has archives");
            for archive in &sources.archives {
                assert!(!archive.name.is_empty());
                assert!(matches!(archive.format.as_str(), "zip" | "tar.xz"));
                assert!(!archive.filename.is_empty());
                assert!(!archive.binaries.is_empty());
                assert!(!archive.urls.is_empty());
                for url in &archive.urls {
                    assert!(url.url.starts_with("https://"));
                }
            }
        }
    }

    #[test]
    fn manifest_checksum_fields_deserialize_camel_case() {
        let source: DownloadSource = serde_json::from_str(
            r#"{"url":"https://example.com/a.zip","sha256":null,"sha256Url":"https://example.com/a.zip.sha256","sha256Sidecar":".sha256"}"#,
        )
        .expect("source parses");
        assert!(source.sha256.is_none());
        assert_eq!(
            source.sha256_url.as_deref(),
            Some("https://example.com/a.zip.sha256")
        );
        assert_eq!(source.sha256_sidecar.as_deref(), Some(".sha256"));
    }

    #[test]
    fn current_target_triple_maps_to_a_manifest_entry() {
        // Development and CI hosts are always one of the supported targets;
        // the mapped triple must exist in the manifest.
        let target = current_target_triple().expect("supported platform");
        let sources = load_target_sources(target).expect("manifest entry");
        assert!(!sources.archives.is_empty());
    }

    #[test]
    fn load_target_sources_rejects_unknown_target() {
        let error = load_target_sources("aarch64-unknown-linux-gnu").unwrap_err();
        assert!(error.contains("no entry"));
    }

    #[test]
    fn managed_install_dir_uses_data_local_convention() {
        let dir = managed_install_dir();
        let path = dir.to_string_lossy().replace('\\', "/");
        assert!(
            path.ends_with("openreelio/ffmpeg/bin"),
            "unexpected managed install dir: {path}"
        );
    }

    #[test]
    fn sidecar_parser_accepts_bare_digest() {
        let digest = "6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72";
        assert_eq!(
            parse_sha256_sidecar(&format!("{digest}\n"), "https://example.com/ffmpeg.zip"),
            Some(digest.to_string())
        );
    }

    #[test]
    fn sidecar_parser_matches_filename_lines() {
        let expected = "6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72";
        let other = "0000000000000000000000000000000000000000000000000000000000000000";
        let sidecar =
            format!("{other}  other-file.zip\n{expected}  ffmpeg-release-essentials.zip\n");
        assert_eq!(
            parse_sha256_sidecar(
                &sidecar,
                "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
            ),
            Some(expected.to_string())
        );
    }

    #[test]
    fn sidecar_parser_rejects_ambiguous_content() {
        let sidecar = "0000000000000000000000000000000000000000000000000000000000000000  a.zip\n\
                       1111111111111111111111111111111111111111111111111111111111111111  b.zip\n";
        assert_eq!(
            parse_sha256_sidecar(sidecar, "https://example.com/c.zip"),
            None
        );
        assert_eq!(
            parse_sha256_sidecar("not a digest", "https://example.com/c.zip"),
            None
        );
    }

    #[test]
    #[cfg(feature = "gui")]
    fn finds_binary_case_insensitively_in_nested_dirs() {
        let temp = tempfile::tempdir().expect("temp dir");
        let nested = temp.path().join("pkg").join("bin");
        std::fs::create_dir_all(&nested).expect("dirs");
        std::fs::write(temp.path().join("README"), b"x").expect("sibling");
        let target = nested.join("FFmpeg.exe");
        std::fs::write(&target, b"bin").expect("binary");

        assert_eq!(
            find_binary_recursive(temp.path(), "ffmpeg.exe"),
            Some(target)
        );
        assert_eq!(find_binary_recursive(temp.path(), "ffprobe"), None);
    }

    /// Real end-to-end download install. Requires network; run manually with
    /// `cargo test -p openreelio --lib installer -- --ignored`.
    #[test]
    #[cfg(feature = "gui")]
    #[ignore = "downloads FFmpeg archives from the network"]
    fn real_install_downloads_and_installs_ffmpeg() {
        let result = install_managed_ffmpeg(|progress| {
            println!(
                "{} {} {}/{:?}",
                progress.stage.as_str(),
                progress.binary,
                progress.downloaded_bytes,
                progress.total_bytes
            );
        })
        .expect("install succeeds");
        assert!(result.ffmpeg_path.exists());
        assert!(result.ffprobe_path.exists());
    }
}

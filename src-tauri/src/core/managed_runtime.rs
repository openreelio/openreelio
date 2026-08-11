//! Generic installer for app-managed native CLI runtimes (codex, claude).
//!
//! OpenReelio pins official native binaries for the external agent CLIs and
//! installs them into versioned directories under the app data folder:
//!
//! ```text
//! {app_data}/OpenReelio/{runtime}/versions/{version}/{binary}
//! {app_data}/OpenReelio/{runtime}/current            # text pointer -> "{version}"
//! ```
//!
//! The `current` file is a plain-text pointer (NOT a symlink, to avoid Windows
//! symlink-privilege requirements). Installs are atomic: the binary is fully
//! downloaded, checksum-verified, extracted, and sanity-run before the pointer
//! is swapped, so a failed install never replaces a working runtime.
//!
//! This module is generic over a per-runtime [`ManagedRuntimeDescriptor`]; the
//! codex/claude modules provide the artifact resolvers (URL + SHA-256) so the
//! download/verify/swap machinery is written once.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::core::artifact;

/// Basename of the text pointer file that records the active version.
const CURRENT_POINTER_FILE: &str = "current";
/// Basename of the in-progress download inside a version directory.
const PARTIAL_DOWNLOAD_FILE: &str = ".download.part";
/// Read/download buffer size (1 MiB), matching the whisper model downloader.
const DOWNLOAD_BUFFER_BYTES: usize = 1024 * 1024;
/// Total timeout for the artifact download (connect + headers + full body).
///
/// 10 minutes comfortably covers a ~100 MB binary even on a slow link while
/// ensuring a stalled CDN can never block a `.read()` forever and hold the
/// [`crate::ipc::commands::external_agent::RuntimeInstallGuard`] open indefinitely.
const DOWNLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
/// Bounded wait for the post-install `<binary> --version` sanity run.
const VERIFY_RUNNABLE_TIMEOUT: Duration = Duration::from_secs(30);
/// Poll interval while waiting on the sanity-run child to exit.
const VERIFY_RUNNABLE_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Shape of a downloadable artifact for a runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactFormat {
    /// A single native executable saved directly as the runtime binary.
    RawExecutable,
    /// A gzip-compressed tarball from which one named binary is extracted.
    TarGz,
}

/// A resolved download target for a specific runtime version and platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedArtifact {
    /// Absolute download URL.
    pub url: String,
    /// Expected lowercase-hex SHA-256 (64 hex chars) of the downloaded file.
    pub sha256: String,
    /// How the downloaded file should be turned into the runtime binary.
    pub format: ArtifactFormat,
    /// For [`ArtifactFormat::TarGz`]: the file name to locate inside the archive.
    pub archive_binary_name: Option<String>,
}

/// Static description of an app-managed runtime install location.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedRuntimeDescriptor {
    /// Stable runtime id (`"codex"` / `"claude"`), used in the progress event.
    pub runtime_id: &'static str,
    /// Root directory: `{app_data}/OpenReelio/{runtime}`.
    pub root_dir: PathBuf,
    /// Final installed binary filename (e.g. `codex.exe` / `claude`).
    pub binary_name: String,
}

impl ManagedRuntimeDescriptor {
    /// Directory that holds all installed versions.
    pub fn versions_dir(&self) -> PathBuf {
        self.root_dir.join("versions")
    }

    /// Directory for a specific version.
    pub fn version_dir(&self, version: &str) -> PathBuf {
        self.versions_dir().join(version)
    }

    /// Absolute path of the installed binary for a specific version.
    pub fn executable_path(&self, version: &str) -> PathBuf {
        self.version_dir(version).join(&self.binary_name)
    }

    /// Path of the text pointer file recording the active version.
    pub fn current_pointer_path(&self) -> PathBuf {
        self.root_dir.join(CURRENT_POINTER_FILE)
    }

    /// Reads the raw active-version pointer text, if present and non-empty.
    ///
    /// This reflects only what the `current` pointer file names; the referenced
    /// binary may be absent (e.g. a partially cleaned or interrupted install).
    /// Prefer [`Self::installed_version`] when you need a version whose binary is
    /// guaranteed to exist.
    pub fn pointer_version(&self) -> Option<String> {
        let contents = std::fs::read_to_string(self.current_pointer_path()).ok()?;
        let trimmed = contents.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }

    /// Returns the active version only when its installed binary exists on disk.
    ///
    /// A dangling pointer (a version recorded in `current` whose binary file is
    /// missing) reports `None`, so callers never treat a vanished install as an
    /// installed runtime.
    pub fn installed_version(&self) -> Option<String> {
        let version = self.pointer_version()?;
        if self.executable_path(&version).is_file() {
            Some(version)
        } else {
            None
        }
    }

    /// Returns the active managed executable path, if the pointer resolves to a
    /// version whose binary exists on disk.
    pub fn current_executable(&self) -> Option<PathBuf> {
        let version = self.installed_version()?;
        Some(self.executable_path(&version))
    }

    /// Atomically writes the pointer file to record `version` as active.
    ///
    /// Writes `current.tmp` first (with `sync_all`), then renames it over the
    /// pointer path so a concurrent reader never observes a partial write.
    pub fn write_pointer(&self, version: &str) -> Result<(), String> {
        std::fs::create_dir_all(&self.root_dir)
            .map_err(|error| format!("Failed to create runtime directory: {error}"))?;

        let pointer_path = self.current_pointer_path();
        let temp_path = self.root_dir.join(format!("{CURRENT_POINTER_FILE}.tmp"));

        let mut file = std::fs::File::create(&temp_path)
            .map_err(|error| format!("Failed to write runtime pointer: {error}"))?;
        file.write_all(version.trim().as_bytes())
            .map_err(|error| format!("Failed to write runtime pointer: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to flush runtime pointer: {error}"))?;
        drop(file);

        // `std::fs::rename` overwrites the destination atomically on BOTH
        // platforms (rename(2) on unix; MoveFileExW with MOVEFILE_REPLACE_EXISTING
        // on Windows), so the live pointer is NOT pre-deleted. If the rename fails
        // (e.g. a transient AV lock on Windows) the previous pointer stays intact
        // and the working runtime remains addressable, rather than being left
        // pointerless by a delete that a failed rename never replaced.
        std::fs::rename(&temp_path, &pointer_path).map_err(|error| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Failed to finalize runtime pointer: {error}")
        })
    }

    /// Best-effort removal of every version directory that is not the active one.
    ///
    /// Locked or in-use directories (EPERM on Windows) are ignored; they are
    /// retried the next time cleanup runs.
    pub fn cleanup_stale_versions(&self) {
        // Keep the pointer-referenced version dir even if its binary is briefly
        // absent; deletion is scoped to versions the pointer does NOT name.
        let active = self.pointer_version();
        let Ok(entries) = std::fs::read_dir(self.versions_dir()) else {
            return;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if active.as_deref() == Some(name) {
                continue;
            }
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Stage of an in-progress install, surfaced to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallStage {
    /// Preparing directories before the download starts.
    Preparing,
    /// Streaming the artifact to disk.
    Downloading,
    /// Verifying the SHA-256 checksum.
    Verifying,
    /// Extracting and finalizing the binary.
    Installing,
    /// Install completed and the pointer was swapped.
    Complete,
}

impl InstallStage {
    /// Stable lowercase identifier used in the Tauri progress payload.
    pub fn as_str(self) -> &'static str {
        match self {
            InstallStage::Preparing => "preparing",
            InstallStage::Downloading => "downloading",
            InstallStage::Verifying => "verifying",
            InstallStage::Installing => "installing",
            InstallStage::Complete => "complete",
        }
    }
}

/// Progress update emitted while installing a managed runtime.
#[derive(Debug, Clone)]
pub struct InstallProgress {
    /// Runtime id (`"codex"` / `"claude"`).
    pub runtime_id: &'static str,
    /// Bytes downloaded so far.
    pub downloaded_bytes: u64,
    /// Total bytes, when the server advertised a content length.
    pub total_bytes: Option<u64>,
    /// Current install stage.
    pub stage: InstallStage,
}

impl InstallProgress {
    /// Download completion percentage in `[0, 100]`, when the total is known.
    pub fn percent(&self) -> Option<f64> {
        let total = self.total_bytes?;
        if total == 0 {
            return None;
        }
        Some((self.downloaded_bytes as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
    }
}

/// RAII guard that deletes a partial download unless explicitly kept.
struct PartialDownloadGuard {
    path: PathBuf,
    keep: bool,
}

impl PartialDownloadGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for PartialDownloadGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Downloads, verifies, installs, and activates a specific runtime version.
///
/// The flow mirrors the whisper model downloader and the FFmpeg bundler:
/// stream to a partial file with progress, verify the pinned SHA-256, extract
/// (for tar.gz artifacts), make the binary executable, sanity-run
/// `<binary> --version`, and only then swap the `current` pointer.
///
/// Returns the path of the installed executable on success. On any failure the
/// previous active version and pointer are left untouched.
pub fn install_version<F>(
    descriptor: &ManagedRuntimeDescriptor,
    version: &str,
    artifact_spec: &ResolvedArtifact,
    mut on_progress: F,
) -> Result<PathBuf, String>
where
    F: FnMut(InstallProgress),
{
    let version = version.trim();
    if version.is_empty() {
        return Err("Runtime version must not be empty.".to_string());
    }

    let emit = |on_progress: &mut F, downloaded: u64, total: Option<u64>, stage: InstallStage| {
        on_progress(InstallProgress {
            runtime_id: descriptor.runtime_id,
            downloaded_bytes: downloaded,
            total_bytes: total,
            stage,
        });
    };

    emit(&mut on_progress, 0, None, InstallStage::Preparing);

    let version_dir = descriptor.version_dir(version);
    std::fs::create_dir_all(&version_dir)
        .map_err(|error| format!("Failed to create version directory: {error}"))?;

    let part_path = version_dir.join(PARTIAL_DOWNLOAD_FILE);
    if part_path.exists() {
        std::fs::remove_file(&part_path)
            .map_err(|error| format!("Failed to remove stale partial download: {error}"))?;
    }
    let mut guard = PartialDownloadGuard::new(part_path.clone());

    // --- Download (streaming) ------------------------------------------------
    // The shared client carries a generous total timeout so a stalled read can
    // never wedge the install lock (see `DOWNLOAD_TOTAL_TIMEOUT`).
    let client = artifact::blocking_http_client(DOWNLOAD_TOTAL_TIMEOUT)?;

    let mut response = client
        .get(&artifact_spec.url)
        .send()
        .map_err(|error| format!("Download request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Download request failed with HTTP status {}",
            response.status()
        ));
    }

    let content_length = response.content_length();
    let mut output = std::fs::File::create(&part_path)
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
        emit(
            &mut on_progress,
            downloaded_bytes,
            content_length,
            InstallStage::Downloading,
        );
    }

    if downloaded_bytes == 0 {
        return Err("Downloaded runtime file is empty.".to_string());
    }
    if let Some(expected) = content_length {
        if downloaded_bytes != expected {
            return Err(format!(
                "Downloaded {downloaded_bytes} bytes but expected {expected} bytes."
            ));
        }
    }
    output
        .sync_all()
        .map_err(|error| format!("Failed to flush download: {error}"))?;
    drop(output);

    // --- Verify --------------------------------------------------------------
    emit(
        &mut on_progress,
        downloaded_bytes,
        content_length,
        InstallStage::Verifying,
    );
    let matches = artifact::verify_sha256(&part_path, &artifact_spec.sha256)
        .map_err(|error| format!("Failed to verify runtime checksum: {error}"))?;
    if !matches {
        return Err(format!(
            "Runtime checksum verification failed for version {version}. Expected {}.",
            artifact_spec.sha256
        ));
    }

    // --- Install (extract / place) ------------------------------------------
    emit(
        &mut on_progress,
        downloaded_bytes,
        content_length,
        InstallStage::Installing,
    );
    let executable_path = descriptor.executable_path(version);
    // Stage next to the final path and only swap once the new binary proved
    // runnable, so a failed placement/validation never destroys a working
    // binary of the same version (a same-version reinstall/repair would
    // otherwise leave the `current` pointer dangling).
    let staged_name = format!(
        "staged-{}",
        executable_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("runtime-binary")
    );
    let staged_path = executable_path.with_file_name(staged_name);
    let _ = std::fs::remove_file(&staged_path);

    match artifact_spec.format {
        ArtifactFormat::RawExecutable => {
            std::fs::rename(&part_path, &staged_path)
                .map_err(|error| format!("Failed to install runtime binary: {error}"))?;
            guard.keep();
        }
        ArtifactFormat::TarGz => {
            let inner_name = artifact_spec
                .archive_binary_name
                .as_deref()
                .ok_or_else(|| "Missing archive binary name for tar.gz runtime.".to_string())?;
            let extract_dir = version_dir.join(".extract");
            let _ = std::fs::remove_dir_all(&extract_dir);
            artifact::extract_tar_gz(&part_path, &extract_dir)
                .map_err(|error| format!("Failed to extract runtime archive: {error}"))?;
            let found = find_binary_in_dir(&extract_dir, inner_name).ok_or_else(|| {
                format!("Runtime binary '{inner_name}' was not found in the downloaded archive.")
            })?;
            std::fs::rename(&found, &staged_path).or_else(|_| {
                std::fs::copy(&found, &staged_path)
                    .map(|_| ())
                    .map_err(|error| format!("Failed to install runtime binary: {error}"))
            })?;
            let _ = std::fs::remove_dir_all(&extract_dir);
            // The .part file is consumed once extracted; drop guard clean-up.
        }
    }

    // --- Make executable + sanity-run (still on the staged file) -------------
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("Failed to mark runtime binary executable: {error}"))?;
    }

    verify_runnable(&staged_path)?;

    // --- Swap into place ------------------------------------------------------
    if executable_path.exists() {
        std::fs::remove_file(&executable_path)
            .map_err(|error| format!("Failed to replace existing runtime binary: {error}"))?;
    }
    std::fs::rename(&staged_path, &executable_path)
        .map_err(|error| format!("Failed to activate runtime binary: {error}"))?;

    // --- Activate ------------------------------------------------------------
    descriptor.write_pointer(version)?;
    descriptor.cleanup_stale_versions();

    emit(
        &mut on_progress,
        downloaded_bytes,
        content_length,
        InstallStage::Complete,
    );

    Ok(executable_path)
}

/// Runs `<binary> --version` to confirm the freshly installed file is runnable.
fn verify_runnable(path: &Path) -> Result<(), String> {
    verify_runnable_with_arg(path, "--version")
}

/// Runs `<binary> <version_arg>` to confirm a freshly installed file is runnable.
///
/// This is blocking code, so the wait is bounded by [`VERIFY_RUNNABLE_TIMEOUT`]:
/// the child is spawned, polled with `try_wait`, and killed if it does not exit
/// in time. Without this, a hung version probe would block the install (and its
/// install guard) forever. Shared with the FFmpeg installer, whose binaries use
/// the single-dash `-version` flag.
pub(crate) fn verify_runnable_with_arg(path: &Path, version_arg: &str) -> Result<(), String> {
    if !path.exists() {
        return Err(format!(
            "Installed runtime binary does not exist: {}",
            path.display()
        ));
    }

    let mut command = std::process::Command::new(path);
    crate::core::process::configure_std_command(&mut command);
    // Output is discarded (only the exit status matters); null'ing the pipes also
    // avoids any chance of a full-pipe deadlock during the bounded wait.
    let mut child = command
        .arg(version_arg)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("Installed runtime binary failed to execute: {error}"))?;

    let deadline = std::time::Instant::now() + VERIFY_RUNNABLE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!(
                        "Installed runtime binary returned a non-zero exit code: {}",
                        path.display()
                    ))
                };
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "Installed runtime binary did not respond to --version within {}s: {}",
                        VERIFY_RUNNABLE_TIMEOUT.as_secs(),
                        path.display()
                    ));
                }
                std::thread::sleep(VERIFY_RUNNABLE_POLL_INTERVAL);
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed to check installed runtime binary: {error}"));
            }
        }
    }
}

/// Recursively finds the first regular file named `binary_name` under `dir`.
fn find_binary_in_dir(dir: &Path, binary_name: &str) -> Option<PathBuf> {
    for entry in walkdir::WalkDir::new(dir).follow_links(false) {
        // Skip individual unreadable entries (e.g. a permission error on one
        // path) instead of aborting the whole search — the target binary may
        // still exist further along the walk.
        let Ok(entry) = entry else {
            continue;
        };
        if entry.file_type().is_file() && entry.file_name().to_string_lossy() == binary_name {
            return Some(entry.path().to_path_buf());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(root: &Path) -> ManagedRuntimeDescriptor {
        ManagedRuntimeDescriptor {
            runtime_id: "codex",
            root_dir: root.to_path_buf(),
            binary_name: "codex".to_string(),
        }
    }

    #[test]
    fn pointer_round_trips_and_resolves_executable() {
        let temp = tempfile::tempdir().expect("temp dir");
        let descriptor = descriptor(temp.path());

        assert_eq!(descriptor.pointer_version(), None);
        assert_eq!(descriptor.installed_version(), None);
        assert_eq!(descriptor.current_executable(), None);

        // No binary yet -> the pointer text resolves, but the version is not
        // treated as installed (dangling pointer) and no executable resolves.
        descriptor.write_pointer("1.2.3").expect("write pointer");
        assert_eq!(descriptor.pointer_version(), Some("1.2.3".to_string()));
        assert_eq!(descriptor.installed_version(), None);
        assert_eq!(descriptor.current_executable(), None);

        // Materialize the binary and confirm resolution.
        let executable = descriptor.executable_path("1.2.3");
        std::fs::create_dir_all(executable.parent().expect("parent")).expect("dir");
        std::fs::write(&executable, b"binary").expect("write binary");
        assert_eq!(descriptor.installed_version(), Some("1.2.3".to_string()));
        assert_eq!(descriptor.current_executable(), Some(executable));
    }

    #[test]
    fn installed_version_is_none_when_binary_vanishes() {
        let temp = tempfile::tempdir().expect("temp dir");
        let descriptor = descriptor(temp.path());

        // Install a version with its binary present.
        descriptor.write_pointer("4.5.6").expect("pointer");
        let executable = descriptor.executable_path("4.5.6");
        std::fs::create_dir_all(executable.parent().expect("parent")).expect("dir");
        std::fs::write(&executable, b"bin").expect("bin");
        assert_eq!(descriptor.installed_version(), Some("4.5.6".to_string()));

        // Remove the binary but leave the pointer dangling.
        std::fs::remove_file(&executable).expect("remove bin");
        assert_eq!(descriptor.pointer_version(), Some("4.5.6".to_string()));
        assert_eq!(descriptor.installed_version(), None);
        assert_eq!(descriptor.current_executable(), None);
    }

    #[test]
    fn pointer_write_is_atomic_across_updates() {
        let temp = tempfile::tempdir().expect("temp dir");
        let descriptor = descriptor(temp.path());

        descriptor.write_pointer("1.0.0").expect("first");
        descriptor.write_pointer("2.0.0").expect("second");

        // The pointer text tracks the latest write (no binaries materialized).
        assert_eq!(descriptor.pointer_version(), Some("2.0.0".to_string()));
        // No leftover temp file remains after the swap.
        assert!(!temp.path().join("current.tmp").exists());
    }

    #[test]
    fn cleanup_removes_only_inactive_versions() {
        let temp = tempfile::tempdir().expect("temp dir");
        let descriptor = descriptor(temp.path());

        for version in ["1.0.0", "2.0.0", "3.0.0"] {
            let dir = descriptor.version_dir(version);
            std::fs::create_dir_all(&dir).expect("version dir");
            std::fs::write(dir.join("codex"), b"bin").expect("bin");
        }
        descriptor.write_pointer("3.0.0").expect("pointer");

        descriptor.cleanup_stale_versions();

        assert!(!descriptor.version_dir("1.0.0").exists());
        assert!(!descriptor.version_dir("2.0.0").exists());
        assert!(descriptor.version_dir("3.0.0").exists());
    }

    #[test]
    fn percent_is_none_without_total() {
        let progress = InstallProgress {
            runtime_id: "codex",
            downloaded_bytes: 10,
            total_bytes: None,
            stage: InstallStage::Downloading,
        };
        assert_eq!(progress.percent(), None);
    }

    #[test]
    fn percent_is_bounded_when_total_known() {
        let progress = InstallProgress {
            runtime_id: "codex",
            downloaded_bytes: 50,
            total_bytes: Some(200),
            stage: InstallStage::Downloading,
        };
        assert_eq!(progress.percent(), Some(25.0));
    }

    #[test]
    fn install_stage_labels_are_stable() {
        assert_eq!(InstallStage::Preparing.as_str(), "preparing");
        assert_eq!(InstallStage::Downloading.as_str(), "downloading");
        assert_eq!(InstallStage::Verifying.as_str(), "verifying");
        assert_eq!(InstallStage::Installing.as_str(), "installing");
        assert_eq!(InstallStage::Complete.as_str(), "complete");
    }

    #[test]
    fn pointer_rename_overwrites_existing_pointer() {
        let temp = tempfile::tempdir().expect("temp dir");
        let descriptor = descriptor(temp.path());

        // Establish a live pointer, then overwrite it in place. The rename must
        // replace the existing pointer without a pre-delete, so the pointer file
        // is never transiently absent and always names the latest version.
        descriptor.write_pointer("1.0.0").expect("first pointer");
        assert_eq!(descriptor.pointer_version(), Some("1.0.0".to_string()));
        assert!(descriptor.current_pointer_path().is_file());

        descriptor
            .write_pointer("2.0.0")
            .expect("overwrite pointer");
        assert_eq!(descriptor.pointer_version(), Some("2.0.0".to_string()));
        assert!(descriptor.current_pointer_path().is_file());
        assert!(!temp.path().join("current.tmp").exists());
    }

    #[test]
    fn finds_binary_in_nested_directory_among_siblings() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();

        // Sibling files/dirs force the walk to continue past non-matching entries
        // instead of aborting on the first one it inspects.
        std::fs::create_dir_all(root.join("a/b/c")).expect("dirs");
        std::fs::write(root.join("a/other.txt"), b"x").expect("sibling file");
        std::fs::write(root.join("a/b/README"), b"x").expect("sibling file");
        let target = root.join("a/b/c/codex");
        std::fs::write(&target, b"bin").expect("binary");

        assert_eq!(find_binary_in_dir(root, "codex"), Some(target));
        assert_eq!(find_binary_in_dir(root, "missing"), None);
    }
}

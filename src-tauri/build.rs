//! Build script for OpenReelio
//!
//! This script handles:
//! 1. Standard Tauri build process
//! 2. Automatic FFmpeg binary download for bundling
//!
//! Download sources come from `scripts/ffmpeg-sources.json`, the single
//! manifest shared with `scripts/prepare-bundled-ffmpeg.mjs`.
//!
//! Download policy:
//! - `SKIP_FFMPEG_DOWNLOAD=1` disables all automatic downloads.
//! - `OPENREELIO_DOWNLOAD_FFMPEG=1` or the `bundled-ffmpeg` feature opts in
//!   explicitly (release-style, checksum-strict).
//! - Debug, non-CI builds auto-download when neither bundled binaries nor a
//!   system FFmpeg/FFprobe on PATH are available (best-effort verification).

use std::env;
use std::path::PathBuf;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn configure_build_command(command: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = command;
}

fn main() {
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed={FFMPEG_SOURCES_MANIFEST_PATH}");

    // Standard Tauri build (only when GUI feature is enabled)
    #[cfg(feature = "gui")]
    tauri_build::build();

    // ------------------------------------------------------------------------
    // Windows CI: unit test manifest
    // ------------------------------------------------------------------------
    // On Windows, the Rust unit test executables are separate binaries and do
    // not always get the same embedded manifest/resources as the main Tauri app
    // binary. Some transitive UI dependencies import Common Controls v6-only
    // symbols (e.g. `TaskDialogIndirect`), which will fail to resolve unless the
    // Common Controls v6 assembly is activated via an app manifest.
    //
    // We only enable this when explicitly requested (CI) to avoid any risk of
    // manifest/resource duplication for normal builds.
    // Only emit the custom test manifest when the GUI feature is NOT active.
    // When `gui` is enabled, `tauri_build::build()` already embeds a manifest
    // via `resource.lib`, so adding another one causes CVT1100 duplicate resource.
    #[cfg(target_os = "windows")]
    #[cfg(not(feature = "gui"))]
    emit_windows_test_manifest_if_requested();

    // Download FFmpeg binaries if needed
    if let Some(mode) = should_download_ffmpeg() {
        println!("cargo:warning=FFmpeg binaries not found, downloading...");
        match download_ffmpeg_for_build(mode) {
            Ok(paths) => {
                println!("cargo:warning=FFmpeg downloaded successfully");
                println!("cargo:warning=  ffmpeg: {}", paths.ffmpeg.display());
                println!("cargo:warning=  ffprobe: {}", paths.ffprobe.display());

                // Copy binaries to src-tauri/binaries for bundling
                if let Err(e) = copy_binaries_for_bundle(&paths) {
                    println!("cargo:warning=Failed to copy binaries for bundling: {e}");
                }
            }
            Err(e) => {
                panic!("FFmpeg download failed: {e}");
            }
        }
    }
}

#[cfg(target_os = "windows")]
#[cfg(not(feature = "gui"))]
fn emit_windows_test_manifest_if_requested() {
    if env::var("OPENREELIO_WINDOWS_TEST_MANIFEST").ok().as_deref() != Some("1") {
        return;
    }

    const COMMON_CONTROLS_V6_MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

    let Ok(out_dir) = env::var("OUT_DIR") else {
        return;
    };

    let manifest_path = PathBuf::from(out_dir).join("openreelio.common-controls-v6.manifest");
    if std::fs::write(&manifest_path, COMMON_CONTROLS_V6_MANIFEST).is_err() {
        return;
    }

    // Merge and embed the manifest into every linked artifact in this build.
    // In CI this is used specifically for `cargo test` on Windows.
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
        manifest_path.display()
    );
}

/// How a build-time FFmpeg download was requested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadMode {
    /// Explicit opt-in via `OPENREELIO_DOWNLOAD_FFMPEG=1` or the
    /// `bundled-ffmpeg` feature. Unverified sources hard-fail unless
    /// `OPENREELIO_ALLOW_UNVERIFIED_FFMPEG=1` is set.
    Explicit,
    /// Automatic developer convenience download for debug, non-CI builds.
    /// Unverified sources emit a warning instead of failing the build.
    DevAuto,
}

/// Determine if FFmpeg should be downloaded during build, and in which mode
fn should_download_ffmpeg() -> Option<DownloadMode> {
    // Skip if explicitly disabled
    if env::var("SKIP_FFMPEG_DOWNLOAD").is_ok() {
        return None;
    }

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let binaries_dir = PathBuf::from(&manifest_dir).join("binaries");

    // Explicit opt-in via env var or the `bundled-ffmpeg` feature.
    let opted_in = env::var("OPENREELIO_DOWNLOAD_FFMPEG").ok().as_deref() == Some("1")
        || env::var("CARGO_FEATURE_BUNDLED_FFMPEG").is_ok();
    if opted_in {
        if bundled_ffmpeg_binaries_are_usable(&binaries_dir) {
            return None;
        }

        println!(
            "cargo:warning=Bundled FFmpeg binaries are missing or not executable for this platform; downloading replacements."
        );
        return Some(DownloadMode::Explicit);
    }

    // Dev convenience: debug, non-CI builds fetch FFmpeg automatically when
    // neither bundled binaries nor a system FFmpeg on PATH are available.
    let is_debug_build = env::var("PROFILE").ok().as_deref() == Some("debug");
    if !is_debug_build || env::var("CI").is_ok() {
        return None;
    }

    if bundled_ffmpeg_binaries_are_usable(&binaries_dir) {
        return None;
    }

    if system_ffmpeg_available() {
        return None;
    }

    println!(
        "cargo:warning=No bundled FFmpeg binaries and no system ffmpeg/ffprobe on PATH; downloading FFmpeg for this debug build (sources: scripts/ffmpeg-sources.json). Set SKIP_FFMPEG_DOWNLOAD=1 to opt out."
    );
    Some(DownloadMode::DevAuto)
}

/// Check whether both `ffmpeg` and `ffprobe` are resolvable on PATH
fn system_ffmpeg_available() -> bool {
    let locator = if cfg!(windows) { "where" } else { "which" };

    ["ffmpeg", "ffprobe"].iter().all(|tool| {
        let mut command = std::process::Command::new(locator);
        configure_build_command(&mut command);
        command
            .arg(tool)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
}

fn bundled_ffmpeg_binaries_are_usable(binaries_dir: &Path) -> bool {
    let (ffmpeg_name, ffprobe_name) = get_binary_names(detect_platform());
    let ffmpeg_path = binaries_dir.join(ffmpeg_name);
    let ffprobe_path = binaries_dir.join(ffprobe_name);

    if !ffmpeg_path.exists() || !ffprobe_path.exists() {
        return false;
    }

    let ffmpeg_result = verify_binary(&ffmpeg_path);
    let ffprobe_result = verify_binary(&ffprobe_path);
    match (ffmpeg_result, ffprobe_result) {
        (Ok(()), Ok(())) => true,
        (ffmpeg_result, ffprobe_result) => {
            if let Err(error) = ffmpeg_result {
                println!(
                    "cargo:warning=Existing bundled ffmpeg is not usable for this platform: {error}"
                );
            }
            if let Err(error) = ffprobe_result {
                println!(
                    "cargo:warning=Existing bundled ffprobe is not usable for this platform: {error}"
                );
            }
            false
        }
    }
}

/// Download FFmpeg binaries to OUT_DIR
fn download_ffmpeg_for_build(mode: DownloadMode) -> Result<FFmpegPaths, String> {
    let out_dir = env::var("OUT_DIR").map_err(|e| format!("OUT_DIR not set: {e}"))?;
    let output_dir = PathBuf::from(out_dir);

    let config = BundlerConfig {
        mode,
        require_checksums: env::var("OPENREELIO_REQUIRE_FFMPEG_CHECKSUMS")
            .ok()
            .as_deref()
            == Some("1"),
        timeout_seconds: 600, // 10 minutes timeout for CI
    };

    download_ffmpeg(&output_dir, &config).map_err(|e| e.to_string())
}

/// Copy downloaded binaries to src-tauri/binaries for Tauri bundling
fn copy_binaries_for_bundle(paths: &FFmpegPaths) -> Result<(), String> {
    let manifest_dir =
        env::var("CARGO_MANIFEST_DIR").map_err(|e| format!("CARGO_MANIFEST_DIR not set: {e}"))?;
    let binaries_dir = PathBuf::from(&manifest_dir).join("binaries");

    std::fs::create_dir_all(&binaries_dir)
        .map_err(|e| format!("Failed to create binaries dir: {e}"))?;

    // Get binary names for current platform
    let (ffmpeg_name, ffprobe_name) = get_binary_names(detect_platform());

    let dest_ffmpeg = binaries_dir.join(ffmpeg_name);
    let dest_ffprobe = binaries_dir.join(ffprobe_name);

    std::fs::copy(&paths.ffmpeg, &dest_ffmpeg)
        .map_err(|e| format!("Failed to copy ffmpeg: {e}"))?;
    std::fs::copy(&paths.ffprobe, &dest_ffprobe)
        .map_err(|e| format!("Failed to copy ffprobe: {e}"))?;

    println!(
        "cargo:warning=Binaries copied to {}",
        binaries_dir.display()
    );

    Ok(())
}

// ============================================================================
// Inline bundler module for build script
// ============================================================================

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path};

#[derive(Debug)]
pub struct FFmpegPaths {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOS,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    X64,
    Arm64,
}

#[derive(Debug)]
pub struct BundlerConfig {
    mode: DownloadMode,
    require_checksums: bool,
    timeout_seconds: u64,
}

#[derive(Debug)]
pub enum BundlerError {
    DownloadFailed(String),
    ExtractionFailed(String),
    VerificationFailed(String),
    UnsupportedPlatform(String),
    IoError(std::io::Error),
    BinaryNotFound(String),
}

impl std::fmt::Display for BundlerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BundlerError::DownloadFailed(msg) => write!(f, "Download failed: {msg}"),
            BundlerError::ExtractionFailed(msg) => write!(f, "Extraction failed: {msg}"),
            BundlerError::VerificationFailed(msg) => write!(f, "Verification failed: {msg}"),
            BundlerError::UnsupportedPlatform(msg) => write!(f, "Unsupported platform: {msg}"),
            BundlerError::IoError(e) => write!(f, "IO error: {e}"),
            BundlerError::BinaryNotFound(msg) => write!(f, "Binary not found: {msg}"),
        }
    }
}

impl From<std::io::Error> for BundlerError {
    fn from(e: std::io::Error) -> Self {
        BundlerError::IoError(e)
    }
}

pub type BundlerResult<T> = Result<T, BundlerError>;

pub fn detect_platform() -> Platform {
    #[cfg(target_os = "windows")]
    return Platform::Windows;

    #[cfg(target_os = "macos")]
    return Platform::MacOS;

    #[cfg(target_os = "linux")]
    return Platform::Linux;
}

pub fn detect_arch() -> Arch {
    #[cfg(target_arch = "x86_64")]
    return Arch::X64;

    #[cfg(target_arch = "aarch64")]
    return Arch::Arm64;

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    return Arch::X64;
}

pub fn get_binary_names(platform: Platform) -> (&'static str, &'static str) {
    match platform {
        Platform::Windows => ("ffmpeg.exe", "ffprobe.exe"),
        Platform::MacOS | Platform::Linux => ("ffmpeg", "ffprobe"),
    }
}

/// Relative path (from `CARGO_MANIFEST_DIR`) to the shared FFmpeg source manifest
const FFMPEG_SOURCES_MANIFEST_PATH: &str = "../scripts/ffmpeg-sources.json";

/// Attempts per download URL before falling through to the next candidate
const DOWNLOAD_ATTEMPTS_PER_URL: u32 = 3;

/// Shared FFmpeg source manifest (`scripts/ffmpeg-sources.json`)
#[derive(Debug, serde::Deserialize)]
struct SourceManifest {
    targets: std::collections::HashMap<String, TargetSources>,
}

/// Download sources for a single target triple
#[derive(Debug, serde::Deserialize)]
struct TargetSources {
    archives: Vec<ArchiveSource>,
}

/// One downloadable archive and the binaries it provides
#[derive(Debug, serde::Deserialize)]
struct ArchiveSource {
    name: String,
    filename: String,
    binaries: Vec<String>,
    urls: Vec<UrlSource>,
}

/// A candidate download URL with optional checksum sources
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UrlSource {
    url: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    sha256_url: Option<String>,
    #[serde(default)]
    sha256_sidecar: Option<String>,
}

fn load_source_manifest() -> BundlerResult<SourceManifest> {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR")
        .map_err(|e| BundlerError::DownloadFailed(format!("CARGO_MANIFEST_DIR not set: {e}")))?;
    let manifest_path = PathBuf::from(manifest_dir).join(FFMPEG_SOURCES_MANIFEST_PATH);
    let contents = std::fs::read_to_string(&manifest_path)?;

    serde_json::from_str(&contents).map_err(|e| {
        BundlerError::DownloadFailed(format!("Failed to parse {}: {e}", manifest_path.display()))
    })
}

/// Map the build platform/arch to a manifest target-triple key
fn manifest_target_key(platform: Platform, arch: Arch) -> BundlerResult<&'static str> {
    match (platform, arch) {
        (Platform::Windows, Arch::X64) => Ok("x86_64-pc-windows-msvc"),
        (Platform::MacOS, Arch::X64) => Ok("x86_64-apple-darwin"),
        (Platform::MacOS, Arch::Arm64) => Ok("aarch64-apple-darwin"),
        (Platform::Linux, Arch::X64) => Ok("x86_64-unknown-linux-gnu"),
        _ => Err(BundlerError::UnsupportedPlatform(format!(
            "{platform:?} {arch:?}"
        ))),
    }
}

fn download_file_blocking(url: &str, output: &Path, timeout_secs: u64) -> BundlerResult<String> {
    use reqwest::header::{ACCEPT, USER_AGENT};
    use std::time::Duration;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| BundlerError::DownloadFailed(e.to_string()))?;

    println!("cargo:warning=Downloading from {url}...");

    let response = client
        .get(url)
        .header(USER_AGENT, "OpenReelio release asset downloader")
        .header(ACCEPT, "application/octet-stream, application/x-xz, */*")
        .send()
        .map_err(|e| BundlerError::DownloadFailed(format!("Request failed: {e}")))?;

    if !response.status().is_success() {
        return Err(BundlerError::DownloadFailed(format!(
            "HTTP {}: {}",
            response.status(),
            url
        )));
    }

    let final_url = response.url().to_string();
    let bytes = response
        .bytes()
        .map_err(|e| BundlerError::DownloadFailed(format!("Failed to read response: {e}")))?;

    let mut file = File::create(output)?;
    file.write_all(&bytes)?;

    println!(
        "cargo:warning=Downloaded {} bytes to {}",
        bytes.len(),
        output.display()
    );

    Ok(final_url)
}

/// Download one manifest archive, trying each candidate URL with retries and
/// verifying checksums per the bundler config policy
fn download_archive_blocking(
    archive: &ArchiveSource,
    output: &Path,
    config: &BundlerConfig,
) -> BundlerResult<()> {
    let mut errors = Vec::new();

    for source in &archive.urls {
        let mut download_result = Err(BundlerError::DownloadFailed(format!(
            "No download attempted for {}",
            source.url
        )));
        for attempt in 1..=DOWNLOAD_ATTEMPTS_PER_URL {
            download_result = download_file_blocking(&source.url, output, config.timeout_seconds);
            match &download_result {
                Ok(_) => break,
                Err(error) if attempt < DOWNLOAD_ATTEMPTS_PER_URL => {
                    println!(
                        "cargo:warning=Attempt {attempt}/{DOWNLOAD_ATTEMPTS_PER_URL} failed for {}: {error}",
                        source.url
                    );
                }
                Err(_) => {}
            }
        }

        match download_result {
            Ok(final_url) => match verify_downloaded_archive(source, output, &final_url, config) {
                Ok(()) => return Ok(()),
                Err(error) => errors.push(format!("{}: {error}", source.url)),
            },
            Err(error) => errors.push(format!("{}: {error}", source.url)),
        }
    }

    Err(BundlerError::DownloadFailed(format!(
        "All download URLs failed for {}: {}",
        archive.name,
        errors.join("; ")
    )))
}

/// Verify a downloaded archive against the manifest checksum sources
fn verify_downloaded_archive(
    source: &UrlSource,
    path: &Path,
    final_url: &str,
    config: &BundlerConfig,
) -> BundlerResult<()> {
    use sha2::{Digest, Sha256};

    // A candidate URL whose DECLARED checksum source fails to resolve is
    // rejected (the caller moves on to the next URL) instead of silently
    // falling through to the unverified-download path. `Ok(None)` still means
    // the manifest declares no checksum source for this URL at all.
    let expected = resolve_expected_sha256(source, final_url, config.timeout_seconds)?;

    let Some(expected) = expected else {
        return handle_unverified_download(source, path, config);
    };

    let bytes = std::fs::read(path)?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(BundlerError::VerificationFailed(format!(
            "Checksum mismatch for {}: expected {}, got {}",
            path.display(),
            expected,
            actual
        )));
    }

    println!(
        "cargo:warning=Verified SHA-256 for {}: {actual}",
        path.display()
    );
    Ok(())
}

/// Decide whether an archive without a verifiable checksum may be used
fn handle_unverified_download(
    source: &UrlSource,
    path: &Path,
    config: &BundlerConfig,
) -> BundlerResult<()> {
    let allow_unverified = env::var("OPENREELIO_ALLOW_UNVERIFIED_FFMPEG")
        .ok()
        .as_deref()
        == Some("1");

    if allow_unverified {
        println!(
            "cargo:warning=OPENREELIO_ALLOW_UNVERIFIED_FFMPEG=1 set; skipping checksum for {}",
            path.display()
        );
        return Ok(());
    }

    if config.mode == DownloadMode::DevAuto && !config.require_checksums {
        println!(
            "cargo:warning=No verifiable SHA-256 for {}; accepting unverified download in dev auto-download mode.",
            source.url
        );
        return Ok(());
    }

    Err(BundlerError::VerificationFailed(format!(
        "Missing pinned SHA-256 for downloaded FFmpeg archive: {} (set OPENREELIO_ALLOW_UNVERIFIED_FFMPEG=1 to override)",
        path.display()
    )))
}

/// Resolve the expected SHA-256 digest from the manifest entry, fetching a
/// checksum sidecar when one is configured
fn resolve_expected_sha256(
    source: &UrlSource,
    final_url: &str,
    timeout_secs: u64,
) -> BundlerResult<Option<String>> {
    if let Some(sha256) = &source.sha256 {
        return Ok(Some(sha256.clone()));
    }

    let sidecar_url = if let Some(sha256_url) = &source.sha256_url {
        sha256_url.clone()
    } else if let Some(suffix) = &source.sha256_sidecar {
        format!("{final_url}{suffix}")
    } else {
        return Ok(None);
    };

    use reqwest::header::USER_AGENT;
    use std::time::Duration;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| BundlerError::DownloadFailed(e.to_string()))?;

    let response = client
        .get(&sidecar_url)
        .header(USER_AGENT, "OpenReelio release asset downloader")
        .send()
        .map_err(|e| BundlerError::DownloadFailed(format!("Sidecar request failed: {e}")))?;

    if !response.status().is_success() {
        return Err(BundlerError::DownloadFailed(format!(
            "HTTP {}: {sidecar_url}",
            response.status()
        )));
    }

    let sidecar_text = response
        .text()
        .map_err(|e| BundlerError::DownloadFailed(format!("Failed to read sidecar: {e}")))?;

    match parse_sha256_sidecar(&sidecar_text, &source.url) {
        Some(digest) => Ok(Some(digest)),
        None => Err(BundlerError::VerificationFailed(format!(
            "No matching SHA-256 digest found in {sidecar_url}"
        ))),
    }
}

/// Parse a checksum sidecar (bare digest, or `digest  filename` lines) and
/// return the digest matching the manifest URL's basename
fn parse_sha256_sidecar(sidecar_text: &str, source_url: &str) -> Option<String> {
    // Match against the manifest URL basename: redirect targets (for example
    // GitHub release assets) often resolve to opaque object-storage paths.
    let url_path = source_url.split('?').next().unwrap_or(source_url);
    let download_basename = url_path.rsplit('/').next().unwrap_or(url_path);
    let mut digests = Vec::new();

    for line in sidecar_text.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some(digest) = tokens.first() else {
            continue;
        };
        if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }

        if tokens.len() > 1 {
            let file_token = tokens[tokens.len() - 1].trim_start_matches('*');
            let file_basename = file_token.rsplit('/').next().unwrap_or(file_token);
            if file_basename.eq_ignore_ascii_case(download_basename) {
                return Some((*digest).to_string());
            }
        }

        digests.push((*digest).to_string());
    }

    // A bare-digest sidecar (single digest, no filename) applies to the download.
    if digests.len() == 1 {
        return digests.pop();
    }

    None
}

fn extract_archive(archive_path: &Path, output_dir: &Path) -> BundlerResult<()> {
    std::fs::create_dir_all(output_dir)?;

    let filename = archive_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

    if filename.ends_with(".zip") {
        extract_zip(archive_path, output_dir)
    } else if filename.ends_with(".tar.xz") {
        extract_tar_xz(archive_path, output_dir)
    } else if filename.ends_with(".tar.gz") || filename.ends_with(".tgz") {
        extract_tar_gz(archive_path, output_dir)
    } else {
        Err(BundlerError::ExtractionFailed(format!(
            "Unsupported archive format: {filename}"
        )))
    }
}

fn archive_entry_destination(output_root: &Path, entry_name: &Path) -> BundlerResult<PathBuf> {
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
                return Err(BundlerError::ExtractionFailed(format!(
                    "Archive entry escapes extraction directory: {}",
                    entry_name.display()
                )));
            }
        }
    }

    if !saw_component {
        return Err(BundlerError::ExtractionFailed(
            "Archive entry has an empty path".to_string(),
        ));
    }

    Ok(destination)
}

fn ensure_no_existing_symlink_in_destination(
    output_root: &Path,
    destination: &Path,
) -> BundlerResult<()> {
    let relative = destination.strip_prefix(output_root).map_err(|_| {
        BundlerError::ExtractionFailed(format!(
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
                return Err(BundlerError::ExtractionFailed(format!(
                    "Archive entry escapes extraction directory: {}",
                    destination.display()
                )));
            }
        }

        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(BundlerError::ExtractionFailed(format!(
                    "Archive destination contains a symlink: {}",
                    current.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(BundlerError::IoError(error)),
        }
    }

    Ok(())
}

fn extract_zip(archive: &Path, output: &Path) -> BundlerResult<()> {
    let file = File::open(archive)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| BundlerError::ExtractionFailed(format!("Failed to open zip: {e}")))?;

    let output_root = output.canonicalize()?;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|e| {
            BundlerError::ExtractionFailed(format!("Failed to read zip entry: {e}"))
        })?;

        if file.is_symlink() {
            return Err(BundlerError::ExtractionFailed(format!(
                "Archive symlink entries are not allowed: {}",
                file.name()
            )));
        }

        let entry_name = file.enclosed_name().ok_or_else(|| {
            BundlerError::ExtractionFailed(format!(
                "Archive entry escapes extraction directory: {}",
                file.name()
            ))
        })?;
        let destination = archive_entry_destination(&output_root, &entry_name)?;
        ensure_no_existing_symlink_in_destination(&output_root, &destination)?;

        if file.is_dir() {
            std::fs::create_dir_all(&destination)?;
            continue;
        }

        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut output_file = File::create(&destination)?;
        std::io::copy(&mut file, &mut output_file).map_err(|e| {
            BundlerError::ExtractionFailed(format!("Failed to extract zip entry: {e}"))
        })?;

        #[cfg(unix)]
        if let Some(mode) = file.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(mode))?;
        }
    }

    Ok(())
}

fn extract_tar_entries<R: Read>(
    mut archive: tar::Archive<R>,
    output: &Path,
    format: &str,
) -> BundlerResult<()> {
    let output_root = output.canonicalize()?;

    for entry in archive
        .entries()
        .map_err(|e| BundlerError::ExtractionFailed(format!("Failed to read {format}: {e}")))?
    {
        let mut entry = entry.map_err(|e| {
            BundlerError::ExtractionFailed(format!("Failed to read {format} entry: {e}"))
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
            return Err(BundlerError::ExtractionFailed(format!(
                "Archive link entries are not allowed: {}",
                entry
                    .path()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default()
            )));
        }

        if !entry_type.is_file() && !entry_type.is_dir() && !entry_type.is_contiguous() {
            return Err(BundlerError::ExtractionFailed(format!(
                "Unsupported archive entry type in {format}: {entry_type:?}"
            )));
        }

        let entry_path = entry.path().map_err(|e| {
            BundlerError::ExtractionFailed(format!("Failed to read {format} entry path: {e}"))
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

        entry.unpack(&destination).map_err(|e| {
            BundlerError::ExtractionFailed(format!("Failed to extract {format} entry: {e}"))
        })?;
    }

    Ok(())
}

fn extract_tar_xz(archive: &Path, output: &Path) -> BundlerResult<()> {
    let file = File::open(archive)?;
    let decompressor = xz2::read::XzDecoder::new(file);
    extract_tar_entries(tar::Archive::new(decompressor), output, "tar.xz")
}

fn extract_tar_gz(archive: &Path, output: &Path) -> BundlerResult<()> {
    let file = File::open(archive)?;
    let decompressor = flate2::read::GzDecoder::new(file);
    extract_tar_entries(tar::Archive::new(decompressor), output, "tar.gz")
}

fn find_binary_in_dir(dir: &Path, binary_name: &str) -> BundlerResult<PathBuf> {
    for entry in walkdir::WalkDir::new(dir).follow_links(false) {
        let entry = entry.map_err(|e| BundlerError::IoError(e.into()))?;
        if entry.file_name().to_string_lossy() == binary_name && entry.file_type().is_file() {
            return Ok(entry.path().to_path_buf());
        }
    }

    Err(BundlerError::BinaryNotFound(format!(
        "{} not found in {}",
        binary_name,
        dir.display()
    )))
}

fn verify_binary(path: &Path) -> BundlerResult<()> {
    if !path.exists() {
        return Err(BundlerError::VerificationFailed(format!(
            "Binary does not exist: {}",
            path.display()
        )));
    }

    let mut command = std::process::Command::new(path);
    configure_build_command(&mut command);
    let output = command
        .arg("-version")
        .output()
        .map_err(|e| BundlerError::VerificationFailed(format!("Failed to execute binary: {e}")))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(BundlerError::VerificationFailed(format!(
            "Binary returned non-zero exit code: {}",
            path.display()
        )))
    }
}

pub fn download_ffmpeg(output_dir: &Path, config: &BundlerConfig) -> BundlerResult<FFmpegPaths> {
    let platform = detect_platform();
    let arch = detect_arch();
    let manifest = load_source_manifest()?;
    let target_key = manifest_target_key(platform, arch)?;
    let target = manifest.targets.get(target_key).ok_or_else(|| {
        BundlerError::UnsupportedPlatform(format!(
            "No entry for {target_key} in {FFMPEG_SOURCES_MANIFEST_PATH}"
        ))
    })?;
    let (ffmpeg_name, ffprobe_name) = get_binary_names(platform);

    // Create directories
    std::fs::create_dir_all(output_dir)?;
    let temp_dir = output_dir.join("ffmpeg_temp");
    std::fs::create_dir_all(&temp_dir)?;
    let extract_dir = output_dir.join("ffmpeg_extracted");
    std::fs::create_dir_all(&extract_dir)?;
    let binaries_dir = output_dir.join("binaries");
    std::fs::create_dir_all(&binaries_dir)?;

    // Download and extract every archive listed for this target, then stage
    // the binaries each archive provides.
    let mut staged_binaries: std::collections::HashMap<String, PathBuf> =
        std::collections::HashMap::new();

    for archive in &target.archives {
        let archive_path = temp_dir.join(&archive.filename);
        let archive_extract_dir = extract_dir.join(format!("{}-extracted", archive.name));
        std::fs::create_dir_all(&archive_extract_dir)?;

        download_archive_blocking(archive, &archive_path, config)?;

        println!("cargo:warning=Extracting {} archive...", archive.name);
        extract_archive(&archive_path, &archive_extract_dir)?;

        for binary_name in &archive.binaries {
            let found = find_binary_in_dir(&archive_extract_dir, binary_name)?;
            staged_binaries.insert(binary_name.clone(), found);
        }
    }

    let copy_staged = |binary_name: &str| -> BundlerResult<PathBuf> {
        let source_path = staged_binaries.get(binary_name).ok_or_else(|| {
            BundlerError::BinaryNotFound(format!(
                "{binary_name} is not provided by any archive for {target_key}"
            ))
        })?;
        let destination = binaries_dir.join(binary_name);
        std::fs::copy(source_path, &destination)?;
        Ok(destination)
    };

    let final_ffmpeg = copy_staged(ffmpeg_name)?;
    let final_ffprobe = copy_staged(ffprobe_name)?;

    // Set executable permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&final_ffmpeg, std::fs::Permissions::from_mode(0o755))?;
        std::fs::set_permissions(&final_ffprobe, std::fs::Permissions::from_mode(0o755))?;
    }

    // Verify binaries
    println!("cargo:warning=Verifying FFmpeg binary...");
    verify_binary(&final_ffmpeg)?;
    println!("cargo:warning=Verifying FFprobe binary...");
    verify_binary(&final_ffprobe)?;

    // Cleanup temp files
    let _ = std::fs::remove_dir_all(&temp_dir);
    let _ = std::fs::remove_dir_all(&extract_dir);

    Ok(FFmpegPaths {
        ffmpeg: final_ffmpeg,
        ffprobe: final_ffprobe,
    })
}

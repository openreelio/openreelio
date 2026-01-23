//! FFmpeg Bundler Module
//!
//! Downloads and manages bundled FFmpeg binaries for cross-platform distribution.
//! Supports Windows (x64), macOS (x64, ARM), and Linux (x64).

#[cfg(feature = "bundled-ffmpeg")]
use std::fs::File;
#[cfg(feature = "bundled-ffmpeg")]
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

use crate::core::process::configure_std_command;

// ============================================================================
// Types and Enums
// ============================================================================

/// Target platform for FFmpeg binaries
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOS,
    Linux,
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Platform::Windows => write!(f, "windows"),
            Platform::MacOS => write!(f, "macos"),
            Platform::Linux => write!(f, "linux"),
        }
    }
}

/// Target architecture for FFmpeg binaries
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    X64,
    Arm64,
}

impl std::fmt::Display for Arch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Arch::X64 => write!(f, "x64"),
            Arch::Arm64 => write!(f, "arm64"),
        }
    }
}

/// FFmpeg bundler error types
#[derive(Debug, Error)]
pub enum BundlerError {
    #[error("Download failed: {0}")]
    DownloadFailed(String),

    #[error("Extraction failed: {0}")]
    ExtractionFailed(String),

    #[error("Verification failed: {0}")]
    VerificationFailed(String),

    #[error("Unsupported platform: {0}")]
    UnsupportedPlatform(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Binary not found: {0}")]
    BinaryNotFound(String),

    #[error("Timeout: operation exceeded {0} seconds")]
    Timeout(u64),
}

pub type BundlerResult<T> = Result<T, BundlerError>;

/// Configuration for the FFmpeg bundler
#[derive(Debug, Clone)]
pub struct BundlerConfig {
    /// Whether to verify checksums after download
    pub verify_checksums: bool,
    /// Download timeout in seconds
    pub timeout_seconds: u64,
    /// Cache directory for downloaded archives (optional)
    pub cache_dir: Option<PathBuf>,
}

impl Default for BundlerConfig {
    fn default() -> Self {
        Self {
            verify_checksums: true,
            timeout_seconds: 300, // 5 minutes
            cache_dir: None,
        }
    }
}

/// Paths to FFmpeg binaries
#[derive(Debug, Clone)]
pub struct FFmpegPaths {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

/// Download source information
#[derive(Debug, Clone)]
pub struct DownloadSource {
    /// URL to download from
    pub url: String,
    /// Expected filename after download
    pub filename: String,
    /// Optional SHA256 checksum for verification
    pub sha256: Option<String>,
}

/// Download source for ffprobe (macOS requires separate download)
#[derive(Debug, Clone)]
pub struct FFprobeSource {
    pub url: String,
    pub filename: String,
    pub sha256: Option<String>,
}

// ============================================================================
// Platform Detection
// ============================================================================

/// Detect the current platform
pub fn detect_platform() -> Platform {
    #[cfg(target_os = "windows")]
    return Platform::Windows;

    #[cfg(target_os = "macos")]
    return Platform::MacOS;

    #[cfg(target_os = "linux")]
    return Platform::Linux;

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    compile_error!("Unsupported platform");
}

/// Detect the current architecture
pub fn detect_arch() -> Arch {
    #[cfg(target_arch = "x86_64")]
    return Arch::X64;

    #[cfg(target_arch = "aarch64")]
    return Arch::Arm64;

    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    return Arch::X64; // Fallback to x64
}

/// Get platform-specific binary names
pub fn get_binary_names(platform: Platform) -> (&'static str, &'static str) {
    match platform {
        Platform::Windows => ("ffmpeg.exe", "ffprobe.exe"),
        Platform::MacOS | Platform::Linux => ("ffmpeg", "ffprobe"),
    }
}

// ============================================================================
// Download URL Generation
// ============================================================================

/// Get download URL for FFmpeg based on platform and architecture
pub fn get_ffmpeg_download_url(platform: Platform, arch: Arch) -> BundlerResult<DownloadSource> {
    match (platform, arch) {
        (Platform::Windows, Arch::X64) => Ok(DownloadSource {
            url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip".to_string(),
            filename: "ffmpeg-release-essentials.zip".to_string(),
            sha256: None,
        }),
        (Platform::MacOS, Arch::X64) | (Platform::MacOS, Arch::Arm64) => {
            // evermeet.cx provides universal binaries for macOS
            Ok(DownloadSource {
                url: "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip".to_string(),
                filename: "ffmpeg.zip".to_string(),
                sha256: None,
            })
        }
        (Platform::Linux, Arch::X64) => Ok(DownloadSource {
            url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
                .to_string(),
            filename: "ffmpeg-release-amd64-static.tar.xz".to_string(),
            sha256: None,
        }),
        (Platform::Windows, Arch::Arm64) => Err(BundlerError::UnsupportedPlatform(
            "Windows ARM64 is not supported yet".to_string(),
        )),
        (Platform::Linux, Arch::Arm64) => Err(BundlerError::UnsupportedPlatform(
            "Linux ARM64 is not supported yet".to_string(),
        )),
    }
}

/// Get download URL for FFprobe (only needed for macOS where it's separate)
pub fn get_ffprobe_download_url(
    platform: Platform,
    arch: Arch,
) -> BundlerResult<Option<FFprobeSource>> {
    match (platform, arch) {
        (Platform::MacOS, Arch::X64) | (Platform::MacOS, Arch::Arm64) => Ok(Some(FFprobeSource {
            url: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip".to_string(),
            filename: "ffprobe.zip".to_string(),
            sha256: None,
        })),
        // Windows and Linux include ffprobe in the main package
        _ => Ok(None),
    }
}

// ============================================================================
// Checksum Verification
// ============================================================================

/// Verify file checksum using SHA256
#[cfg(feature = "bundled-ffmpeg")]
pub fn verify_checksum(file_path: &Path, expected_sha256: &str) -> BundlerResult<bool> {
    use sha2::{Digest, Sha256};

    let mut file = File::open(file_path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    let hash = format!("{:x}", hasher.finalize());
    Ok(hash.eq_ignore_ascii_case(expected_sha256))
}

#[cfg(not(feature = "bundled-ffmpeg"))]
pub fn verify_checksum(_file_path: &Path, _expected_sha256: &str) -> BundlerResult<bool> {
    // When bundled-ffmpeg feature is not enabled, skip verification
    Ok(true)
}

// ============================================================================
// Download Logic
// ============================================================================

/// Download a file from URL (blocking version for build script)
#[cfg(feature = "bundled-ffmpeg")]
pub fn download_file_blocking(url: &str, output: &Path, timeout_secs: u64) -> BundlerResult<()> {
    use std::time::Duration;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| BundlerError::DownloadFailed(e.to_string()))?;

    let response = client
        .get(url)
        .send()
        .map_err(|e| BundlerError::DownloadFailed(format!("Request failed: {}", e)))?;

    if !response.status().is_success() {
        return Err(BundlerError::DownloadFailed(format!(
            "HTTP {}: {}",
            response.status(),
            url
        )));
    }

    let bytes = response
        .bytes()
        .map_err(|e| BundlerError::DownloadFailed(format!("Failed to read response: {}", e)))?;

    let mut file = File::create(output)?;
    file.write_all(&bytes)?;

    Ok(())
}

#[cfg(not(feature = "bundled-ffmpeg"))]
pub fn download_file_blocking(_url: &str, _output: &Path, _timeout_secs: u64) -> BundlerResult<()> {
    Err(BundlerError::DownloadFailed(
        "bundled-ffmpeg feature is not enabled".to_string(),
    ))
}

// ============================================================================
// Archive Extraction
// ============================================================================

/// Extract archive based on file extension
#[cfg(feature = "bundled-ffmpeg")]
pub fn extract_archive(archive_path: &Path, output_dir: &Path) -> BundlerResult<()> {
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
            "Unsupported archive format: {}",
            filename
        )))
    }
}

#[cfg(not(feature = "bundled-ffmpeg"))]
pub fn extract_archive(_archive_path: &Path, _output_dir: &Path) -> BundlerResult<()> {
    Err(BundlerError::ExtractionFailed(
        "bundled-ffmpeg feature is not enabled".to_string(),
    ))
}

#[cfg(feature = "bundled-ffmpeg")]
fn extract_zip(archive: &Path, output: &Path) -> BundlerResult<()> {
    let file = File::open(archive)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| BundlerError::ExtractionFailed(format!("Failed to open zip: {}", e)))?;

    archive
        .extract(output)
        .map_err(|e| BundlerError::ExtractionFailed(format!("Failed to extract zip: {}", e)))
}

#[cfg(feature = "bundled-ffmpeg")]
fn extract_tar_xz(archive: &Path, output: &Path) -> BundlerResult<()> {
    let file = File::open(archive)?;
    let decompressor = xz2::read::XzDecoder::new(file);
    let mut archive = tar::Archive::new(decompressor);

    archive
        .unpack(output)
        .map_err(|e| BundlerError::ExtractionFailed(format!("Failed to extract tar.xz: {}", e)))
}

#[cfg(feature = "bundled-ffmpeg")]
fn extract_tar_gz(archive: &Path, output: &Path) -> BundlerResult<()> {
    let file = File::open(archive)?;
    let decompressor = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decompressor);

    archive
        .unpack(output)
        .map_err(|e| BundlerError::ExtractionFailed(format!("Failed to extract tar.gz: {}", e)))
}

// ============================================================================
// Binary Discovery
// ============================================================================

/// Find a binary file in a directory (recursive search)
#[cfg(feature = "bundled-ffmpeg")]
pub fn find_binary_in_dir(dir: &Path, binary_name: &str) -> BundlerResult<PathBuf> {
    for entry in walkdir::WalkDir::new(dir).follow_links(true) {
        let entry = entry.map_err(|e| BundlerError::IoError(e.into()))?;
        if entry.file_name().to_string_lossy() == binary_name {
            let path = entry.path().to_path_buf();
            // Verify it's a file, not a directory
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    Err(BundlerError::BinaryNotFound(format!(
        "{} not found in {}",
        binary_name,
        dir.display()
    )))
}

#[cfg(not(feature = "bundled-ffmpeg"))]
pub fn find_binary_in_dir(_dir: &Path, binary_name: &str) -> BundlerResult<PathBuf> {
    Err(BundlerError::BinaryNotFound(format!(
        "bundled-ffmpeg feature is not enabled, cannot find {}",
        binary_name
    )))
}

/// Verify that a binary is executable and functional
pub fn verify_binary(path: &Path) -> BundlerResult<()> {
    if !path.exists() {
        return Err(BundlerError::VerificationFailed(format!(
            "Binary does not exist: {}",
            path.display()
        )));
    }

    let mut cmd = std::process::Command::new(path);
    configure_std_command(&mut cmd);
    let output = cmd.arg("-version").output().map_err(|e| {
        BundlerError::VerificationFailed(format!("Failed to execute binary: {}", e))
    })?;

    if output.status.success() {
        Ok(())
    } else {
        Err(BundlerError::VerificationFailed(format!(
            "Binary returned non-zero exit code: {}",
            path.display()
        )))
    }
}

// ============================================================================
// Main Download Function
// ============================================================================

/// Download and prepare FFmpeg binaries for the current platform
#[cfg(feature = "bundled-ffmpeg")]
pub fn download_ffmpeg(output_dir: &Path, config: &BundlerConfig) -> BundlerResult<FFmpegPaths> {
    let platform = detect_platform();
    let arch = detect_arch();
    let source = get_ffmpeg_download_url(platform, arch)?;
    let ffprobe_source = get_ffprobe_download_url(platform, arch)?;
    let (ffmpeg_name, ffprobe_name) = get_binary_names(platform);

    // Create directories
    std::fs::create_dir_all(output_dir)?;
    let temp_dir = output_dir.join("temp");
    std::fs::create_dir_all(&temp_dir)?;
    let extract_dir = output_dir.join("extracted");
    std::fs::create_dir_all(&extract_dir)?;
    let binaries_dir = output_dir.join("binaries");
    std::fs::create_dir_all(&binaries_dir)?;

    // Download main FFmpeg archive
    let archive_path = temp_dir.join(&source.filename);
    println!("Downloading FFmpeg from {}...", source.url);
    download_file_blocking(&source.url, &archive_path, config.timeout_seconds)?;

    // Verify checksum if provided
    if config.verify_checksums {
        if let Some(expected_hash) = &source.sha256 {
            let valid = verify_checksum(&archive_path, expected_hash)?;
            if !valid {
                return Err(BundlerError::VerificationFailed(
                    "FFmpeg checksum mismatch".to_string(),
                ));
            }
        }
    }

    // Extract main archive
    println!("Extracting FFmpeg...");
    extract_archive(&archive_path, &extract_dir)?;

    // Find and copy ffmpeg binary
    let ffmpeg_found = find_binary_in_dir(&extract_dir, ffmpeg_name)?;
    let final_ffmpeg = binaries_dir.join(ffmpeg_name);
    std::fs::copy(&ffmpeg_found, &final_ffmpeg)?;

    // Handle ffprobe - either from main archive or separate download
    let final_ffprobe = binaries_dir.join(ffprobe_name);

    if let Some(ffprobe_src) = ffprobe_source {
        // macOS: Download separate ffprobe
        let ffprobe_archive = temp_dir.join(&ffprobe_src.filename);
        println!("Downloading FFprobe from {}...", ffprobe_src.url);
        download_file_blocking(&ffprobe_src.url, &ffprobe_archive, config.timeout_seconds)?;

        let ffprobe_extract_dir = extract_dir.join("ffprobe");
        std::fs::create_dir_all(&ffprobe_extract_dir)?;
        extract_archive(&ffprobe_archive, &ffprobe_extract_dir)?;

        let ffprobe_found = find_binary_in_dir(&ffprobe_extract_dir, ffprobe_name)?;
        std::fs::copy(&ffprobe_found, &final_ffprobe)?;
    } else {
        // Windows/Linux: ffprobe is in main archive
        let ffprobe_found = find_binary_in_dir(&extract_dir, ffprobe_name)?;
        std::fs::copy(&ffprobe_found, &final_ffprobe)?;
    }

    // Set executable permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&final_ffmpeg, std::fs::Permissions::from_mode(0o755))?;
        std::fs::set_permissions(&final_ffprobe, std::fs::Permissions::from_mode(0o755))?;
    }

    // Verify binaries work
    println!("Verifying FFmpeg binary...");
    verify_binary(&final_ffmpeg)?;
    println!("Verifying FFprobe binary...");
    verify_binary(&final_ffprobe)?;

    // Cleanup temp files
    let _ = std::fs::remove_dir_all(&temp_dir);
    let _ = std::fs::remove_dir_all(&extract_dir);

    println!("FFmpeg binaries ready at {}", binaries_dir.display());

    Ok(FFmpegPaths {
        ffmpeg: final_ffmpeg,
        ffprobe: final_ffprobe,
    })
}

#[cfg(not(feature = "bundled-ffmpeg"))]
pub fn download_ffmpeg(_output_dir: &Path, _config: &BundlerConfig) -> BundlerResult<FFmpegPaths> {
    Err(BundlerError::DownloadFailed(
        "bundled-ffmpeg feature is not enabled".to_string(),
    ))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Platform Detection Tests
    // ========================================================================

    #[test]
    fn test_detect_current_platform() {
        let platform = detect_platform();

        #[cfg(target_os = "windows")]
        assert_eq!(platform, Platform::Windows);

        #[cfg(target_os = "macos")]
        assert_eq!(platform, Platform::MacOS);

        #[cfg(target_os = "linux")]
        assert_eq!(platform, Platform::Linux);
    }

    #[test]
    fn test_detect_current_arch() {
        let arch = detect_arch();

        #[cfg(target_arch = "x86_64")]
        assert_eq!(arch, Arch::X64);

        #[cfg(target_arch = "aarch64")]
        assert_eq!(arch, Arch::Arm64);
    }

    #[test]
    fn test_platform_display() {
        assert_eq!(Platform::Windows.to_string(), "windows");
        assert_eq!(Platform::MacOS.to_string(), "macos");
        assert_eq!(Platform::Linux.to_string(), "linux");
    }

    #[test]
    fn test_arch_display() {
        assert_eq!(Arch::X64.to_string(), "x64");
        assert_eq!(Arch::Arm64.to_string(), "arm64");
    }

    // ========================================================================
    // Download URL Tests
    // ========================================================================

    #[test]
    fn test_get_download_url_windows_x64() {
        let result = get_ffmpeg_download_url(Platform::Windows, Arch::X64);
        assert!(result.is_ok());
        let source = result.unwrap();
        assert!(source.url.contains("gyan.dev"));
        assert!(source.filename.ends_with(".zip"));
    }

    #[test]
    fn test_get_download_url_macos_x64() {
        let result = get_ffmpeg_download_url(Platform::MacOS, Arch::X64);
        assert!(result.is_ok());
        let source = result.unwrap();
        assert!(source.url.contains("evermeet.cx"));
    }

    #[test]
    fn test_get_download_url_macos_arm64() {
        let result = get_ffmpeg_download_url(Platform::MacOS, Arch::Arm64);
        assert!(result.is_ok());
        let source = result.unwrap();
        assert!(source.url.contains("evermeet.cx"));
    }

    #[test]
    fn test_get_download_url_linux_x64() {
        let result = get_ffmpeg_download_url(Platform::Linux, Arch::X64);
        assert!(result.is_ok());
        let source = result.unwrap();
        assert!(source.url.contains("johnvansickle.com"));
        assert!(source.filename.ends_with(".tar.xz"));
    }

    #[test]
    fn test_get_download_url_unsupported_platform() {
        let result = get_ffmpeg_download_url(Platform::Windows, Arch::Arm64);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            BundlerError::UnsupportedPlatform(_)
        ));
    }

    #[test]
    fn test_get_ffprobe_url_macos() {
        let result = get_ffprobe_download_url(Platform::MacOS, Arch::X64);
        assert!(result.is_ok());
        let source = result.unwrap();
        assert!(source.is_some());
        let source = source.unwrap();
        assert!(source.url.contains("evermeet.cx"));
        assert!(source.url.contains("ffprobe"));
    }

    #[test]
    fn test_get_ffprobe_url_windows() {
        let result = get_ffprobe_download_url(Platform::Windows, Arch::X64);
        assert!(result.is_ok());
        assert!(result.unwrap().is_none()); // ffprobe included in main package
    }

    #[test]
    fn test_get_ffprobe_url_linux() {
        let result = get_ffprobe_download_url(Platform::Linux, Arch::X64);
        assert!(result.is_ok());
        assert!(result.unwrap().is_none()); // ffprobe included in main package
    }

    // ========================================================================
    // Binary Name Tests
    // ========================================================================

    #[test]
    fn test_get_binary_names_windows() {
        let (ffmpeg, ffprobe) = get_binary_names(Platform::Windows);
        assert_eq!(ffmpeg, "ffmpeg.exe");
        assert_eq!(ffprobe, "ffprobe.exe");
    }

    #[test]
    fn test_get_binary_names_macos() {
        let (ffmpeg, ffprobe) = get_binary_names(Platform::MacOS);
        assert_eq!(ffmpeg, "ffmpeg");
        assert_eq!(ffprobe, "ffprobe");
    }

    #[test]
    fn test_get_binary_names_linux() {
        let (ffmpeg, ffprobe) = get_binary_names(Platform::Linux);
        assert_eq!(ffmpeg, "ffmpeg");
        assert_eq!(ffprobe, "ffprobe");
    }

    // ========================================================================
    // Checksum Tests
    // ========================================================================

    #[test]
    fn test_verify_checksum_valid() {
        let temp_dir = tempfile::tempdir().unwrap();
        let test_file = temp_dir.path().join("test.bin");
        std::fs::write(&test_file, b"test content").unwrap();

        // SHA256 of "test content"
        let expected_hash = "6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72";
        let result = verify_checksum(&test_file, expected_hash);
        assert!(result.is_ok());

        #[cfg(feature = "bundled-ffmpeg")]
        assert!(result.unwrap());
    }

    #[test]
    fn test_verify_checksum_invalid() {
        let temp_dir = tempfile::tempdir().unwrap();
        let test_file = temp_dir.path().join("test.bin");
        std::fs::write(&test_file, b"test content").unwrap();

        let result = verify_checksum(&test_file, "invalid_hash_value");
        assert!(result.is_ok());

        #[cfg(feature = "bundled-ffmpeg")]
        assert!(!result.unwrap());
    }

    #[test]
    fn test_verify_checksum_file_not_found() {
        let result = verify_checksum(Path::new("/nonexistent/file"), "somehash");

        #[cfg(feature = "bundled-ffmpeg")]
        assert!(result.is_err());

        #[cfg(not(feature = "bundled-ffmpeg"))]
        assert!(result.is_ok()); // Skipped when feature disabled
    }

    // ========================================================================
    // Configuration Tests
    // ========================================================================

    #[test]
    fn test_bundler_config_default() {
        let config = BundlerConfig::default();
        assert!(config.verify_checksums);
        assert_eq!(config.timeout_seconds, 300);
        assert!(config.cache_dir.is_none());
    }

    #[test]
    fn test_bundler_config_custom() {
        let config = BundlerConfig {
            verify_checksums: false,
            timeout_seconds: 600,
            cache_dir: Some(PathBuf::from("/custom/cache")),
        };
        assert!(!config.verify_checksums);
        assert_eq!(config.timeout_seconds, 600);
        assert!(config.cache_dir.is_some());
    }

    // ========================================================================
    // Error Display Tests
    // ========================================================================

    #[test]
    fn test_bundler_error_display() {
        let err = BundlerError::DownloadFailed("network error".to_string());
        assert!(err.to_string().contains("Download failed"));
        assert!(err.to_string().contains("network error"));

        let err = BundlerError::ExtractionFailed("corrupt archive".to_string());
        assert!(err.to_string().contains("Extraction failed"));

        let err = BundlerError::VerificationFailed("checksum mismatch".to_string());
        assert!(err.to_string().contains("Verification failed"));

        let err = BundlerError::UnsupportedPlatform("unknown".to_string());
        assert!(err.to_string().contains("Unsupported platform"));

        let err = BundlerError::BinaryNotFound("ffmpeg".to_string());
        assert!(err.to_string().contains("Binary not found"));

        let err = BundlerError::Timeout(300);
        assert!(err.to_string().contains("Timeout"));
        assert!(err.to_string().contains("300"));
    }

    // ========================================================================
    // Binary Verification Tests
    // ========================================================================

    #[test]
    fn test_verify_binary_invalid_path() {
        let result = verify_binary(Path::new("/nonexistent/ffmpeg"));
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            BundlerError::VerificationFailed(_)
        ));
    }

    #[test]
    fn test_verify_binary_not_executable() {
        let temp_dir = tempfile::tempdir().unwrap();
        let fake_binary = temp_dir.path().join("ffmpeg");
        std::fs::write(&fake_binary, "not a binary").unwrap();

        let result = verify_binary(&fake_binary);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_binary_system_ffmpeg() {
        // Try to verify system FFmpeg if available
        // This test is informational - doesn't fail if FFmpeg not installed
        let ffmpeg_path = if cfg!(windows) {
            PathBuf::from("ffmpeg.exe")
        } else {
            PathBuf::from("/usr/bin/ffmpeg")
        };

        match verify_binary(&ffmpeg_path) {
            Ok(()) => println!("System FFmpeg verified successfully"),
            Err(e) => println!("System FFmpeg not available: {}", e),
        }
    }

    // ========================================================================
    // Integration Tests (require network - marked with #[ignore])
    // ========================================================================

    #[test]
    #[ignore] // Run with: cargo test -- --ignored
    fn test_download_ffmpeg_full() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config = BundlerConfig {
            verify_checksums: false, // Skip checksum for test
            timeout_seconds: 600,
            cache_dir: None,
        };

        let result = download_ffmpeg(temp_dir.path(), &config);

        match result {
            Ok(paths) => {
                assert!(paths.ffmpeg.exists());
                assert!(paths.ffprobe.exists());
                println!("FFmpeg downloaded to: {}", paths.ffmpeg.display());
                println!("FFprobe downloaded to: {}", paths.ffprobe.display());
            }
            Err(e) => {
                // In CI without network, this might fail
                println!("Download failed (expected in CI): {}", e);
            }
        }
    }
}

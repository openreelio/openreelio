//! Build script for OpenReelio
//!
//! This script handles:
//! 1. Standard Tauri build process
//! 2. Automatic FFmpeg binary download for bundling
//!
//! FFmpeg is automatically downloaded if binaries don't exist.
//! Set SKIP_FFMPEG_DOWNLOAD=1 to disable automatic download.

use std::env;
use std::path::PathBuf;

fn main() {
    // Standard Tauri build
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
    #[cfg(target_os = "windows")]
    emit_windows_test_manifest_if_requested();

    // Download FFmpeg binaries if needed
    if should_download_ffmpeg() {
        println!("cargo:warning=FFmpeg binaries not found, downloading...");
        match download_ffmpeg_for_build() {
            Ok(paths) => {
                println!("cargo:warning=FFmpeg downloaded successfully");
                println!("cargo:warning=  ffmpeg: {}", paths.ffmpeg.display());
                println!("cargo:warning=  ffprobe: {}", paths.ffprobe.display());

                // Copy binaries to src-tauri/binaries for bundling
                if let Err(e) = copy_binaries_for_bundle(&paths) {
                    println!("cargo:warning=Failed to copy binaries for bundling: {}", e);
                }
            }
            Err(e) => {
                println!("cargo:warning=FFmpeg download failed: {}", e);
                println!("cargo:warning=The app will fall back to system FFmpeg at runtime");
            }
        }
    }
}

#[cfg(target_os = "windows")]
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

/// Determine if FFmpeg should be downloaded during build
fn should_download_ffmpeg() -> bool {
    // Require explicit opt-in to avoid non-reproducible builds and supply-chain surprises.
    // Enable by setting `OPENREELIO_DOWNLOAD_FFMPEG=1` (recommended for CI release builds),
    // or by building with the `bundled-ffmpeg` feature.
    let opted_in = env::var("OPENREELIO_DOWNLOAD_FFMPEG").ok().as_deref() == Some("1")
        || env::var("CARGO_FEATURE_BUNDLED_FFMPEG").is_ok();
    if !opted_in {
        return false;
    }

    // Skip if explicitly disabled
    if env::var("SKIP_FFMPEG_DOWNLOAD").is_ok() {
        return false;
    }

    // Check if binaries already exist
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let binaries_dir = PathBuf::from(&manifest_dir).join("binaries");

    #[cfg(target_os = "windows")]
    let ffmpeg_exists = binaries_dir.join("ffmpeg.exe").exists();

    #[cfg(not(target_os = "windows"))]
    let ffmpeg_exists = binaries_dir.join("ffmpeg").exists();

    if ffmpeg_exists {
        return false;
    }

    // Download if binaries don't exist
    true
}

/// Download FFmpeg binaries to OUT_DIR
fn download_ffmpeg_for_build() -> Result<FFmpegPaths, String> {
    let out_dir = env::var("OUT_DIR").map_err(|e| format!("OUT_DIR not set: {}", e))?;
    let output_dir = PathBuf::from(out_dir);

    let config = BundlerConfig {
        verify_checksums: false, // Skip checksum verification for faster builds
        timeout_seconds: 600,    // 10 minutes timeout for CI
        cache_dir: None,
    };

    download_ffmpeg(&output_dir, &config).map_err(|e| e.to_string())
}

/// Copy downloaded binaries to src-tauri/binaries for Tauri bundling
fn copy_binaries_for_bundle(paths: &FFmpegPaths) -> Result<(), String> {
    let manifest_dir =
        env::var("CARGO_MANIFEST_DIR").map_err(|e| format!("CARGO_MANIFEST_DIR not set: {}", e))?;
    let binaries_dir = PathBuf::from(&manifest_dir).join("binaries");

    std::fs::create_dir_all(&binaries_dir)
        .map_err(|e| format!("Failed to create binaries dir: {}", e))?;

    // Get binary names for current platform
    let (ffmpeg_name, ffprobe_name) = get_binary_names(detect_platform());

    let dest_ffmpeg = binaries_dir.join(ffmpeg_name);
    let dest_ffprobe = binaries_dir.join(ffprobe_name);

    std::fs::copy(&paths.ffmpeg, &dest_ffmpeg)
        .map_err(|e| format!("Failed to copy ffmpeg: {}", e))?;
    std::fs::copy(&paths.ffprobe, &dest_ffprobe)
        .map_err(|e| format!("Failed to copy ffprobe: {}", e))?;

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
use std::io::Write;
use std::path::Path;

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
    pub verify_checksums: bool,
    pub timeout_seconds: u64,
    pub cache_dir: Option<PathBuf>,
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
            BundlerError::DownloadFailed(msg) => write!(f, "Download failed: {}", msg),
            BundlerError::ExtractionFailed(msg) => write!(f, "Extraction failed: {}", msg),
            BundlerError::VerificationFailed(msg) => write!(f, "Verification failed: {}", msg),
            BundlerError::UnsupportedPlatform(msg) => write!(f, "Unsupported platform: {}", msg),
            BundlerError::IoError(e) => write!(f, "IO error: {}", e),
            BundlerError::BinaryNotFound(msg) => write!(f, "Binary not found: {}", msg),
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

struct DownloadSource {
    url: String,
    filename: String,
}

fn get_ffmpeg_download_url(platform: Platform, arch: Arch) -> BundlerResult<DownloadSource> {
    match (platform, arch) {
        (Platform::Windows, Arch::X64) => Ok(DownloadSource {
            url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip".to_string(),
            filename: "ffmpeg-release-essentials.zip".to_string(),
        }),
        (Platform::MacOS, Arch::X64) | (Platform::MacOS, Arch::Arm64) => Ok(DownloadSource {
            url: "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip".to_string(),
            filename: "ffmpeg.zip".to_string(),
        }),
        (Platform::Linux, Arch::X64) => Ok(DownloadSource {
            url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
                .to_string(),
            filename: "ffmpeg-release-amd64-static.tar.xz".to_string(),
        }),
        _ => Err(BundlerError::UnsupportedPlatform(format!(
            "{:?} {:?}",
            platform, arch
        ))),
    }
}

fn get_ffprobe_download_url(
    platform: Platform,
    arch: Arch,
) -> BundlerResult<Option<DownloadSource>> {
    match (platform, arch) {
        (Platform::MacOS, Arch::X64) | (Platform::MacOS, Arch::Arm64) => Ok(Some(DownloadSource {
            url: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip".to_string(),
            filename: "ffprobe.zip".to_string(),
        })),
        _ => Ok(None),
    }
}

fn download_file_blocking(url: &str, output: &Path, timeout_secs: u64) -> BundlerResult<()> {
    use std::time::Duration;

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| BundlerError::DownloadFailed(e.to_string()))?;

    println!("cargo:warning=Downloading from {}...", url);

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

    println!(
        "cargo:warning=Downloaded {} bytes to {}",
        bytes.len(),
        output.display()
    );

    Ok(())
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
            "Unsupported archive format: {}",
            filename
        )))
    }
}

fn extract_zip(archive: &Path, output: &Path) -> BundlerResult<()> {
    let file = File::open(archive)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| BundlerError::ExtractionFailed(format!("Failed to open zip: {}", e)))?;

    archive
        .extract(output)
        .map_err(|e| BundlerError::ExtractionFailed(format!("Failed to extract zip: {}", e)))
}

fn extract_tar_xz(archive: &Path, output: &Path) -> BundlerResult<()> {
    let file = File::open(archive)?;
    let decompressor = xz2::read::XzDecoder::new(file);
    let mut archive = tar::Archive::new(decompressor);

    archive
        .unpack(output)
        .map_err(|e| BundlerError::ExtractionFailed(format!("Failed to extract tar.xz: {}", e)))
}

fn extract_tar_gz(archive: &Path, output: &Path) -> BundlerResult<()> {
    let file = File::open(archive)?;
    let decompressor = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decompressor);

    archive
        .unpack(output)
        .map_err(|e| BundlerError::ExtractionFailed(format!("Failed to extract tar.gz: {}", e)))
}

fn find_binary_in_dir(dir: &Path, binary_name: &str) -> BundlerResult<PathBuf> {
    for entry in walkdir::WalkDir::new(dir).follow_links(true) {
        let entry = entry.map_err(|e| BundlerError::IoError(e.into()))?;
        if entry.file_name().to_string_lossy() == binary_name && entry.path().is_file() {
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

    let output = std::process::Command::new(path)
        .arg("-version")
        .output()
        .map_err(|e| {
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

pub fn download_ffmpeg(output_dir: &Path, config: &BundlerConfig) -> BundlerResult<FFmpegPaths> {
    let platform = detect_platform();
    let arch = detect_arch();
    let source = get_ffmpeg_download_url(platform, arch)?;
    let ffprobe_source = get_ffprobe_download_url(platform, arch)?;
    let (ffmpeg_name, ffprobe_name) = get_binary_names(platform);

    // Create directories
    std::fs::create_dir_all(output_dir)?;
    let temp_dir = output_dir.join("ffmpeg_temp");
    std::fs::create_dir_all(&temp_dir)?;
    let extract_dir = output_dir.join("ffmpeg_extracted");
    std::fs::create_dir_all(&extract_dir)?;
    let binaries_dir = output_dir.join("binaries");
    std::fs::create_dir_all(&binaries_dir)?;

    // Download main FFmpeg archive
    let archive_path = temp_dir.join(&source.filename);
    download_file_blocking(&source.url, &archive_path, config.timeout_seconds)?;

    // Extract main archive
    println!("cargo:warning=Extracting FFmpeg archive...");
    extract_archive(&archive_path, &extract_dir)?;

    // Find and copy ffmpeg binary
    let ffmpeg_found = find_binary_in_dir(&extract_dir, ffmpeg_name)?;
    let final_ffmpeg = binaries_dir.join(ffmpeg_name);
    std::fs::copy(&ffmpeg_found, &final_ffmpeg)?;

    // Handle ffprobe
    let final_ffprobe = binaries_dir.join(ffprobe_name);

    if let Some(ffprobe_src) = ffprobe_source {
        // macOS: Download separate ffprobe
        let ffprobe_archive = temp_dir.join(&ffprobe_src.filename);
        download_file_blocking(&ffprobe_src.url, &ffprobe_archive, config.timeout_seconds)?;

        let ffprobe_extract_dir = extract_dir.join("ffprobe_extracted");
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

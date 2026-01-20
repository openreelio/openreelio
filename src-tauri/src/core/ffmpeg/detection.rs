//! FFmpeg Detection Module
//!
//! Handles detection and validation of FFmpeg/FFprobe binaries.
//! Supports both bundled (sidecar) and system-installed binaries.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::{FFmpegError, FFmpegResult};

/// Information about detected FFmpeg installation
#[derive(Debug, Clone)]
pub struct FFmpegInfo {
    /// Path to ffmpeg binary
    pub ffmpeg_path: PathBuf,
    /// Path to ffprobe binary
    pub ffprobe_path: PathBuf,
    /// FFmpeg version string
    pub version: String,
    /// Whether this is a bundled (sidecar) installation
    pub is_bundled: bool,
}

/// Detect FFmpeg from bundled sidecar binaries
///
/// Looks for FFmpeg binaries bundled with the application using Tauri's sidecar feature.
/// The binaries should be in the `binaries/` directory relative to the app resources.
///
/// In development mode, also checks the `src-tauri/binaries/` directory where binaries
/// are downloaded during the build process.
pub fn detect_bundled_ffmpeg(app_handle: &tauri::AppHandle) -> FFmpegResult<FFmpegInfo> {
    use tauri::Manager;

    // Get the resource directory (works in production)
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|_| FFmpegError::NotFound)?;

    tracing::debug!("Checking resource directory: {:?}", resource_dir);

    // Try resource directory first (production path)
    if let Ok(info) = detect_bundled_at_path(&resource_dir) {
        tracing::info!(
            "Found bundled FFmpeg at resource directory: {:?}",
            info.ffmpeg_path
        );
        return Ok(info);
    }

    tracing::debug!("FFmpeg not found in resource directory, trying dev mode paths");

    // In dev mode, check src-tauri/binaries/ directly
    // This is where build.rs downloads the binaries
    if let Ok(info) = detect_dev_mode_binaries() {
        tracing::info!("Found bundled FFmpeg in dev mode: {:?}", info.ffmpeg_path);
        return Ok(info);
    }

    tracing::debug!("FFmpeg not found in dev mode paths");
    Err(FFmpegError::NotFound)
}

/// Detect FFmpeg binaries in development mode
///
/// During development (`npm run tauri dev`), binaries are in `src-tauri/binaries/`
/// which is not the same as the resource directory. This function checks that path.
fn detect_dev_mode_binaries() -> FFmpegResult<FFmpegInfo> {
    // Get the path to src-tauri/binaries from CARGO_MANIFEST_DIR or relative to executable
    let dev_binaries_paths = get_dev_mode_paths();

    tracing::debug!("Checking dev mode paths: {:?}", dev_binaries_paths);

    for binaries_dir in dev_binaries_paths {
        tracing::trace!(
            "Checking path: {:?} (exists: {})",
            binaries_dir,
            binaries_dir.exists()
        );

        if binaries_dir.exists() {
            // Platform-specific binary names
            #[cfg(target_os = "windows")]
            let (ffmpeg_name, ffprobe_name) = ("ffmpeg.exe", "ffprobe.exe");

            #[cfg(not(target_os = "windows"))]
            let (ffmpeg_name, ffprobe_name) = ("ffmpeg", "ffprobe");

            let ffmpeg_path = binaries_dir.join(ffmpeg_name);
            let ffprobe_path = binaries_dir.join(ffprobe_name);

            tracing::trace!(
                "Checking binaries: ffmpeg={:?} (exists: {}), ffprobe={:?} (exists: {})",
                ffmpeg_path,
                ffmpeg_path.exists(),
                ffprobe_path,
                ffprobe_path.exists()
            );

            if ffmpeg_path.exists() && ffprobe_path.exists() {
                if let Ok(version) = get_ffmpeg_version(&ffmpeg_path) {
                    return Ok(FFmpegInfo {
                        ffmpeg_path,
                        ffprobe_path,
                        version,
                        is_bundled: true,
                    });
                }
            }
        }
    }

    Err(FFmpegError::NotFound)
}

/// Get possible paths where dev mode binaries might be located
fn get_dev_mode_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // Try CARGO_MANIFEST_DIR (available during cargo build/run)
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        paths.push(PathBuf::from(&manifest_dir).join("binaries"));
    }

    // Try relative to current executable (for dev mode)
    if let Ok(exe_path) = std::env::current_exe() {
        // In dev mode, exe is typically at src-tauri/target/debug/openreelio
        // So binaries would be at src-tauri/binaries (3 levels up, then binaries)
        if let Some(parent) = exe_path.parent() {
            // target/debug -> target -> src-tauri
            if let Some(target_dir) = parent.parent() {
                if let Some(src_tauri) = target_dir.parent() {
                    paths.push(src_tauri.join("binaries"));
                }
            }
        }
    }

    // Try current working directory (might be project root)
    if let Ok(cwd) = std::env::current_dir() {
        paths.push(cwd.join("src-tauri").join("binaries"));
        paths.push(cwd.join("binaries"));
    }

    paths
}

/// Detect FFmpeg binaries at a specific resource directory path
///
/// This function is separated from `detect_bundled_ffmpeg` to enable unit testing
/// without requiring a Tauri AppHandle.
pub fn detect_bundled_at_path(resource_dir: &Path) -> FFmpegResult<FFmpegInfo> {
    // Platform-specific binary names
    #[cfg(target_os = "windows")]
    let (ffmpeg_name, ffprobe_name) = ("ffmpeg.exe", "ffprobe.exe");

    #[cfg(not(target_os = "windows"))]
    let (ffmpeg_name, ffprobe_name) = ("ffmpeg", "ffprobe");

    // Check binaries directory
    let binaries_dir = resource_dir.join("binaries");
    let ffmpeg_path = binaries_dir.join(ffmpeg_name);
    let ffprobe_path = binaries_dir.join(ffprobe_name);

    if !binaries_dir.exists() {
        return Err(FFmpegError::NotFound);
    }

    if !ffmpeg_path.exists() {
        return Err(FFmpegError::NotFound);
    }

    if !ffprobe_path.exists() {
        return Err(FFmpegError::NotFound);
    }

    let version = get_ffmpeg_version(&ffmpeg_path)?;
    Ok(FFmpegInfo {
        ffmpeg_path,
        ffprobe_path,
        version,
        is_bundled: true,
    })
}

/// Get platform-specific binary names for FFmpeg and FFprobe
pub fn get_bundled_binary_names() -> (&'static str, &'static str) {
    #[cfg(target_os = "windows")]
    return ("ffmpeg.exe", "ffprobe.exe");

    #[cfg(not(target_os = "windows"))]
    return ("ffmpeg", "ffprobe");
}

/// Detect FFmpeg from system PATH
///
/// Searches for FFmpeg binaries in the system PATH environment variable.
pub fn detect_system_ffmpeg() -> FFmpegResult<FFmpegInfo> {
    // Try to find ffmpeg in PATH
    let ffmpeg_path = which_ffmpeg()?;
    let ffprobe_path = which_ffprobe()?;

    let version = get_ffmpeg_version(&ffmpeg_path)?;

    Ok(FFmpegInfo {
        ffmpeg_path,
        ffprobe_path,
        version,
        is_bundled: false,
    })
}

/// Find ffmpeg binary in system PATH
fn which_ffmpeg() -> FFmpegResult<PathBuf> {
    #[cfg(target_os = "windows")]
    let binary_name = "ffmpeg.exe";

    #[cfg(not(target_os = "windows"))]
    let binary_name = "ffmpeg";

    // Try common locations first
    let common_paths = get_common_ffmpeg_paths();
    for path in common_paths {
        let ffmpeg_path = path.join(binary_name);
        if ffmpeg_path.exists() {
            return Ok(ffmpeg_path);
        }
    }

    // Fall back to PATH search using `where` (Windows) or `which` (Unix)
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("where")
            .arg("ffmpeg")
            .output()
            .map_err(|_| FFmpegError::NotFound)?;

        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = path_str.lines().next() {
                return Ok(PathBuf::from(first_line.trim()));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("which")
            .arg("ffmpeg")
            .output()
            .map_err(|_| FFmpegError::NotFound)?;

        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            return Ok(PathBuf::from(path_str.trim()));
        }
    }

    Err(FFmpegError::NotFound)
}

/// Find ffprobe binary in system PATH
fn which_ffprobe() -> FFmpegResult<PathBuf> {
    #[cfg(target_os = "windows")]
    let binary_name = "ffprobe.exe";

    #[cfg(not(target_os = "windows"))]
    let binary_name = "ffprobe";

    // Try common locations first
    let common_paths = get_common_ffmpeg_paths();
    for path in common_paths {
        let ffprobe_path = path.join(binary_name);
        if ffprobe_path.exists() {
            return Ok(ffprobe_path);
        }
    }

    // Fall back to PATH search
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("where")
            .arg("ffprobe")
            .output()
            .map_err(|_| FFmpegError::NotFound)?;

        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = path_str.lines().next() {
                return Ok(PathBuf::from(first_line.trim()));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("which")
            .arg("ffprobe")
            .output()
            .map_err(|_| FFmpegError::NotFound)?;

        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout);
            return Ok(PathBuf::from(path_str.trim()));
        }
    }

    Err(FFmpegError::NotFound)
}

/// Get common FFmpeg installation paths for the current platform
fn get_common_ffmpeg_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // Common Windows installation paths
        paths.push(PathBuf::from(r"C:\ffmpeg\bin"));
        paths.push(PathBuf::from(r"C:\Program Files\ffmpeg\bin"));
        paths.push(PathBuf::from(r"C:\Program Files (x86)\ffmpeg\bin"));

        // Chocolatey installation
        if let Ok(programdata) = std::env::var("ProgramData") {
            paths.push(PathBuf::from(programdata).join("chocolatey").join("bin"));
        }

        // Scoop installation
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            paths.push(PathBuf::from(userprofile).join("scoop").join("shims"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Homebrew paths
        paths.push(PathBuf::from("/opt/homebrew/bin"));
        paths.push(PathBuf::from("/usr/local/bin"));
        paths.push(PathBuf::from("/opt/local/bin")); // MacPorts
    }

    #[cfg(target_os = "linux")]
    {
        paths.push(PathBuf::from("/usr/bin"));
        paths.push(PathBuf::from("/usr/local/bin"));
        paths.push(PathBuf::from("/snap/bin"));
    }

    paths
}

/// Get FFmpeg version string
fn get_ffmpeg_version(ffmpeg_path: &PathBuf) -> FFmpegResult<String> {
    let output = Command::new(ffmpeg_path)
        .arg("-version")
        .output()
        .map_err(FFmpegError::ProcessError)?;

    if !output.status.success() {
        return Err(FFmpegError::ExecutionFailed(
            "Failed to get FFmpeg version".to_string(),
        ));
    }

    let output_str = String::from_utf8_lossy(&output.stdout);

    // Parse version from first line: "ffmpeg version X.X.X ..."
    if let Some(first_line) = output_str.lines().next() {
        if let Some(version_part) = first_line.strip_prefix("ffmpeg version ") {
            if let Some(version) = version_part.split_whitespace().next() {
                return Ok(version.to_string());
            }
        }
        // Return the whole first line if parsing fails
        return Ok(first_line.to_string());
    }

    Err(FFmpegError::ParseError(
        "Could not parse FFmpeg version".to_string(),
    ))
}

/// Validate that FFmpeg binaries are functional
pub fn validate_ffmpeg(info: &FFmpegInfo) -> FFmpegResult<()> {
    // Test ffmpeg
    let output = Command::new(&info.ffmpeg_path)
        .arg("-version")
        .output()
        .map_err(FFmpegError::ProcessError)?;

    if !output.status.success() {
        return Err(FFmpegError::ExecutionFailed(
            "FFmpeg binary is not functional".to_string(),
        ));
    }

    // Test ffprobe
    let output = Command::new(&info.ffprobe_path)
        .arg("-version")
        .output()
        .map_err(FFmpegError::ProcessError)?;

    if !output.status.success() {
        return Err(FFmpegError::ExecutionFailed(
            "FFprobe binary is not functional".to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_common_paths_not_empty() {
        let paths = get_common_ffmpeg_paths();
        assert!(!paths.is_empty());
    }

    #[test]
    fn test_detect_system_ffmpeg() {
        // This test will pass if FFmpeg is installed on the system
        // It's not a hard failure if FFmpeg isn't installed
        match detect_system_ffmpeg() {
            Ok(info) => {
                assert!(!info.version.is_empty());
                assert!(!info.is_bundled);
                println!("Found FFmpeg version: {}", info.version);
            }
            Err(FFmpegError::NotFound) => {
                println!("FFmpeg not found on system (expected in CI without FFmpeg)");
            }
            Err(e) => {
                panic!("Unexpected error: {}", e);
            }
        }
    }

    // ========================================================================
    // Bundled Detection Tests
    // ========================================================================

    #[test]
    fn test_get_bundled_binary_names() {
        let (ffmpeg, ffprobe) = get_bundled_binary_names();

        #[cfg(target_os = "windows")]
        {
            assert_eq!(ffmpeg, "ffmpeg.exe");
            assert_eq!(ffprobe, "ffprobe.exe");
        }

        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(ffmpeg, "ffmpeg");
            assert_eq!(ffprobe, "ffprobe");
        }
    }

    #[test]
    fn test_detect_bundled_at_path_missing_dir() {
        let temp_dir = tempfile::tempdir().unwrap();
        // Don't create binaries directory

        let result = detect_bundled_at_path(temp_dir.path());
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), FFmpegError::NotFound));
    }

    #[test]
    fn test_detect_bundled_at_path_empty_binaries_dir() {
        let temp_dir = tempfile::tempdir().unwrap();
        // Create empty binaries directory
        std::fs::create_dir_all(temp_dir.path().join("binaries")).unwrap();

        let result = detect_bundled_at_path(temp_dir.path());
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), FFmpegError::NotFound));
    }

    #[test]
    fn test_detect_bundled_at_path_missing_ffprobe() {
        let temp_dir = tempfile::tempdir().unwrap();
        let binaries_dir = temp_dir.path().join("binaries");
        std::fs::create_dir_all(&binaries_dir).unwrap();

        // Create only ffmpeg, not ffprobe
        #[cfg(target_os = "windows")]
        let ffmpeg_name = "ffmpeg.exe";
        #[cfg(not(target_os = "windows"))]
        let ffmpeg_name = "ffmpeg";

        std::fs::write(binaries_dir.join(ffmpeg_name), "fake binary").unwrap();

        let result = detect_bundled_at_path(temp_dir.path());
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), FFmpegError::NotFound));
    }

    #[test]
    fn test_detect_bundled_at_path_missing_ffmpeg() {
        let temp_dir = tempfile::tempdir().unwrap();
        let binaries_dir = temp_dir.path().join("binaries");
        std::fs::create_dir_all(&binaries_dir).unwrap();

        // Create only ffprobe, not ffmpeg
        #[cfg(target_os = "windows")]
        let ffprobe_name = "ffprobe.exe";
        #[cfg(not(target_os = "windows"))]
        let ffprobe_name = "ffprobe";

        std::fs::write(binaries_dir.join(ffprobe_name), "fake binary").unwrap();

        let result = detect_bundled_at_path(temp_dir.path());
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), FFmpegError::NotFound));
    }

    #[test]
    fn test_ffmpeg_info_clone() {
        let info = FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "6.0".to_string(),
            is_bundled: false,
        };

        let cloned = info.clone();
        assert_eq!(cloned.ffmpeg_path, info.ffmpeg_path);
        assert_eq!(cloned.ffprobe_path, info.ffprobe_path);
        assert_eq!(cloned.version, info.version);
        assert_eq!(cloned.is_bundled, info.is_bundled);
    }

    #[test]
    fn test_ffmpeg_info_debug() {
        let info = FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "6.0".to_string(),
            is_bundled: true,
        };

        let debug_str = format!("{:?}", info);
        assert!(debug_str.contains("ffmpeg"));
        assert!(debug_str.contains("6.0"));
        assert!(debug_str.contains("true"));
    }

    // ========================================================================
    // Dev Mode Detection Tests
    // ========================================================================

    #[test]
    fn test_get_dev_mode_paths_returns_paths() {
        let paths = get_dev_mode_paths();
        // Should return at least one path (current working directory based)
        assert!(
            !paths.is_empty(),
            "get_dev_mode_paths should return at least one path"
        );
    }

    #[test]
    fn test_get_dev_mode_paths_includes_src_tauri_binaries() {
        let paths = get_dev_mode_paths();
        // At least one path should end with "binaries"
        let has_binaries_path = paths.iter().any(|p| {
            p.file_name()
                .map(|name| name == "binaries")
                .unwrap_or(false)
        });
        assert!(
            has_binaries_path,
            "Should include a path ending with 'binaries'"
        );
    }

    #[test]
    fn test_detect_dev_mode_binaries_with_existing_binaries() {
        // This test verifies that detect_dev_mode_binaries works when binaries exist
        // It will succeed if we're running in dev mode with binaries present
        match detect_dev_mode_binaries() {
            Ok(info) => {
                assert!(info.is_bundled);
                assert!(!info.version.is_empty());
                assert!(info.ffmpeg_path.exists());
                assert!(info.ffprobe_path.exists());
                println!(
                    "Found dev mode FFmpeg: {} at {:?}",
                    info.version, info.ffmpeg_path
                );
            }
            Err(FFmpegError::NotFound) => {
                // This is OK if binaries haven't been downloaded yet
                println!("Dev mode binaries not found (expected if not downloaded)");
            }
            Err(e) => {
                panic!("Unexpected error: {}", e);
            }
        }
    }
}

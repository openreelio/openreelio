//! FFmpeg Detection Module
//!
//! Handles detection and validation of FFmpeg/FFprobe binaries.
//! Supports both bundled (sidecar) and system-installed binaries.

use std::path::PathBuf;
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
pub fn detect_bundled_ffmpeg(app_handle: &tauri::AppHandle) -> FFmpegResult<FFmpegInfo> {
    use tauri::Manager;

    // Get the resource directory
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|_| FFmpegError::NotFound)?;

    // Platform-specific binary names
    #[cfg(target_os = "windows")]
    let (ffmpeg_name, ffprobe_name) = ("ffmpeg.exe", "ffprobe.exe");

    #[cfg(not(target_os = "windows"))]
    let (ffmpeg_name, ffprobe_name) = ("ffmpeg", "ffprobe");

    // Check binaries directory
    let binaries_dir = resource_dir.join("binaries");
    let ffmpeg_path = binaries_dir.join(ffmpeg_name);
    let ffprobe_path = binaries_dir.join(ffprobe_name);

    if ffmpeg_path.exists() && ffprobe_path.exists() {
        let version = get_ffmpeg_version(&ffmpeg_path)?;
        return Ok(FFmpegInfo {
            ffmpeg_path,
            ffprobe_path,
            version,
            is_bundled: true,
        });
    }

    Err(FFmpegError::NotFound)
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
            paths.push(
                PathBuf::from(userprofile)
                    .join("scoop")
                    .join("shims"),
            );
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
}

//! FFmpeg Detection Module
//!
//! Handles detection and validation of FFmpeg/FFprobe binaries.
//! Supports both bundled (sidecar) and system-installed binaries.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::{FFmpegError, FFmpegResult};
use crate::core::process::configure_std_command;

/// Environment variable opting into working-directory-relative binary discovery.
///
/// Set to `1` or `true` by developers who run the binaries straight out of a
/// checkout (`cargo run`, `npm run tauri dev`) from a directory that is not the
/// crate manifest directory. See [`dev_mode_enabled`] for why it is opt-in.
pub const DEV_MODE_ENV: &str = "OPENREELIO_DEV";

/// Returns whether working-directory-relative FFmpeg discovery is enabled.
///
/// SECURITY: a directory that is searched for `binaries/ffmpeg` is a
/// code-execution root — whatever is found there is spawned. The CLI is
/// routinely launched as an MCP server with an *agent's project directory* as
/// its working directory (see `distribution/skills/.mcp.json`), so the working
/// directory holds untrusted, attacker-plantable content. It therefore only
/// becomes a discovery root when a developer explicitly opts in through
/// [`DEV_MODE_ENV`]; the trusted roots (executable directory, Cargo manifest
/// directory, managed install directory, system PATH) always participate.
pub fn dev_mode_enabled() -> bool {
    std::env::var(DEV_MODE_ENV)
        .map(|value| {
            let value = value.trim();
            value.eq_ignore_ascii_case("1") || value.eq_ignore_ascii_case("true")
        })
        .unwrap_or(false)
}

/// Where a detected FFmpeg installation came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FFmpegSource {
    /// Explicitly configured by the caller (CLI flag or API argument).
    Explicit,
    /// Configured through the `OPENREELIO_FFMPEG_PATH` environment override.
    Env,
    /// Bundled with the application (resource directory).
    Bundled,
    /// Installed by the in-app managed installer.
    Managed,
    /// Development-mode binaries under `src-tauri/binaries/`.
    Dev,
    /// System-installed FFmpeg (PATH or common locations).
    System,
}

impl FFmpegSource {
    /// Stable lowercase identifier surfaced to the frontend.
    pub fn as_str(self) -> &'static str {
        match self {
            FFmpegSource::Explicit => "explicit",
            FFmpegSource::Env => "env",
            FFmpegSource::Bundled => "bundled",
            FFmpegSource::Managed => "managed",
            FFmpegSource::Dev => "dev",
            FFmpegSource::System => "system",
        }
    }
}

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
    /// Where the installation was detected from
    pub source: FFmpegSource,
}

/// Detect FFmpeg from bundled sidecar binaries
///
/// Looks for FFmpeg binaries bundled with the application using Tauri's sidecar feature.
/// The binaries should be in the `binaries/` directory relative to the app resources.
///
/// In development mode, also checks the `src-tauri/binaries/` directory where binaries
/// are downloaded during the build process.
#[cfg(feature = "gui")]
pub fn detect_bundled_ffmpeg(app_handle: &tauri::AppHandle) -> FFmpegResult<FFmpegInfo> {
    // Try resource directory first (production path)
    if let Ok(info) = detect_bundled_resources(app_handle) {
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

/// Detect FFmpeg from the application resource directory only (no dev-mode
/// fallback), so callers can interleave other sources in the resolution order.
#[cfg(feature = "gui")]
pub fn detect_bundled_resources(app_handle: &tauri::AppHandle) -> FFmpegResult<FFmpegInfo> {
    use tauri::Manager;

    // Get the resource directory (works in production)
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|_| FFmpegError::NotFound)?;

    tracing::debug!("Checking resource directory: {:?}", resource_dir);

    let info = detect_bundled_at_path(&resource_dir)?;
    tracing::info!(
        "Found bundled FFmpeg at resource directory: {:?}",
        info.ffmpeg_path
    );
    Ok(info)
}

/// Detect FFmpeg binaries installed by the in-app managed installer.
///
/// Looks in `{data_local}/openreelio/ffmpeg/bin/` (see
/// [`super::installer::managed_install_dir`]).
pub fn detect_managed_ffmpeg() -> FFmpegResult<FFmpegInfo> {
    let install_dir = super::installer::managed_install_dir();
    let (ffmpeg_name, ffprobe_name) = get_bundled_binary_names();
    let ffmpeg_path = install_dir.join(ffmpeg_name);
    let ffprobe_path = install_dir.join(ffprobe_name);

    if !ffmpeg_path.exists() || !ffprobe_path.exists() {
        return Err(FFmpegError::NotFound);
    }

    let version = get_ffmpeg_version(&ffmpeg_path)?;
    Ok(FFmpegInfo {
        ffmpeg_path,
        ffprobe_path,
        version,
        is_bundled: false,
        source: FFmpegSource::Managed,
    })
}

/// Detect FFmpeg binaries in development mode
///
/// During development (`npm run tauri dev`), binaries are in `src-tauri/binaries/`
/// which is not the same as the resource directory. This function checks that path.
pub(crate) fn detect_dev_mode_binaries() -> FFmpegResult<FFmpegInfo> {
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
                        source: FFmpegSource::Dev,
                    });
                }
            }
        }
    }

    Err(FFmpegError::NotFound)
}

/// Get possible paths where dev mode binaries might be located
fn get_dev_mode_paths() -> Vec<PathBuf> {
    // The working directory is only a discovery root under an explicit
    // developer opt-in; see [`dev_mode_enabled`] for the threat model.
    let dev_cwd = if dev_mode_enabled() {
        std::env::current_dir().ok()
    } else {
        None
    };

    build_dev_mode_paths(
        std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from),
        std::env::current_exe().ok(),
        dev_cwd,
    )
}

/// Build the dev-mode search paths from already-resolved inputs.
///
/// Split from [`get_dev_mode_paths`] so the trust boundary (which inputs may
/// contribute roots) is testable without mutating process-global state.
fn build_dev_mode_paths(
    manifest_dir: Option<PathBuf>,
    exe_path: Option<PathBuf>,
    dev_cwd: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // CARGO_MANIFEST_DIR is set by cargo when it runs a binary or test, so it
    // only ever points inside a developer's own checkout.
    if let Some(manifest_dir) = manifest_dir {
        paths.push(manifest_dir.join("binaries"));
        // Workspace members (crates/openreelio-cli) have no `binaries/` of
        // their own: the downloaded dev binaries live in `src-tauri/binaries`
        // at the workspace root.
        for ancestor in manifest_dir.ancestors() {
            paths.push(ancestor.join("src-tauri").join("binaries"));
        }
    }

    // Try relative to current executable (for dev mode)
    if let Some(exe_path) = exe_path {
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

    // Working directory (might be project root) — opt-in only.
    if let Some(cwd) = dev_cwd {
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
        source: FFmpegSource::Bundled,
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
        source: FFmpegSource::System,
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
        let mut cmd = Command::new("where");
        configure_std_command(&mut cmd);
        let output = cmd
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
        let mut cmd = Command::new("which");
        configure_std_command(&mut cmd);
        let output = cmd
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
        let mut cmd = Command::new("where");
        configure_std_command(&mut cmd);
        let output = cmd
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
        let mut cmd = Command::new("which");
        configure_std_command(&mut cmd);
        let output = cmd
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

/// Run `<binary> -version` and return its first output line
fn run_version_probe(binary_path: &Path) -> FFmpegResult<String> {
    let mut cmd = Command::new(binary_path);
    configure_std_command(&mut cmd);
    let output = cmd
        .arg("-version")
        .output()
        .map_err(FFmpegError::ProcessError)?;

    if !output.status.success() {
        return Err(FFmpegError::ExecutionFailed(
            "Failed to get FFmpeg version".to_string(),
        ));
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(|line| line.to_string())
        .ok_or_else(|| FFmpegError::ParseError("Could not parse FFmpeg version".to_string()))
}

/// Get FFmpeg version string
pub(super) fn get_ffmpeg_version(ffmpeg_path: &Path) -> FFmpegResult<String> {
    let first_line = run_version_probe(ffmpeg_path)?;

    // Parse version from first line: "ffmpeg version X.X.X ..."
    if let Some(version_part) = first_line.strip_prefix("ffmpeg version ") {
        if let Some(version) = version_part.split_whitespace().next() {
            return Ok(version.to_string());
        }
    }

    // Return the whole first line if parsing fails
    Ok(first_line)
}

/// Check that a binary is present and responds to `-version`
///
/// Used by the resolver to validate explicitly configured ffprobe binaries,
/// which are not discovered through the filesystem probes above.
pub(super) fn probe_binary_runs(binary_path: &Path) -> FFmpegResult<()> {
    run_version_probe(binary_path).map(|_| ())
}

/// Validate that FFmpeg binaries are functional
pub fn validate_ffmpeg(info: &FFmpegInfo) -> FFmpegResult<()> {
    // Test ffmpeg
    let mut ffmpeg_cmd = Command::new(&info.ffmpeg_path);
    configure_std_command(&mut ffmpeg_cmd);
    let output = ffmpeg_cmd
        .arg("-version")
        .output()
        .map_err(FFmpegError::ProcessError)?;

    if !output.status.success() {
        return Err(FFmpegError::ExecutionFailed(
            "FFmpeg binary is not functional".to_string(),
        ));
    }

    // Test ffprobe
    let mut ffprobe_cmd = Command::new(&info.ffprobe_path);
    configure_std_command(&mut ffprobe_cmd);
    let output = ffprobe_cmd
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
            source: FFmpegSource::System,
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
            source: FFmpegSource::Bundled,
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
    fn should_exclude_working_directory_roots_when_dev_mode_is_off() {
        let cwd = PathBuf::from("/agent/untrusted-project");

        let paths = build_dev_mode_paths(
            Some(PathBuf::from("/home/dev/openreelio/src-tauri")),
            Some(PathBuf::from("/opt/openreelio/openreelio.exe")),
            None,
        );

        assert!(
            !paths.iter().any(|path| path.starts_with(&cwd)),
            "the working directory must never be searched by default: {paths:?}"
        );
        assert!(
            paths.contains(&PathBuf::from("/home/dev/openreelio/src-tauri").join("binaries")),
            "the Cargo manifest directory must still be searched: {paths:?}"
        );
    }

    #[test]
    fn should_include_working_directory_roots_when_dev_mode_is_on() {
        let cwd = PathBuf::from("/home/dev/openreelio");

        let paths = build_dev_mode_paths(None, None, Some(cwd.clone()));

        assert_eq!(
            paths,
            vec![cwd.join("src-tauri").join("binaries"), cwd.join("binaries"),]
        );
    }

    #[test]
    fn should_search_workspace_src_tauri_binaries_from_a_member_manifest_dir() {
        let manifest_dir = PathBuf::from("/home/dev/openreelio/crates/openreelio-cli");

        let paths = build_dev_mode_paths(Some(manifest_dir), None, None);

        assert!(
            paths.contains(
                &PathBuf::from("/home/dev/openreelio")
                    .join("src-tauri")
                    .join("binaries")
            ),
            "a workspace member must still find the shared dev binaries: {paths:?}"
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

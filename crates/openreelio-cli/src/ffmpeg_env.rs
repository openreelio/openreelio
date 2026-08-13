//! FFmpeg resolution for the CLI process.
//!
//! Every command that spawns ffmpeg/ffprobe (directly or through a core
//! module) must call [`ensure_ffmpeg`] first: core modules read the globally
//! registered paths, and without registration they fall back to bare `ffmpeg`,
//! which fails on installs where FFmpeg is only bundled or managed.

use openreelio_core::ffmpeg::{
    dev_mode_enabled, resolve_and_register, FFmpegInfo, FFmpegResolveOptions,
};
use std::path::PathBuf;

/// Resolve FFmpeg and publish the paths process-wide.
///
/// Search order: `OPENREELIO_FFMPEG_PATH` / `OPENREELIO_FFPROBE_PATH` →
/// bundled binaries next to the executable → managed install → dev-mode
/// binaries → system PATH.
pub fn ensure_ffmpeg() -> anyhow::Result<FFmpegInfo> {
    resolve_and_register(&resolve_options())
        .map_err(|error| anyhow::anyhow!("FFmpeg initialization failed: {}", error))
}

/// Resolve FFmpeg without failing the command when it is missing.
///
/// For paths where FFmpeg only enriches the result (media metadata probing on
/// import), a missing toolchain must stay a degraded success rather than an
/// error.
pub fn ensure_ffmpeg_optional() -> Option<FFmpegInfo> {
    match resolve_and_register(&resolve_options()) {
        Ok(info) => Some(info),
        Err(error) => {
            tracing::debug!("FFmpeg not available: {}", error);
            None
        }
    }
}

fn resolve_options() -> FFmpegResolveOptions {
    // The working directory only becomes a discovery root under the developer
    // opt-in; see `resource_roots_for` for the threat model.
    let dev_cwd = if dev_mode_enabled() {
        std::env::current_dir().ok()
    } else {
        None
    };

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from));

    FFmpegResolveOptions {
        resource_roots: resource_roots_for(exe_dir, dev_cwd),
        use_env: true,
        ..Default::default()
    }
}

/// Build the bundled-binary search roots from already-resolved inputs.
///
/// SECURITY: a resource root is a code-execution root — the resolver spawns
/// `<root>/binaries/ffmpeg` to probe its version, ahead of the managed install
/// and the system PATH. The CLI is routinely launched as an MCP server with an
/// agent's project directory as its working directory (see
/// `distribution/skills/.mcp.json`, which passes `${CLAUDE_PROJECT_DIR}`), so
/// that directory is untrusted: any checked-out repository carrying a
/// `binaries/ffmpeg` would otherwise be executed. The legitimate bundled layout
/// ships next to the binary, so only the executable directory is trusted here;
/// the working directory participates solely under the `OPENREELIO_DEV`
/// opt-in that developers running from a checkout set for themselves. When that
/// opt-in is set, the working directory keeps the highest priority it had
/// before, so an opted-in developer sees exactly the old behaviour.
///
/// Split from [`resolve_options`] so the trust boundary is testable without
/// mutating process-global state.
fn resource_roots_for(exe_dir: Option<PathBuf>, dev_cwd: Option<PathBuf>) -> Vec<PathBuf> {
    let mut resource_roots = Vec::new();

    if let Some(cwd) = dev_cwd {
        resource_roots.push(cwd.join("src-tauri"));
        resource_roots.push(cwd);
    }

    if let Some(exe_dir) = exe_dir {
        resource_roots.push(exe_dir);
    }

    resource_roots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_exclude_the_working_directory_when_dev_mode_is_off() {
        let cwd = PathBuf::from("/agent/untrusted-project");
        let exe_dir = PathBuf::from("/opt/openreelio");

        let roots = resource_roots_for(Some(exe_dir.clone()), None);

        assert_eq!(roots, vec![exe_dir]);
        assert!(
            !roots.iter().any(|root| root.starts_with(&cwd)),
            "the working directory must never be a bundled-binary root by default"
        );
    }

    #[test]
    fn should_include_the_working_directory_when_dev_mode_is_on() {
        let cwd = PathBuf::from("/home/dev/openreelio");
        let exe_dir = PathBuf::from("/home/dev/openreelio/target/debug");

        let roots = resource_roots_for(Some(exe_dir.clone()), Some(cwd.clone()));

        assert_eq!(roots, vec![cwd.join("src-tauri"), cwd, exe_dir]);
    }
}

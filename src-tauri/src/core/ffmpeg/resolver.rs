//! Global FFmpeg/FFprobe path resolver
//!
//! Modules that spawn ffmpeg/ffprobe directly (metadata extraction, shot
//! detection, audio extraction, ...) must not assume the binaries are on the
//! system PATH: on installs where FFmpeg is only bundled, bare "ffmpeg"
//! invocations silently fail. This module stores the paths resolved by
//! `FFmpegState::initialize` (GUI) or `detect_cli_ffmpeg` (CLI) and exposes
//! them process-wide. If nothing has been registered yet, a one-time lazy
//! detection runs (dev-mode binaries, then system PATH), falling back to the
//! bare binary name as the last resort so behavior never regresses.

use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use super::detection::{detect_dev_mode_binaries, detect_system_ffmpeg};

/// Globally resolved FFmpeg/FFprobe binary paths.
#[derive(Clone, Debug)]
pub struct ResolvedFFmpeg {
    /// Path to the ffmpeg binary
    pub ffmpeg: PathBuf,
    /// Path to the ffprobe binary
    pub ffprobe: PathBuf,
}

static RESOLVED: OnceLock<RwLock<Option<ResolvedFFmpeg>>> = OnceLock::new();

fn resolved_cell() -> &'static RwLock<Option<ResolvedFFmpeg>> {
    RESOLVED.get_or_init(|| RwLock::new(None))
}

/// Registers the globally resolved FFmpeg/FFprobe paths.
///
/// Called by `FFmpegState::initialize` (GUI) and `detect_cli_ffmpeg` (CLI)
/// once detection succeeds. Overwrites any previously cached paths.
pub fn set_resolved_paths(ffmpeg: PathBuf, ffprobe: PathBuf) {
    // A poisoned lock only means another thread panicked mid-write; the
    // stored Option is still valid, so recover the guard instead of panicking.
    let mut guard = resolved_cell()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(ResolvedFFmpeg { ffmpeg, ffprobe });
}

/// Returns the globally resolved paths, running lazy detection if needed.
fn resolved_paths() -> ResolvedFFmpeg {
    if let Some(resolved) = resolved_cell()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
    {
        return resolved;
    }

    // No registration yet: detect once (dev-mode binaries, then system PATH)
    // and fall back to bare names so PATH-based lookup keeps working.
    let detected = detect_dev_mode_binaries()
        .or_else(|_| detect_system_ffmpeg())
        .map(|info| ResolvedFFmpeg {
            ffmpeg: info.ffmpeg_path,
            ffprobe: info.ffprobe_path,
        })
        .unwrap_or_else(|_| ResolvedFFmpeg {
            ffmpeg: PathBuf::from("ffmpeg"),
            ffprobe: PathBuf::from("ffprobe"),
        });

    let mut guard = resolved_cell()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Another thread (or an explicit registration) may have won the race.
    match guard.as_ref() {
        Some(existing) => existing.clone(),
        None => {
            *guard = Some(detected.clone());
            detected
        }
    }
}

/// Returns the globally resolved ffmpeg path (lazy detection on first use).
pub fn resolved_ffmpeg_path() -> PathBuf {
    resolved_paths().ffmpeg
}

/// Returns the globally resolved ffprobe path (lazy detection on first use).
pub fn resolved_ffprobe_path() -> PathBuf {
    resolved_paths().ffprobe
}

#[cfg(test)]
mod tests {
    use super::*;

    // The resolver caches into process-global state shared by every test in
    // this binary, so all assertions live in a single test to keep ordering
    // deterministic.
    #[test]
    fn test_resolver_lazy_fallback_then_explicit_registration() {
        // Lazy path: with or without prior registration, the resolver must
        // always return a non-empty path for both binaries.
        let lazy_ffmpeg = resolved_ffmpeg_path();
        let lazy_ffprobe = resolved_ffprobe_path();
        assert!(!lazy_ffmpeg.as_os_str().is_empty());
        assert!(!lazy_ffprobe.as_os_str().is_empty());

        // Explicit registration overrides whatever was cached.
        let custom_ffmpeg = PathBuf::from("/custom/bin/ffmpeg");
        let custom_ffprobe = PathBuf::from("/custom/bin/ffprobe");
        set_resolved_paths(custom_ffmpeg.clone(), custom_ffprobe.clone());
        assert_eq!(resolved_ffmpeg_path(), custom_ffmpeg);
        assert_eq!(resolved_ffprobe_path(), custom_ffprobe);

        // Restore the initially resolved paths so later tests in this binary
        // never observe the synthetic /custom registration.
        set_resolved_paths(lazy_ffmpeg, lazy_ffprobe);
    }
}

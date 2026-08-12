//! Global FFmpeg/FFprobe path resolver
//!
//! Modules that spawn ffmpeg/ffprobe directly (metadata extraction, shot
//! detection, audio extraction, ...) must not assume the binaries are on the
//! system PATH: on installs where FFmpeg is only bundled or only installed
//! through the in-app installer, bare "ffmpeg" invocations silently fail.
//!
//! [`resolve_ffmpeg`] is the single resolution routine shared by the GUI and
//! the CLI so both see the same installations. [`resolve_and_register`]
//! additionally publishes the result process-wide via [`set_resolved_paths`].
//! If nothing has been registered yet, a one-time lazy detection runs
//! (dev-mode binaries, then system PATH), falling back to the bare binary name
//! as the last resort so behavior never regresses.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use super::detection::{
    detect_bundled_at_path, detect_dev_mode_binaries, detect_managed_ffmpeg, detect_system_ffmpeg,
    get_bundled_binary_names, get_ffmpeg_version, probe_binary_runs, FFmpegInfo, FFmpegSource,
};
use super::{FFmpegError, FFmpegResult};

/// Environment variable overriding the ffmpeg binary path.
pub const FFMPEG_PATH_ENV: &str = "OPENREELIO_FFMPEG_PATH";

/// Environment variable overriding the ffprobe binary path.
pub const FFPROBE_PATH_ENV: &str = "OPENREELIO_FFPROBE_PATH";

/// Globally resolved FFmpeg/FFprobe binary paths.
#[derive(Clone, Debug)]
pub struct ResolvedFFmpeg {
    /// Path to the ffmpeg binary
    pub ffmpeg: PathBuf,
    /// Path to the ffprobe binary
    pub ffprobe: PathBuf,
}

/// Inputs controlling how [`resolve_ffmpeg`] searches for FFmpeg.
///
/// The search order is fixed; these options only decide which of the
/// higher-priority sources participate at all.
#[derive(Clone, Debug, Default)]
pub struct FFmpegResolveOptions {
    /// Explicitly configured ffmpeg binary (highest priority).
    pub explicit_ffmpeg: Option<PathBuf>,
    /// Explicitly configured ffprobe binary. Derived from `explicit_ffmpeg`
    /// when only one of the two is supplied.
    pub explicit_ffprobe: Option<PathBuf>,
    /// Directories containing a bundled `binaries/` layout, in priority order.
    pub resource_roots: Vec<PathBuf>,
    /// Whether the `OPENREELIO_FFMPEG_PATH` / `OPENREELIO_FFPROBE_PATH`
    /// overrides participate. Off by default so GUI processes never inherit a
    /// stray variable from whatever launched them.
    pub use_env: bool,
}

/// A single resolution source, evaluated in priority order.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Candidate {
    /// Caller-supplied paths.
    Explicit { ffmpeg: PathBuf, ffprobe: PathBuf },
    /// Paths from the environment overrides.
    Env { ffmpeg: PathBuf, ffprobe: PathBuf },
    /// A directory holding a bundled `binaries/` layout.
    ResourceRoot(PathBuf),
    /// The in-app managed installer directory.
    Managed,
    /// Dev-mode binaries under `src-tauri/binaries/`.
    Dev,
    /// System PATH and common install locations.
    System,
}

impl Candidate {
    /// Human-readable label listed in the aggregated "not found" error.
    fn label(&self) -> String {
        match self {
            Candidate::Explicit { ffmpeg, .. } => format!("explicit({})", ffmpeg.display()),
            Candidate::Env { ffmpeg, .. } => {
                format!("env({FFMPEG_PATH_ENV}={})", ffmpeg.display())
            }
            Candidate::ResourceRoot(root) => format!("bundled({})", root.display()),
            Candidate::Managed => "managed".to_string(),
            Candidate::Dev => "dev".to_string(),
            Candidate::System => "system".to_string(),
        }
    }

    fn resolve(&self) -> FFmpegResult<FFmpegInfo> {
        match self {
            Candidate::Explicit { ffmpeg, ffprobe } => {
                validate_pair(ffmpeg, ffprobe, FFmpegSource::Explicit)
            }
            Candidate::Env { ffmpeg, ffprobe } => validate_pair(ffmpeg, ffprobe, FFmpegSource::Env),
            Candidate::ResourceRoot(root) => detect_bundled_at_path(root),
            Candidate::Managed => detect_managed_ffmpeg(),
            Candidate::Dev => detect_dev_mode_binaries(),
            Candidate::System => detect_system_ffmpeg(),
        }
    }
}

/// Validate a caller-supplied binary pair with the same version probe the
/// filesystem detectors use.
fn validate_pair(ffmpeg: &Path, ffprobe: &Path, source: FFmpegSource) -> FFmpegResult<FFmpegInfo> {
    let version = get_ffmpeg_version(ffmpeg)?;
    probe_binary_runs(ffprobe)?;

    Ok(FFmpegInfo {
        ffmpeg_path: ffmpeg.to_path_buf(),
        ffprobe_path: ffprobe.to_path_buf(),
        version,
        is_bundled: false,
        source,
    })
}

/// Derive the companion binary path next to an explicitly configured one.
///
/// A bare command name (no directory component) stays bare so PATH lookup
/// still applies to the derived binary.
fn sibling_binary(path: &Path, binary_name: &str) -> PathBuf {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(binary_name),
        _ => PathBuf::from(binary_name),
    }
}

/// Complete a partially supplied ffmpeg/ffprobe pair, or `None` when neither
/// half was supplied.
fn complete_pair(ffmpeg: Option<PathBuf>, ffprobe: Option<PathBuf>) -> Option<(PathBuf, PathBuf)> {
    let (ffmpeg_name, ffprobe_name) = get_bundled_binary_names();

    match (ffmpeg, ffprobe) {
        (Some(ffmpeg), Some(ffprobe)) => Some((ffmpeg, ffprobe)),
        (Some(ffmpeg), None) => {
            let ffprobe = sibling_binary(&ffmpeg, ffprobe_name);
            Some((ffmpeg, ffprobe))
        }
        (None, Some(ffprobe)) => {
            let ffmpeg = sibling_binary(&ffprobe, ffmpeg_name);
            Some((ffmpeg, ffprobe))
        }
        (None, None) => None,
    }
}

/// Read a path override from the environment, ignoring empty values.
fn read_env_override(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// Build the ordered candidate list.
///
/// Pure: the environment overrides are passed in rather than read here, and
/// they are dropped entirely unless `opts.use_env` is set.
fn build_candidates(
    opts: &FFmpegResolveOptions,
    env_ffmpeg: Option<PathBuf>,
    env_ffprobe: Option<PathBuf>,
) -> Vec<Candidate> {
    let mut candidates = Vec::new();

    if let Some((ffmpeg, ffprobe)) =
        complete_pair(opts.explicit_ffmpeg.clone(), opts.explicit_ffprobe.clone())
    {
        candidates.push(Candidate::Explicit { ffmpeg, ffprobe });
    }

    if opts.use_env {
        if let Some((ffmpeg, ffprobe)) = complete_pair(env_ffmpeg, env_ffprobe) {
            candidates.push(Candidate::Env { ffmpeg, ffprobe });
        }
    }

    candidates.extend(
        opts.resource_roots
            .iter()
            .cloned()
            .map(Candidate::ResourceRoot),
    );
    candidates.push(Candidate::Managed);
    candidates.push(Candidate::Dev);
    candidates.push(Candidate::System);

    candidates
}

/// Resolve an FFmpeg installation without touching any shared state.
///
/// Order: explicit paths → environment overrides (when
/// [`FFmpegResolveOptions::use_env`]) → each resource root → managed install →
/// dev-mode binaries → system PATH. Every candidate is validated by probing
/// `-version` on both binaries; the first valid one wins.
///
/// This spawns blocking process probes, so async callers must run it inside
/// `spawn_blocking`.
pub fn resolve_ffmpeg(opts: &FFmpegResolveOptions) -> FFmpegResult<FFmpegInfo> {
    let candidates = build_candidates(
        opts,
        read_env_override(FFMPEG_PATH_ENV),
        read_env_override(FFPROBE_PATH_ENV),
    );

    let mut tried = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        match candidate.resolve() {
            Ok(info) => {
                tracing::debug!(
                    "Resolved FFmpeg from {}: {:?}",
                    candidate.label(),
                    info.ffmpeg_path
                );
                return Ok(info);
            }
            Err(error) => {
                tracing::debug!("FFmpeg candidate {} rejected: {}", candidate.label(), error);
                tried.push(candidate.label());
            }
        }
    }

    Err(FFmpegError::NotFoundInSources(tried.join(", ")))
}

/// Resolve an FFmpeg installation and publish it process-wide.
///
/// Callers that go on to spawn ffmpeg/ffprobe through core modules must use
/// this instead of [`resolve_ffmpeg`], because those modules read the globals
/// registered here.
pub fn resolve_and_register(opts: &FFmpegResolveOptions) -> FFmpegResult<FFmpegInfo> {
    let info = resolve_ffmpeg(opts)?;
    set_resolved_paths(info.ffmpeg_path.clone(), info.ffprobe_path.clone());
    Ok(info)
}

static RESOLVED: OnceLock<RwLock<Option<ResolvedFFmpeg>>> = OnceLock::new();

fn resolved_cell() -> &'static RwLock<Option<ResolvedFFmpeg>> {
    RESOLVED.get_or_init(|| RwLock::new(None))
}

/// Registers the globally resolved FFmpeg/FFprobe paths.
///
/// Called by `FFmpegState::initialize` (GUI) and [`resolve_and_register`]
/// (CLI) once detection succeeds. Overwrites any previously cached paths.
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

    fn labels(candidates: &[Candidate]) -> Vec<String> {
        candidates
            .iter()
            .map(|candidate| match candidate {
                Candidate::Explicit { .. } => "explicit".to_string(),
                Candidate::Env { .. } => "env".to_string(),
                Candidate::ResourceRoot(root) => format!("root:{}", root.display()),
                Candidate::Managed => "managed".to_string(),
                Candidate::Dev => "dev".to_string(),
                Candidate::System => "system".to_string(),
            })
            .collect()
    }

    #[test]
    fn build_candidates_orders_explicit_before_env_before_detectors() {
        let opts = FFmpegResolveOptions {
            explicit_ffmpeg: Some(PathBuf::from("/explicit/ffmpeg")),
            explicit_ffprobe: Some(PathBuf::from("/explicit/ffprobe")),
            resource_roots: vec![PathBuf::from("/root_a"), PathBuf::from("/root_b")],
            use_env: true,
        };

        let candidates = build_candidates(
            &opts,
            Some(PathBuf::from("/env/ffmpeg")),
            Some(PathBuf::from("/env/ffprobe")),
        );

        assert_eq!(
            labels(&candidates),
            vec![
                "explicit",
                "env",
                &format!("root:{}", PathBuf::from("/root_a").display()),
                &format!("root:{}", PathBuf::from("/root_b").display()),
                "managed",
                "dev",
                "system",
            ]
        );
    }

    #[test]
    fn build_candidates_skips_env_when_disabled() {
        let opts = FFmpegResolveOptions {
            use_env: false,
            ..Default::default()
        };

        let candidates = build_candidates(
            &opts,
            Some(PathBuf::from("/env/ffmpeg")),
            Some(PathBuf::from("/env/ffprobe")),
        );

        assert_eq!(labels(&candidates), vec!["managed", "dev", "system"]);
    }

    #[test]
    fn build_candidates_derives_missing_companion_binary() {
        let (_, ffprobe_name) = get_bundled_binary_names();
        let opts = FFmpegResolveOptions {
            explicit_ffmpeg: Some(PathBuf::from("/opt/tools/ffmpeg")),
            ..Default::default()
        };

        let candidates = build_candidates(&opts, None, None);

        match &candidates[0] {
            Candidate::Explicit { ffprobe, .. } => {
                assert_eq!(ffprobe, &PathBuf::from("/opt/tools").join(ffprobe_name));
            }
            other => panic!("Expected an explicit candidate, got {other:?}"),
        }
    }

    #[test]
    fn build_candidates_keeps_bare_command_names_bare() {
        let (ffmpeg_name, _) = get_bundled_binary_names();
        let opts = FFmpegResolveOptions {
            explicit_ffprobe: Some(PathBuf::from("ffprobe")),
            ..Default::default()
        };

        let candidates = build_candidates(&opts, None, None);

        match &candidates[0] {
            Candidate::Explicit { ffmpeg, .. } => {
                assert_eq!(ffmpeg, &PathBuf::from(ffmpeg_name));
            }
            other => panic!("Expected an explicit candidate, got {other:?}"),
        }
    }

    #[test]
    fn resolve_ffmpeg_falls_through_invalid_explicit_paths() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bogus = temp_dir.path().join("not-ffmpeg");
        let opts = FFmpegResolveOptions {
            explicit_ffmpeg: Some(bogus.clone()),
            use_env: false,
            ..Default::default()
        };

        // Whether a real installation exists depends on the machine, so only
        // assert that the invalid explicit candidate is never accepted.
        match resolve_ffmpeg(&opts) {
            Ok(info) => assert_ne!(info.ffmpeg_path, bogus),
            Err(error) => {
                let message = error.to_string();
                assert!(message.contains("explicit("), "unexpected error: {message}");
                assert!(message.contains("system"), "unexpected error: {message}");
            }
        }
    }

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

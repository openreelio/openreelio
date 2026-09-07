//! FFmpeg Integration Module
//!
//! Provides FFmpeg functionality for video processing including:
//! - Frame extraction for preview
//! - Thumbnail generation
//! - Proxy video generation
//! - Final render/export
//!
//! Supports both bundled FFmpeg binaries (via Tauri sidecar) and system-installed FFmpeg.
//!
//! ## Bundling FFmpeg
//!
//! To bundle FFmpeg with the application, set `OPENREELIO_DOWNLOAD_FFMPEG=1` during build:
//! ```bash
//! OPENREELIO_DOWNLOAD_FFMPEG=1 cargo build --release
//! ```
//!
//! This will download platform-specific FFmpeg binaries and include them in the app bundle.

pub mod bundler;
#[cfg(all(not(test), feature = "gui"))]
mod commands;
mod detection;
pub mod installer;
mod resolver;
pub mod rotation;
mod runner;
mod state;

pub use bundler::{
    Arch, BundlerConfig, BundlerError, BundlerResult, DownloadSource, FFmpegPaths, Platform,
};
#[cfg(all(not(test), feature = "gui"))]
pub use commands::*;
pub use detection::*;
pub use resolver::{
    resolve_and_register, resolve_ffmpeg, resolved_ffmpeg_path, resolved_ffprobe_path,
    set_resolved_paths, FFmpegResolveOptions, ResolvedFFmpeg, FFMPEG_PATH_ENV, FFPROBE_PATH_ENV,
};
pub use rotation::{display_dimensions, normalize_rotation_deg, rotation_swaps_dimensions};
pub use runner::{
    capture_filter_stderr, AudioStreamInfo, FFmpegProgress, FFmpegRunner, FilterCapture,
    FilterMode, FrameExtractOptions, MediaInfo, RenderSettings, VideoStreamInfo, WaveformData,
};
pub use state::{create_ffmpeg_state, FFmpegState, SharedFFmpegState};
#[cfg(all(not(test), feature = "gui"))]
pub use state::{detect_ffmpeg, initialize_shared_ffmpeg};

/// FFmpeg-related error types
#[derive(Debug, thiserror::Error)]
pub enum FFmpegError {
    #[error("FFmpeg not found. Please install FFmpeg or ensure bundled binaries are present.")]
    NotFound,

    #[error("FFmpeg not found. Please install FFmpeg or ensure bundled binaries are present. Sources tried: {0}")]
    NotFoundInSources(String),

    #[error("FFmpeg execution failed: {0}")]
    ExecutionFailed(String),

    #[error("Invalid input file: {0}")]
    InvalidInput(String),

    #[error("Output path error: {0}")]
    OutputError(String),

    #[error("FFprobe error: {0}")]
    ProbeError(String),

    #[error("Configured FFmpeg binaries are unusable [{origin}]: {details}")]
    InvalidOverride {
        /// Where the override came from, e.g. `explicit(/opt/bin/ffmpeg)`.
        origin: String,
        /// The validation failure that rejected the configured binaries.
        details: String,
    },

    #[error("Process error: {0}")]
    ProcessError(#[from] std::io::Error),

    #[error("Parse error: {0}")]
    ParseError(String),

    #[error("Timeout: operation took too long")]
    Timeout,
}

impl FFmpegError {
    /// Whether the failure means the child process never ran at all.
    ///
    /// A probe fails in two ways, and only one of them says anything about the
    /// file: FFprobe ran and rejected what it read, or FFprobe could not be
    /// started. The second still happens long after startup detection
    /// succeeded - a binary uninstalled, quarantined by endpoint security, or
    /// living on a volume mounted without execute permission - and reaches the
    /// spawn as [`FFmpegError::ProcessError`] carrying
    /// [`std::io::ErrorKind::NotFound`] or
    /// [`std::io::ErrorKind::PermissionDenied`].
    ///
    /// That one arm is the whole rule. [`FFmpegError::NotFound`],
    /// [`FFmpegError::NotFoundInSources`] and [`FFmpegError::InvalidOverride`]
    /// are raised by the *resolver*, before an [`FFmpegRunner`] exists at all;
    /// a caller holding a runner has already got past them, so they can never
    /// come back out of [`FFmpegRunner::probe`] and listing them here would
    /// only describe a case no caller can reach.
    ///
    /// Callers that otherwise fall back to unmeasured defaults use this to tell
    /// a spawn that failed apart from a file FFprobe actually looked at. A
    /// `ProcessError` raised while *waiting* on a child that did start is not
    /// one of these; see [`FFmpegError::measured_nothing`] for the wider
    /// question a caller deciding whether to invent a duration should ask.
    pub fn is_launch_failure(&self) -> bool {
        match self {
            Self::ProcessError(error) => matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ),
            _ => false,
        }
    }

    /// Whether the failure left the caller knowing nothing about the file.
    ///
    /// A caller that falls back to defaults is claiming "FFprobe looked and
    /// this is the best we can say". Three failures make that claim false:
    /// FFprobe never started ([`FFmpegError::is_launch_failure`]);
    /// [`FFmpegError::Timeout`], where the child was killed before it reported
    /// anything; and [`FFmpegError::ParseError`], where output came back but
    /// could not be read, so no field of it was ever available. Substituting a
    /// default duration and frame size for any of these puts an invented
    /// measurement on an asset the user believes was imported.
    ///
    /// [`FFmpegError::ProbeError`] and [`FFmpegError::InvalidInput`] are
    /// deliberately excluded: FFprobe reached those about the file itself, and
    /// they are the cases a fallback exists for.
    pub fn measured_nothing(&self) -> bool {
        self.is_launch_failure() || matches!(self, Self::Timeout | Self::ParseError(_))
    }
}

pub type FFmpegResult<T> = Result<T, FFmpegError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ffmpeg_error_display() {
        let err = FFmpegError::NotFound;
        assert!(err.to_string().contains("FFmpeg not found"));

        let err = FFmpegError::ExecutionFailed("exit code 1".to_string());
        assert!(err.to_string().contains("exit code 1"));
    }

    /// Feature: FFmpeg error classification
    /// Scenario: telling "never ran" apart from "ran and refused"
    ///
    /// Given the failures a probe spawn can come back with
    /// When each is classified
    /// Then only the ones where no child ever started count as launch
    /// failures, so a caller may keep its fallback for everything FFprobe
    /// actually looked at.
    #[test]
    fn only_failures_before_the_child_started_are_launch_failures() {
        use std::io::{Error, ErrorKind};

        for error in [
            FFmpegError::ProcessError(Error::new(ErrorKind::NotFound, "program not found")),
            FFmpegError::ProcessError(Error::new(ErrorKind::PermissionDenied, "access is denied")),
        ] {
            assert!(
                error.is_launch_failure(),
                "{error} means no FFprobe ever looked at the file"
            );
        }

        for error in [
            FFmpegError::ProbeError("FFprobe failed: Invalid data found".to_string()),
            FFmpegError::InvalidInput("Input file does not exist: /gone.mp4".to_string()),
            FFmpegError::ParseError("unexpected end of JSON".to_string()),
            FFmpegError::Timeout,
            FFmpegError::ProcessError(Error::new(ErrorKind::Interrupted, "wait interrupted")),
        ] {
            assert!(
                !error.is_launch_failure(),
                "{error} did not stop a child from starting"
            );
        }
    }

    /// Feature: FFmpeg error classification
    /// Scenario: deciding when a default would be an invented measurement
    ///
    /// Given the failures a probe can come back with
    /// When each is asked whether anything was learned about the file
    /// Then the spawn failures, the watchdog kill and the unreadable output all
    /// say no - an import must refuse rather than attach a default duration and
    /// frame size, and a relink must refuse rather than clear the real ones -
    /// while FFprobe's own verdicts on the file keep the fallback.
    #[test]
    fn a_probe_that_reported_nothing_cannot_be_answered_with_defaults() {
        use std::io::{Error, ErrorKind};

        for error in [
            FFmpegError::ProcessError(Error::new(ErrorKind::NotFound, "program not found")),
            FFmpegError::ProcessError(Error::new(ErrorKind::PermissionDenied, "access is denied")),
            FFmpegError::Timeout,
            FFmpegError::ParseError("unexpected end of JSON".to_string()),
        ] {
            assert!(
                error.measured_nothing(),
                "{error} measured nothing, so a default would be invented"
            );
        }

        for error in [
            FFmpegError::ProbeError("FFprobe failed: Invalid data found".to_string()),
            FFmpegError::InvalidInput("Input file does not exist: /gone.mp4".to_string()),
            FFmpegError::ProcessError(Error::new(ErrorKind::Interrupted, "wait interrupted")),
        ] {
            assert!(
                !error.measured_nothing(),
                "{error} is a verdict FFprobe reached, not a reason to refuse the import"
            );
        }
    }
}

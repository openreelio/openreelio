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
#[cfg(not(test))]
mod commands;
mod detection;
mod runner;
mod state;

pub use bundler::{
    Arch, BundlerConfig, BundlerError, BundlerResult, DownloadSource, FFmpegPaths, Platform,
};
#[cfg(not(test))]
pub use commands::*;
pub use detection::*;
pub use runner::{
    AudioStreamInfo, FFmpegProgress, FFmpegRunner, MediaInfo, RenderSettings, VideoStreamInfo,
    WaveformData,
};
pub use state::{create_ffmpeg_state, FFmpegState, SharedFFmpegState};

/// FFmpeg-related error types
#[derive(Debug, thiserror::Error)]
pub enum FFmpegError {
    #[error("FFmpeg not found. Please install FFmpeg or ensure bundled binaries are present.")]
    NotFound,

    #[error("FFmpeg execution failed: {0}")]
    ExecutionFailed(String),

    #[error("Invalid input file: {0}")]
    InvalidInput(String),

    #[error("Output path error: {0}")]
    OutputError(String),

    #[error("FFprobe error: {0}")]
    ProbeError(String),

    #[error("Process error: {0}")]
    ProcessError(#[from] std::io::Error),

    #[error("Parse error: {0}")]
    ParseError(String),

    #[error("Timeout: operation took too long")]
    Timeout,
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
}

/// Error types for the point tracking module.
use thiserror::Error;

/// Errors that can occur during point tracking operations.
#[derive(Debug, Error)]
pub enum TrackingError {
    /// FFmpeg process failed or produced unexpected output.
    #[allow(clippy::upper_case_acronyms)]
    #[error("FFmpeg error: {0}")]
    FFmpeg(String),

    /// Invalid input parameters provided to the tracker.
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    /// IO error during file operations.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

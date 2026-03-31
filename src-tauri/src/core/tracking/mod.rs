/// Point tracking module.
///
/// Provides NCC (Normalized Cross-Correlation) template matching
/// for tracking a user-selected point across video frames.
/// Uses FFmpeg for frame extraction and pure Rust for the matching algorithm.
pub mod error;
pub mod models;
pub mod tracker;

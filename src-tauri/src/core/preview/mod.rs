//! Canvas preview decoding.
//!
//! The canvas preview player composites one drawable per active clip per
//! displayed frame. This module supplies those drawables from a small pool of
//! long-lived FFmpeg processes streaming raw RGBA, replacing the previous
//! spawn-encode-write-read-decode round trip per frame.

#[cfg(all(not(test), feature = "gui"))]
mod commands;
pub mod decoder;
mod state;

#[cfg(all(not(test), feature = "gui"))]
pub use commands::*;
pub use decoder::{
    classify_timing, fitted_output_size, frame_index_for_time, seek_argument,
    seek_argument_seconds, PreviewDecoderPool, PreviewFrame, SourceInfo, SourceTiming,
    DEFAULT_MAX_RESIDENT_DECODERS,
};
pub use state::{create_preview_decoder_state, PreviewDecoderState, SharedPreviewDecoders};

//! Caption System Module
//!
//! Provides caption/subtitle functionality for OpenReelio including:
//! - Caption data models (Caption, CaptionTrack, CaptionStyle)
//! - SRT and VTT format parsing and export
//! - Caption rendering (planned: FFmpeg subtitle filter generation)
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────┐
//! │                     Caption System                               │
//! ├─────────────────────────────────────────────────────────────────┤
//! │  models.rs     - Data structures (Caption, Track, Style)        │
//! │  formats.rs    - SRT/VTT parsing and export                     │
//! │  render.rs     - FFmpeg subtitle filter generation (planned)    │
//! └─────────────────────────────────────────────────────────────────┘
//! ```
//!
//! # Example Usage
//!
//! ```rust,ignore
//! use crate::core::captions::{Caption, CaptionTrack, parse_srt, export_vtt};
//!
//! // Create a caption track
//! let mut track = CaptionTrack::create("English Subtitles", "en");
//!
//! // Add captions
//! track.add_caption(Caption::create(0.0, 2.5, "Hello World"));
//! track.add_caption(Caption::create(3.0, 5.5, "Welcome to OpenReelio"));
//!
//! // Export to VTT
//! let vtt_content = export_vtt(&track.captions);
//!
//! // Parse SRT file
//! let srt_content = std::fs::read_to_string("subtitles.srt")?;
//! let captions = parse_srt(&srt_content)?;
//! ```

pub mod audio;
mod formats;
mod models;
pub mod whisper;

// Re-export models
pub use models::{
    Caption, CaptionId, CaptionPosition, CaptionStyle, CaptionTrack, CaptionTrackId, Color,
    CustomPosition, FontWeight, TextAlignment, VerticalPosition,
};

// Re-export format functions
pub use formats::{
    captions_to_track, export_srt, export_vtt, parse_srt, parse_vtt, track_to_srt, track_to_vtt,
    ParseError,
};

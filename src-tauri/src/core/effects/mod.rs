//! Effects Module
//!
//! Defines visual and audio effects that can be applied to clips.
//! Includes FFmpeg filter generation for rendering effects.

mod filter_builder;
mod models;

pub use filter_builder::{FilterGraph, IntoFFmpegFilter};
pub use models::*;

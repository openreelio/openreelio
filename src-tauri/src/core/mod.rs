//! OpenReelio Core Engine
//!
//! Core editing engine module.
//! Handles all core functionality including timeline, assets, rendering, and project management.

pub mod ai;
pub mod assets;
pub mod commands;
pub mod effects;
pub mod ffmpeg;
pub mod generative;
pub mod indexing;
pub mod jobs;
pub mod performance;
pub mod plugin;
pub mod project;
pub mod qc;
pub mod render;
pub mod search;
pub mod template;
pub mod timeline;

// Re-export common types
mod types;
pub use types::*;

mod error;
pub use error::*;

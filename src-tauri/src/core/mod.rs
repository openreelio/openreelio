//! OpenReelio Core Engine
//!
//! Core editing engine module.
//! Handles all core functionality including timeline, assets, rendering, and project management.

pub mod ai;
pub mod annotations;
pub mod assets;
pub mod captions;
pub mod commands;
pub mod credentials;
pub mod effects;
pub mod ffmpeg;
pub mod fs;
pub mod generative;
pub mod indexing;
pub mod jobs;
pub mod masks;
pub mod performance;
pub mod plugin;
pub mod process;
pub mod project;
pub mod qc;
pub mod recovery;
pub mod render;
pub mod search;
pub mod settings;
pub mod shapes;
pub mod template;
pub mod text;
pub mod timeline;
pub mod update;
pub mod workspace;

// Re-export common types
mod types;
pub use types::*;

mod error;
pub use error::*;

#[cfg(test)]
mod tests_destructive;

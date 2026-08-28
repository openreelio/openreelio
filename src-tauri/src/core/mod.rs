//! OpenReelio Core Engine
//!
//! Core editing engine module.
//! Handles all core functionality including timeline, assets, rendering, and project management.

pub mod ai;
pub mod analysis;
pub mod annotations;
pub mod artifact;
pub mod assets;
pub mod captions;
pub mod claude_agent;
pub mod claude_code;
pub mod claude_headless;
#[cfg(feature = "gui")]
pub mod claude_login_pty;
pub mod codex;
pub mod codex_app_server;
#[cfg(feature = "gui")]
pub mod codex_login;
pub mod commands;
pub mod credentials;
pub mod effects;
pub mod external_agent;
pub mod ffmpeg;
pub mod fs;
pub mod generative;
pub mod indexing;
pub mod interchange;
pub mod jobs;
#[cfg(feature = "gui")]
pub mod managed_runtime;
pub mod masks;
pub mod performance;
pub mod plugin;
pub mod preview;
pub mod process;
pub mod project;
pub mod qc;
pub mod recovery;
pub mod render;
pub mod search;
pub mod settings;
pub mod shapes;
pub mod style;
pub mod template;
pub mod terminal_command_line;
pub mod text;
pub mod timeline;
pub mod tracking;
pub mod update;
pub mod workspace;

// Re-export common types
mod types;
pub use types::*;

mod error;
pub use error::*;

#[cfg(test)]
mod tests_destructive;

#[cfg(test)]
mod test_ffmpeg;

//! IPC (Inter-Process Communication) Module
//!
//! Handles communication between Tauri backend and React frontend.
//! All Tauri commands and events are defined here.

#[cfg(feature = "gui")]
mod ai_command_defaults;
#[cfg(all(not(test), feature = "gui"))]
mod commands;
#[cfg(feature = "gui")]
mod dto;
#[cfg(all(not(test), feature = "gui"))]
mod events;
mod payloads;

#[allow(unused_imports)]
#[cfg(feature = "gui")]
pub(crate) use ai_command_defaults::*;
#[cfg(all(not(test), feature = "gui"))]
pub use commands::*;
#[allow(unused_imports)]
#[cfg(feature = "gui")]
pub(crate) use dto::*;
#[cfg(all(not(test), feature = "gui"))]
pub use events::*;
pub use payloads::*;

#[cfg(test)]
mod tests_destructive;

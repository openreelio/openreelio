//! IPC (Inter-Process Communication) Module
//!
//! Handles communication between Tauri backend and React frontend.
//! All Tauri commands and events are defined here.

mod ai_command_defaults;
#[cfg(not(test))]
mod commands;
mod dto;
#[cfg(not(test))]
mod events;
mod payloads;

#[allow(unused_imports)]
pub(crate) use ai_command_defaults::*;
#[cfg(not(test))]
pub use commands::*;
#[allow(unused_imports)]
pub(crate) use dto::*;
#[cfg(not(test))]
pub use events::*;
pub use payloads::*;

#[cfg(test)]
mod tests_destructive;

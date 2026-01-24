//! IPC (Inter-Process Communication) Module
//!
//! Handles communication between Tauri backend and React frontend.
//! All Tauri commands and events are defined here.

#[cfg(not(test))]
mod commands;
mod dto;
#[cfg(not(test))]
mod events;
mod payloads;

#[cfg(not(test))]
pub use commands::*;
#[cfg(not(test))]
pub(crate) use dto::*;
#[cfg(not(test))]
pub use events::*;
pub use payloads::*;

#[cfg(test)]
mod tests_destructive;

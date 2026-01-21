//! IPC (Inter-Process Communication) Module
//!
//! Handles communication between Tauri backend and React frontend.
//! All Tauri commands and events are defined here.

mod commands;
mod events;
mod payloads;

pub use commands::*;
pub use events::*;
pub use payloads::*;

#[cfg(test)]
mod tests_destructive;

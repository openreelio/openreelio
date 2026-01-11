//! IPC (Inter-Process Communication) Module
//!
//! Handles communication between Tauri backend and React frontend.
//! All Tauri commands and events are defined here.

mod commands;
mod events;

pub use commands::*;
pub use events::*;

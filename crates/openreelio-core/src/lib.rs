//! OpenReelio Core Library
//!
//! Facade crate that re-exports the core editing engine from `openreelio_lib`
//! without any GUI (Tauri/WebView) dependency. This crate is the foundation
//! for both the CLI binary and future non-GUI frontends.
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────┐    ┌─────────────────┐
//! │  openreelio-cli  │    │  src-tauri (GUI) │
//! └────────┬────────┘    └────────┬────────┘
//!          │                      │
//!          ▼                      ▼
//!   ┌──────────────────────────────────┐
//!   │        openreelio-core           │
//!   │  (EventBroadcaster, ActiveProject│
//!   │   commands, timeline, project)   │
//!   └──────────────────────────────────┘
//! ```

mod events;

// Re-export the EventBroadcaster abstraction
pub use events::{ChannelBroadcaster, EventBroadcaster, NullBroadcaster};

// Re-export all core modules from the main library
pub use openreelio_lib::core::*;

// Re-export the ActiveProject struct
pub use openreelio_lib::ActiveProject;

//! IPC Commands Module
//!
//! This module organizes Tauri IPC commands by domain.
//!
//! ## Module Structure (Target)
//!
//! ```text
//! commands/
//! ├── mod.rs           # Re-exports all command modules
//! ├── helpers.rs       # get_active_project! macro, shared error handling
//! ├── project.rs       # create/open/close/save/get project (TODO)
//! ├── asset.rs         # import/remove/thumbnail/proxy/waveform (TODO)
//! ├── timeline.rs      # sequence CRUD (TODO)
//! ├── command.rs       # execute/undo/redo (TODO)
//! ├── job.rs           # job queue management (TODO)
//! ├── render.rs        # export/render (TODO)
//! ├── ai.rs            # AI integration (TODO)
//! ├── transcription.rs # speech-to-text (TODO)
//! ├── search.rs        # search/indexing (TODO)
//! ├── memory.rs        # performance stats (TODO)
//! └── settings.rs      # app settings (TODO)
//! ```
//!
//! ## Migration Notes
//!
//! Commands are being incrementally extracted from the monolithic `commands_legacy.rs`
//! file (originally `commands.rs`). Each domain-specific module should:
//!
//! 1. Import only necessary types from `crate::core`
//! 2. Use helpers from `helpers.rs` for common patterns
//! 3. Re-export commands at the module level
//!
//! ## Current Status
//!
//! All commands are currently in `commands_legacy.rs`. The scaffolding is in place
//! for incremental extraction. To extract a command group:
//!
//! 1. Create a new module file (e.g., `settings.rs`)
//! 2. Move the relevant commands from `commands_legacy.rs`
//! 3. Add `pub mod settings;` and `pub use settings::*;` here
//! 4. Remove the corresponding `pub use legacy::command_name;` line
//!
//! ## Usage
//!
//! ```ignore
//! use crate::ipc::commands::*;
//!
//! // All commands are available through this re-export
//! ```

// Core helpers shared across command modules
pub mod helpers;

// Annotation commands (Asset Annotation System - ADR-036)
pub mod annotations;

// Video generation commands (Seedance 2.0 integration)
pub mod video_generation;

// Workspace commands (workspace scanning, file tree, registration)
pub mod workspace;

// Placeholder for future extracted modules
// pub mod settings;

// Legacy module containing all commands (not yet extracted)
#[path = "../commands_legacy.rs"]
mod legacy;

// Re-export all commands from legacy module
pub use legacy::*;

// Re-export annotation commands
pub use annotations::*;

// Re-export video generation commands
pub use video_generation::*;

// Re-export workspace commands
pub use workspace::*;

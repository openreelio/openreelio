//! IPC Commands Module
//!
//! This module organizes Tauri IPC commands by domain.
//!
//! ## Module Structure
//!
//! ```text
//! commands/
//! ├── mod.rs           # Re-exports all command modules
//! ├── helpers.rs       # get_active_project! macro, shared error handling
//! ├── project.rs       # create/open/close/save/get project
//! ├── asset.rs         # import/remove/thumbnail/proxy/waveform
//! ├── timeline.rs      # sequence CRUD, execute/undo/redo
//! ├── render.rs        # export/render
//! ├── ai_legacy.rs     # AI integration (intent, provider, chat, completion)
//! ├── transcription.rs # speech-to-text, captions, shot detection
//! ├── search.rs        # search/indexing (SQLite + Meilisearch)
//! ├── jobs.rs          # job queue, memory/performance stats
//! ├── system.rs        # app lifecycle, settings, credentials, updates
//! ├── annotations.rs   # asset annotation system (ADR-036)
//! ├── video_generation.rs # Seedance 2.0 integration
//! ├── workspace.rs     # workspace scanning, file tree, registration
//! └── agent.rs         # trace writing, plan execution, memory persistence
//! ```
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

// Domain modules (extracted from commands_legacy.rs)
pub mod ai_legacy;
pub mod asset;
pub mod jobs;
pub mod project;
pub mod render;
pub mod search;
pub mod system;
pub mod timeline;
pub mod transcription;

// Annotation commands (Asset Annotation System - ADR-036)
pub mod annotations;

// Video generation commands (Seedance 2.0 integration)
pub mod video_generation;

// Workspace commands (workspace scanning, file tree, registration)
pub mod workspace;

// Analysis pipeline commands (reference video analysis - ADR-048)
pub mod analysis;

// Source monitor commands (dual-viewer, In/Out points, 3-point editing)
pub mod source_monitor;

// Agent commands (trace writing, plan execution, memory persistence)
pub mod agent;

// Re-export all domain modules
pub use ai_legacy::*;
pub use asset::*;
pub use jobs::*;
pub use project::*;
pub use render::*;
pub use search::*;
pub use system::*;
pub use timeline::*;
pub use transcription::*;

// Re-export annotation commands
pub use annotations::*;

// Re-export video generation commands
pub use video_generation::*;

// Re-export workspace commands
pub use workspace::*;

// Re-export analysis pipeline commands
pub use analysis::*;

// Re-export source monitor commands
pub use source_monitor::*;

// Re-export agent commands
pub use agent::*;

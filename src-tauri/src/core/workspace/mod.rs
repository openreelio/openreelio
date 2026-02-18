//! Workspace Management Module
//!
//! Provides workspace-based asset discovery for the project folder.
//! Instead of requiring explicit file imports, the workspace module scans
//! the project directory for media files and monitors for changes.

pub mod ignore;
pub mod index;
pub mod path_resolver;
pub mod scanner;
pub mod service;
pub mod watcher;

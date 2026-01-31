//! Project Management Module
//!
//! Handles project state, operation log (event sourcing), snapshots, and backups.

mod backup;
mod ops_log;
mod snapshot;
mod state;

pub use backup::*;
pub use ops_log::*;
pub use snapshot::*;
pub use state::*;

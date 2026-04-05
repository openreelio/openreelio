//! Project Management Module
//!
//! Handles project state, operation log (event sourcing), snapshots, backups,
//! and persistent history metadata.

mod backup;
mod history;
mod ops_log;
mod snapshot;
mod state;

pub use backup::*;
pub use history::*;
pub use ops_log::*;
pub use snapshot::*;
pub use state::*;

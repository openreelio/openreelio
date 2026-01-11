//! Project Management Module
//!
//! Handles project state, operation log (event sourcing), and snapshots.

mod ops_log;
mod snapshot;
mod state;

pub use ops_log::*;
pub use snapshot::*;
pub use state::*;

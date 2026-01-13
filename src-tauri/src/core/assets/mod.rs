//! Asset Management Module
//!
//! Handles all asset-related operations including import, metadata extraction,
//! thumbnail generation, and asset lifecycle management.

mod metadata;
mod models;
pub mod thumbnail;

pub use metadata::*;
pub use models::*;
pub use thumbnail::*;

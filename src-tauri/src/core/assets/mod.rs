//! Asset Management Module
//!
//! Handles all asset-related operations including import, metadata extraction,
//! thumbnail generation, proxy generation, and asset lifecycle management.

mod license_policy;
mod metadata;
mod models;
pub mod thumbnail;

pub use license_policy::*;
pub use metadata::*;
pub use models::*;
pub use thumbnail::*;

// Re-export proxy-related items for convenience
pub use models::{requires_proxy, ProxyStatus, PROXY_THRESHOLD_HEIGHT};

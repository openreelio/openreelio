//! Analysis Providers
//!
//! Implements different video analysis backends.
//!
//! - **local.rs**: FFmpeg-based shot detection (free, default)
//! - **google_cloud.rs**: Google Cloud Video Intelligence + Vision (paid, optional)

pub mod google_cloud;
pub mod local;

pub use google_cloud::GoogleCloudProvider;
pub use local::LocalAnalysisProvider;

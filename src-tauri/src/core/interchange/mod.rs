//! Interchange Module
//!
//! Handles export/import of timeline data to/from standard NLE interchange formats:
//! - **EDL**: CMX 3600 Edit Decision List
//! - **FCPXML**: Final Cut Pro XML (v1.11)
//! - **OTIO**: OpenTimelineIO (stub for future)

pub mod edl;
pub mod models;
pub mod otio;
pub mod xml;

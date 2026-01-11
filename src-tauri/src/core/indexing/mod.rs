//! Indexing System Module
//!
//! Manages media indexing including shot detection, transcription, and embeddings.

pub mod db;
pub mod shots;
pub mod transcripts;

pub use db::IndexDb;
pub use shots::{Shot, ShotDetector};
pub use transcripts::{Transcript, TranscriptSegment};

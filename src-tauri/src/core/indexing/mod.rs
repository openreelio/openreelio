//! Indexing System Module
//!
//! Manages media indexing including shot detection, transcription, and embeddings.

pub mod db;
pub mod report_chunks;
pub mod shots;
pub mod transcripts;

pub use db::IndexDb;
pub use report_chunks::{ReportChunk, ReportChunkSearchResult};
pub use shots::{Shot, ShotDetector, ShotDetectorConfig};
pub use transcripts::{Transcript, TranscriptSegment};

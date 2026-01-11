//! Transcript Module
//!
//! Manages ASR (Automatic Speech Recognition) transcriptions.

use serde::{Deserialize, Serialize};

use super::db::IndexDb;
use crate::core::{AssetId, CoreError, CoreResult};

// =============================================================================
// Transcript Model
// =============================================================================

/// Complete transcript for an asset
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    /// Asset ID this transcript belongs to
    pub asset_id: AssetId,
    /// Language code (e.g., "en", "ko", "ja")
    pub language: Option<String>,
    /// Transcript segments
    pub segments: Vec<TranscriptSegment>,
}

impl Transcript {
    /// Creates a new empty transcript
    pub fn new(asset_id: &str) -> Self {
        Self {
            asset_id: asset_id.to_string(),
            language: None,
            segments: Vec::new(),
        }
    }

    /// Creates a transcript with segments
    pub fn with_segments(asset_id: &str, segments: Vec<TranscriptSegment>) -> Self {
        Self {
            asset_id: asset_id.to_string(),
            language: None,
            segments,
        }
    }

    /// Returns the full text of the transcript
    pub fn full_text(&self) -> String {
        self.segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Returns segments that overlap with a time range
    pub fn segments_in_range(&self, start_sec: f64, end_sec: f64) -> Vec<&TranscriptSegment> {
        self.segments
            .iter()
            .filter(|s| s.end_sec > start_sec && s.start_sec < end_sec)
            .collect()
    }

    /// Returns text within a time range
    pub fn text_in_range(&self, start_sec: f64, end_sec: f64) -> String {
        self.segments_in_range(start_sec, end_sec)
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Returns total duration covered by segments
    pub fn total_duration(&self) -> f64 {
        if self.segments.is_empty() {
            return 0.0;
        }

        let start = self
            .segments
            .iter()
            .map(|s| s.start_sec)
            .fold(f64::INFINITY, f64::min);
        let end = self.segments.iter().map(|s| s.end_sec).fold(0.0, f64::max);

        end - start
    }
}

// =============================================================================
// Transcript Segment
// =============================================================================

/// A single segment of a transcript
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    /// Unique segment ID
    pub id: String,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Transcribed text
    pub text: String,
    /// Confidence score (0.0 - 1.0)
    pub confidence: Option<f64>,
    /// Language code (if different from transcript default)
    pub language: Option<String>,
}

impl TranscriptSegment {
    /// Creates a new transcript segment
    pub fn new(start_sec: f64, end_sec: f64, text: &str) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            start_sec,
            end_sec,
            text: text.to_string(),
            confidence: None,
            language: None,
        }
    }

    /// Creates a segment with confidence score
    pub fn with_confidence(start_sec: f64, end_sec: f64, text: &str, confidence: f64) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            start_sec,
            end_sec,
            text: text.to_string(),
            confidence: Some(confidence),
            language: None,
        }
    }

    /// Returns the duration of this segment
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }

    /// Returns the midpoint time of this segment
    pub fn midpoint(&self) -> f64 {
        (self.start_sec + self.end_sec) / 2.0
    }

    /// Checks if this segment overlaps with a time range
    pub fn overlaps(&self, start: f64, end: f64) -> bool {
        self.end_sec > start && self.start_sec < end
    }

    /// Returns words per second for this segment
    pub fn words_per_second(&self) -> f64 {
        let word_count = self.text.split_whitespace().count() as f64;
        let duration = self.duration();

        if duration > 0.0 {
            word_count / duration
        } else {
            0.0
        }
    }
}

// =============================================================================
// Transcript Database Operations
// =============================================================================

/// Saves a transcript to the index database
pub fn save_transcript(
    db: &IndexDb,
    asset_id: &str,
    segments: &[TranscriptSegment],
) -> CoreResult<()> {
    let conn = db.connection();

    for segment in segments {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO transcripts (id, asset_id, start_sec, end_sec, text, lang, confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
            rusqlite::params![
                segment.id,
                asset_id,
                segment.start_sec,
                segment.end_sec,
                segment.text,
                segment.language,
                segment.confidence,
            ],
        )
        .map_err(|e| CoreError::Internal(format!("Failed to save transcript segment: {}", e)))?;
    }

    Ok(())
}

/// Loads transcript segments for an asset from the database
pub fn load_transcript(db: &IndexDb, asset_id: &str) -> CoreResult<Transcript> {
    let conn = db.connection();

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, start_sec, end_sec, text, lang, confidence
            FROM transcripts
            WHERE asset_id = ?
            ORDER BY start_sec
            "#,
        )
        .map_err(|e| CoreError::Internal(format!("Failed to prepare query: {}", e)))?;

    let segments = stmt
        .query_map([asset_id], |row| {
            Ok(TranscriptSegment {
                id: row.get(0)?,
                start_sec: row.get(1)?,
                end_sec: row.get(2)?,
                text: row.get(3)?,
                language: row.get(4)?,
                confidence: row.get(5)?,
            })
        })
        .map_err(|e| CoreError::Internal(format!("Failed to query transcripts: {}", e)))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| CoreError::Internal(format!("Failed to read transcripts: {}", e)))?;

    Ok(Transcript::with_segments(asset_id, segments))
}

/// Searches transcripts for text
pub fn search_transcripts(
    db: &IndexDb,
    query: &str,
    limit: usize,
) -> CoreResult<Vec<TranscriptSearchResult>> {
    let conn = db.connection();

    // Simple LIKE search (can be upgraded to FTS5 later)
    let pattern = format!("%{}%", query.to_lowercase());

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, asset_id, start_sec, end_sec, text, confidence
            FROM transcripts
            WHERE LOWER(text) LIKE ?
            ORDER BY start_sec
            LIMIT ?
            "#,
        )
        .map_err(|e| CoreError::Internal(format!("Failed to prepare search query: {}", e)))?;

    let results = stmt
        .query_map(rusqlite::params![pattern, limit as i64], |row| {
            Ok(TranscriptSearchResult {
                segment_id: row.get(0)?,
                asset_id: row.get(1)?,
                start_sec: row.get(2)?,
                end_sec: row.get(3)?,
                text: row.get(4)?,
                confidence: row.get(5)?,
            })
        })
        .map_err(|e| CoreError::Internal(format!("Failed to search transcripts: {}", e)))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| CoreError::Internal(format!("Failed to read search results: {}", e)))?;

    Ok(results)
}

// =============================================================================
// Search Result
// =============================================================================

/// Result from transcript search
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchResult {
    /// Segment ID
    pub segment_id: String,
    /// Asset ID
    pub asset_id: AssetId,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Matched text
    pub text: String,
    /// Confidence score
    pub confidence: Option<f64>,
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // TranscriptSegment Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_segment_creation() {
        let segment = TranscriptSegment::new(0.0, 5.0, "Hello world");

        assert!(!segment.id.is_empty());
        assert_eq!(segment.start_sec, 0.0);
        assert_eq!(segment.end_sec, 5.0);
        assert_eq!(segment.text, "Hello world");
        assert!(segment.confidence.is_none());
    }

    #[test]
    fn test_segment_with_confidence() {
        let segment = TranscriptSegment::with_confidence(0.0, 5.0, "Hello world", 0.95);

        assert_eq!(segment.confidence, Some(0.95));
    }

    #[test]
    fn test_segment_duration() {
        let segment = TranscriptSegment::new(2.5, 7.5, "test");
        assert_eq!(segment.duration(), 5.0);
    }

    #[test]
    fn test_segment_midpoint() {
        let segment = TranscriptSegment::new(0.0, 10.0, "test");
        assert_eq!(segment.midpoint(), 5.0);
    }

    #[test]
    fn test_segment_overlaps() {
        let segment = TranscriptSegment::new(5.0, 10.0, "test");

        // Overlapping ranges
        assert!(segment.overlaps(4.0, 6.0)); // Overlaps start
        assert!(segment.overlaps(9.0, 11.0)); // Overlaps end
        assert!(segment.overlaps(6.0, 8.0)); // Inside
        assert!(segment.overlaps(4.0, 11.0)); // Contains

        // Non-overlapping ranges
        assert!(!segment.overlaps(0.0, 5.0)); // Before (touching)
        assert!(!segment.overlaps(10.0, 15.0)); // After (touching)
        assert!(!segment.overlaps(0.0, 4.0)); // Before
        assert!(!segment.overlaps(11.0, 15.0)); // After
    }

    #[test]
    fn test_segment_words_per_second() {
        let segment = TranscriptSegment::new(0.0, 10.0, "one two three four five");
        // 5 words in 10 seconds = 0.5 wps
        assert_eq!(segment.words_per_second(), 0.5);
    }

    #[test]
    fn test_segment_words_per_second_zero_duration() {
        let segment = TranscriptSegment::new(5.0, 5.0, "test");
        assert_eq!(segment.words_per_second(), 0.0);
    }

    // -------------------------------------------------------------------------
    // Transcript Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_transcript_creation() {
        let transcript = Transcript::new("asset_001");

        assert_eq!(transcript.asset_id, "asset_001");
        assert!(transcript.language.is_none());
        assert!(transcript.segments.is_empty());
    }

    #[test]
    fn test_transcript_with_segments() {
        let segments = vec![
            TranscriptSegment::new(0.0, 2.0, "Hello"),
            TranscriptSegment::new(2.0, 4.0, "world"),
        ];

        let transcript = Transcript::with_segments("asset_001", segments);

        assert_eq!(transcript.segments.len(), 2);
    }

    #[test]
    fn test_transcript_full_text() {
        let segments = vec![
            TranscriptSegment::new(0.0, 2.0, "Hello"),
            TranscriptSegment::new(2.0, 4.0, "world"),
            TranscriptSegment::new(4.0, 6.0, "test"),
        ];

        let transcript = Transcript::with_segments("asset_001", segments);

        assert_eq!(transcript.full_text(), "Hello world test");
    }

    #[test]
    fn test_transcript_segments_in_range() {
        let segments = vec![
            TranscriptSegment::new(0.0, 2.0, "First"),
            TranscriptSegment::new(2.0, 4.0, "Second"),
            TranscriptSegment::new(4.0, 6.0, "Third"),
            TranscriptSegment::new(6.0, 8.0, "Fourth"),
        ];

        let transcript = Transcript::with_segments("asset_001", segments);

        // Get segments from 1.5 to 5.0 - should include First, Second, Third
        let in_range = transcript.segments_in_range(1.5, 5.0);

        assert_eq!(in_range.len(), 3);
        assert_eq!(in_range[0].text, "First");
        assert_eq!(in_range[1].text, "Second");
        assert_eq!(in_range[2].text, "Third");
    }

    #[test]
    fn test_transcript_text_in_range() {
        let segments = vec![
            TranscriptSegment::new(0.0, 2.0, "Hello"),
            TranscriptSegment::new(2.0, 4.0, "beautiful"),
            TranscriptSegment::new(4.0, 6.0, "world"),
        ];

        let transcript = Transcript::with_segments("asset_001", segments);

        assert_eq!(transcript.text_in_range(1.0, 5.0), "Hello beautiful world");
    }

    #[test]
    fn test_transcript_total_duration() {
        let segments = vec![
            TranscriptSegment::new(1.0, 3.0, "First"),
            TranscriptSegment::new(5.0, 8.0, "Second"),
        ];

        let transcript = Transcript::with_segments("asset_001", segments);

        // From 1.0 to 8.0 = 7.0 seconds
        assert_eq!(transcript.total_duration(), 7.0);
    }

    #[test]
    fn test_transcript_total_duration_empty() {
        let transcript = Transcript::new("asset_001");
        assert_eq!(transcript.total_duration(), 0.0);
    }

    // -------------------------------------------------------------------------
    // Database Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_save_and_load_transcript() {
        let db = IndexDb::in_memory().unwrap();

        let segments = vec![
            TranscriptSegment::new(0.0, 2.0, "Hello"),
            TranscriptSegment::new(2.0, 4.0, "world"),
        ];

        // Save
        save_transcript(&db, "asset_001", &segments).unwrap();

        // Load
        let loaded = load_transcript(&db, "asset_001").unwrap();

        assert_eq!(loaded.segments.len(), 2);
        assert_eq!(loaded.segments[0].text, "Hello");
        assert_eq!(loaded.segments[1].text, "world");
    }

    #[test]
    fn test_load_transcript_ordered() {
        let db = IndexDb::in_memory().unwrap();

        // Insert in random order
        let segments = vec![
            TranscriptSegment::new(4.0, 6.0, "Third"),
            TranscriptSegment::new(0.0, 2.0, "First"),
            TranscriptSegment::new(2.0, 4.0, "Second"),
        ];

        save_transcript(&db, "asset_001", &segments).unwrap();

        // Should be ordered by start_sec
        let loaded = load_transcript(&db, "asset_001").unwrap();

        assert_eq!(loaded.segments[0].text, "First");
        assert_eq!(loaded.segments[1].text, "Second");
        assert_eq!(loaded.segments[2].text, "Third");
    }

    #[test]
    fn test_search_transcripts() {
        let db = IndexDb::in_memory().unwrap();

        let segments = vec![
            TranscriptSegment::new(0.0, 2.0, "Hello world"),
            TranscriptSegment::new(2.0, 4.0, "Goodbye world"),
            TranscriptSegment::new(4.0, 6.0, "Hello again"),
        ];

        save_transcript(&db, "asset_001", &segments).unwrap();

        // Search for "hello"
        let results = search_transcripts(&db, "hello", 10).unwrap();

        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.text == "Hello world"));
        assert!(results.iter().any(|r| r.text == "Hello again"));
    }

    #[test]
    fn test_search_transcripts_case_insensitive() {
        let db = IndexDb::in_memory().unwrap();

        let segments = vec![TranscriptSegment::new(0.0, 2.0, "HELLO World")];

        save_transcript(&db, "asset_001", &segments).unwrap();

        // Search with lowercase
        let results = search_transcripts(&db, "hello", 10).unwrap();

        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_search_transcripts_limit() {
        let db = IndexDb::in_memory().unwrap();

        let segments: Vec<_> = (0..10)
            .map(|i| TranscriptSegment::new(i as f64, (i + 1) as f64, "test content"))
            .collect();

        save_transcript(&db, "asset_001", &segments).unwrap();

        // Limit to 3 results
        let results = search_transcripts(&db, "test", 3).unwrap();

        assert_eq!(results.len(), 3);
    }

    #[test]
    fn test_search_transcripts_no_match() {
        let db = IndexDb::in_memory().unwrap();

        let segments = vec![TranscriptSegment::new(0.0, 2.0, "Hello world")];

        save_transcript(&db, "asset_001", &segments).unwrap();

        let results = search_transcripts(&db, "nonexistent", 10).unwrap();

        assert!(results.is_empty());
    }
}

//! Search System Module
//!
//! Provides media search capabilities across indexed content.

use serde::{Deserialize, Serialize};

use crate::core::indexing::{IndexDb, ShotDetector};
use crate::core::{AssetId, CoreResult};

// =============================================================================
// Search Query
// =============================================================================

/// Search query parameters
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    /// Text to search for
    pub text: Option<String>,
    /// Duration hint (min, max) in seconds
    pub duration_hint: Option<(f64, f64)>,
    /// Search modality
    pub modality: SearchModality,
    /// Additional filters
    pub filters: SearchFilters,
    /// Maximum number of results
    pub limit: usize,
}

impl SearchQuery {
    /// Creates a new text search query
    pub fn text(query: &str) -> Self {
        Self {
            text: Some(query.to_string()),
            modality: SearchModality::Text,
            limit: 20,
            ..Default::default()
        }
    }

    /// Creates a new hybrid search query
    pub fn hybrid(query: &str) -> Self {
        Self {
            text: Some(query.to_string()),
            modality: SearchModality::Hybrid,
            limit: 20,
            ..Default::default()
        }
    }

    /// Sets the result limit
    pub fn with_limit(mut self, limit: usize) -> Self {
        self.limit = limit;
        self
    }

    /// Sets duration filter
    pub fn with_duration(mut self, min: f64, max: f64) -> Self {
        self.duration_hint = Some((min, max));
        self
    }

    /// Sets asset filter
    pub fn with_assets(mut self, asset_ids: Vec<String>) -> Self {
        self.filters.asset_ids = Some(asset_ids);
        self
    }
}

// =============================================================================
// Search Modality
// =============================================================================

/// Type of search to perform
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchModality {
    /// Search transcripts/text only
    #[default]
    Text,
    /// Search visual content (shots)
    Visual,
    /// Search audio content
    Audio,
    /// Combined search across all modalities
    Hybrid,
}

// =============================================================================
// Search Filters
// =============================================================================

/// Additional search filters
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    /// Filter by aspect ratio
    pub aspect: Option<String>,
    /// Minimum quality score
    pub min_quality: Option<f64>,
    /// Filter for shots with faces
    pub has_face: Option<bool>,
    /// Filter by specific asset IDs
    pub asset_ids: Option<Vec<AssetId>>,
}

// =============================================================================
// Search Result
// =============================================================================

/// A single search result
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Asset ID
    pub asset_id: AssetId,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Relevance score (0.0 - 1.0)
    pub score: f64,
    /// Reasons for the match
    pub reasons: Vec<String>,
    /// Thumbnail URI (if available)
    pub thumbnail_uri: Option<String>,
    /// Source of the match (transcript, shot, etc.)
    pub source: SearchResultSource,
}

impl SearchResult {
    /// Creates a new search result
    pub fn new(asset_id: &str, start_sec: f64, end_sec: f64, score: f64) -> Self {
        Self {
            asset_id: asset_id.to_string(),
            start_sec,
            end_sec,
            score,
            reasons: Vec::new(),
            thumbnail_uri: None,
            source: SearchResultSource::Unknown,
        }
    }

    /// Adds a reason for the match
    pub fn with_reason(mut self, reason: &str) -> Self {
        self.reasons.push(reason.to_string());
        self
    }

    /// Sets the source of the match
    pub fn with_source(mut self, source: SearchResultSource) -> Self {
        self.source = source;
        self
    }

    /// Returns the duration of this result
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }
}

// =============================================================================
// Search Result Source
// =============================================================================

/// Source of a search result match
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchResultSource {
    /// Matched from transcript
    Transcript,
    /// Matched from shot/visual analysis
    Shot,
    /// Matched from audio analysis
    Audio,
    /// Multiple sources
    Multiple,
    /// Unknown source
    #[default]
    Unknown,
}

// =============================================================================
// Search Engine
// =============================================================================

/// Main search engine
pub struct SearchEngine<'a> {
    db: &'a IndexDb,
}

impl<'a> SearchEngine<'a> {
    /// Creates a new search engine
    pub fn new(db: &'a IndexDb) -> Self {
        Self { db }
    }

    /// Performs a search with the given query
    pub fn search(&self, query: &SearchQuery) -> CoreResult<Vec<SearchResult>> {
        match query.modality {
            SearchModality::Text => self.search_text(query),
            SearchModality::Visual => self.search_visual(query),
            SearchModality::Audio => self.search_audio(query),
            SearchModality::Hybrid => self.search_hybrid(query),
        }
    }

    /// Searches transcripts for text
    fn search_text(&self, query: &SearchQuery) -> CoreResult<Vec<SearchResult>> {
        let text = match &query.text {
            Some(t) => t,
            None => return Ok(Vec::new()),
        };

        let transcript_results =
            crate::core::indexing::transcripts::search_transcripts(self.db, text, query.limit)?;

        let results = transcript_results
            .into_iter()
            .map(|tr| {
                SearchResult::new(
                    &tr.asset_id,
                    tr.start_sec,
                    tr.end_sec,
                    tr.confidence.unwrap_or(0.5),
                )
                .with_reason(&format!(
                    "Transcript match: \"{}\"",
                    truncate_text(&tr.text, 50)
                ))
                .with_source(SearchResultSource::Transcript)
            })
            .collect();

        Ok(self.apply_filters(results, query))
    }

    /// Searches visual content (shots)
    fn search_visual(&self, query: &SearchQuery) -> CoreResult<Vec<SearchResult>> {
        // For now, return shots that match any asset filter
        // In the future, this would use visual embeddings

        let mut results = Vec::new();

        if let Some(asset_ids) = &query.filters.asset_ids {
            for asset_id in asset_ids {
                let shots = ShotDetector::load_from_db(self.db, asset_id)?;

                for shot in shots {
                    let mut result = SearchResult::new(
                        &shot.asset_id,
                        shot.start_sec,
                        shot.end_sec,
                        shot.quality_score.unwrap_or(0.5),
                    )
                    .with_source(SearchResultSource::Shot);

                    if !shot.tags.is_empty() {
                        result = result.with_reason(&format!("Tags: {}", shot.tags.join(", ")));
                    }

                    results.push(result);
                }
            }
        }

        results.truncate(query.limit);
        Ok(self.apply_filters(results, query))
    }

    /// Searches audio content
    fn search_audio(&self, query: &SearchQuery) -> CoreResult<Vec<SearchResult>> {
        // Audio search would analyze audio features
        // For now, falls back to transcript search
        self.search_text(query)
    }

    /// Performs hybrid search across all modalities
    fn search_hybrid(&self, query: &SearchQuery) -> CoreResult<Vec<SearchResult>> {
        let mut all_results = Vec::new();

        // Get text results
        let text_results = self.search_text(query)?;
        all_results.extend(text_results);

        // Get visual results (if asset filter provided)
        if query.filters.asset_ids.is_some() {
            let visual_results = self.search_visual(query)?;
            all_results.extend(visual_results);
        }

        // Deduplicate and merge results with overlapping time ranges
        let merged = self.merge_overlapping_results(all_results);

        // Sort by score
        let mut sorted = merged;
        sorted.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Apply limit
        sorted.truncate(query.limit);

        Ok(sorted)
    }

    /// Applies filters to search results
    fn apply_filters(&self, results: Vec<SearchResult>, query: &SearchQuery) -> Vec<SearchResult> {
        results
            .into_iter()
            .filter(|r| {
                // Duration filter
                if let Some((min, max)) = query.duration_hint {
                    let duration = r.duration();
                    if duration < min || duration > max {
                        return false;
                    }
                }

                // Asset ID filter
                if let Some(ref asset_ids) = query.filters.asset_ids {
                    if !asset_ids.contains(&r.asset_id) {
                        return false;
                    }
                }

                // Quality filter
                if let Some(min_quality) = query.filters.min_quality {
                    if r.score < min_quality {
                        return false;
                    }
                }

                true
            })
            .collect()
    }

    /// Merges results with overlapping time ranges
    fn merge_overlapping_results(&self, results: Vec<SearchResult>) -> Vec<SearchResult> {
        if results.is_empty() {
            return results;
        }

        // Group by asset_id
        let mut by_asset: std::collections::HashMap<String, Vec<SearchResult>> =
            std::collections::HashMap::new();

        for result in results {
            by_asset
                .entry(result.asset_id.clone())
                .or_default()
                .push(result);
        }

        let mut merged = Vec::new();

        for (_asset_id, mut asset_results) in by_asset {
            // Sort by start time
            asset_results.sort_by(|a, b| {
                a.start_sec
                    .partial_cmp(&b.start_sec)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            // Merge overlapping
            let mut current: Option<SearchResult> = None;

            for result in asset_results {
                match current.take() {
                    None => {
                        current = Some(result);
                    }
                    Some(mut cur) => {
                        // Check for overlap (with 0.5s tolerance)
                        if result.start_sec <= cur.end_sec + 0.5 {
                            // Merge
                            cur.end_sec = cur.end_sec.max(result.end_sec);
                            cur.score = (cur.score + result.score) / 2.0;
                            cur.reasons.extend(result.reasons);

                            if cur.source != result.source {
                                cur.source = SearchResultSource::Multiple;
                            }

                            current = Some(cur);
                        } else {
                            // No overlap, push current and start new
                            merged.push(cur);
                            current = Some(result);
                        }
                    }
                }
            }

            if let Some(cur) = current {
                merged.push(cur);
            }
        }

        merged
    }
}

// =============================================================================
// Utility Functions
// =============================================================================

/// Truncates text to a maximum length
fn truncate_text(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        text.to_string()
    } else {
        format!("{}...", &text[..max_len.saturating_sub(3)])
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::indexing::transcripts::{save_transcript, TranscriptSegment};

    // -------------------------------------------------------------------------
    // SearchQuery Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_search_query_text() {
        let query = SearchQuery::text("hello world");

        assert_eq!(query.text, Some("hello world".to_string()));
        assert_eq!(query.modality, SearchModality::Text);
        assert_eq!(query.limit, 20);
    }

    #[test]
    fn test_search_query_hybrid() {
        let query = SearchQuery::hybrid("test")
            .with_limit(10)
            .with_duration(1.0, 10.0);

        assert_eq!(query.modality, SearchModality::Hybrid);
        assert_eq!(query.limit, 10);
        assert_eq!(query.duration_hint, Some((1.0, 10.0)));
    }

    #[test]
    fn test_search_query_with_assets() {
        let query = SearchQuery::text("test")
            .with_assets(vec!["asset_1".to_string(), "asset_2".to_string()]);

        assert_eq!(
            query.filters.asset_ids,
            Some(vec!["asset_1".to_string(), "asset_2".to_string()])
        );
    }

    // -------------------------------------------------------------------------
    // SearchResult Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_search_result_creation() {
        let result = SearchResult::new("asset_001", 0.0, 5.0, 0.8);

        assert_eq!(result.asset_id, "asset_001");
        assert_eq!(result.start_sec, 0.0);
        assert_eq!(result.end_sec, 5.0);
        assert_eq!(result.score, 0.8);
        assert!(result.reasons.is_empty());
    }

    #[test]
    fn test_search_result_with_reason() {
        let result = SearchResult::new("asset_001", 0.0, 5.0, 0.8)
            .with_reason("Transcript match")
            .with_source(SearchResultSource::Transcript);

        assert_eq!(result.reasons.len(), 1);
        assert_eq!(result.reasons[0], "Transcript match");
        assert_eq!(result.source, SearchResultSource::Transcript);
    }

    #[test]
    fn test_search_result_duration() {
        let result = SearchResult::new("asset_001", 2.5, 7.5, 0.8);
        assert_eq!(result.duration(), 5.0);
    }

    // -------------------------------------------------------------------------
    // SearchEngine Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_search_engine_text_search() {
        let db = IndexDb::in_memory().unwrap();

        // Add some transcripts
        let segments = vec![
            TranscriptSegment::with_confidence(0.0, 2.0, "Hello world", 0.9),
            TranscriptSegment::with_confidence(2.0, 4.0, "Goodbye world", 0.85),
            TranscriptSegment::with_confidence(4.0, 6.0, "Hello again", 0.95),
        ];
        save_transcript(&db, "asset_001", &segments).unwrap();

        // Search
        let engine = SearchEngine::new(&db);
        let query = SearchQuery::text("hello");
        let results = engine.search(&query).unwrap();

        assert_eq!(results.len(), 2);
        assert!(results
            .iter()
            .all(|r| r.source == SearchResultSource::Transcript));
    }

    #[test]
    fn test_search_engine_empty_query() {
        let db = IndexDb::in_memory().unwrap();
        let engine = SearchEngine::new(&db);

        let query = SearchQuery {
            text: None,
            modality: SearchModality::Text,
            limit: 10,
            ..Default::default()
        };

        let results = engine.search(&query).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_search_engine_duration_filter() {
        let db = IndexDb::in_memory().unwrap();

        // Add transcripts with different durations
        let segments = vec![
            TranscriptSegment::with_confidence(0.0, 1.0, "Short segment", 0.9),
            TranscriptSegment::with_confidence(2.0, 7.0, "Long segment with test word", 0.9),
            TranscriptSegment::with_confidence(10.0, 12.0, "Medium test segment", 0.9),
        ];
        save_transcript(&db, "asset_001", &segments).unwrap();

        let engine = SearchEngine::new(&db);
        let query = SearchQuery::text("segment").with_duration(1.5, 6.0);

        let results = engine.search(&query).unwrap();

        // Should only return segments with duration between 1.5 and 6.0 seconds
        assert!(results.iter().all(|r| {
            let dur = r.duration();
            dur >= 1.5 && dur <= 6.0
        }));
    }

    #[test]
    fn test_search_engine_asset_filter() {
        let db = IndexDb::in_memory().unwrap();

        // Add transcripts for multiple assets
        let segments1 = vec![TranscriptSegment::with_confidence(
            0.0,
            2.0,
            "Test content",
            0.9,
        )];
        let segments2 = vec![TranscriptSegment::with_confidence(
            0.0,
            2.0,
            "Test content",
            0.9,
        )];

        save_transcript(&db, "asset_001", &segments1).unwrap();
        save_transcript(&db, "asset_002", &segments2).unwrap();

        let engine = SearchEngine::new(&db);
        let query = SearchQuery::text("test").with_assets(vec!["asset_001".to_string()]);

        let results = engine.search(&query).unwrap();

        assert!(results.iter().all(|r| r.asset_id == "asset_001"));
    }

    #[test]
    fn test_search_engine_limit() {
        let db = IndexDb::in_memory().unwrap();

        // Add many segments
        let segments: Vec<_> = (0..20)
            .map(|i| TranscriptSegment::with_confidence(i as f64, (i + 1) as f64, "test word", 0.9))
            .collect();

        save_transcript(&db, "asset_001", &segments).unwrap();

        let engine = SearchEngine::new(&db);
        let query = SearchQuery::text("test").with_limit(5);

        let results = engine.search(&query).unwrap();

        assert!(results.len() <= 5);
    }

    // -------------------------------------------------------------------------
    // Utility Function Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_truncate_text_short() {
        let text = "Hello";
        assert_eq!(truncate_text(text, 10), "Hello");
    }

    #[test]
    fn test_truncate_text_long() {
        let text = "Hello world this is a long text";
        let truncated = truncate_text(text, 15);
        assert!(truncated.ends_with("..."));
        assert!(truncated.len() <= 15);
    }

    #[test]
    fn test_truncate_text_exact() {
        let text = "Hello";
        assert_eq!(truncate_text(text, 5), "Hello");
    }
}

//! Meilisearch Document Indexer
//!
//! Provides indexing capabilities for assets, transcripts, and other searchable
//! content using Meilisearch as the backend.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::sidecar::SidecarConfig;

// =============================================================================
// Error Types
// =============================================================================

/// Errors that can occur during indexing operations
#[derive(Error, Debug)]
pub enum IndexerError {
    /// Failed to connect to Meilisearch
    #[error("Failed to connect to Meilisearch: {0}")]
    ConnectionFailed(String),

    /// Failed to create index
    #[error("Failed to create index: {0}")]
    IndexCreationFailed(String),

    /// Failed to add documents
    #[error("Failed to add documents: {0}")]
    AddDocumentsFailed(String),

    /// Failed to search
    #[error("Search failed: {0}")]
    SearchFailed(String),

    /// Failed to delete documents
    #[error("Failed to delete documents: {0}")]
    DeleteFailed(String),

    /// Meilisearch feature not enabled
    #[error("Meilisearch feature not enabled")]
    FeatureNotEnabled,

    /// Serialization error
    #[error("Serialization error: {0}")]
    SerializationError(String),
}

/// Result type for indexer operations
pub type IndexerResult<T> = Result<T, IndexerError>;

// =============================================================================
// Document Types
// =============================================================================

/// Index names used by the indexer
pub mod indexes {
    /// Index for asset metadata
    pub const ASSETS: &str = "assets";
    /// Index for transcript segments
    pub const TRANSCRIPTS: &str = "transcripts";
    /// Index for project metadata
    pub const PROJECTS: &str = "projects";
}

/// Document representing an indexed asset
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetDocument {
    /// Unique identifier (asset ID)
    pub id: String,
    /// Asset display name
    pub name: String,
    /// File path
    pub path: String,
    /// Asset kind (video, audio, image, etc.)
    pub kind: String,
    /// Duration in seconds (for media assets)
    pub duration: Option<f64>,
    /// Creation timestamp
    pub created_at: String,
    /// Tags/labels
    pub tags: Vec<String>,
    /// Project ID this asset belongs to
    pub project_id: Option<String>,
}

impl AssetDocument {
    /// Creates a new asset document
    pub fn new(id: &str, name: &str, path: &str, kind: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            path: path.to_string(),
            kind: kind.to_string(),
            duration: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            tags: Vec::new(),
            project_id: None,
        }
    }

    /// Sets the duration
    pub fn with_duration(mut self, duration: f64) -> Self {
        self.duration = Some(duration);
        self
    }

    /// Sets the tags
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self
    }

    /// Sets the project ID
    pub fn with_project_id(mut self, project_id: &str) -> Self {
        self.project_id = Some(project_id.to_string());
        self
    }
}

/// Document representing an indexed transcript segment
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDocument {
    /// Unique identifier (segment ID)
    pub id: String,
    /// Asset ID this segment belongs to
    pub asset_id: String,
    /// Transcribed text content
    pub text: String,
    /// Start time in seconds
    pub start_time: f64,
    /// End time in seconds
    pub end_time: f64,
    /// Language code
    pub language: Option<String>,
    /// Confidence score (0.0 - 1.0)
    pub confidence: Option<f64>,
}

impl TranscriptDocument {
    /// Creates a new transcript document
    pub fn new(id: &str, asset_id: &str, text: &str, start_time: f64, end_time: f64) -> Self {
        Self {
            id: id.to_string(),
            asset_id: asset_id.to_string(),
            text: text.to_string(),
            start_time,
            end_time,
            language: None,
            confidence: None,
        }
    }

    /// Sets the language
    pub fn with_language(mut self, language: &str) -> Self {
        self.language = Some(language.to_string());
        self
    }

    /// Sets the confidence score
    pub fn with_confidence(mut self, confidence: f64) -> Self {
        self.confidence = Some(confidence);
        self
    }
}

// =============================================================================
// Search Results
// =============================================================================

/// Search results from Meilisearch
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeilisearchResults<T> {
    /// Matching documents
    pub hits: Vec<T>,
    /// Total number of matches (estimated)
    pub estimated_total_hits: Option<usize>,
    /// Query processing time in milliseconds
    pub processing_time_ms: u64,
    /// Original query string
    pub query: String,
}

impl<T> Default for MeilisearchResults<T> {
    fn default() -> Self {
        Self {
            hits: Vec::new(),
            estimated_total_hits: None,
            processing_time_ms: 0,
            query: String::new(),
        }
    }
}

/// Combined search results across multiple indexes
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CombinedSearchResults {
    /// Asset search results
    pub assets: MeilisearchResults<AssetDocument>,
    /// Transcript search results
    pub transcripts: MeilisearchResults<TranscriptDocument>,
    /// Total processing time in milliseconds
    pub total_processing_time_ms: u64,
}

// =============================================================================
// Search Options
// =============================================================================

/// Options for search queries
#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    /// Maximum number of results per index
    pub limit: usize,
    /// Offset for pagination
    pub offset: usize,
    /// Filter by asset IDs
    pub asset_ids: Option<Vec<String>>,
    /// Filter by project ID
    pub project_id: Option<String>,
    /// Search only specific indexes
    pub indexes: Option<Vec<String>>,
}

impl SearchOptions {
    /// Creates search options with a limit
    pub fn with_limit(limit: usize) -> Self {
        Self {
            limit,
            ..Default::default()
        }
    }

    /// Sets pagination offset
    pub fn offset(mut self, offset: usize) -> Self {
        self.offset = offset;
        self
    }

    /// Filters by asset IDs
    pub fn filter_assets(mut self, asset_ids: Vec<String>) -> Self {
        self.asset_ids = Some(asset_ids);
        self
    }

    /// Filters by project ID
    pub fn filter_project(mut self, project_id: &str) -> Self {
        self.project_id = Some(project_id.to_string());
        self
    }

    /// Search only specific indexes
    pub fn only_indexes(mut self, indexes: Vec<String>) -> Self {
        self.indexes = Some(indexes);
        self
    }
}

// =============================================================================
// Search Indexer - Feature-gated Implementation
// =============================================================================

#[cfg(feature = "meilisearch")]
mod indexer_impl {
    use super::*;
    use meilisearch_sdk::{
        client::Client, documents::DocumentDeletionQuery, search::SearchResults as MsResults,
    };

    /// Meilisearch search indexer
    pub struct SearchIndexer {
        client: Client,
    }

    impl SearchIndexer {
        /// Creates a new indexer connected to the given Meilisearch instance
        pub async fn new(config: &SidecarConfig) -> IndexerResult<Self> {
            let client = Client::new(config.client_url(), Some(&config.master_key))
                .map_err(|e| IndexerError::ConnectionFailed(e.to_string()))?;

            let indexer = Self { client };

            // Initialize indexes
            indexer.init_indexes().await?;

            Ok(indexer)
        }

        /// Initializes the required indexes with proper settings
        async fn init_indexes(&self) -> IndexerResult<()> {
            // Create assets index
            let assets_task = self
                .client
                .create_index(indexes::ASSETS, Some("id"))
                .await
                .map_err(|e| IndexerError::IndexCreationFailed(e.to_string()))?;

            assets_task
                .wait_for_completion(&self.client, None, None)
                .await
                .map_err(|e| IndexerError::IndexCreationFailed(e.to_string()))?;

            // Configure assets index
            let assets_index = self.client.index(indexes::ASSETS);
            assets_index
                .set_searchable_attributes(["name", "path", "tags"])
                .await
                .map_err(|e| IndexerError::IndexCreationFailed(e.to_string()))?;

            assets_index
                .set_filterable_attributes(["kind", "projectId", "tags"])
                .await
                .map_err(|e| IndexerError::IndexCreationFailed(e.to_string()))?;

            // Create transcripts index
            let transcripts_task = self
                .client
                .create_index(indexes::TRANSCRIPTS, Some("id"))
                .await
                .map_err(|e| IndexerError::IndexCreationFailed(e.to_string()))?;

            transcripts_task
                .wait_for_completion(&self.client, None, None)
                .await
                .map_err(|e| IndexerError::IndexCreationFailed(e.to_string()))?;

            // Configure transcripts index
            let transcripts_index = self.client.index(indexes::TRANSCRIPTS);
            transcripts_index
                .set_searchable_attributes(["text"])
                .await
                .map_err(|e| IndexerError::IndexCreationFailed(e.to_string()))?;

            transcripts_index
                .set_filterable_attributes(["assetId", "language"])
                .await
                .map_err(|e| IndexerError::IndexCreationFailed(e.to_string()))?;

            transcripts_index
                .set_sortable_attributes(["startTime", "endTime"])
                .await
                .map_err(|e| IndexerError::IndexCreationFailed(e.to_string()))?;

            Ok(())
        }

        /// Indexes an asset document
        pub async fn index_asset(&self, doc: &AssetDocument) -> IndexerResult<()> {
            let index = self.client.index(indexes::ASSETS);

            let task = index
                .add_documents(&[doc], Some("id"))
                .await
                .map_err(|e| IndexerError::AddDocumentsFailed(e.to_string()))?;

            task.wait_for_completion(&self.client, None, None)
                .await
                .map_err(|e| IndexerError::AddDocumentsFailed(e.to_string()))?;

            tracing::debug!("Indexed asset: {}", doc.id);
            Ok(())
        }

        /// Indexes multiple asset documents in batch
        pub async fn index_assets(&self, docs: &[AssetDocument]) -> IndexerResult<()> {
            if docs.is_empty() {
                return Ok(());
            }

            let index = self.client.index(indexes::ASSETS);

            let task = index
                .add_documents(docs, Some("id"))
                .await
                .map_err(|e| IndexerError::AddDocumentsFailed(e.to_string()))?;

            task.wait_for_completion(&self.client, None, None)
                .await
                .map_err(|e| IndexerError::AddDocumentsFailed(e.to_string()))?;

            tracing::debug!("Indexed {} assets", docs.len());
            Ok(())
        }

        /// Indexes transcript segments for an asset
        pub async fn index_transcripts(
            &self,
            asset_id: &str,
            segments: &[TranscriptDocument],
        ) -> IndexerResult<()> {
            if segments.is_empty() {
                return Ok(());
            }

            // Verify all segments belong to the same asset
            for seg in segments {
                if seg.asset_id != asset_id {
                    return Err(IndexerError::AddDocumentsFailed(format!(
                        "Segment {} has mismatched asset_id: expected {}, got {}",
                        seg.id, asset_id, seg.asset_id
                    )));
                }
            }

            let index = self.client.index(indexes::TRANSCRIPTS);

            let task = index
                .add_documents(segments, Some("id"))
                .await
                .map_err(|e| IndexerError::AddDocumentsFailed(e.to_string()))?;

            task.wait_for_completion(&self.client, None, None)
                .await
                .map_err(|e| IndexerError::AddDocumentsFailed(e.to_string()))?;

            tracing::debug!(
                "Indexed {} transcript segments for asset {}",
                segments.len(),
                asset_id
            );
            Ok(())
        }

        /// Searches for assets
        pub async fn search_assets(
            &self,
            query: &str,
            options: &SearchOptions,
        ) -> IndexerResult<MeilisearchResults<AssetDocument>> {
            let index = self.client.index(indexes::ASSETS);

            let mut search = index.search();
            search.with_query(query);
            search.with_limit(options.limit);
            search.with_offset(options.offset);

            // Build filter
            let mut filter: Option<String> = None;
            if let Some(ref project_id) = options.project_id {
                filter = Some(format!("projectId = \"{}\"", project_id));
            }
            if let Some(ref filter) = filter {
                search.with_filter(filter);
            }

            let results: MsResults<AssetDocument> = search
                .execute()
                .await
                .map_err(|e| IndexerError::SearchFailed(e.to_string()))?;

            Ok(MeilisearchResults {
                hits: results.hits.into_iter().map(|h| h.result).collect(),
                estimated_total_hits: results.estimated_total_hits,
                processing_time_ms: results.processing_time_ms as u64,
                query: query.to_string(),
            })
        }

        /// Searches for transcript segments
        pub async fn search_transcripts(
            &self,
            query: &str,
            options: &SearchOptions,
        ) -> IndexerResult<MeilisearchResults<TranscriptDocument>> {
            let index = self.client.index(indexes::TRANSCRIPTS);

            let mut search = index.search();
            search.with_query(query);
            search.with_limit(options.limit);
            search.with_offset(options.offset);

            // Build filter
            let mut filters = Vec::new();
            if let Some(ref asset_ids) = options.asset_ids {
                if !asset_ids.is_empty() {
                    let ids: Vec<String> =
                        asset_ids.iter().map(|id| format!("\"{}\"", id)).collect();
                    filters.push(format!("assetId IN [{}]", ids.join(", ")));
                }
            }

            let filter = if filters.is_empty() {
                None
            } else {
                Some(filters.join(" AND "))
            };
            if let Some(ref filter) = filter {
                search.with_filter(filter);
            }

            let results: MsResults<TranscriptDocument> = search
                .execute()
                .await
                .map_err(|e| IndexerError::SearchFailed(e.to_string()))?;

            Ok(MeilisearchResults {
                hits: results.hits.into_iter().map(|h| h.result).collect(),
                estimated_total_hits: results.estimated_total_hits,
                processing_time_ms: results.processing_time_ms as u64,
                query: query.to_string(),
            })
        }

        /// Performs a combined search across assets and transcripts
        pub async fn search(
            &self,
            query: &str,
            options: &SearchOptions,
        ) -> IndexerResult<CombinedSearchResults> {
            let start = std::time::Instant::now();

            // Check which indexes to search
            let search_assets = options
                .indexes
                .as_ref()
                .map(|i| i.contains(&indexes::ASSETS.to_string()))
                .unwrap_or(true);

            let search_transcripts = options
                .indexes
                .as_ref()
                .map(|i| i.contains(&indexes::TRANSCRIPTS.to_string()))
                .unwrap_or(true);

            // Search in parallel
            let assets_future = async {
                if search_assets {
                    self.search_assets(query, options).await
                } else {
                    Ok(MeilisearchResults::default())
                }
            };

            let transcripts_future = async {
                if search_transcripts {
                    self.search_transcripts(query, options).await
                } else {
                    Ok(MeilisearchResults::default())
                }
            };

            let (assets, transcripts) =
                futures::future::try_join(assets_future, transcripts_future).await?;

            Ok(CombinedSearchResults {
                assets,
                transcripts,
                total_processing_time_ms: start.elapsed().as_millis() as u64,
            })
        }

        /// Deletes an asset and its associated transcripts from the indexes
        pub async fn delete_asset(&self, asset_id: &str) -> IndexerResult<()> {
            // Delete from assets index
            let assets_index = self.client.index(indexes::ASSETS);
            let task = assets_index
                .delete_document(asset_id)
                .await
                .map_err(|e| IndexerError::DeleteFailed(e.to_string()))?;

            task.wait_for_completion(&self.client, None, None)
                .await
                .map_err(|e| IndexerError::DeleteFailed(e.to_string()))?;

            // Delete associated transcripts
            let transcripts_index = self.client.index(indexes::TRANSCRIPTS);
            let filter = format!("assetId = \"{}\"", asset_id);
            let mut query = DocumentDeletionQuery::new(&transcripts_index);
            query.with_filter(&filter);
            let task = transcripts_index
                .delete_documents_with(&query)
                .await
                .map_err(|e| IndexerError::DeleteFailed(e.to_string()))?;

            task.wait_for_completion(&self.client, None, None)
                .await
                .map_err(|e| IndexerError::DeleteFailed(e.to_string()))?;

            tracing::debug!("Deleted asset {} and its transcripts from index", asset_id);
            Ok(())
        }

        /// Deletes all documents from all indexes
        pub async fn clear_all(&self) -> IndexerResult<()> {
            let indexes = [indexes::ASSETS, indexes::TRANSCRIPTS];

            for index_name in indexes {
                let index = self.client.index(index_name);
                let task = index
                    .delete_all_documents()
                    .await
                    .map_err(|e| IndexerError::DeleteFailed(e.to_string()))?;

                task.wait_for_completion(&self.client, None, None)
                    .await
                    .map_err(|e| IndexerError::DeleteFailed(e.to_string()))?;
            }

            tracing::info!("Cleared all search indexes");
            Ok(())
        }
    }
}

#[cfg(feature = "meilisearch")]
pub use indexer_impl::SearchIndexer;

// =============================================================================
// Stub Implementation (when meilisearch feature is disabled)
// =============================================================================

#[cfg(not(feature = "meilisearch"))]
#[derive(Debug)]
pub struct SearchIndexer;

#[cfg(not(feature = "meilisearch"))]
impl SearchIndexer {
    /// Creates a new indexer (stub - returns error)
    pub async fn new(_config: &SidecarConfig) -> IndexerResult<Self> {
        Err(IndexerError::FeatureNotEnabled)
    }

    /// Indexes an asset document (stub)
    pub async fn index_asset(&self, _doc: &AssetDocument) -> IndexerResult<()> {
        Err(IndexerError::FeatureNotEnabled)
    }

    /// Indexes multiple asset documents (stub)
    pub async fn index_assets(&self, _docs: &[AssetDocument]) -> IndexerResult<()> {
        Err(IndexerError::FeatureNotEnabled)
    }

    /// Indexes transcript segments (stub)
    pub async fn index_transcripts(
        &self,
        _asset_id: &str,
        _segments: &[TranscriptDocument],
    ) -> IndexerResult<()> {
        Err(IndexerError::FeatureNotEnabled)
    }

    /// Searches for assets (stub)
    pub async fn search_assets(
        &self,
        _query: &str,
        _options: &SearchOptions,
    ) -> IndexerResult<MeilisearchResults<AssetDocument>> {
        Err(IndexerError::FeatureNotEnabled)
    }

    /// Searches for transcript segments (stub)
    pub async fn search_transcripts(
        &self,
        _query: &str,
        _options: &SearchOptions,
    ) -> IndexerResult<MeilisearchResults<TranscriptDocument>> {
        Err(IndexerError::FeatureNotEnabled)
    }

    /// Performs a combined search (stub)
    pub async fn search(
        &self,
        _query: &str,
        _options: &SearchOptions,
    ) -> IndexerResult<CombinedSearchResults> {
        Err(IndexerError::FeatureNotEnabled)
    }

    /// Deletes an asset from the indexes (stub)
    pub async fn delete_asset(&self, _asset_id: &str) -> IndexerResult<()> {
        Err(IndexerError::FeatureNotEnabled)
    }

    /// Clears all indexes (stub)
    pub async fn clear_all(&self) -> IndexerResult<()> {
        Err(IndexerError::FeatureNotEnabled)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // AssetDocument Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_asset_document_creation() {
        let doc = AssetDocument::new("asset_001", "Video.mp4", "/path/to/video.mp4", "video");

        assert_eq!(doc.id, "asset_001");
        assert_eq!(doc.name, "Video.mp4");
        assert_eq!(doc.path, "/path/to/video.mp4");
        assert_eq!(doc.kind, "video");
        assert!(doc.duration.is_none());
        assert!(doc.tags.is_empty());
    }

    #[test]
    fn test_asset_document_builder() {
        let doc = AssetDocument::new("asset_001", "Video.mp4", "/path/to/video.mp4", "video")
            .with_duration(120.5)
            .with_tags(vec!["interview".to_string(), "outdoor".to_string()])
            .with_project_id("project_001");

        assert_eq!(doc.duration, Some(120.5));
        assert_eq!(doc.tags.len(), 2);
        assert_eq!(doc.project_id, Some("project_001".to_string()));
    }

    // -------------------------------------------------------------------------
    // TranscriptDocument Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_transcript_document_creation() {
        let doc = TranscriptDocument::new("seg_001", "asset_001", "Hello world", 0.0, 2.5);

        assert_eq!(doc.id, "seg_001");
        assert_eq!(doc.asset_id, "asset_001");
        assert_eq!(doc.text, "Hello world");
        assert_eq!(doc.start_time, 0.0);
        assert_eq!(doc.end_time, 2.5);
        assert!(doc.language.is_none());
        assert!(doc.confidence.is_none());
    }

    #[test]
    fn test_transcript_document_builder() {
        let doc = TranscriptDocument::new("seg_001", "asset_001", "Hello world", 0.0, 2.5)
            .with_language("en")
            .with_confidence(0.95);

        assert_eq!(doc.language, Some("en".to_string()));
        assert_eq!(doc.confidence, Some(0.95));
    }

    // -------------------------------------------------------------------------
    // SearchOptions Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_search_options_default() {
        let options = SearchOptions::default();

        assert_eq!(options.limit, 0);
        assert_eq!(options.offset, 0);
        assert!(options.asset_ids.is_none());
        assert!(options.project_id.is_none());
        assert!(options.indexes.is_none());
    }

    #[test]
    fn test_search_options_builder() {
        let options = SearchOptions::with_limit(20)
            .offset(10)
            .filter_assets(vec!["asset_001".to_string()])
            .filter_project("project_001")
            .only_indexes(vec!["transcripts".to_string()]);

        assert_eq!(options.limit, 20);
        assert_eq!(options.offset, 10);
        assert_eq!(options.asset_ids, Some(vec!["asset_001".to_string()]));
        assert_eq!(options.project_id, Some("project_001".to_string()));
        assert_eq!(options.indexes, Some(vec!["transcripts".to_string()]));
    }

    // -------------------------------------------------------------------------
    // MeilisearchResults Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_meilisearch_results_default() {
        let results: MeilisearchResults<AssetDocument> = MeilisearchResults::default();

        assert!(results.hits.is_empty());
        assert!(results.estimated_total_hits.is_none());
        assert_eq!(results.processing_time_ms, 0);
        assert!(results.query.is_empty());
    }

    #[test]
    fn test_combined_search_results_default() {
        let results = CombinedSearchResults::default();

        assert!(results.assets.hits.is_empty());
        assert!(results.transcripts.hits.is_empty());
        assert_eq!(results.total_processing_time_ms, 0);
    }

    // -------------------------------------------------------------------------
    // Stub Tests
    // -------------------------------------------------------------------------

    #[cfg(not(feature = "meilisearch"))]
    #[tokio::test]
    async fn test_stub_returns_error() {
        let config = SidecarConfig::default();
        let result = SearchIndexer::new(&config).await;
        assert!(matches!(result, Err(IndexerError::FeatureNotEnabled)));
    }
}

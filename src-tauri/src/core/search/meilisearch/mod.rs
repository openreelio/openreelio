//! Meilisearch Integration Module
//!
//! Provides full-text search capabilities using Meilisearch as the backend.
//! This module is conditionally compiled when the `meilisearch` feature is enabled.
//!
//! # Architecture
//!
//! The Meilisearch integration consists of two main components:
//!
//! 1. **Sidecar**: Manages the lifecycle of an embedded Meilisearch instance
//! 2. **Indexer**: Handles document indexing and search operations
//!
//! # Usage
//!
//! ```rust,ignore
//! use openreelio::core::search::meilisearch::{
//!     MeilisearchSidecar, SearchIndexer, SidecarConfig,
//!     AssetDocument, TranscriptDocument, SearchOptions,
//! };
//!
//! // Start the Meilisearch sidecar
//! let config = SidecarConfig::default();
//! let mut sidecar = MeilisearchSidecar::new(config.clone());
//! sidecar.start().await?;
//!
//! // Create an indexer
//! let indexer = SearchIndexer::new(&config).await?;
//!
//! // Index an asset
//! let asset_doc = AssetDocument::new("asset_001", "Video.mp4", "/path/to/video.mp4", "video");
//! indexer.index_asset(&asset_doc).await?;
//!
//! // Search
//! let results = indexer.search("video", &SearchOptions::with_limit(10)).await?;
//! ```

pub mod indexer;
pub mod sidecar;

// Re-export commonly used types
pub use indexer::{
    AssetDocument, CombinedSearchResults, IndexerError, IndexerResult, MeilisearchResults,
    SearchIndexer, SearchOptions, TranscriptDocument,
};
pub use sidecar::{
    default_data_dir, is_meilisearch_available, MeilisearchSidecar, SidecarConfig, SidecarError,
    SidecarResult,
};

// =============================================================================
// Convenience Functions
// =============================================================================

/// Creates a new Meilisearch sidecar and indexer with default configuration
#[cfg(feature = "meilisearch")]
pub async fn create_search_system(
    data_dir: Option<std::path::PathBuf>,
) -> Result<(MeilisearchSidecar, SearchIndexer), Box<dyn std::error::Error + Send + Sync>> {
    let config = match data_dir {
        Some(dir) => SidecarConfig::with_data_dir(dir),
        None => SidecarConfig::default(),
    };

    let mut sidecar = MeilisearchSidecar::new(config.clone());
    sidecar.start().await?;

    let indexer = SearchIndexer::new(&config).await?;

    Ok((sidecar, indexer))
}

/// Creates a new Meilisearch sidecar and indexer (stub - returns error)
#[cfg(not(feature = "meilisearch"))]
pub async fn create_search_system(
    _data_dir: Option<std::path::PathBuf>,
) -> Result<(MeilisearchSidecar, SearchIndexer), Box<dyn std::error::Error + Send + Sync>> {
    Err(Box::new(SidecarError::FeatureNotEnabled))
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_meilisearch_available() {
        let available = is_meilisearch_available();

        #[cfg(feature = "meilisearch")]
        assert!(available);

        #[cfg(not(feature = "meilisearch"))]
        assert!(!available);
    }

    #[test]
    fn test_default_data_dir() {
        let dir = default_data_dir();
        assert!(dir.to_string_lossy().contains("search"));
    }

    #[test]
    fn test_sidecar_config_default() {
        let config = SidecarConfig::default();
        assert!(!config.http_addr.is_empty());
        assert!(!config.master_key.is_empty());
    }

    #[test]
    fn test_search_options() {
        let options = SearchOptions::with_limit(20)
            .offset(5)
            .filter_project("test_project");

        assert_eq!(options.limit, 20);
        assert_eq!(options.offset, 5);
        assert_eq!(options.project_id, Some("test_project".to_string()));
    }
}

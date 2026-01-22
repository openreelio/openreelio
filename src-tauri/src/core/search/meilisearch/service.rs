//! Meilisearch Search Service
//!
//! Provides a production-safe wrapper around Meilisearch sidecar + indexer.
//!
//! Goals:
//! - Lazy startup (no hard dependency during app boot)
//! - Single shared sidecar per app
//! - Single shared indexer per app
//! - Clear, actionable errors for IPC and jobs

use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};

use super::indexer::{
    AssetDocument, CombinedSearchResults, SearchIndexer, SearchOptions, TranscriptDocument,
};
use super::sidecar::{is_meilisearch_available, MeilisearchSidecar, SidecarConfig};

/// Shared Meilisearch service (sidecar lifecycle + search/index API).
pub struct SearchService {
    config: SidecarConfig,
    sidecar: Mutex<MeilisearchSidecar>,
    indexer: RwLock<Option<Arc<SearchIndexer>>>,
}

impl SearchService {
    /// Creates a new service wrapper. The sidecar is not started until the
    /// first call to `ensure_ready`.
    pub fn new(config: SidecarConfig) -> Self {
        Self {
            sidecar: Mutex::new(MeilisearchSidecar::new(config.clone())),
            config,
            indexer: RwLock::new(None),
        }
    }

    pub fn config(&self) -> &SidecarConfig {
        &self.config
    }

    /// Starts the sidecar (if needed) and creates the indexer (if needed).
    pub async fn ensure_ready(&self) -> Result<(), String> {
        if !is_meilisearch_available() {
            return Err(
                "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
            );
        }

        {
            let mut sidecar_guard = self.sidecar.lock().await;
            if !sidecar_guard.is_running() {
                sidecar_guard
                    .start()
                    .await
                    .map_err(|e| format!("Failed to start Meilisearch sidecar: {}", e))?;
            }
        }

        // Indexer init happens after the sidecar is up.
        let mut indexer_guard = self.indexer.write().await;
        if indexer_guard.is_none() {
            let indexer = SearchIndexer::new(&self.config)
                .await
                .map_err(|e| format!("Failed to create Meilisearch indexer: {}", e))?;
            *indexer_guard = Some(Arc::new(indexer));
        }

        Ok(())
    }

    async fn get_indexer(&self) -> Result<Arc<SearchIndexer>, String> {
        self.ensure_ready().await?;
        let guard = self.indexer.read().await;
        guard
            .clone()
            .ok_or_else(|| "Meilisearch indexer not initialized".to_string())
    }

    pub async fn search(
        &self,
        query: &str,
        options: &SearchOptions,
    ) -> Result<CombinedSearchResults, String> {
        let indexer = self.get_indexer().await?;
        indexer
            .search(query, options)
            .await
            .map_err(|e| format!("Search failed: {}", e))
    }

    pub async fn index_asset(&self, doc: &AssetDocument) -> Result<(), String> {
        let indexer = self.get_indexer().await?;
        indexer
            .index_asset(doc)
            .await
            .map_err(|e| format!("Index asset failed: {}", e))
    }

    pub async fn index_transcripts(
        &self,
        asset_id: &str,
        segments: &[TranscriptDocument],
    ) -> Result<(), String> {
        let indexer = self.get_indexer().await?;
        indexer
            .index_transcripts(asset_id, segments)
            .await
            .map_err(|e| format!("Index transcripts failed: {}", e))
    }

    pub async fn delete_asset(&self, asset_id: &str) -> Result<(), String> {
        let indexer = self.get_indexer().await?;
        indexer
            .delete_asset(asset_id)
            .await
            .map_err(|e| format!("Delete asset failed: {}", e))
    }
}

/// Convenience shared type.
pub type SharedSearchService = Arc<SearchService>;

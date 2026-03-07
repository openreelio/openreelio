//! Search and indexing commands
//!
//! Tauri IPC commands for SQLite-based search and Meilisearch integration.

use specta::Type;
use tauri::State;

use crate::core::CoreError;
use crate::AppState;

use super::transcription::TranscriptionSegmentDto;

// =============================================================================
// SQLite Search DTOs
// =============================================================================

/// Search query parameters for SQLite-based search
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryDto {
    /// Text to search for
    pub text: Option<String>,
    /// Search modality: "text", "visual", "audio", "hybrid"
    pub modality: Option<String>,
    /// Duration filter: [min, max] in seconds
    pub duration_range: Option<(f64, f64)>,
    /// Filter by specific asset IDs
    #[serde(alias = "filterAssetIds")]
    pub asset_ids: Option<Vec<String>>,
    /// Minimum quality score (0.0 - 1.0)
    pub min_quality: Option<f64>,
    /// Maximum number of results
    #[serde(alias = "resultLimit")]
    pub limit: Option<usize>,
}

/// A single search result from SQLite search
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultDto {
    /// Asset ID
    pub asset_id: String,
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
    /// Source of the match: "transcript", "shot", "audio", "multiple", "unknown"
    pub source: String,
}

/// Search response with results and metadata
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponseDto {
    /// Search results
    pub results: Vec<SearchResultDto>,
    /// Total number of results found
    pub total: usize,
    /// Query processing time in milliseconds
    pub processing_time_ms: u64,
}

// =============================================================================
// Meilisearch DTOs
// =============================================================================

/// Options for full-text search queries.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptionsDto {
    /// Maximum number of results per index
    pub limit: Option<usize>,
    /// Offset for pagination
    pub offset: Option<usize>,
    /// Filter by asset IDs
    pub asset_ids: Option<Vec<String>>,
    /// Filter by project ID
    pub project_id: Option<String>,
    /// Search only specific indexes ("assets", "transcripts")
    pub indexes: Option<Vec<String>>,
}

/// Search result for an asset.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetSearchResultDto {
    /// Asset ID
    pub id: String,
    /// Asset display name
    pub name: String,
    /// File path
    pub path: String,
    /// Asset kind ("video", "audio", "image", etc.)
    pub kind: String,
    /// Duration in seconds (for video/audio)
    pub duration: Option<f64>,
    /// Associated tags
    pub tags: Vec<String>,
}

/// Search result for a transcript segment.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchResultDto {
    /// Segment ID
    pub id: String,
    /// Parent asset ID
    pub asset_id: String,
    /// Matched text content
    pub text: String,
    /// Start time in seconds
    pub start_time: f64,
    /// End time in seconds
    pub end_time: f64,
    /// Language code
    pub language: Option<String>,
}

/// Combined search results from all indexes.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultsDto {
    /// Matching assets
    pub assets: Vec<AssetSearchResultDto>,
    /// Matching transcript segments
    pub transcripts: Vec<TranscriptSearchResultDto>,
    /// Total asset matches (estimated)
    pub asset_total: Option<usize>,
    /// Total transcript matches (estimated)
    pub transcript_total: Option<usize>,
    /// Query processing time in milliseconds
    pub processing_time_ms: u64,
}

// =============================================================================
// SQLite Search Commands
// =============================================================================

/// Searches assets using SQLite-based search engine (always available)
///
/// This command performs search across transcripts and shots stored in the
/// project's index database. Unlike Meilisearch, this is always available
/// without additional feature flags.
#[tauri::command]
#[specta::specta]
pub async fn search_assets(
    query: SearchQueryDto,
    state: State<'_, AppState>,
) -> Result<SearchResponseDto, String> {
    use crate::core::indexing::IndexDb;
    use crate::core::search::{SearchEngine, SearchFilters, SearchModality, SearchQuery};
    use std::time::Instant;

    let start = Instant::now();

    // Get project and index database
    let guard = state.project.lock().await;
    let project = guard
        .as_ref()
        .ok_or_else(|| CoreError::NoProjectOpen.to_ipc_error())?;

    // Open (or create) the project's index database.
    let index_db_path = project.path.join("index.db");
    let index_db = (if index_db_path.exists() {
        IndexDb::open(&index_db_path)
    } else {
        IndexDb::create(&index_db_path)
    })
    .map_err(|e| e.to_ipc_error())?;

    // Build search query
    let modality = match query.modality.as_deref() {
        Some("visual") => SearchModality::Visual,
        Some("audio") => SearchModality::Audio,
        Some("hybrid") => SearchModality::Hybrid,
        _ => SearchModality::Text,
    };

    let search_query = SearchQuery {
        text: query.text,
        duration_hint: query.duration_range,
        modality,
        filters: SearchFilters {
            asset_ids: query.asset_ids,
            min_quality: query.min_quality,
            ..Default::default()
        },
        limit: query.limit.unwrap_or(20),
    };

    // Perform search
    let engine = SearchEngine::new(&index_db);
    let results = engine.search(&search_query).map_err(|e| e.to_ipc_error())?;

    // Convert to DTOs
    let result_dtos: Vec<SearchResultDto> = results
        .iter()
        .map(|r| SearchResultDto {
            asset_id: r.asset_id.clone(),
            start_sec: r.start_sec,
            end_sec: r.end_sec,
            score: r.score,
            reasons: r.reasons.clone(),
            thumbnail_uri: r.thumbnail_uri.clone(),
            source: match r.source {
                crate::core::search::SearchResultSource::Transcript => "transcript".to_string(),
                crate::core::search::SearchResultSource::Shot => "shot".to_string(),
                crate::core::search::SearchResultSource::Audio => "audio".to_string(),
                crate::core::search::SearchResultSource::Multiple => "multiple".to_string(),
                crate::core::search::SearchResultSource::Unknown => "unknown".to_string(),
            },
        })
        .collect();

    let total = result_dtos.len();
    let processing_time_ms = start.elapsed().as_millis() as u64;

    Ok(SearchResponseDto {
        results: result_dtos,
        total,
        processing_time_ms,
    })
}

// =============================================================================
// Meilisearch Commands
// =============================================================================

/// Checks if Meilisearch is available and ready.
///
/// This is a best-effort check that may attempt lazy sidecar startup.
#[tauri::command]
#[specta::specta]
pub async fn is_meilisearch_available(state: State<'_, AppState>) -> Result<bool, String> {
    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Ok(false);
    }

    let service = match get_search_service(&state).await {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };

    match service.ensure_ready().await {
        Ok(()) => Ok(true),
        Err(e) => {
            tracing::debug!("Meilisearch not ready: {}", e);
            Ok(false)
        }
    }
}

/// Performs a full-text search using Meilisearch
#[tauri::command]
#[specta::specta]
pub async fn search_content(
    query: String,
    options: Option<SearchOptionsDto>,
    state: State<'_, AppState>,
) -> Result<SearchResultsDto, String> {
    use crate::core::search::meilisearch::SearchOptions;

    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Err(
            "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
        );
    }

    let search_options = match options {
        Some(opts) => SearchOptions {
            limit: opts.limit.unwrap_or(20),
            offset: opts.offset.unwrap_or(0),
            asset_ids: opts.asset_ids,
            project_id: opts.project_id,
            indexes: opts.indexes,
        },
        None => SearchOptions::with_limit(20),
    };

    let service = get_search_service(&state).await?;

    tracing::debug!(
        "Meilisearch query: '{}' (limit {}, offset {})",
        query,
        search_options.limit,
        search_options.offset
    );

    let results = service.search(&query, &search_options).await?;

    Ok(SearchResultsDto {
        assets: results
            .assets
            .hits
            .into_iter()
            .map(|a| AssetSearchResultDto {
                id: a.id,
                name: a.name,
                path: a.path,
                kind: a.kind,
                duration: a.duration,
                tags: a.tags,
            })
            .collect(),
        transcripts: results
            .transcripts
            .hits
            .into_iter()
            .map(|t| TranscriptSearchResultDto {
                id: t.id,
                asset_id: t.asset_id,
                text: t.text,
                start_time: t.start_time,
                end_time: t.end_time,
                language: t.language,
            })
            .collect(),
        asset_total: results.assets.estimated_total_hits,
        transcript_total: results.transcripts.estimated_total_hits,
        processing_time_ms: results.total_processing_time_ms,
    })
}

/// Indexes an asset in Meilisearch
#[tauri::command]
#[specta::specta]
pub async fn index_asset_for_search(
    asset_id: String,
    name: String,
    path: String,
    kind: String,
    duration: Option<f64>,
    tags: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::core::search::meilisearch::AssetDocument;

    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Err(
            "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
        );
    }

    let mut doc = AssetDocument::new(&asset_id, &name, &path, &kind);
    if let Some(dur) = duration {
        doc = doc.with_duration(dur);
    }
    if let Some(tags) = tags {
        doc = doc.with_tags(tags);
    }
    // If a project is open, attach its ID for filtering.
    if let Some(project_id) = {
        let guard = state.project.lock().await;
        guard.as_ref().map(|p| p.state.meta.id.clone())
    } {
        doc = doc.with_project_id(&project_id);
    }

    let service = get_search_service(&state).await?;
    service.index_asset(&doc).await?;

    tracing::info!(
        "Indexed asset for search: {} ({}) kind={} duration={:?}",
        asset_id,
        name,
        kind,
        duration
    );

    Ok(())
}

/// Indexes transcript segments for an asset
#[tauri::command]
#[specta::specta]
pub async fn index_transcripts_for_search(
    asset_id: String,
    segments: Vec<TranscriptionSegmentDto>,
    language: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use crate::core::search::meilisearch::TranscriptDocument;

    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Err(
            "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
        );
    }

    let service = get_search_service(&state).await?;

    let mut docs = Vec::with_capacity(segments.len());
    let mut skipped = 0usize;

    for (i, seg) in segments.into_iter().enumerate() {
        if seg.end_time < seg.start_time {
            skipped += 1;
            tracing::warn!(
                "Skipping invalid transcript segment (end < start) asset={} start={} end={}",
                asset_id,
                seg.start_time,
                seg.end_time
            );
            continue;
        }

        let mut doc = TranscriptDocument::new(
            &format!("{}_{}", asset_id, i),
            &asset_id,
            &seg.text,
            seg.start_time,
            seg.end_time,
        );
        if let Some(lang) = language.as_deref() {
            doc = doc.with_language(lang);
        }
        docs.push(doc);
    }

    if docs.is_empty() {
        tracing::info!(
            "No valid transcript segments to index for asset {} (skipped {})",
            asset_id,
            skipped
        );
        return Ok(());
    }

    service.index_transcripts(&asset_id, &docs).await?;

    tracing::info!(
        "Indexed {} transcript segments for asset {} (skipped {})",
        docs.len(),
        asset_id,
        skipped
    );

    Ok(())
}

/// Removes an asset and its transcripts from the search index
#[tauri::command]
#[specta::specta]
pub async fn remove_asset_from_search(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Err(
            "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
        );
    }

    let service = get_search_service(&state).await?;
    service.delete_asset(&asset_id).await?;

    tracing::info!("Removed asset {} from search index", asset_id);
    Ok(())
}

// =============================================================================
// Helper
// =============================================================================

async fn get_search_service(
    state: &State<'_, AppState>,
) -> Result<std::sync::Arc<crate::core::search::meilisearch::SearchService>, String> {
    let mut guard = state.search_service.lock().await;

    if let Some(service) = guard.as_ref() {
        return Ok(std::sync::Arc::clone(service));
    }

    if !crate::core::search::meilisearch::is_meilisearch_available() {
        return Err(
            "Meilisearch feature not enabled. Rebuild with --features meilisearch".to_string(),
        );
    }

    let service = std::sync::Arc::new(crate::core::search::meilisearch::SearchService::new(
        crate::core::search::meilisearch::SidecarConfig::default(),
    ));
    *guard = Some(std::sync::Arc::clone(&service));
    Ok(service)
}

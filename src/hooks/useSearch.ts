/**
 * useSearch Hook
 *
 * Provides full-text search capabilities using Meilisearch backend.
 * Supports searching across assets and transcripts with filtering and pagination.
 */

import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/services/logger';

const logger = createLogger('useSearch');

// =============================================================================
// Types
// =============================================================================

/**
 * Options for search queries
 */
export interface SearchOptions {
  /** Maximum number of results per index */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Filter by asset IDs */
  assetIds?: string[];
  /** Filter by project ID */
  projectId?: string;
  /** Search only specific indexes (assets, transcripts) */
  indexes?: ('assets' | 'transcripts')[];
}

/**
 * Asset search result
 */
export interface AssetSearchResult {
  /** Asset ID */
  id: string;
  /** Asset name */
  name: string;
  /** File path */
  path: string;
  /** Asset kind */
  kind: string;
  /** Duration in seconds */
  duration: number | null;
  /** Tags */
  tags: string[];
}

/**
 * Transcript search result
 */
export interface TranscriptSearchResult {
  /** Segment ID */
  id: string;
  /** Asset ID */
  assetId: string;
  /** Text content */
  text: string;
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Language code */
  language: string | null;
}

/**
 * Combined search results
 */
export interface SearchResults {
  /** Asset results */
  assets: AssetSearchResult[];
  /** Transcript results */
  transcripts: TranscriptSearchResult[];
  /** Total number of asset hits (estimated) */
  assetTotal: number | null;
  /** Total number of transcript hits (estimated) */
  transcriptTotal: number | null;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

// =============================================================================
// SQLite Search Types (always available)
// =============================================================================

/**
 * Options for SQLite-based asset search
 */
export interface AssetSearchOptions {
  /** Maximum number of results (default: hook's defaultLimit) */
  limit?: number;
  /** Filter by specific asset IDs */
  assetIds?: string[];
  /** Search modality: 'visual', 'audio', 'transcript', or all (default) */
  modality?: 'visual' | 'audio' | 'transcript';
}

/**
 * Single result from SQLite asset search
 */
export interface AssetSearchResultItem {
  /** Asset ID */
  assetId: string;
  /** Asset name */
  assetName: string;
  /** Start time in seconds */
  startSec: number;
  /** End time in seconds */
  endSec: number;
  /** Relevance score (0.0 - 1.0) */
  score: number;
  /** Reasons for the match */
  reasons: string[];
  /** Thumbnail URI (if available) */
  thumbnailUri: string | null;
  /** Source of the match: "transcript", "shot", "audio", "multiple", "unknown" */
  source: string;
}

/**
 * Response from SQLite asset search
 */
export interface AssetSearchResponse {
  /** Search results */
  results: AssetSearchResultItem[];
  /** Total number of results found */
  total: number;
  /** Query processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Search state
 */
export interface SearchState {
  /** Whether a search is in progress */
  isSearching: boolean;
  /** Current search query */
  query: string;
  /** Search results */
  results: SearchResults | null;
  /** Error message if search failed */
  error: string | null;
}

/**
 * Hook configuration options
 */
export interface UseSearchOptions {
  /** Debounce delay in milliseconds (default: 300) */
  debounceMs?: number;
  /** Default search limit (default: 20) */
  defaultLimit?: number;
  /** Whether to cache search results */
  cacheResults?: boolean;
  /** Maximum cache size (default: 100) */
  maxCacheSize?: number;
}

/**
 * Hook return type
 */
export interface UseSearchReturn {
  /** Search for content (debounced with caching) - Meilisearch */
  search: (query: string, options?: SearchOptions) => Promise<SearchResults | null>;
  /** Search assets using SQLite backend (always available) */
  searchAssets: (query: string, options?: AssetSearchOptions) => Promise<AssetSearchResponse | null>;
  /** Clear search results */
  clearResults: () => void;
  /** Clear the search cache */
  clearCache: () => void;
  /** Check if Meilisearch is available */
  isSearchAvailable: () => Promise<boolean>;
  /** Index an asset for search */
  indexAsset: (
    assetId: string,
    name: string,
    path: string,
    kind: string,
    duration?: number,
    tags?: string[]
  ) => Promise<void>;
  /** Index transcript segments for search */
  indexTranscripts: (
    assetId: string,
    segments: Array<{ startTime: number; endTime: number; text: string }>,
    language?: string
  ) => Promise<void>;
  /** Remove an asset from search index */
  removeAssetFromSearch: (assetId: string) => Promise<void>;
  /** Current search state */
  state: SearchState;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for full-text search using Meilisearch
 *
 * @param options - Hook configuration options
 * @returns Search functions and state
 *
 * @example
 * ```tsx
 * const { search, state, isSearchAvailable } = useSearch();
 *
 * // Check availability
 * const available = await isSearchAvailable();
 *
 * // Perform search
 * const results = await search('hello world', { limit: 10 });
 *
 * // Access results
 * console.log(state.results?.assets);
 * console.log(state.results?.transcripts);
 * ```
 */
export function useSearch(options: UseSearchOptions = {}): UseSearchReturn {
  const {
    debounceMs = 300,
    defaultLimit = 20,
    cacheResults = true,
    maxCacheSize = 100,
  } = options;

  // State
  const [state, setState] = useState<SearchState>({
    isSearching: false,
    query: '',
    results: null,
    error: null,
  });

  // Ref for debounce timer
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref for tracking request ID (race condition prevention)
  const requestIdRef = useRef(0);

  // Cache: Map<cacheKey, SearchResults>
  const cacheRef = useRef<Map<string, SearchResults>>(new Map());

  /**
   * Generate cache key from query and options
   */
  const getCacheKey = useCallback(
    (query: string, searchOptions?: SearchOptions): string => {
      const normalizedQuery = query.trim().toLowerCase();
      const optionsStr = searchOptions
        ? JSON.stringify({
            limit: searchOptions.limit ?? defaultLimit,
            offset: searchOptions.offset ?? 0,
            assetIds: searchOptions.assetIds?.sort(),
            projectId: searchOptions.projectId,
            indexes: searchOptions.indexes?.sort(),
          })
        : `{"limit":${defaultLimit}}`;
      return `${normalizedQuery}:${optionsStr}`;
    },
    [defaultLimit]
  );

  /**
   * Add result to cache with LRU eviction
   */
  const addToCache = useCallback(
    (cacheKey: string, results: SearchResults) => {
      if (!cacheResults) return;

      const cache = cacheRef.current;

      // LRU: if key exists, delete it first to update position
      if (cache.has(cacheKey)) {
        cache.delete(cacheKey);
      }

      // Evict oldest entry if at max size
      if (cache.size >= maxCacheSize) {
        const firstKey = cache.keys().next().value;
        if (firstKey) {
          cache.delete(firstKey);
        }
      }

      cache.set(cacheKey, results);
    },
    [cacheResults, maxCacheSize]
  );

  /**
   * Get from cache (with LRU refresh)
   */
  const getFromCache = useCallback(
    (cacheKey: string): SearchResults | null => {
      if (!cacheResults) return null;

      const cache = cacheRef.current;
      const cached = cache.get(cacheKey);

      if (cached) {
        // LRU refresh: delete and re-insert to move to end
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        return cached;
      }

      return null;
    },
    [cacheResults]
  );

  /**
   * Check if Meilisearch is available
   */
  const isSearchAvailable = useCallback(async (): Promise<boolean> => {
    try {
      const available = await invoke<boolean>('is_meilisearch_available');
      return available;
    } catch (error) {
      logger.error('Failed to check search availability', { error });
      return false;
    }
  }, []);

  /**
   * Perform a search with debouncing and caching
   */
  const search = useCallback(
    (
      query: string,
      searchOptions?: SearchOptions
    ): Promise<SearchResults | null> => {
      // Clear any pending debounce
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      // Skip empty queries
      if (!query.trim()) {
        setState((prev) => ({
          ...prev,
          query: '',
          results: null,
          error: null,
        }));
        return Promise.resolve(null);
      }

      // Check cache first (immediate return for cached results)
      const cacheKey = getCacheKey(query, searchOptions);
      const cached = getFromCache(cacheKey);
      if (cached) {
        logger.debug('Returning cached search results', { query, cacheKey });
        setState((prev) => ({
          ...prev,
          query,
          results: cached,
          error: null,
        }));
        return Promise.resolve(cached);
      }

      // Return a promise that resolves after debounce
      return new Promise((resolve) => {
        // Update state to show we're preparing to search
        setState((prev) => ({
          ...prev,
          query,
        }));

        debounceRef.current = setTimeout(async () => {
          // Increment request ID for race condition handling
          const currentRequestId = ++requestIdRef.current;

          // Update state to searching
          setState((prev) => ({
            ...prev,
            isSearching: true,
            error: null,
          }));

          try {
            const results = await invoke<SearchResults>('search_content', {
              query,
              options: searchOptions
                ? {
                    limit: searchOptions.limit ?? defaultLimit,
                    offset: searchOptions.offset ?? 0,
                    assetIds: searchOptions.assetIds,
                    projectId: searchOptions.projectId,
                    indexes: searchOptions.indexes,
                  }
                : { limit: defaultLimit },
            });

            // Check if this is still the latest request (race condition guard)
            if (currentRequestId !== requestIdRef.current) {
              logger.debug('Discarding stale search result', {
                query,
                requestId: currentRequestId,
                currentId: requestIdRef.current,
              });
              resolve(null);
              return;
            }

            logger.debug('Search completed', {
              query,
              assetCount: results.assets.length,
              transcriptCount: results.transcripts.length,
              processingTimeMs: results.processingTimeMs,
            });

            // Cache the result
            addToCache(cacheKey, results);

            setState((prev) => ({
              ...prev,
              isSearching: false,
              results,
              error: null,
            }));

            resolve(results);
          } catch (error) {
            // Check if this is still the latest request
            if (currentRequestId !== requestIdRef.current) {
              resolve(null);
              return;
            }

            const errorMessage =
              error instanceof Error ? error.message : String(error);
            logger.error('Search failed', { query, error: errorMessage });

            setState((prev) => ({
              ...prev,
              isSearching: false,
              results: null,
              error: errorMessage,
            }));

            resolve(null);
          }
        }, debounceMs);
      });
    },
    [defaultLimit, debounceMs, getCacheKey, getFromCache, addToCache]
  );

  /**
   * Clear search results
   */
  const clearResults = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    // Increment request ID to cancel any pending requests
    requestIdRef.current++;

    setState({
      isSearching: false,
      query: '',
      results: null,
      error: null,
    });
  }, []);

  /**
   * Clear the search cache
   */
  const clearCache = useCallback(() => {
    cacheRef.current.clear();
    logger.debug('Search cache cleared');
  }, []);

  /**
   * Index an asset for search
   */
  const indexAsset = useCallback(
    async (
      assetId: string,
      name: string,
      path: string,
      kind: string,
      duration?: number,
      tags?: string[]
    ): Promise<void> => {
      try {
        await invoke('index_asset_for_search', {
          assetId,
          name,
          path,
          kind,
          duration: duration ?? null,
          tags: tags ?? null,
        });
        logger.debug('Asset indexed for search', { assetId, name });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error('Failed to index asset', { assetId, error: errorMessage });
        throw new Error(errorMessage);
      }
    },
    []
  );

  /**
   * Index transcript segments for search
   */
  const indexTranscripts = useCallback(
    async (
      assetId: string,
      segments: Array<{ startTime: number; endTime: number; text: string }>,
      language?: string
    ): Promise<void> => {
      try {
        await invoke('index_transcripts_for_search', {
          assetId,
          segments,
          language: language ?? null,
        });
        logger.debug('Transcripts indexed for search', {
          assetId,
          segmentCount: segments.length,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error('Failed to index transcripts', {
          assetId,
          error: errorMessage,
        });
        throw new Error(errorMessage);
      }
    },
    []
  );

  /**
   * Remove an asset from search index
   */
  const removeAssetFromSearch = useCallback(
    async (assetId: string): Promise<void> => {
      try {
        await invoke('remove_asset_from_search', { assetId });
        logger.debug('Asset removed from search index', { assetId });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error('Failed to remove asset from search', {
          assetId,
          error: errorMessage,
        });
        throw new Error(errorMessage);
      }
    },
    []
  );

  /**
   * Search assets using SQLite backend (always available)
   *
   * Unlike the Meilisearch-based search, this function uses the local SQLite
   * database which is always available without additional service dependencies.
   */
  const searchAssets = useCallback(
    async (
      query: string,
      searchOptions?: AssetSearchOptions
    ): Promise<AssetSearchResponse | null> => {
      // Skip empty queries
      if (!query.trim()) {
        return null;
      }

      // Update state to searching
      setState((prev) => ({
        ...prev,
        isSearching: true,
        error: null,
      }));

      try {
        const response = await invoke<AssetSearchResponse>('search_assets', {
          query: {
            text: query.trim(),
            resultLimit: searchOptions?.limit ?? defaultLimit,
            modality: searchOptions?.modality ?? null,
            filterAssetIds: searchOptions?.assetIds ?? null,
          },
        });

        logger.debug('SQLite search completed', {
          query,
          resultCount: response.results.length,
          processingTimeMs: response.processingTimeMs,
        });

        setState((prev) => ({
          ...prev,
          isSearching: false,
          error: null,
        }));

        return response;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error('SQLite search failed', { query, error: errorMessage });

        setState((prev) => ({
          ...prev,
          isSearching: false,
          error: errorMessage,
        }));

        return null;
      }
    },
    [defaultLimit]
  );

  return {
    search,
    searchAssets,
    clearResults,
    clearCache,
    isSearchAvailable,
    indexAsset,
    indexTranscripts,
    removeAssetFromSearch,
    state,
  };
}

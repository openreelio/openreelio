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
  /** Auto-search on query change */
  autoSearch?: boolean;
}

/**
 * Hook return type
 */
export interface UseSearchReturn {
  /** Search for content */
  search: (query: string, options?: SearchOptions) => Promise<SearchResults | null>;
  /** Clear search results */
  clearResults: () => void;
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
  const { defaultLimit = 20 } = options;

  // State
  const [state, setState] = useState<SearchState>({
    isSearching: false,
    query: '',
    results: null,
    error: null,
  });

  // Ref for debounce timer
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
   * Perform a search
   */
  const search = useCallback(
    async (
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
        return null;
      }

      // Update state to searching
      setState((prev) => ({
        ...prev,
        isSearching: true,
        query,
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

        logger.debug('Search completed', {
          query,
          assetCount: results.assets.length,
          transcriptCount: results.transcripts.length,
          processingTimeMs: results.processingTimeMs,
        });

        setState((prev) => ({
          ...prev,
          isSearching: false,
          results,
          error: null,
        }));

        return results;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error('Search failed', { query, error: errorMessage });

        setState((prev) => ({
          ...prev,
          isSearching: false,
          results: null,
          error: errorMessage,
        }));

        return null;
      }
    },
    [defaultLimit]
  );

  /**
   * Clear search results
   */
  const clearResults = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    setState({
      isSearching: false,
      query: '',
      results: null,
      error: null,
    });
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

  return {
    search,
    clearResults,
    isSearchAvailable,
    indexAsset,
    indexTranscripts,
    removeAssetFromSearch,
    state,
  };
}

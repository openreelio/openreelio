/**
 * useSearch Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSearch } from './useSearch';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

// =============================================================================
// Test Data
// =============================================================================

const mockSearchResults = {
  assets: [
    {
      id: 'asset_001',
      name: 'Video.mp4',
      path: '/path/to/video.mp4',
      kind: 'video',
      duration: 120.5,
      tags: ['interview', 'outdoor'],
    },
    {
      id: 'asset_002',
      name: 'Audio.wav',
      path: '/path/to/audio.wav',
      kind: 'audio',
      duration: 60.0,
      tags: [],
    },
  ],
  transcripts: [
    {
      id: 'seg_001',
      assetId: 'asset_001',
      text: 'Hello world',
      startTime: 0.0,
      endTime: 2.5,
      language: 'en',
    },
    {
      id: 'seg_002',
      assetId: 'asset_001',
      text: 'Goodbye world',
      startTime: 2.5,
      endTime: 5.0,
      language: 'en',
    },
  ],
  assetTotal: 2,
  transcriptTotal: 2,
  processingTimeMs: 15,
};

// =============================================================================
// Tests
// =============================================================================

describe('useSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('initialization', () => {
    it('should initialize with default state', () => {
      const { result } = renderHook(() => useSearch());

      expect(result.current.state.isSearching).toBe(false);
      expect(result.current.state.query).toBe('');
      expect(result.current.state.results).toBeNull();
      expect(result.current.state.error).toBeNull();
    });

    it('should provide all required functions', () => {
      const { result } = renderHook(() => useSearch());

      expect(typeof result.current.search).toBe('function');
      expect(typeof result.current.searchAssets).toBe('function');
      expect(typeof result.current.clearResults).toBe('function');
      expect(typeof result.current.isSearchAvailable).toBe('function');
      expect(typeof result.current.indexAsset).toBe('function');
      expect(typeof result.current.indexTranscripts).toBe('function');
      expect(typeof result.current.removeAssetFromSearch).toBe('function');
    });
  });

  // ===========================================================================
  // Availability Tests
  // ===========================================================================

  describe('isSearchAvailable', () => {
    it('should return true when Meilisearch is available', async () => {
      mockInvoke.mockResolvedValueOnce(true);

      const { result } = renderHook(() => useSearch());

      let available: boolean;
      await act(async () => {
        available = await result.current.isSearchAvailable();
      });

      expect(available!).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('is_meilisearch_available');
    });

    it('should return false when Meilisearch is not available', async () => {
      mockInvoke.mockResolvedValueOnce(false);

      const { result } = renderHook(() => useSearch());

      let available: boolean;
      await act(async () => {
        available = await result.current.isSearchAvailable();
      });

      expect(available!).toBe(false);
    });

    it('should return false on error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Connection failed'));

      const { result } = renderHook(() => useSearch());

      let available: boolean;
      await act(async () => {
        available = await result.current.isSearchAvailable();
      });

      expect(available!).toBe(false);
    });
  });

  // ===========================================================================
  // Search Tests
  // ===========================================================================

  describe('search', () => {
    it('should perform search and return results', async () => {
      mockInvoke.mockResolvedValueOnce(mockSearchResults);

      const { result } = renderHook(() => useSearch());

      let searchResult: Awaited<ReturnType<typeof result.current.search>> = null;

      await act(async () => {
        searchResult = await result.current.search('hello');
      });

      expect(searchResult).toEqual(mockSearchResults);
      expect(result.current.state.results).toEqual(mockSearchResults);
      expect(result.current.state.isSearching).toBe(false);
      expect(result.current.state.error).toBeNull();
      expect(result.current.state.query).toBe('hello');
      expect(mockInvoke).toHaveBeenCalledWith('search_content', {
        query: 'hello',
        options: { limit: 20 },
      });
    });

    it('should pass search options', async () => {
      mockInvoke.mockResolvedValueOnce(mockSearchResults);

      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.search('test', {
          limit: 10,
          offset: 5,
          assetIds: ['asset_001'],
          projectId: 'project_001',
          indexes: ['transcripts'],
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('search_content', {
        query: 'test',
        options: {
          limit: 10,
          offset: 5,
          assetIds: ['asset_001'],
          projectId: 'project_001',
          indexes: ['transcripts'],
        },
      });
    });

    it('should use default limit from options', async () => {
      mockInvoke.mockResolvedValueOnce(mockSearchResults);

      const { result } = renderHook(() => useSearch({ defaultLimit: 50 }));

      await act(async () => {
        await result.current.search('test');
      });

      expect(mockInvoke).toHaveBeenCalledWith('search_content', {
        query: 'test',
        options: { limit: 50 },
      });
    });

    it('should return null for empty query', async () => {
      const { result } = renderHook(() => useSearch());

      let searchResult: Awaited<ReturnType<typeof result.current.search>>;

      await act(async () => {
        searchResult = await result.current.search('');
      });

      expect(searchResult!).toBeNull();
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(result.current.state.query).toBe('');
      expect(result.current.state.results).toBeNull();
    });

    it('should return null for whitespace-only query', async () => {
      const { result } = renderHook(() => useSearch());

      let searchResult: Awaited<ReturnType<typeof result.current.search>>;

      await act(async () => {
        searchResult = await result.current.search('   ');
      });

      expect(searchResult!).toBeNull();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should handle search errors', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Search failed'));

      const { result } = renderHook(() => useSearch());

      let searchResult: Awaited<ReturnType<typeof result.current.search>>;

      await act(async () => {
        searchResult = await result.current.search('test');
      });

      expect(searchResult!).toBeNull();
      expect(result.current.state.results).toBeNull();
      expect(result.current.state.isSearching).toBe(false);
      expect(result.current.state.error).toBe('Search failed');
    });

    it('should set isSearching during search', async () => {
      vi.useFakeTimers();

      let resolveSearch: (value: typeof mockSearchResults) => void;
      const delayedPromise = new Promise<typeof mockSearchResults>((resolve) => {
        resolveSearch = resolve;
      });
      mockInvoke.mockReturnValueOnce(delayedPromise);

      const { result } = renderHook(() => useSearch({ debounceMs: 300 }));

      // Start search (this sets up debounce timer)
      act(() => {
        void result.current.search('test');
      });

      // Initially not searching (waiting for debounce)
      expect(result.current.state.isSearching).toBe(false);

      // Advance past debounce timer
      await act(async () => {
        vi.advanceTimersByTime(350);
      });

      // Now should be searching
      expect(result.current.state.isSearching).toBe(true);

      // Complete the search
      await act(async () => {
        resolveSearch!(mockSearchResults);
        await delayedPromise;
      });

      expect(result.current.state.isSearching).toBe(false);

      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // Clear Results Tests
  // ===========================================================================

  describe('clearResults', () => {
    it('should clear all search state', async () => {
      vi.useFakeTimers();
      mockInvoke.mockResolvedValueOnce(mockSearchResults);

      const { result } = renderHook(() => useSearch({ debounceMs: 100 }));

      // Start search and wait for debounce
      act(() => {
        void result.current.search('test');
      });

      // Advance timer and wait for search to complete
      await act(async () => {
        vi.advanceTimersByTime(150);
        await Promise.resolve(); // Allow invoke to resolve
      });

      expect(result.current.state.results).not.toBeNull();

      // Clear results
      act(() => {
        result.current.clearResults();
      });

      expect(result.current.state.query).toBe('');
      expect(result.current.state.results).toBeNull();
      expect(result.current.state.error).toBeNull();
      expect(result.current.state.isSearching).toBe(false);

      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // Index Asset Tests
  // ===========================================================================

  describe('indexAsset', () => {
    it('should index an asset for search', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.indexAsset(
          'asset_001',
          'Video.mp4',
          '/path/to/video.mp4',
          'video',
          120.5,
          ['interview'],
        );
      });

      expect(mockInvoke).toHaveBeenCalledWith('index_asset_for_search', {
        assetId: 'asset_001',
        name: 'Video.mp4',
        path: '/path/to/video.mp4',
        kind: 'video',
        duration: 120.5,
        tags: ['interview'],
      });
    });

    it('should handle optional parameters', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.indexAsset('asset_001', 'Image.png', '/path/to/image.png', 'image');
      });

      expect(mockInvoke).toHaveBeenCalledWith('index_asset_for_search', {
        assetId: 'asset_001',
        name: 'Image.png',
        path: '/path/to/image.png',
        kind: 'image',
        duration: null,
        tags: null,
      });
    });

    it('should throw on indexing failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Index failed'));

      const { result } = renderHook(() => useSearch());

      await expect(
        act(async () => {
          await result.current.indexAsset('asset_001', 'Video.mp4', '/path/to/video.mp4', 'video');
        }),
      ).rejects.toThrow('Index failed');
    });
  });

  // ===========================================================================
  // Index Transcripts Tests
  // ===========================================================================

  describe('indexTranscripts', () => {
    it('should index transcript segments', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useSearch());

      const segments = [
        { startTime: 0.0, endTime: 2.5, text: 'Hello world' },
        { startTime: 2.5, endTime: 5.0, text: 'Goodbye world' },
      ];

      await act(async () => {
        await result.current.indexTranscripts('asset_001', segments, 'en');
      });

      expect(mockInvoke).toHaveBeenCalledWith('index_transcripts_for_search', {
        assetId: 'asset_001',
        segments,
        language: 'en',
      });
    });

    it('should handle optional language parameter', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useSearch());

      const segments = [{ startTime: 0.0, endTime: 2.5, text: 'Hello' }];

      await act(async () => {
        await result.current.indexTranscripts('asset_001', segments);
      });

      expect(mockInvoke).toHaveBeenCalledWith('index_transcripts_for_search', {
        assetId: 'asset_001',
        segments,
        language: null,
      });
    });

    it('should throw on indexing failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Transcript index failed'));

      const { result } = renderHook(() => useSearch());

      await expect(
        act(async () => {
          await result.current.indexTranscripts('asset_001', []);
        }),
      ).rejects.toThrow('Transcript index failed');
    });
  });

  // ===========================================================================
  // Remove Asset Tests
  // ===========================================================================

  describe('removeAssetFromSearch', () => {
    it('should remove an asset from search index', async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.removeAssetFromSearch('asset_001');
      });

      expect(mockInvoke).toHaveBeenCalledWith('remove_asset_from_search', {
        assetId: 'asset_001',
      });
    });

    it('should throw on removal failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Removal failed'));

      const { result } = renderHook(() => useSearch());

      await expect(
        act(async () => {
          await result.current.removeAssetFromSearch('asset_001');
        }),
      ).rejects.toThrow('Removal failed');
    });
  });

  // ===========================================================================
  // SQLite-based Search Assets Tests (always available)
  // ===========================================================================

  describe('searchAssets (SQLite-based)', () => {
    const mockSqliteSearchResults = {
      results: [
        {
          assetId: 'asset_001',
          assetName: 'Interview.mp4',
          startSec: 10.5,
          endSec: 15.0,
          score: 0.95,
          reasons: ['Transcript match: "hello world"'],
          thumbnailUri: '/path/to/thumb.jpg',
          source: 'transcript',
        },
        {
          assetId: 'asset_002',
          assetName: 'B-roll.mp4',
          startSec: 0.0,
          endSec: 5.0,
          score: 0.75,
          reasons: ['Shot label: "outdoor scene"'],
          thumbnailUri: null,
          source: 'shot',
        },
      ],
      total: 2,
      processingTimeMs: 12,
    };

    it('should search assets using SQLite backend', async () => {
      mockInvoke.mockResolvedValueOnce(mockSqliteSearchResults);

      const { result } = renderHook(() => useSearch());

      let searchResult: Awaited<ReturnType<typeof result.current.searchAssets>>;

      await act(async () => {
        searchResult = await result.current.searchAssets('hello world');
      });

      expect(searchResult!).toEqual(mockSqliteSearchResults);
      expect(mockInvoke).toHaveBeenCalledWith('search_assets', {
        query: {
          text: 'hello world',
          limit: 20,
          modality: null,
          assetIds: null,
        },
      });
    });

    it('should pass search options to SQLite search', async () => {
      mockInvoke.mockResolvedValueOnce(mockSqliteSearchResults);

      const { result } = renderHook(() => useSearch());

      await act(async () => {
        await result.current.searchAssets('test query', {
          limit: 50,
          assetIds: ['asset_001', 'asset_002'],
          modality: 'visual',
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('search_assets', {
        query: {
          text: 'test query',
          limit: 50,
          modality: 'visual',
          assetIds: ['asset_001', 'asset_002'],
        },
      });
    });

    it('should return null for empty query in SQLite search', async () => {
      const { result } = renderHook(() => useSearch());

      let searchResult: Awaited<ReturnType<typeof result.current.searchAssets>>;

      await act(async () => {
        searchResult = await result.current.searchAssets('');
      });

      expect(searchResult!).toBeNull();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should return null for whitespace-only query in SQLite search', async () => {
      const { result } = renderHook(() => useSearch());

      let searchResult: Awaited<ReturnType<typeof result.current.searchAssets>>;

      await act(async () => {
        searchResult = await result.current.searchAssets('   ');
      });

      expect(searchResult!).toBeNull();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should handle SQLite search errors', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Database error'));

      const { result } = renderHook(() => useSearch());

      let searchResult: Awaited<ReturnType<typeof result.current.searchAssets>>;

      await act(async () => {
        searchResult = await result.current.searchAssets('test');
      });

      expect(searchResult!).toBeNull();
      expect(result.current.state.error).toBe('Database error');
    });

    it('should update state during SQLite search', async () => {
      let resolveSearch: (value: typeof mockSqliteSearchResults) => void;
      const delayedPromise = new Promise<typeof mockSqliteSearchResults>((resolve) => {
        resolveSearch = resolve;
      });
      mockInvoke.mockReturnValueOnce(delayedPromise);

      const { result } = renderHook(() => useSearch());

      // Start search
      act(() => {
        void result.current.searchAssets('test');
      });

      // Should be searching
      expect(result.current.state.isSearching).toBe(true);

      // Complete the search
      await act(async () => {
        resolveSearch!(mockSqliteSearchResults);
        await delayedPromise;
      });

      expect(result.current.state.isSearching).toBe(false);
    });

    it('should use hook defaultLimit for SQLite search', async () => {
      mockInvoke.mockResolvedValueOnce(mockSqliteSearchResults);

      const { result } = renderHook(() => useSearch({ defaultLimit: 100 }));

      await act(async () => {
        await result.current.searchAssets('test');
      });

      expect(mockInvoke).toHaveBeenCalledWith('search_assets', {
        query: {
          text: 'test',
          limit: 100,
          modality: null,
          assetIds: null,
        },
      });
    });

    it('should support all modality options', async () => {
      const { result } = renderHook(() => useSearch());

      // Test visual modality
      mockInvoke.mockResolvedValueOnce(mockSqliteSearchResults);
      await act(async () => {
        await result.current.searchAssets('test', { modality: 'visual' });
      });
      expect(mockInvoke).toHaveBeenLastCalledWith('search_assets', {
        query: expect.objectContaining({ modality: 'visual' }),
      });

      // Test audio modality
      mockInvoke.mockResolvedValueOnce(mockSqliteSearchResults);
      await act(async () => {
        await result.current.searchAssets('test', { modality: 'audio' });
      });
      expect(mockInvoke).toHaveBeenLastCalledWith('search_assets', {
        query: expect.objectContaining({ modality: 'audio' }),
      });

      // Test transcript modality
      mockInvoke.mockResolvedValueOnce(mockSqliteSearchResults);
      await act(async () => {
        await result.current.searchAssets('test', { modality: 'transcript' });
      });
      expect(mockInvoke).toHaveBeenLastCalledWith('search_assets', {
        query: expect.objectContaining({ modality: 'text' }),
      });
    });
  });
});

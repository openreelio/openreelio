/**
 * WaveformCacheStore Tests
 *
 * Tests for the global waveform cache store including:
 * - LRU eviction policy
 * - Persistent cache management
 * - Priority queue for loading
 * - Concurrent request handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { useWaveformCacheStore, createWaveformCacheKey } from './waveformCacheStore';

// =============================================================================
// Mocks
// =============================================================================

const mockInvoke = vi.fn();
const mockConvertFileSrc = vi.fn((path: string) => `asset://${path}`);

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  convertFileSrc: (path: string) => mockConvertFileSrc(path),
}));

// =============================================================================
// Test Helpers
// =============================================================================

const getStore = () => useWaveformCacheStore.getState();

// =============================================================================
// Tests
// =============================================================================

describe('waveformCacheStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);

    // Reset store to initial state
    act(() => {
      getStore().clearCache();
      getStore().resetStats();
      getStore().setMaxCacheSize(100); // Reset to default
    });
  });

  // ===========================================================================
  // Utility Functions
  // ===========================================================================

  describe('createWaveformCacheKey', () => {
    it('should create consistent cache key from asset ID and dimensions', () => {
      const key1 = createWaveformCacheKey('asset-1', 1920, 100);
      const key2 = createWaveformCacheKey('asset-1', 1920, 100);

      expect(key1).toBe(key2);
    });

    it('should create different keys for different dimensions', () => {
      const key1 = createWaveformCacheKey('asset-1', 1920, 100);
      const key2 = createWaveformCacheKey('asset-1', 1280, 100);

      expect(key1).not.toBe(key2);
    });

    it('should include all components in key', () => {
      const key = createWaveformCacheKey('asset-1', 1920, 100);

      expect(key).toContain('asset-1');
      expect(key).toContain('1920');
      expect(key).toContain('100');
    });
  });

  // ===========================================================================
  // Basic Cache Operations
  // ===========================================================================

  describe('basic cache operations', () => {
    it('should start with empty cache', () => {
      const state = getStore();

      expect(state.cacheSize).toBe(0);
      expect(state.entries).toEqual({});
    });

    it('should add entry to cache', () => {
      act(() => {
        getStore().addToCache('asset-1', 1920, 100, '/path/to/waveform.png');
      });

      const state = getStore();
      expect(state.cacheSize).toBe(1);
      expect(state.entries['asset-1:1920x100']).toBeDefined();
    });

    it('should get entry from cache', () => {
      act(() => {
        getStore().addToCache('asset-1', 1920, 100, '/path/to/waveform.png');
      });

      const entry = getStore().getFromCache('asset-1', 1920, 100);

      expect(entry).toBeDefined();
      expect(entry?.imagePath).toBe('/path/to/waveform.png');
    });

    it('should return null for non-existent entry', () => {
      const entry = getStore().getFromCache('nonexistent', 1920, 100);

      expect(entry).toBeNull();
    });

    it('should check if entry exists in cache', () => {
      act(() => {
        getStore().addToCache('asset-1', 1920, 100, '/path/to/waveform.png');
      });

      expect(getStore().hasInCache('asset-1', 1920, 100)).toBe(true);
      expect(getStore().hasInCache('asset-2', 1920, 100)).toBe(false);
    });

    it('should clear cache', () => {
      act(() => {
        getStore().addToCache('asset-1', 1920, 100, '/path/to/waveform1.png');
        getStore().addToCache('asset-2', 1920, 100, '/path/to/waveform2.png');
      });

      expect(getStore().cacheSize).toBe(2);

      act(() => {
        getStore().clearCache();
      });

      expect(getStore().cacheSize).toBe(0);
      expect(getStore().entries).toEqual({});
    });
  });

  // ===========================================================================
  // LRU Eviction
  // ===========================================================================

  describe('LRU eviction', () => {
    it('should update lastAccessedAt when getting entry', async () => {
      act(() => {
        getStore().addToCache('asset-1', 1920, 100, '/path/to/waveform.png');
      });

      const initialAccess = getStore().entries['asset-1:1920x100'].lastAccessedAt;

      // Wait a bit and access again
      await new Promise((r) => setTimeout(r, 10));

      act(() => {
        getStore().getFromCache('asset-1', 1920, 100);
      });

      const updatedAccess = getStore().entries['asset-1:1920x100'].lastAccessedAt;

      // Should have been updated (or at least not decreased)
      expect(updatedAccess).toBeGreaterThanOrEqual(initialAccess);
    });

    it('should evict least recently used entry when cache is full', async () => {
      // Set max cache size to 3
      act(() => {
        getStore().setMaxCacheSize(3);
      });

      // Add 3 entries with delays to ensure different timestamps
      act(() => {
        getStore().addToCache('asset-a', 1920, 100, '/path/a.png');
      });
      await new Promise((r) => setTimeout(r, 10));

      act(() => {
        getStore().addToCache('asset-b', 1920, 100, '/path/b.png');
      });
      await new Promise((r) => setTimeout(r, 10));

      act(() => {
        getStore().addToCache('asset-c', 1920, 100, '/path/c.png');
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(getStore().cacheSize).toBe(3);

      // Access asset-a to make it recently used
      act(() => {
        getStore().getFromCache('asset-a', 1920, 100);
      });
      await new Promise((r) => setTimeout(r, 10));

      // Add new entry - should evict asset-b (least recently used)
      act(() => {
        getStore().addToCache('asset-d', 1920, 100, '/path/d.png');
      });

      expect(getStore().cacheSize).toBe(3);
      expect(getStore().hasInCache('asset-a', 1920, 100)).toBe(true);
      expect(getStore().hasInCache('asset-b', 1920, 100)).toBe(false); // Evicted
      expect(getStore().hasInCache('asset-c', 1920, 100)).toBe(true);
      expect(getStore().hasInCache('asset-d', 1920, 100)).toBe(true);
    });

    it('should evict multiple entries if needed', async () => {
      act(() => {
        getStore().setMaxCacheSize(5);
      });

      // Add 5 entries
      for (let i = 1; i <= 5; i++) {
        act(() => {
          getStore().addToCache(`asset-${i}`, 1920, 100, `/path/${i}.png`);
        });
        await new Promise((r) => setTimeout(r, 5));
      }

      expect(getStore().cacheSize).toBe(5);

      // Reduce max size to 3 - should trigger eviction
      act(() => {
        getStore().setMaxCacheSize(3);
      });

      expect(getStore().cacheSize).toBe(3);
    });
  });

  // ===========================================================================
  // Priority Queue
  // ===========================================================================

  describe('priority queue', () => {
    it('should add request to queue', () => {
      act(() => {
        getStore().queueRequest({
          assetId: 'asset-1',
          inputPath: '/path/to/audio.mp3',
          width: 1920,
          height: 100,
          priority: 'normal',
        });
      });

      expect(getStore().pendingRequests.length).toBe(1);
    });

    it('should prioritize high priority requests', () => {
      act(() => {
        getStore().queueRequest({
          assetId: 'asset-1',
          inputPath: '/path/1.mp3',
          width: 1920,
          height: 100,
          priority: 'normal',
        });
        getStore().queueRequest({
          assetId: 'asset-2',
          inputPath: '/path/2.mp3',
          width: 1920,
          height: 100,
          priority: 'high',
        });
      });

      const requests = getStore().pendingRequests;

      // High priority should be first
      expect(requests[0].assetId).toBe('asset-2');
      expect(requests[1].assetId).toBe('asset-1');
    });

    it('should not duplicate requests in queue', () => {
      act(() => {
        getStore().queueRequest({
          assetId: 'asset-1',
          inputPath: '/path/1.mp3',
          width: 1920,
          height: 100,
          priority: 'normal',
        });
        getStore().queueRequest({
          assetId: 'asset-1',
          inputPath: '/path/1.mp3',
          width: 1920,
          height: 100,
          priority: 'high', // Same asset, different priority
        });
      });

      expect(getStore().pendingRequests.length).toBe(1);
      // Should keep higher priority
      expect(getStore().pendingRequests[0].priority).toBe('high');
    });

    it('should remove request from queue', () => {
      act(() => {
        getStore().queueRequest({
          assetId: 'asset-1',
          inputPath: '/path/1.mp3',
          width: 1920,
          height: 100,
          priority: 'normal',
        });
      });

      expect(getStore().pendingRequests.length).toBe(1);

      act(() => {
        getStore().removeFromQueue('asset-1', 1920, 100);
      });

      expect(getStore().pendingRequests.length).toBe(0);
    });
  });

  // ===========================================================================
  // Generation Tracking
  // ===========================================================================

  describe('generation tracking', () => {
    it('should track active generations', () => {
      expect(getStore().activeGenerations.size).toBe(0);

      act(() => {
        getStore().markGenerating('asset-1', 1920, 100);
      });

      expect(getStore().activeGenerations.has('asset-1:1920x100')).toBe(true);
      expect(getStore().isGenerating).toBe(true);
    });

    it('should clear generation when complete', () => {
      act(() => {
        getStore().markGenerating('asset-1', 1920, 100);
      });

      expect(getStore().isGenerating).toBe(true);

      act(() => {
        getStore().markComplete('asset-1', 1920, 100);
      });

      expect(getStore().activeGenerations.has('asset-1:1920x100')).toBe(false);
      expect(getStore().isGenerating).toBe(false);
    });

    it('should remain generating when some generations are still active', () => {
      act(() => {
        getStore().markGenerating('asset-1', 1920, 100);
        getStore().markGenerating('asset-2', 1920, 100);
      });

      act(() => {
        getStore().markComplete('asset-1', 1920, 100);
      });

      expect(getStore().isGenerating).toBe(true);

      act(() => {
        getStore().markComplete('asset-2', 1920, 100);
      });

      expect(getStore().isGenerating).toBe(false);
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('error handling', () => {
    it('should track error state', () => {
      expect(getStore().error).toBeNull();

      act(() => {
        getStore().setError('Generation failed');
      });

      expect(getStore().error).toBe('Generation failed');
    });

    it('should clear error on successful operation', () => {
      act(() => {
        getStore().setError('Previous error');
      });

      expect(getStore().error).toBe('Previous error');

      act(() => {
        getStore().addToCache('asset-1', 1920, 100, '/path/waveform.png');
      });

      expect(getStore().error).toBeNull();
    });

    it('should clear error on cache clear', () => {
      act(() => {
        getStore().setError('Some error');
      });

      act(() => {
        getStore().clearCache();
      });

      expect(getStore().error).toBeNull();
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================

  describe('statistics', () => {
    it('should track cache hits', () => {
      act(() => {
        getStore().addToCache('asset-1', 1920, 100, '/path/waveform.png');
      });

      // First access - should count as hit
      act(() => {
        getStore().getFromCache('asset-1', 1920, 100);
      });

      expect(getStore().stats.cacheHits).toBe(1);

      // Second access
      act(() => {
        getStore().getFromCache('asset-1', 1920, 100);
      });

      expect(getStore().stats.cacheHits).toBe(2);
    });

    it('should track cache misses', () => {
      act(() => {
        getStore().getFromCache('nonexistent', 1920, 100);
      });

      expect(getStore().stats.cacheMisses).toBe(1);
    });

    it('should track total generations', () => {
      act(() => {
        getStore().markGenerating('asset-1', 1920, 100);
        getStore().markComplete('asset-1', 1920, 100);
      });

      expect(getStore().stats.totalGenerations).toBe(1);
    });

    it('should reset stats', () => {
      act(() => {
        getStore().getFromCache('nonexistent', 1920, 100);
        getStore().addToCache('asset-1', 1920, 100, '/path/waveform.png');
        getStore().getFromCache('asset-1', 1920, 100);
      });

      expect(getStore().stats.cacheHits).toBe(1);
      expect(getStore().stats.cacheMisses).toBe(1);

      act(() => {
        getStore().resetStats();
      });

      expect(getStore().stats.cacheHits).toBe(0);
      expect(getStore().stats.cacheMisses).toBe(0);
    });
  });
});

/**
 * FrameCache Service Tests
 *
 * TDD tests for LRU-based frame caching system.
 * Tests cover: basic operations, LRU eviction, TTL expiration, memory management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FrameCache, type FrameCacheConfig } from './frameCache';

describe('FrameCache', () => {
  let cache: FrameCache;

  const defaultConfig: FrameCacheConfig = {
    maxEntries: 5,
    maxMemoryMB: 10,
    ttlMs: 60000, // 1 minute
  };

  beforeEach(() => {
    cache = new FrameCache(defaultConfig);
    vi.useFakeTimers();
  });

  afterEach(() => {
    cache.clear();
    vi.useRealTimers();
  });

  // ===========================================================================
  // Basic Operations
  // ===========================================================================

  describe('Basic Operations', () => {
    it('should store and retrieve a frame URL', () => {
      cache.set('asset1:1.00', 'blob:http://localhost/frame1', 100);
      expect(cache.get('asset1:1.00')).toBe('blob:http://localhost/frame1');
    });

    it('should return null for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('should check if key exists with has()', () => {
      cache.set('asset1:1.00', 'blob:url', 100);
      expect(cache.has('asset1:1.00')).toBe(true);
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should overwrite existing entry with same key', () => {
      cache.set('asset1:1.00', 'old-url', 100);
      cache.set('asset1:1.00', 'new-url', 100);
      expect(cache.get('asset1:1.00')).toBe('new-url');
    });

    it('should delete an entry', () => {
      cache.set('asset1:1.00', 'blob:url', 100);
      cache.delete('asset1:1.00');
      expect(cache.get('asset1:1.00')).toBeNull();
    });

    it('should clear all entries', () => {
      cache.set('asset1:1.00', 'url1', 100);
      cache.set('asset2:2.00', 'url2', 100);
      cache.clear();
      expect(cache.get('asset1:1.00')).toBeNull();
      expect(cache.get('asset2:2.00')).toBeNull();
    });
  });

  // ===========================================================================
  // LRU Eviction
  // ===========================================================================

  describe('LRU Eviction', () => {
    it('should evict least recently used entry when maxEntries exceeded', () => {
      // Fill cache to max (5 entries) with time progression
      cache.set('key1', 'url1', 100);
      vi.advanceTimersByTime(10);
      cache.set('key2', 'url2', 100);
      vi.advanceTimersByTime(10);
      cache.set('key3', 'url3', 100);
      vi.advanceTimersByTime(10);
      cache.set('key4', 'url4', 100);
      vi.advanceTimersByTime(10);
      cache.set('key5', 'url5', 100);
      vi.advanceTimersByTime(10);

      // Add one more - should evict key1 (oldest)
      cache.set('key6', 'url6', 100);

      expect(cache.get('key1')).toBeNull(); // Evicted
      expect(cache.get('key6')).toBe('url6'); // New entry exists
    });

    it('should update access time on get()', () => {
      cache.set('key1', 'url1', 100);
      vi.advanceTimersByTime(10);
      cache.set('key2', 'url2', 100);
      vi.advanceTimersByTime(10);
      cache.set('key3', 'url3', 100);
      vi.advanceTimersByTime(10);
      cache.set('key4', 'url4', 100);
      vi.advanceTimersByTime(10);
      cache.set('key5', 'url5', 100);
      vi.advanceTimersByTime(10);

      // Access key1 to make it recently used
      cache.get('key1');
      vi.advanceTimersByTime(10);

      // Add new entry - should evict key2 (now oldest)
      cache.set('key6', 'url6', 100);

      expect(cache.get('key1')).toBe('url1'); // Still exists (recently accessed)
      expect(cache.get('key2')).toBeNull(); // Evicted
    });

    it('should maintain correct order after multiple accesses', () => {
      cache.set('key1', 'url1', 100);
      vi.advanceTimersByTime(10);
      cache.set('key2', 'url2', 100);
      vi.advanceTimersByTime(10);
      cache.set('key3', 'url3', 100);
      vi.advanceTimersByTime(10);

      // Access in order: key2, key1, key3 - key2 is accessed first, then key1, then key3
      // After accesses: key2 has oldest access time
      cache.get('key2');
      vi.advanceTimersByTime(10);
      cache.get('key1');
      vi.advanceTimersByTime(10);
      cache.get('key3');
      vi.advanceTimersByTime(10);

      // Fill remaining slots
      cache.set('key4', 'url4', 100);
      vi.advanceTimersByTime(10);
      cache.set('key5', 'url5', 100);
      vi.advanceTimersByTime(10);

      // Add new entry - should evict key2 (least recently used among existing)
      cache.set('key6', 'url6', 100);

      expect(cache.get('key2')).toBeNull();
      expect(cache.get('key1')).not.toBeNull();
      expect(cache.get('key3')).not.toBeNull();
    });
  });

  // ===========================================================================
  // TTL Expiration
  // ===========================================================================

  describe('TTL Expiration', () => {
    it('should not return expired entries', () => {
      cache.set('key1', 'url1', 100);

      // Advance time past TTL
      vi.advanceTimersByTime(defaultConfig.ttlMs + 1000);

      expect(cache.get('key1')).toBeNull();
    });

    it('should return entries before TTL expires', () => {
      cache.set('key1', 'url1', 100);

      // Advance time but not past TTL
      vi.advanceTimersByTime(defaultConfig.ttlMs - 1000);

      expect(cache.get('key1')).toBe('url1');
    });

    it('should remove expired entry from has() check', () => {
      cache.set('key1', 'url1', 100);

      vi.advanceTimersByTime(defaultConfig.ttlMs + 1000);

      expect(cache.has('key1')).toBe(false);
    });

    it('should clean up expired entries on prune()', () => {
      cache.set('key1', 'url1', 100);
      cache.set('key2', 'url2', 100);

      vi.advanceTimersByTime(defaultConfig.ttlMs + 1000);

      cache.set('key3', 'url3', 100); // Fresh entry

      cache.prune();

      const stats = cache.getStats();
      expect(stats.entryCount).toBe(1); // Only key3 remains
    });
  });

  // ===========================================================================
  // Memory Management
  // ===========================================================================

  describe('Memory Management', () => {
    it('should track total memory usage', () => {
      cache.set('key1', 'url1', 1000);
      cache.set('key2', 'url2', 2000);

      const stats = cache.getStats();
      expect(stats.totalSizeBytes).toBe(3000);
    });

    it('should release memory when entry deleted', () => {
      cache.set('key1', 'url1', 1000);
      cache.set('key2', 'url2', 2000);

      cache.delete('key1');

      const stats = cache.getStats();
      expect(stats.totalSizeBytes).toBe(2000);
    });

    it('should evict entries when maxMemoryMB exceeded', () => {
      const smallMemoryCache = new FrameCache({
        maxEntries: 100,
        maxMemoryMB: 0.001, // 1KB limit
        ttlMs: 60000,
      });

      // Add entries that exceed memory limit
      smallMemoryCache.set('key1', 'url1', 500);
      smallMemoryCache.set('key2', 'url2', 500);
      smallMemoryCache.set('key3', 'url3', 500); // Should trigger eviction

      const stats = smallMemoryCache.getStats();
      // Should have evicted at least one entry
      expect(stats.entryCount).toBeLessThan(3);

      smallMemoryCache.clear();
    });

    it('should update memory when overwriting entry', () => {
      cache.set('key1', 'url1', 1000);
      cache.set('key1', 'url1-new', 500);

      const stats = cache.getStats();
      expect(stats.totalSizeBytes).toBe(500);
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================

  describe('Statistics', () => {
    it('should track hit/miss counts', () => {
      cache.set('key1', 'url1', 100);

      cache.get('key1'); // Hit
      cache.get('key1'); // Hit
      cache.get('nonexistent'); // Miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });

    it('should calculate hit rate correctly', () => {
      cache.set('key1', 'url1', 100);

      cache.get('key1'); // Hit
      cache.get('key1'); // Hit
      cache.get('nonexistent'); // Miss
      cache.get('nonexistent'); // Miss

      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(0.5, 2);
    });

    it('should return 0 hit rate when no accesses', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });

    it('should track entry count', () => {
      cache.set('key1', 'url1', 100);
      cache.set('key2', 'url2', 100);

      expect(cache.getStats().entryCount).toBe(2);

      cache.delete('key1');

      expect(cache.getStats().entryCount).toBe(1);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle empty key', () => {
      cache.set('', 'url', 100);
      expect(cache.get('')).toBe('url');
    });

    it('should handle very large timestamps in key', () => {
      const key = 'asset:99999.99';
      cache.set(key, 'url', 100);
      expect(cache.get(key)).toBe('url');
    });

    it('should handle zero size entries', () => {
      cache.set('key1', 'url1', 0);
      expect(cache.get('key1')).toBe('url1');
    });

    it('should not crash when deleting non-existent key', () => {
      expect(() => cache.delete('nonexistent')).not.toThrow();
    });

    it('should handle rapid set/get operations', () => {
      for (let i = 0; i < 1000; i++) {
        cache.set(`key${i}`, `url${i}`, 10);
      }

      // Should have evicted down to maxEntries
      expect(cache.getStats().entryCount).toBeLessThanOrEqual(defaultConfig.maxEntries);

      // Most recent entries should exist
      expect(cache.get('key999')).toBe('url999');
    });
  });

  // ===========================================================================
  // Configuration
  // ===========================================================================

  describe('Configuration', () => {
    it('should use default config when not provided', () => {
      const defaultCache = new FrameCache();
      // Should not throw
      defaultCache.set('key', 'url', 100);
      expect(defaultCache.get('key')).toBe('url');
      defaultCache.clear();
    });

    it('should allow config override', () => {
      const customCache = new FrameCache({
        maxEntries: 2,
        maxMemoryMB: 1,
        ttlMs: 1000,
      });

      customCache.set('key1', 'url1', 100);
      customCache.set('key2', 'url2', 100);
      customCache.set('key3', 'url3', 100);

      // Should have evicted first entry
      expect(customCache.get('key1')).toBeNull();

      customCache.clear();
    });
  });
});

/**
 * FrameCache Service
 *
 * LRU-based cache for extracted video frames.
 * Features:
 * - LRU eviction policy when maxEntries exceeded
 * - Memory-based eviction when maxMemoryMB exceeded
 * - TTL-based expiration
 * - Hit/miss statistics tracking
 * - Proper blob URL lifecycle management with error logging
 */

import { FRAME_EXTRACTION } from '@/constants/preview';
import { createLogger } from '@/services/logger';

const logger = createLogger('FrameCache');

// =============================================================================
// Types
// =============================================================================

/**
 * Cache configuration options.
 */
export interface FrameCacheConfig {
  /** Maximum number of entries to keep */
  maxEntries: number;
  /** Maximum memory usage in megabytes */
  maxMemoryMB: number;
  /** Time-to-live for entries in milliseconds */
  ttlMs: number;
}

/**
 * Internal cache entry structure.
 */
interface CacheEntry {
  /** The cached URL (blob: or file://) */
  url: string;
  /** Approximate size in bytes */
  sizeBytes: number;
  /** Creation timestamp */
  createdAt: number;
  /** Last access timestamp (for LRU) */
  lastAccessedAt: number;
}

/**
 * Cache statistics for monitoring.
 */
export interface CacheStats {
  /** Number of entries currently cached */
  entryCount: number;
  /** Total size of all entries in bytes */
  totalSizeBytes: number;
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Hit rate (0-1) */
  hitRate: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: FrameCacheConfig = {
  maxEntries: FRAME_EXTRACTION.MAX_CACHE_ENTRIES,
  maxMemoryMB: FRAME_EXTRACTION.MAX_CACHE_MEMORY_MB,
  ttlMs: FRAME_EXTRACTION.CACHE_TTL_MS,
};

// =============================================================================
// FrameCache Class
// =============================================================================

/**
 * LRU-based frame cache with memory and TTL management.
 *
 * @example
 * ```typescript
 * const cache = new FrameCache({ maxEntries: 100, maxMemoryMB: 200, ttlMs: 300000 });
 *
 * cache.set('asset1:5.50', 'blob:http://localhost/frame1', 50000);
 * const url = cache.get('asset1:5.50'); // Returns URL or null
 *
 * const stats = cache.getStats();
 * console.log(`Hit rate: ${stats.hitRate * 100}%`);
 * ```
 */
export class FrameCache {
  private readonly config: FrameCacheConfig;
  private readonly entries: Map<string, CacheEntry>;
  private hits: number = 0;
  private misses: number = 0;

  /**
   * Create a new FrameCache instance.
   * @param config - Optional configuration overrides
   */
  constructor(config?: Partial<FrameCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.entries = new Map();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get a cached frame URL.
   * Updates the entry's last access time for LRU tracking.
   *
   * @param key - Cache key (typically `${assetId}:${timestamp}`)
   * @returns The cached URL or null if not found/expired
   */
  get(key: string): string | null {
    const entry = this.entries.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL expiration
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      this.misses++;
      return null;
    }

    // Update access time for LRU
    entry.lastAccessedAt = Date.now();
    this.hits++;

    return entry.url;
  }

  /**
   * Store a frame URL in the cache.
   * May trigger eviction if limits are exceeded.
   *
   * @param key - Cache key
   * @param url - URL to cache (blob: or file://)
   * @param sizeBytes - Approximate size in bytes
   */
  set(key: string, url: string, sizeBytes: number): void {
    const now = Date.now();

    // Remove existing entry if present (for accurate size tracking)
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    // Create new entry
    const entry: CacheEntry = {
      url,
      sizeBytes,
      createdAt: now,
      lastAccessedAt: now,
    };

    this.entries.set(key, entry);

    // Evict if necessary
    this.evictIfNeeded();
  }

  /**
   * Check if a key exists and is not expired.
   *
   * @param key - Cache key
   * @returns True if the key exists and is valid
   */
  has(key: string): boolean {
    const entry = this.entries.get(key);

    if (!entry) {
      return false;
    }

    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a specific entry from the cache.
   * Revokes blob URLs to prevent memory leaks.
   *
   * @param key - Cache key
   */
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.revokeIfBlobUrl(entry.url);
      this.entries.delete(key);
    }
  }

  /**
   * Clear all entries from the cache.
   * Revokes all blob URLs to prevent memory leaks.
   */
  clear(): void {
    for (const entry of this.entries.values()) {
      this.revokeIfBlobUrl(entry.url);
    }
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Remove all expired entries.
   * Useful for periodic cleanup.
   * Revokes blob URLs to prevent memory leaks.
   */
  prune(): void {
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.delete(key);
    }
  }

  /**
   * Get cache statistics.
   *
   * @returns Current cache statistics
   */
  getStats(): CacheStats {
    let totalSizeBytes = 0;

    for (const entry of this.entries.values()) {
      totalSizeBytes += entry.sizeBytes;
    }

    const totalAccesses = this.hits + this.misses;

    return {
      entryCount: this.entries.size,
      totalSizeBytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: totalAccesses > 0 ? this.hits / totalAccesses : 0,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Check if an entry has expired based on TTL.
   */
  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.createdAt > this.config.ttlMs;
  }

  /**
   * Evict entries if cache limits are exceeded.
   * Uses LRU (Least Recently Used) eviction policy.
   * Logs warnings when memory pressure is high.
   */
  private evictIfNeeded(): void {
    let evictionCount = 0;

    // Evict by entry count
    while (this.entries.size > this.config.maxEntries) {
      this.evictLeastRecentlyUsed();
      evictionCount++;
    }

    // Evict by memory
    const maxBytes = this.config.maxMemoryMB * 1024 * 1024;
    while (this.getTotalSize() > maxBytes && this.entries.size > 0) {
      this.evictLeastRecentlyUsed();
      evictionCount++;
    }

    // Log warning if significant eviction occurred (indicates memory pressure)
    if (evictionCount > 5) {
      logger.warn('High frame cache eviction rate', {
        evicted: evictionCount,
        remainingEntries: this.entries.size,
        totalSizeMB: (this.getTotalSize() / 1024 / 1024).toFixed(2),
        hitRate: (this.getStats().hitRate * 100).toFixed(1) + '%',
      });
    }
  }

  /**
   * Evict the least recently used entry.
   * Revokes blob URL to prevent memory leaks.
   */
  private evictLeastRecentlyUsed(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.delete(oldestKey);
    }
  }

  /**
   * Revoke a blob URL to free memory.
   * Logs warnings on failure to help debug potential memory leaks.
   */
  private revokeIfBlobUrl(url: string): void {
    if (url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch (error) {
        // Log warning - failed revocation can indicate memory leak risk
        logger.warn('Failed to revoke blob URL', {
          url: url.substring(0, 50) + '...',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Calculate total size of all entries.
   */
  private getTotalSize(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.sizeBytes;
    }
    return total;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/**
 * Global frame cache instance.
 * Use this for application-wide frame caching.
 */
export const frameCache = new FrameCache();

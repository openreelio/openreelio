/**
 * useFrameExtractor Hook
 *
 * Provides functionality to extract video frames using FFmpeg.
 * Features:
 * - LRU caching via FrameCache service
 * - Prefetching for smooth scrubbing
 * - Concurrency limiting to prevent IPC overload
 * - Debouncing for rapid requests
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { extractFrame, probeMedia } from '@/utils/ffmpeg';
import { frameCache, type CacheStats } from '@/services/frameCache';
import { buildFrameOutputPath } from '@/services/framePaths';
import { FRAME_EXTRACTION, createFrameCacheKey } from '@/constants/preview';
import type { MediaInfo } from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('FrameExtractor');

// =============================================================================
// Types
// =============================================================================

export interface UseFrameExtractorOptions {
  /** Maximum number of frames to cache (default: 100) */
  maxCacheSize?: number;
  /** Directory path for storing extracted frames */
  cacheDir?: string;
  /** Whether to use the shared FrameCache (default: true for new API) */
  useSharedCache?: boolean;
}

export interface UseFrameExtractorReturn {
  /** Extract a frame at a specific time */
  getFrame: (inputPath: string, timeSec: number) => Promise<string | null>;
  /** Probe media file for information */
  getMediaInfo: (inputPath: string) => Promise<MediaInfo | null>;
  /** Clear the frame cache */
  clearCache: () => void;
  /** Whether an extraction is in progress */
  isExtracting: boolean;
  /** Last error that occurred */
  error: string | null;
  /** Number of cached frames */
  cacheSize: number;
}

/**
 * Extended options for asset-based frame extraction.
 */
export interface UseAssetFrameExtractorOptions {
  /** Asset ID for cache key generation */
  assetId: string;
  /** Path to the asset file */
  assetPath: string;
  /** Optional proxy path (used instead of assetPath if provided) */
  proxyPath?: string;
  /** Whether extraction is enabled */
  enabled?: boolean;
  /** Seconds to prefetch ahead of current time */
  prefetchAhead?: number;
  /** Interval between prefetched frames */
  prefetchInterval?: number;
}

export interface UseAssetFrameExtractorReturn {
  /** Extract a frame at a specific timestamp */
  extractFrame: (timestamp: number) => Promise<string | null>;
  /** Prefetch frames in a time range */
  prefetchFrames: (startTime: number, endTime: number) => void;
  /** Whether extraction is in progress */
  isLoading: boolean;
  /** Last error */
  error: Error | null;
  /** Cache statistics */
  cacheStats: CacheStats;
}

interface FrameCacheEntry {
  path: string;
  timestamp: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_CACHE_SIZE = 100;
// Resolved per-runtime in `buildFrameOutputPath()`.
const DEFAULT_CACHE_DIR = '';
const MAX_CONCURRENT_EXTRACTIONS = FRAME_EXTRACTION.MAX_CONCURRENT_EXTRACTIONS;
const DEBOUNCE_MS = FRAME_EXTRACTION.DEBOUNCE_MS;

// =============================================================================
// Hook
// =============================================================================

export function useFrameExtractor(options: UseFrameExtractorOptions = {}): UseFrameExtractorReturn {
  const { maxCacheSize = DEFAULT_MAX_CACHE_SIZE, cacheDir = DEFAULT_CACHE_DIR } = options;

  const [error, setError] = useState<string | null>(null);
  const [cacheSize, setCacheSize] = useState(0);

  // Local frame cache: key = "inputPath:timeSec" -> value = extracted frame path
  // Note: This is separate from the shared FrameCache service
  const localFrameCache = useRef<Map<string, FrameCacheEntry>>(new Map());

  // Media info cache: key = inputPath -> value = MediaInfo
  const mediaInfoCache = useRef<Map<string, MediaInfo>>(new Map());

  // Pending extractions to avoid duplicate requests
  const pendingExtractions = useRef<Map<string, Promise<string | null>>>(new Map());

  // Track active extraction count for accurate isExtracting state
  const activeExtractionCount = useRef(0);
  const [isExtracting, setIsExtracting] = useState(false);

  /**
   * Generate a cache key for a frame
   */
  const getCacheKey = useCallback((inputPath: string, timeSec: number): string => {
    // Round to nearest millisecond to avoid floating point issues
    const roundedTime = Math.round(timeSec * 1000) / 1000;
    return `${inputPath}:${roundedTime}`;
  }, []);

  /**
   * Generate output path for extracted frame
   */
  const getOutputPath = useCallback(
    async (inputPath: string, timeSec: number): Promise<string> => {
      const safeInputName = inputPath.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const timeMs = Math.floor(timeSec * 1000);

      // Explicit override (primarily for tests / power-users).
      if (cacheDir && cacheDir.trim().length > 0) {
        return `${cacheDir}/${safeInputName}_${timeMs}.png`;
      }

      return buildFrameOutputPath(safeInputName, timeMs, 'png');
    },
    [cacheDir],
  );

  /**
   * Evict oldest entries if cache is full
   */
  const evictOldestEntries = useCallback(() => {
    const cache = localFrameCache.current;
    if (cache.size <= maxCacheSize) return;

    // Sort entries by timestamp and remove oldest
    const entries = Array.from(cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove = entries.slice(0, cache.size - maxCacheSize);
    for (const [key] of toRemove) {
      cache.delete(key);
    }
  }, [maxCacheSize]);

  /**
   * Extract a frame from a video at a specific time
   */
  const getFrame = useCallback(
    async (inputPath: string, timeSec: number): Promise<string | null> => {
      const cacheKey = getCacheKey(inputPath, timeSec);

      // Check cache first
      const cached = localFrameCache.current.get(cacheKey);
      if (cached) {
        // Update access timestamp
        cached.timestamp = Date.now();
        return cached.path;
      }

      // Check if extraction is already pending
      const pending = pendingExtractions.current.get(cacheKey);
      if (pending) {
        return pending;
      }

      // Start new extraction
      const extractionPromise = (async () => {
        activeExtractionCount.current += 1;
        setIsExtracting(true);
        setError(null);

        try {
          const outputPath = await getOutputPath(inputPath, timeSec);

          await extractFrame({
            inputPath,
            timeSec,
            outputPath,
          });

          // Add to cache
          localFrameCache.current.set(cacheKey, {
            path: outputPath,
            timestamp: Date.now(),
          });

          // Evict old entries if needed
          evictOldestEntries();

          // Update cache size state
          setCacheSize(localFrameCache.current.size);

          return outputPath;
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Frame extraction failed';
          setError(errorMessage);
          logger.error('Frame extraction error', { error: err });
          return null;
        } finally {
          activeExtractionCount.current -= 1;
          pendingExtractions.current.delete(cacheKey);
          // Only set isExtracting to false when all extractions are complete
          if (activeExtractionCount.current === 0) {
            setIsExtracting(false);
          }
        }
      })();

      pendingExtractions.current.set(cacheKey, extractionPromise);
      return extractionPromise;
    },
    [getCacheKey, getOutputPath, evictOldestEntries],
  );

  /**
   * Get media information for a file
   */
  const getMediaInfo = useCallback(async (inputPath: string): Promise<MediaInfo | null> => {
    // Check cache first
    const cached = mediaInfoCache.current.get(inputPath);
    if (cached) {
      return cached;
    }

    try {
      const info = await probeMedia(inputPath);
      mediaInfoCache.current.set(inputPath, info);
      return info;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Media probe failed';
      setError(errorMessage);
      logger.error('Media probe error', { error: err });
      return null;
    }
  }, []);

  /**
   * Clear all cached frames
   */
  const clearCache = useCallback(() => {
    localFrameCache.current.clear();
    mediaInfoCache.current.clear();
    pendingExtractions.current.clear();
    setCacheSize(0);
    setError(null);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    const pending = pendingExtractions.current;

    return () => {
      pending.clear();
    };
  }, []);

  return {
    getFrame,
    getMediaInfo,
    clearCache,
    isExtracting,
    error,
    cacheSize,
  };
}

// =============================================================================
// useAssetFrameExtractor - New API with shared cache and prefetching
// =============================================================================

/**
 * Semaphore for limiting concurrent extractions
 *
 * Features:
 * - Bounded waiting queue to prevent memory leaks
 * - Timeout support for acquire operations
 * - Cancellation via AbortSignal
 * - Thread-safe permit tracking
 */
class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private waiting: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
  }> = [];

  /** Maximum number of waiting requests to prevent unbounded memory growth */
  private static readonly MAX_WAITING_QUEUE = 1000;

  /** Default timeout for acquire operations (30 seconds) */
  private static readonly DEFAULT_TIMEOUT_MS = 30000;

  constructor(permits: number) {
    this.permits = permits;
    this.maxPermits = permits;
  }

  /**
   * Acquire a permit, optionally with timeout and abort signal.
   *
   * @param options - Optional timeout and abort signal
   * @returns Promise that resolves when permit is acquired
   * @throws Error if timeout, aborted, or queue is full
   */
  async acquire(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const { timeoutMs = Semaphore.DEFAULT_TIMEOUT_MS, signal } = options || {};

    // Check if already aborted
    if (signal?.aborted) {
      throw new Error('Semaphore acquire aborted');
    }

    // Fast path: permit available
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    // Check queue size limit to prevent memory leak
    if (this.waiting.length >= Semaphore.MAX_WAITING_QUEUE) {
      throw new Error('Semaphore queue full - too many pending requests');
    }

    return new Promise<void>((resolve, reject) => {
      const entry: {
        resolve: () => void;
        reject: (error: Error) => void;
        timeoutId?: ReturnType<typeof setTimeout>;
      } = { resolve, reject };

      // Set up timeout
      if (timeoutMs > 0) {
        entry.timeoutId = setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            reject(new Error(`Semaphore acquire timeout after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }

      // Set up abort signal listener
      const abortHandler = () => {
        const index = this.waiting.indexOf(entry);
        if (index !== -1) {
          this.waiting.splice(index, 1);
          if (entry.timeoutId) {
            clearTimeout(entry.timeoutId);
          }
          reject(new Error('Semaphore acquire aborted'));
        }
      };

      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      // Add to waiting queue
      this.waiting.push(entry);
    });
  }

  /**
   * Release a permit back to the semaphore.
   * Safe to call multiple times (will not exceed maxPermits).
   */
  release(): void {
    const next = this.waiting.shift();
    if (next) {
      // Clear timeout if set
      if (next.timeoutId) {
        clearTimeout(next.timeoutId);
      }
      // Give permit to next waiter
      next.resolve();
    } else if (this.permits < this.maxPermits) {
      // Only increment if below max to prevent over-release
      this.permits++;
    }
  }

  /**
   * Get current number of available permits.
   */
  get availablePermits(): number {
    return this.permits;
  }

  /**
   * Get number of waiting requests.
   */
  get queueLength(): number {
    return this.waiting.length;
  }

  /**
   * Clear all waiting requests with an error.
   * Useful for cleanup/shutdown scenarios.
   */
  clearWaiting(): void {
    const error = new Error('Semaphore cleared');
    while (this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
      entry.reject(error);
    }
  }
}

// Global semaphore for concurrent extraction limit
const extractionSemaphore = new Semaphore(MAX_CONCURRENT_EXTRACTIONS);

/**
 * Asset-based frame extractor with shared cache and prefetching.
 *
 * This is the recommended hook for Timeline preview rendering.
 * Uses the global FrameCache service for efficient memory management.
 *
 * @example
 * ```typescript
 * const { extractFrame, prefetchFrames, isLoading, error } = useAssetFrameExtractor({
 *   assetId: clip.assetId,
 *   assetPath: asset.path,
 *   enabled: true,
 * });
 *
 * // Extract single frame
 * const frameUrl = await extractFrame(currentTime);
 *
 * // Prefetch ahead for smooth scrubbing
 * prefetchFrames(currentTime, currentTime + 2);
 * ```
 */
export function useAssetFrameExtractor(
  options: UseAssetFrameExtractorOptions,
): UseAssetFrameExtractorReturn {
  const {
    assetId,
    assetPath,
    proxyPath,
    enabled = true,
    prefetchAhead = FRAME_EXTRACTION.PREFETCH_AHEAD_SEC,
    prefetchInterval = FRAME_EXTRACTION.PREFETCH_INTERVAL_SEC,
  } = options;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Active extraction count for loading state
  const activeCount = useRef(0);

  // Pending extractions to deduplicate requests
  const pendingExtractions = useRef<Map<string, Promise<string | null>>>(new Map());

  // Abort controller for prefetch cancellation
  const prefetchAbortRef = useRef<AbortController | null>(null);

  // Debounce timer
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Last requested timestamp for debouncing
  const lastRequestedTimestampRef = useRef<number | null>(null);

  // Pending resolve function to avoid hanging promises
  const pendingResolveRef = useRef<((value: string | null) => void) | null>(null);

  // Actual input path (proxy if available, otherwise original)
  const inputPath = proxyPath || assetPath;

  /**
   * Generate output path for extracted frame
   */
  const getOutputPath = useCallback(
    (timestamp: number): Promise<string> => {
      const safeAssetId = assetId.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
      const timeMs = Math.floor(timestamp * 1000);
      // Use the same per-user cache dir as the legacy extractor.
      return buildFrameOutputPath(safeAssetId, timeMs, FRAME_EXTRACTION.OUTPUT_FORMAT);
    },
    [assetId],
  );

  // Track if component is mounted (will be set in useEffect)
  const isMountedRef = useRef(true);

  // AbortController for cancelling in-flight extractions on unmount
  const extractionAbortRef = useRef<AbortController | null>(null);

  /**
   * Extract a frame at the given timestamp
   *
   * Features:
   * - Deduplicates concurrent requests for the same frame
   * - Uses semaphore to limit concurrent FFmpeg processes
   * - Safely handles component unmount during extraction
   * - Proper error handling and logging
   */
  const extractFrameAtTime = useCallback(
    async (timestamp: number): Promise<string | null> => {
      if (!enabled) {
        return null;
      }

      const cacheKey = createFrameCacheKey(assetId, timestamp);

      // Check shared cache first
      const cached = frameCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // Check if extraction is already pending
      const pending = pendingExtractions.current.get(cacheKey);
      if (pending) {
        return pending;
      }

      // Create abort controller for this extraction
      const abortController = new AbortController();
      extractionAbortRef.current = abortController;

      // Create extraction promise
      const extractionPromise = (async (): Promise<string | null> => {
        let semaphoreAcquired = false;

        try {
          // Acquire semaphore permit with timeout and abort signal
          await extractionSemaphore.acquire({
            timeoutMs: 30000,
            signal: abortController.signal,
          });
          semaphoreAcquired = true;

          // Check if still mounted after acquiring semaphore
          if (!isMountedRef.current || abortController.signal.aborted) {
            return null;
          }

          activeCount.current++;
          if (isMountedRef.current) {
            setIsLoading(true);
            setError(null);
          }

          const outputPath = await getOutputPath(timestamp);

          // Check again before expensive operation
          if (!isMountedRef.current || abortController.signal.aborted) {
            return null;
          }

          await extractFrame({
            inputPath,
            timeSec: timestamp,
            outputPath,
          });

          // Convert to asset URL for frontend
          const frameUrl = convertFileSrc(outputPath);

          // Store in shared cache (estimate 100KB per frame)
          frameCache.set(cacheKey, frameUrl, 100 * 1024);

          logger.debug('Frame extracted successfully', { assetId, timestamp, outputPath });

          return frameUrl;
        } catch (err) {
          // Don't log abort errors as they're expected during cleanup
          if (err instanceof Error && err.message.includes('aborted')) {
            return null;
          }

          const extractionError = err instanceof Error ? err : new Error('Frame extraction failed');

          // Only update error state if still mounted
          if (isMountedRef.current) {
            setError(extractionError);
          }

          logger.error('Frame extraction error', {
            assetId,
            timestamp,
            error: err instanceof Error ? err.message : String(err),
          });

          return null;
        } finally {
          // Always release semaphore if acquired
          if (semaphoreAcquired) {
            extractionSemaphore.release();
          }

          activeCount.current = Math.max(0, activeCount.current - 1);
          pendingExtractions.current.delete(cacheKey);

          // Only update loading state if still mounted
          if (isMountedRef.current && activeCount.current === 0) {
            setIsLoading(false);
          }
        }
      })();

      pendingExtractions.current.set(cacheKey, extractionPromise);
      return extractionPromise;
    },
    [enabled, assetId, inputPath, getOutputPath],
  );

  /**
   * Debounced frame extraction with improved race condition handling.
   *
   * Design notes:
   * - Cache hits bypass debounce entirely for instant response
   * - Superseded requests are resolved with null immediately (not hanging)
   * - Uses a unique request ID to handle timestamp precision issues
   * - Properly cleans up on component unmount
   */
  const requestIdRef = useRef(0);

  const debouncedExtractFrame = useCallback(
    async (timestamp: number): Promise<string | null> => {
      // Generate unique request ID to handle floating-point precision issues
      const requestId = ++requestIdRef.current;
      lastRequestedTimestampRef.current = timestamp;

      // Check cache immediately (no debounce for cache hits)
      const cacheKey = createFrameCacheKey(assetId, timestamp);
      const cached = frameCache.get(cacheKey);
      if (cached) {
        logger.debug('Frame cache hit', { assetId, timestamp, cacheKey });
        return cached;
      }

      // Clear existing debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      // Resolve any pending promise with null to avoid hanging
      if (pendingResolveRef.current) {
        pendingResolveRef.current(null);
        pendingResolveRef.current = null;
      }

      // Return promise that resolves after debounce
      return new Promise((resolve) => {
        pendingResolveRef.current = resolve;

        debounceTimerRef.current = setTimeout(async () => {
          // Check if this request is still the latest (using request ID, not timestamp)
          if (requestIdRef.current !== requestId) {
            // Request was superseded; do not resolve (already resolved by next request)
            return;
          }

          try {
            const result = await extractFrameAtTime(timestamp);
            // Double-check we're still the latest request before resolving
            if (requestIdRef.current === requestId && pendingResolveRef.current === resolve) {
              resolve(result);
              pendingResolveRef.current = null;
            }
          } catch (error) {
            // Log but don't throw - just resolve with null
            logger.error('Debounced extraction failed', { assetId, timestamp, error });
            if (requestIdRef.current === requestId && pendingResolveRef.current === resolve) {
              resolve(null);
              pendingResolveRef.current = null;
            }
          }
        }, DEBOUNCE_MS);
      });
    },
    [assetId, extractFrameAtTime],
  );

  /**
   * Prefetch frames in a time range
   */
  const prefetchFrames = useCallback(
    (startTime: number, endTime: number): void => {
      if (!enabled) {
        return;
      }

      // Clamp prefetch range to avoid excessive background work.
      // This also ensures the prefetchAhead option is always respected.
      const effectiveEnd = Math.min(endTime, startTime + prefetchAhead);

      // Cancel any existing prefetch
      if (prefetchAbortRef.current) {
        prefetchAbortRef.current.abort();
      }

      const abortController = new AbortController();
      prefetchAbortRef.current = abortController;

      // Start prefetching in background
      (async () => {
        for (let t = startTime; t <= effectiveEnd; t += prefetchInterval) {
          if (abortController.signal.aborted) {
            break;
          }

          const cacheKey = createFrameCacheKey(assetId, t);

          // Skip if already cached
          if (frameCache.has(cacheKey)) {
            continue;
          }

          // Extract frame (don't await - fire and forget for prefetching)
          extractFrameAtTime(t).catch((err) => {
            // Ignore prefetch errors
            logger.debug('Prefetch error (ignored)', { timestamp: t, error: err });
          });

          // Small delay between prefetch requests to avoid overwhelming FFmpeg
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();
    },
    [enabled, assetId, prefetchAhead, prefetchInterval, extractFrameAtTime],
  );

  /**
   * Get cache statistics
   */
  const getCacheStats = useCallback((): CacheStats => {
    return frameCache.getStats();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    // Capture ref value at effect creation time for safe cleanup access
    const pending = pendingExtractions.current;

    return () => {
      isMountedRef.current = false;

      // Abort any in-flight extractions
      if (extractionAbortRef.current) {
        extractionAbortRef.current.abort();
        extractionAbortRef.current = null;
      }

      // Clear pending extractions
      pending.clear();

      // Abort any in-flight prefetch
      if (prefetchAbortRef.current) {
        prefetchAbortRef.current.abort();
        prefetchAbortRef.current = null;
      }

      // Clear debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      // Resolve any pending debounce promise to prevent hanging
      if (pendingResolveRef.current) {
        pendingResolveRef.current(null);
        pendingResolveRef.current = null;
      }

      logger.debug('useAssetFrameExtractor cleanup completed', { assetId });
    };
  }, [assetId]);

  return {
    extractFrame: debouncedExtractFrame,
    prefetchFrames,
    isLoading,
    error,
    cacheStats: getCacheStats(),
  };
}

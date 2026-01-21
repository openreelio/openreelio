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
const DEFAULT_CACHE_DIR = '.openreelio/frames';
const MAX_CONCURRENT_EXTRACTIONS = FRAME_EXTRACTION.MAX_CONCURRENT_EXTRACTIONS;
const DEBOUNCE_MS = FRAME_EXTRACTION.DEBOUNCE_MS;

// =============================================================================
// Hook
// =============================================================================

export function useFrameExtractor(
  options: UseFrameExtractorOptions = {}
): UseFrameExtractorReturn {
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
    (inputPath: string, timeSec: number): string => {
      // Create a unique filename based on input path and time
      const safeInputName = inputPath
        .replace(/[^a-zA-Z0-9]/g, '_')
        .substring(0, 50);
      const timeMs = Math.floor(timeSec * 1000);
      return `${cacheDir}/${safeInputName}_${timeMs}.png`;
    },
    [cacheDir]
  );

  /**
   * Evict oldest entries if cache is full
   */
  const evictOldestEntries = useCallback(() => {
    const cache = localFrameCache.current;
    if (cache.size <= maxCacheSize) return;

    // Sort entries by timestamp and remove oldest
    const entries = Array.from(cache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );

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
          const outputPath = getOutputPath(inputPath, timeSec);

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
    [getCacheKey, getOutputPath, evictOldestEntries]
  );

  /**
   * Get media information for a file
   */
  const getMediaInfo = useCallback(
    async (inputPath: string): Promise<MediaInfo | null> => {
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
    },
    []
  );

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
 */
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
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
  options: UseAssetFrameExtractorOptions
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

  // Actual input path (proxy if available, otherwise original)
  const inputPath = proxyPath || assetPath;

  /**
   * Generate output path for extracted frame
   */
  const getOutputPath = useCallback(
    (timestamp: number): string => {
      const safeAssetId = assetId.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
      const timeMs = Math.floor(timestamp * 1000);
      return `.openreelio/frames/${safeAssetId}_${timeMs}.${FRAME_EXTRACTION.OUTPUT_FORMAT}`;
    },
    [assetId]
  );

  /**
   * Extract a frame at the given timestamp
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

      // Create extraction promise
      const extractionPromise = (async (): Promise<string | null> => {
        // Acquire semaphore permit
        await extractionSemaphore.acquire();

        activeCount.current++;
        setIsLoading(true);
        setError(null);

        try {
          const outputPath = getOutputPath(timestamp);

          await extractFrame({
            inputPath,
            timeSec: timestamp,
            outputPath,
          });

          // Convert to asset URL for frontend
          const frameUrl = convertFileSrc(outputPath);

          // Store in shared cache (estimate 100KB per frame)
          frameCache.set(cacheKey, frameUrl, 100 * 1024);

          return frameUrl;
        } catch (err) {
          const extractionError = err instanceof Error ? err : new Error('Frame extraction failed');
          setError(extractionError);
          logger.error('Frame extraction error', { assetId, timestamp, error: err });
          return null;
        } finally {
          extractionSemaphore.release();
          activeCount.current--;
          pendingExtractions.current.delete(cacheKey);

          if (activeCount.current === 0) {
            setIsLoading(false);
          }
        }
      })();

      pendingExtractions.current.set(cacheKey, extractionPromise);
      return extractionPromise;
    },
    [enabled, assetId, inputPath, getOutputPath]
  );

  /**
   * Debounced frame extraction
   */
  const debouncedExtractFrame = useCallback(
    async (timestamp: number): Promise<string | null> => {
      lastRequestedTimestampRef.current = timestamp;

      // Check cache immediately (no debounce for cache hits)
      const cacheKey = createFrameCacheKey(assetId, timestamp);
      const cached = frameCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // Clear existing debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Return promise that resolves after debounce
      return new Promise((resolve) => {
        debounceTimerRef.current = setTimeout(async () => {
          // Only extract if this is still the latest request
          if (lastRequestedTimestampRef.current === timestamp) {
            const result = await extractFrameAtTime(timestamp);
            resolve(result);
          } else {
            // Request was superseded, extract the latest instead
            const latestResult = await extractFrameAtTime(lastRequestedTimestampRef.current!);
            resolve(latestResult);
          }
        }, DEBOUNCE_MS);
      });
    },
    [assetId, extractFrameAtTime]
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
    [enabled, assetId, prefetchAhead, prefetchInterval, extractFrameAtTime]
  );

  /**
   * Get cache statistics
   */
  const getCacheStats = useCallback((): CacheStats => {
    return frameCache.getStats();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    const pending = pendingExtractions.current;
    const abort = prefetchAbortRef.current;
    const timer = debounceTimerRef.current;

    return () => {
      pending.clear();
      if (abort) {
        abort.abort();
      }
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return {
    extractFrame: debouncedExtractFrame,
    prefetchFrames,
    isLoading,
    error,
    cacheStats: getCacheStats(),
  };
}

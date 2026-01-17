/**
 * useFrameExtractor Hook
 *
 * Provides functionality to extract video frames using FFmpeg.
 * Supports caching to avoid re-extracting the same frames.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { extractFrame, probeMedia } from '@/utils/ffmpeg';
import type { MediaInfo } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface UseFrameExtractorOptions {
  /** Maximum number of frames to cache (default: 100) */
  maxCacheSize?: number;
  /** Directory path for storing extracted frames */
  cacheDir?: string;
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

interface FrameCacheEntry {
  path: string;
  timestamp: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_CACHE_SIZE = 100;
const DEFAULT_CACHE_DIR = '.openreelio/frames';

// =============================================================================
// Hook
// =============================================================================

export function useFrameExtractor(
  options: UseFrameExtractorOptions = {}
): UseFrameExtractorReturn {
  const { maxCacheSize = DEFAULT_MAX_CACHE_SIZE, cacheDir = DEFAULT_CACHE_DIR } = options;

  const [error, setError] = useState<string | null>(null);
  const [cacheSize, setCacheSize] = useState(0);

  // Frame cache: key = "inputPath:timeSec" -> value = extracted frame path
  const frameCache = useRef<Map<string, FrameCacheEntry>>(new Map());

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
    const cache = frameCache.current;
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
      const cached = frameCache.current.get(cacheKey);
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
          frameCache.current.set(cacheKey, {
            path: outputPath,
            timestamp: Date.now(),
          });

          // Evict old entries if needed
          evictOldestEntries();

          // Update cache size state
          setCacheSize(frameCache.current.size);

          return outputPath;
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Frame extraction failed';
          setError(errorMessage);
          console.error('Frame extraction error:', err);
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
        console.error('Media probe error:', err);
        return null;
      }
    },
    []
  );

  /**
   * Clear all cached frames
   */
  const clearCache = useCallback(() => {
    frameCache.current.clear();
    mediaInfoCache.current.clear();
    pendingExtractions.current.clear();
    setCacheSize(0);
    setError(null);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      pendingExtractions.current.clear();
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

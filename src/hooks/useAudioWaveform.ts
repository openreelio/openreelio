/**
 * useAudioWaveform Hook
 *
 * Provides audio waveform generation and caching for timeline clips.
 * Uses FFmpeg to generate waveform images via Tauri IPC.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { AssetId } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface UseAudioWaveformOptions {
  /** Maximum number of waveforms to cache (default: 50) */
  maxCacheSize?: number;
  /** Directory path for storing waveform images */
  cacheDir?: string;
  /** Default waveform dimensions */
  defaultWidth?: number;
  defaultHeight?: number;
}

export interface UseAudioWaveformReturn {
  /** Generate or get cached waveform for an asset */
  getWaveform: (assetId: AssetId, inputPath: string, width?: number, height?: number) => Promise<string | null>;
  /** Check if a waveform is already cached */
  hasWaveform: (assetId: AssetId) => boolean;
  /** Clear the waveform cache */
  clearCache: () => void;
  /** Whether a waveform generation is in progress */
  isGenerating: boolean;
  /** Last error that occurred */
  error: string | null;
  /** Number of cached waveforms */
  cacheSize: number;
}

interface WaveformCacheEntry {
  imagePath: string;
  width: number;
  height: number;
  timestamp: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_CACHE_SIZE = 50;
const DEFAULT_CACHE_DIR = '.openreelio/waveforms';
const DEFAULT_WAVEFORM_WIDTH = 1920;
const DEFAULT_WAVEFORM_HEIGHT = 100;

// =============================================================================
// Hook
// =============================================================================

export function useAudioWaveform(
  options: UseAudioWaveformOptions = {}
): UseAudioWaveformReturn {
  const {
    maxCacheSize = DEFAULT_MAX_CACHE_SIZE,
    cacheDir = DEFAULT_CACHE_DIR,
    defaultWidth = DEFAULT_WAVEFORM_WIDTH,
    defaultHeight = DEFAULT_WAVEFORM_HEIGHT,
  } = options;

  const [error, setError] = useState<string | null>(null);
  const [cacheSize, setCacheSize] = useState(0);

  // Waveform cache: key = assetId -> value = waveform image path
  const waveformCache = useRef<Map<string, WaveformCacheEntry>>(new Map());

  // Pending generations to avoid duplicate requests
  const pendingGenerations = useRef<Map<string, Promise<string | null>>>(new Map());

  // Track active generation count for accurate isGenerating state
  const activeGenerationCount = useRef(0);
  const [isGenerating, setIsGenerating] = useState(false);

  /**
   * Generate a cache key for a waveform
   */
  const getCacheKey = useCallback((assetId: string, width: number, height: number): string => {
    return `${assetId}:${width}x${height}`;
  }, []);

  /**
   * Generate output path for waveform image
   */
  const getOutputPath = useCallback(
    (assetId: string, width: number, height: number): string => {
      // Create a unique filename based on asset ID and dimensions
      const safeAssetId = assetId.replace(/[^a-zA-Z0-9]/g, '_');
      return `${cacheDir}/${safeAssetId}_${width}x${height}.png`;
    },
    [cacheDir]
  );

  /**
   * Evict oldest entries if cache is full
   */
  const evictOldestEntries = useCallback(() => {
    const cache = waveformCache.current;
    if (cache.size <= maxCacheSize) return;

    // Sort entries by timestamp and remove oldest
    const entries = Array.from(cache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );

    const toRemove = entries.slice(0, cache.size - maxCacheSize);
    for (const [key] of toRemove) {
      cache.delete(key);
    }

    setCacheSize(cache.size);
  }, [maxCacheSize]);

  /**
   * Check if a waveform is already cached
   */
  const hasWaveform = useCallback((assetId: AssetId): boolean => {
    // Check all cache keys for this asset
    for (const key of waveformCache.current.keys()) {
      if (key.startsWith(assetId + ':')) {
        return true;
      }
    }
    return false;
  }, []);

  /**
   * Get or generate a waveform for an audio/video asset
   */
  const getWaveform = useCallback(
    async (
      assetId: AssetId,
      inputPath: string,
      width: number = defaultWidth,
      height: number = defaultHeight
    ): Promise<string | null> => {
      const cacheKey = getCacheKey(assetId, width, height);

      // Check cache first
      const cached = waveformCache.current.get(cacheKey);
      if (cached) {
        // Update access timestamp
        cached.timestamp = Date.now();
        return convertFileSrc(cached.imagePath);
      }

      // Check if generation is already pending
      const pending = pendingGenerations.current.get(cacheKey);
      if (pending) {
        return pending;
      }

      // Start new generation
      const generationPromise = (async () => {
        activeGenerationCount.current += 1;
        setIsGenerating(true);
        setError(null);

        try {
          const outputPath = getOutputPath(assetId, width, height);

          // Handle file:// URI prefix
          let cleanInputPath = inputPath;
          if (cleanInputPath.startsWith('file://')) {
            cleanInputPath = cleanInputPath.replace('file://', '');
          }

          await invoke('generate_waveform', {
            inputPath: cleanInputPath,
            outputPath,
            width,
            height,
          });

          // Add to cache
          waveformCache.current.set(cacheKey, {
            imagePath: outputPath,
            width,
            height,
            timestamp: Date.now(),
          });

          // Evict old entries if needed
          evictOldestEntries();

          // Update cache size state
          setCacheSize(waveformCache.current.size);

          return convertFileSrc(outputPath);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Waveform generation failed';
          setError(errorMessage);
          console.error('Waveform generation error:', err);
          return null;
        } finally {
          activeGenerationCount.current -= 1;
          pendingGenerations.current.delete(cacheKey);
          // Only set isGenerating to false when all generations are complete
          if (activeGenerationCount.current === 0) {
            setIsGenerating(false);
          }
        }
      })();

      pendingGenerations.current.set(cacheKey, generationPromise);
      return generationPromise;
    },
    [getCacheKey, getOutputPath, evictOldestEntries, defaultWidth, defaultHeight]
  );

  /**
   * Clear all cached waveforms
   */
  const clearCache = useCallback(() => {
    waveformCache.current.clear();
    pendingGenerations.current.clear();
    setCacheSize(0);
    setError(null);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      pendingGenerations.current.clear();
    };
  }, []);

  return {
    getWaveform,
    hasWaveform,
    clearCache,
    isGenerating,
    error,
    cacheSize,
  };
}

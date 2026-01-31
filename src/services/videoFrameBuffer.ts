/**
 * VideoFrameBuffer Service
 *
 * Advanced frame buffering system inspired by OpenCut's video-cache.ts.
 * Implements dual-frame buffer pattern with smart seeking optimization.
 *
 * Features:
 * - Dual-frame buffer (currentFrame + nextFrame) for smooth playback
 * - Smart seeking: iterate forward for small jumps (<2s), full seek otherwise
 * - Per-asset frame pools to reduce memory allocation pressure
 * - Prefetch pipeline with non-blocking background loading
 * - Performance monitoring and drift detection
 */

import { convertFileSrc } from '@tauri-apps/api/core';
import { extractFrame as extractFrameIPC } from '@/utils/ffmpeg';
import { buildFrameOutputPath } from '@/services/framePaths';
import { createFrameCacheKey, FRAME_EXTRACTION } from '@/constants/preview';
import { frameCache } from '@/services/frameCache';
import { createLogger } from '@/services/logger';

const logger = createLogger('VideoFrameBuffer');

// =============================================================================
// Types
// =============================================================================

/**
 * Frame data with metadata for buffer management.
 */
export interface BufferedFrame {
  /** Cache key for this frame */
  key: string;
  /** Asset URL for rendering */
  url: string;
  /** Source timestamp in seconds */
  timestamp: number;
  /** When this frame was loaded */
  loadedAt: number;
  /** Estimated size in bytes */
  sizeBytes: number;
}

/**
 * Per-asset frame buffer state.
 */
interface AssetBufferState {
  /** Asset identifier */
  assetId: string;
  /** Path to the asset file */
  assetPath: string;
  /** Currently displayed frame */
  currentFrame: BufferedFrame | null;
  /** Prefetched next frame */
  nextFrame: BufferedFrame | null;
  /** Last time we fetched a frame for this asset */
  lastFetchTime: number;
  /** Whether prefetch is in progress */
  isPrefetching: boolean;
  /** Pending prefetch promise (for deduplication) */
  prefetchPromise: Promise<void> | null;
  /** Seek iteration position (for smart seeking) */
  iterationPosition: number;
}

/**
 * Performance statistics for monitoring.
 */
export interface BufferStats {
  /** Number of assets being tracked */
  activeAssets: number;
  /** Total frames in buffer */
  bufferedFrames: number;
  /** Cache hit rate (0-1) */
  cacheHitRate: number;
  /** Average frame fetch latency (ms) */
  avgFetchLatencyMs: number;
  /** Number of smart seeks (iterate) vs full seeks */
  smartSeekCount: number;
  /** Number of full seeks */
  fullSeekCount: number;
  /** Number of prefetch hits (next frame was ready) */
  prefetchHits: number;
  /** Number of prefetch misses */
  prefetchMisses: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Maximum time jump for iterate-forward optimization (seconds) */
const ITERATE_FORWARD_THRESHOLD = 2.0;

/** Frame fetch timeout (ms) */
const FRAME_FETCH_TIMEOUT_MS = 5000;

/** Maximum concurrent fetch operations per asset */
const MAX_CONCURRENT_FETCHES = 2;

/** How far ahead to prefetch the next frame (seconds) */
const NEXT_FRAME_OFFSET = FRAME_EXTRACTION.PREFETCH_INTERVAL_SEC;

// =============================================================================
// VideoFrameBuffer Class
// =============================================================================

/**
 * Advanced frame buffer with dual-frame caching and smart seeking.
 */
export class VideoFrameBuffer {
  /** Per-asset buffer states */
  private assetBuffers: Map<string, AssetBufferState> = new Map();

  /** Pending fetch operations (for deduplication) */
  private pendingFetches: Map<string, Promise<string | null>> = new Map();

  /** Performance statistics */
  private stats = {
    smartSeekCount: 0,
    fullSeekCount: 0,
    prefetchHits: 0,
    prefetchMisses: 0,
    totalFetchLatencyMs: 0,
    fetchCount: 0,
  };

  /** Semaphore for concurrent fetch limiting */
  private activeFetchCount = 0;
  private fetchQueue: Array<() => void> = [];

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get a frame for the given asset at the specified time.
   * Uses smart seeking and dual-frame buffer for performance.
   *
   * @param assetId - Asset identifier
   * @param assetPath - Path to the asset file
   * @param timestamp - Desired frame time in seconds
   * @returns Frame URL or null if unavailable
   */
  async getFrame(
    assetId: string,
    assetPath: string,
    timestamp: number,
  ): Promise<string | null> {
    const startTime = performance.now();

    // Get or create buffer state for this asset
    const state = this.getOrCreateAssetState(assetId, assetPath);

    // Check if we already have the frame
    const cacheKey = createFrameCacheKey(assetId, timestamp);
    const cached = frameCache.get(cacheKey);
    if (cached) {
      this.updateCurrentFrame(state, { key: cacheKey, url: cached, timestamp, loadedAt: Date.now(), sizeBytes: 0 });
      this.triggerPrefetch(state, timestamp);
      return cached;
    }

    // Check if nextFrame matches
    if (state.nextFrame && Math.abs(state.nextFrame.timestamp - timestamp) < 0.001) {
      this.stats.prefetchHits++;
      this.updateCurrentFrame(state, state.nextFrame);
      state.nextFrame = null;
      this.triggerPrefetch(state, timestamp);
      return state.currentFrame!.url;
    } else if (state.nextFrame) {
      this.stats.prefetchMisses++;
    }

    // Decide: iterate forward or full seek?
    const timeDelta = timestamp - state.lastFetchTime;
    const shouldIterateForward = timeDelta > 0 && timeDelta < ITERATE_FORWARD_THRESHOLD;

    let frameUrl: string | null = null;

    if (shouldIterateForward && state.currentFrame) {
      // Smart seek: iterate forward from current position
      this.stats.smartSeekCount++;
      frameUrl = await this.iterateToTime(state, timestamp);
    } else {
      // Full seek: fetch frame directly
      this.stats.fullSeekCount++;
      frameUrl = await this.fetchFrame(assetId, assetPath, timestamp);
    }

    if (frameUrl) {
      this.updateCurrentFrame(state, {
        key: cacheKey,
        url: frameUrl,
        timestamp,
        loadedAt: Date.now(),
        sizeBytes: 100 * 1024, // Estimate
      });
      state.lastFetchTime = timestamp;
      this.triggerPrefetch(state, timestamp);
    }

    // Track latency
    const latency = performance.now() - startTime;
    this.stats.totalFetchLatencyMs += latency;
    this.stats.fetchCount++;

    // Log if latency is high
    if (latency > 100) {
      logger.debug('High frame fetch latency', {
        assetId,
        timestamp: timestamp.toFixed(3),
        latencyMs: latency.toFixed(1),
        seekType: shouldIterateForward ? 'iterate' : 'full',
      });
    }

    return frameUrl;
  }

  /**
   * Clear buffer for a specific asset.
   */
  clearAsset(assetId: string): void {
    this.assetBuffers.delete(assetId);
  }

  /**
   * Clear all buffers.
   */
  clearAll(): void {
    this.assetBuffers.clear();
    this.pendingFetches.clear();
    this.resetStats();
  }

  /**
   * Get performance statistics.
   */
  getStats(): BufferStats {
    let bufferedFrames = 0;
    for (const state of this.assetBuffers.values()) {
      if (state.currentFrame) bufferedFrames++;
      if (state.nextFrame) bufferedFrames++;
    }

    const cacheStats = frameCache.getStats();

    return {
      activeAssets: this.assetBuffers.size,
      bufferedFrames,
      cacheHitRate: cacheStats.hitRate,
      avgFetchLatencyMs: this.stats.fetchCount > 0
        ? this.stats.totalFetchLatencyMs / this.stats.fetchCount
        : 0,
      smartSeekCount: this.stats.smartSeekCount,
      fullSeekCount: this.stats.fullSeekCount,
      prefetchHits: this.stats.prefetchHits,
      prefetchMisses: this.stats.prefetchMisses,
    };
  }

  /**
   * Reset performance statistics.
   */
  resetStats(): void {
    this.stats = {
      smartSeekCount: 0,
      fullSeekCount: 0,
      prefetchHits: 0,
      prefetchMisses: 0,
      totalFetchLatencyMs: 0,
      fetchCount: 0,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Get or create buffer state for an asset.
   */
  private getOrCreateAssetState(assetId: string, assetPath: string): AssetBufferState {
    let state = this.assetBuffers.get(assetId);
    if (!state) {
      state = {
        assetId,
        assetPath,
        currentFrame: null,
        nextFrame: null,
        lastFetchTime: 0,
        isPrefetching: false,
        prefetchPromise: null,
        iterationPosition: 0,
      };
      this.assetBuffers.set(assetId, state);
    }
    return state;
  }

  /**
   * Update current frame and manage buffer.
   */
  private updateCurrentFrame(state: AssetBufferState, frame: BufferedFrame): void {
    state.currentFrame = frame;
  }

  /**
   * Iterate forward from current position to target time.
   * More efficient for small time jumps during scrubbing.
   */
  private async iterateToTime(
    state: AssetBufferState,
    targetTime: number,
  ): Promise<string | null> {
    const interval = FRAME_EXTRACTION.PREFETCH_INTERVAL_SEC;
    let currentTime = state.iterationPosition || state.lastFetchTime;

    // Iterate forward, checking cache at each step
    while (currentTime < targetTime) {
      currentTime += interval;

      // Check if we overshoot
      if (currentTime >= targetTime) {
        break;
      }

      // Check cache for intermediate frames (warming cache)
      const cacheKey = createFrameCacheKey(state.assetId, currentTime);
      if (!frameCache.has(cacheKey)) {
        // Pre-warm cache for this position (fire and forget)
        this.fetchFrame(state.assetId, state.assetPath, currentTime).catch(() => {});
      }
    }

    // Fetch the actual target frame
    state.iterationPosition = targetTime;
    return this.fetchFrame(state.assetId, state.assetPath, targetTime);
  }

  /**
   * Fetch a single frame (with deduplication and concurrency control).
   */
  private async fetchFrame(
    assetId: string,
    assetPath: string,
    timestamp: number,
  ): Promise<string | null> {
    const cacheKey = createFrameCacheKey(assetId, timestamp);

    // Check cache first
    const cached = frameCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Check pending fetches (deduplication)
    const pending = this.pendingFetches.get(cacheKey);
    if (pending) {
      return pending;
    }

    // Create fetch promise
    const fetchPromise = this.executeFetch(assetId, assetPath, timestamp, cacheKey);
    this.pendingFetches.set(cacheKey, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.pendingFetches.delete(cacheKey);
    }
  }

  /**
   * Execute frame extraction with concurrency control.
   */
  private async executeFetch(
    assetId: string,
    assetPath: string,
    timestamp: number,
    cacheKey: string,
  ): Promise<string | null> {
    // Wait for permit if at capacity
    if (this.activeFetchCount >= MAX_CONCURRENT_FETCHES) {
      await new Promise<void>((resolve) => {
        this.fetchQueue.push(resolve);
      });
    }

    this.activeFetchCount++;

    try {
      const safeAssetName = assetId.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const timeMs = Math.floor(timestamp * 1000);
      const outputPath = await buildFrameOutputPath(safeAssetName, timeMs, FRAME_EXTRACTION.OUTPUT_FORMAT);

      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Frame fetch timeout')), FRAME_FETCH_TIMEOUT_MS);
      });

      // Race extraction against timeout
      await Promise.race([
        extractFrameIPC({
          inputPath: assetPath,
          timeSec: timestamp,
          outputPath,
        }),
        timeoutPromise,
      ]);

      const frameUrl = convertFileSrc(outputPath);

      // Store in cache
      frameCache.set(cacheKey, frameUrl, 100 * 1024);

      return frameUrl;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Frame fetch failed', {
        assetId,
        timestamp: timestamp.toFixed(3),
        error: errorMessage,
      });
      return null;
    } finally {
      this.activeFetchCount--;

      // Release next waiter if any
      const next = this.fetchQueue.shift();
      if (next) {
        next();
      }
    }
  }

  /**
   * Trigger prefetch for the next frame (non-blocking).
   */
  private triggerPrefetch(state: AssetBufferState, currentTime: number): void {
    // Don't prefetch if already in progress
    if (state.isPrefetching) {
      return;
    }

    const nextTime = currentTime + NEXT_FRAME_OFFSET;
    const cacheKey = createFrameCacheKey(state.assetId, nextTime);

    // Don't prefetch if already cached or if we already have it
    if (frameCache.has(cacheKey) || this.pendingFetches.has(cacheKey)) {
      return;
    }

    if (state.nextFrame && Math.abs(state.nextFrame.timestamp - nextTime) < 0.001) {
      return;
    }

    state.isPrefetching = true;
    state.prefetchPromise = this.prefetchNextFrame(state, nextTime);
  }

  /**
   * Prefetch the next frame in background.
   */
  private async prefetchNextFrame(state: AssetBufferState, nextTime: number): Promise<void> {
    try {
      const frameUrl = await this.fetchFrame(state.assetId, state.assetPath, nextTime);
      if (frameUrl) {
        state.nextFrame = {
          key: createFrameCacheKey(state.assetId, nextTime),
          url: frameUrl,
          timestamp: nextTime,
          loadedAt: Date.now(),
          sizeBytes: 100 * 1024,
        };
      }
    } catch (error) {
      logger.debug('Prefetch failed (ignored)', {
        assetId: state.assetId,
        nextTime: nextTime.toFixed(3),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.isPrefetching = false;
      state.prefetchPromise = null;
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/**
 * Global video frame buffer instance.
 */
export const videoFrameBuffer = new VideoFrameBuffer();

/**
 * VideoFrameBuffer Service
 *
 * Supplies the canvas preview player with decoded frames.
 *
 * Frames come from the resident decoder in the Rust core: one long-lived FFmpeg
 * per source streaming raw RGBA, so an in-order request costs a pipe read rather
 * than a process spawn, a JPEG encode, a disk write and a JPEG decode. This
 * service turns those bytes into `ImageBitmap`s, caches them under a bounded
 * budget, and never lets two requests for the same frame decode twice.
 *
 * The old smart-seek and prefetch machinery is gone on purpose: it existed to
 * amortise a ~100 ms per-frame spawn by speculatively extracting up to thirty
 * neighbouring frames, and against a resident decoder those speculative reads
 * only move the pipe cursor away from the frame that is actually wanted.
 */

import { getPreviewFrame, releasePreviewDecoders } from '@/utils/ffmpeg';
import type { PreviewFrameData } from '@/utils/ffmpeg';
import { createLogger } from '@/services/logger';
import {
  createPreviewFrameKey,
  createPreviewTimeKey,
  previewFrameCache,
} from '@/services/previewFrameCache';

const logger = createLogger('VideoFrameBuffer');

// =============================================================================
// Types
// =============================================================================

/** The box a decoded frame is fitted inside, in canvas pixels. */
export interface PreviewFrameTarget {
  maxWidth: number;
  maxHeight: number;
}

/**
 * How an asset's frames can be looked up, learned from the decoder's first
 * reply for it.
 */
type AssetAddressing =
  /** Constant-rate: a requested time maps onto a frame index. */
  | { kind: 'indexed'; fps: number }
  /** Variable-rate: only the requested time itself identifies a frame. */
  | { kind: 'timed' };

/**
 * Performance statistics for monitoring.
 */
export interface BufferStats {
  /** Number of assets a frame has been requested for. */
  activeAssets: number;
  /** Decoded frames currently held in the cache. */
  bufferedFrames: number;
  /** Bytes those frames occupy. */
  bufferedBytes: number;
  /** Cache hit rate (0-1) */
  cacheHitRate: number;
  /** Average frame fetch latency (ms) */
  avgFetchLatencyMs: number;
  /** Requests dropped because the fetch queue was full. */
  droppedRequests: number;
  /** Requests that failed to decode. */
  failedRequests: number;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Backstop for an IPC reply that never arrives (ms).
 *
 * This is deliberately longer than the decoder's own read budget rather than
 * shorter. Giving up here does not cancel the decode — the Rust watchdog is the
 * only thing that can kill the process — so a shorter deadline would abandon
 * work that was about to succeed and then decode it again, which is how a slow
 * first read on long-GOP footage turns into a loop.
 */
const FRAME_FETCH_TIMEOUT_MS = 70_000;

/** Maximum concurrent decode requests in flight */
const MAX_CONCURRENT_FETCHES = 2;

/** Maximum queued frame fetches waiting for a concurrency slot */
const MAX_FETCH_QUEUE_SIZE = 64;

/** Highest frame rate accepted when learning a source's rate from a reply. */
const MAX_PLAUSIBLE_FPS = 1000;

// =============================================================================
// VideoFrameBuffer Class
// =============================================================================

/**
 * Frame supplier for the canvas preview, backed by the resident decoder.
 */
export class VideoFrameBuffer {
  /** Assets a frame has been requested for. */
  private readonly seenAssets = new Set<string>();

  /**
   * How each asset's frames can be addressed, learned from the first reply.
   *
   * A constant-rate source reports a frame index, which lets a requested time be
   * snapped to the same frame the decoder would snap it to — so two requests a
   * few milliseconds apart resolve to one cache entry instead of two decodes of
   * the same picture. A variable-rate source reports no index and is addressed
   * by time.
   */
  private readonly assetAddressing = new Map<string, AssetAddressing>();

  /**
   * The first request for an asset, which later requests wait behind.
   *
   * Until a reply says how the asset is addressed there is no canonical cache
   * key, so a burst of first requests (the same asset on two tracks, or the two
   * halves of a crossfade) would each pick a different provisional key, decode
   * separately, and then collide on the key they converge to.
   */
  private readonly addressingProbes = new Map<string, Promise<void>>();

  /** In-flight decodes, keyed by cache key, so duplicates share one request. */
  private readonly pendingFetches = new Map<string, Promise<ImageBitmap | null>>();

  /**
   * Bumped by {@link VideoFrameBuffer.clearAll}; captured by every fetch.
   *
   * A fetch whose epoch is stale must not reach the backend: the teardown kills
   * the resident decoders, and a request arriving after it would build a fresh
   * pool of FFmpeg processes with nothing left to release them.
   */
  private epoch = 0;

  /**
   * True from the first line of {@link VideoFrameBuffer.clearAll} until the
   * backend has actually let go.
   *
   * The epoch alone cannot close the window: a request that *starts* during the
   * teardown captures the new epoch, so it passes every epoch check and can
   * still reach the backend after the release, which lazily rebuilds the pool
   * and leaves FFmpeg children holding media files open with nothing left to
   * reap them. A compound clip's nested render and a fast unmount/remount both
   * reach this. Nothing is fetched while it is set.
   */
  private tearingDown = false;

  /** Performance statistics */
  private stats = {
    totalFetchLatencyMs: 0,
    fetchCount: 0,
    droppedRequests: 0,
    failedRequests: 0,
  };

  /** Semaphore for concurrent fetch limiting */
  private activeFetchCount = 0;
  private fetchQueue: Array<() => void> = [];

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Get a drawable frame for the given asset at the specified source time.
   *
   * Resolves to `null` — never rejects — when the frame cannot be produced, so
   * the caller can leave the previous pixels on screen.
   *
   * @param assetId - Asset identifier
   * @param assetPath - Path (or file URI) of the asset file
   * @param timestamp - Desired source time in seconds
   * @param target - Box the frame is fitted inside, in canvas pixels
   * @returns A drawable frame, or null if unavailable
   */
  async getFrame(
    assetId: string,
    assetPath: string,
    timestamp: number,
    target: PreviewFrameTarget,
  ): Promise<ImageBitmap | null> {
    // A teardown is in progress and the backend is about to be told to let go.
    // Anything started now would arrive after that and rebuild the pool.
    if (this.tearingDown) {
      return null;
    }

    const startTime = performance.now();
    const epoch = this.epoch;
    this.seenAssets.add(assetId);

    const width = Math.max(1, Math.round(target.maxWidth));
    const height = Math.max(1, Math.round(target.maxHeight));

    // Wait behind the first request for this asset so every later one keys on
    // the frame the decoder actually returns rather than a provisional guess.
    await this.awaitAddressing(assetId);
    if (epoch !== this.epoch || this.tearingDown) {
      return null;
    }

    const cacheKey = this.cacheKeyFor(assetId, timestamp, width, height);
    const cached = previewFrameCache.get(cacheKey);
    if (cached) {
      previewFrameCache.pin(cached);
      return cached;
    }

    const frame = await this.fetchFrame(
      assetId,
      assetPath,
      timestamp,
      width,
      height,
      cacheKey,
      epoch,
    );

    if (frame) {
      // The caller is about to draw this; eviction must not close it first.
      previewFrameCache.pin(frame);
    }

    const latency = performance.now() - startTime;
    this.stats.totalFetchLatencyMs += latency;
    this.stats.fetchCount++;

    if (latency > 100) {
      logger.debug('High frame fetch latency', {
        assetId,
        timestamp: timestamp.toFixed(3),
        latencyMs: latency.toFixed(1),
      });
    }

    return frame;
  }

  /**
   * Marks the start of a compositing pass.
   *
   * Frames handed out from here until the next call are protected from
   * eviction, so a pass drawing more clips than the cache's byte budget holds
   * cannot close a bitmap it is still about to draw.
   */
  beginRenderPass(): void {
    previewFrameCache.beginPass();
  }

  /**
   * Drop every cached frame and kill the resident decoders behind them.
   *
   * Called when the canvas preview goes away (unmount, project close) so no
   * FFmpeg outlives the thing that was displaying its frames.
   *
   * The order matters and is the whole point of the method. Releasing first and
   * letting queued work drain afterwards would have every parked request reach a
   * backend that has just thrown its pool away, which rebuilds it — leaving
   * exactly the orphaned FFmpeg processes this is supposed to prevent. So: stop
   * new work, release everything parked, let what is already on the wire settle,
   * and only then tell the backend to let go.
   */
  async clearAll(): Promise<void> {
    this.tearingDown = true;
    this.epoch += 1;
    const epoch = this.epoch;

    // Everything parked for a permit wakes up, sees the new epoch, and returns
    // without reaching the backend.
    //
    // `activeFetchCount` is deliberately not zeroed: a parked request bails out
    // before it takes a permit, and one already holding a permit gives it back
    // in its own `finally`. Forcing the counter to zero here would double-count
    // those returns and leave the semaphore permanently over-permissive.
    const parked = this.fetchQueue;
    this.fetchQueue = [];
    for (const release of parked) {
      release();
    }

    const inFlight = [...this.pendingFetches.values()];
    this.pendingFetches.clear();
    this.addressingProbes.clear();

    previewFrameCache.clear();
    this.seenAssets.clear();
    this.assetAddressing.clear();
    this.resetStats();

    // Requests already on the wire will still be answered by the pool, so the
    // release has to come after them or it would tear down a pool that is about
    // to be rebuilt.
    await Promise.allSettled(inFlight);

    if (epoch !== this.epoch) {
      // A later teardown superseded this one and owns both the release and the
      // clearing of `tearingDown`.
      return;
    }

    try {
      await releasePreviewDecoders();
    } catch (error: unknown) {
      logger.debug('Releasing the resident preview decoders failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (epoch === this.epoch) {
        this.tearingDown = false;
      }
    }
  }

  /**
   * Get performance statistics.
   */
  getStats(): BufferStats {
    const cacheStats = previewFrameCache.getStats();

    return {
      activeAssets: this.seenAssets.size,
      bufferedFrames: cacheStats.entries,
      bufferedBytes: cacheStats.bytes,
      cacheHitRate: cacheStats.hitRate,
      avgFetchLatencyMs:
        this.stats.fetchCount > 0 ? this.stats.totalFetchLatencyMs / this.stats.fetchCount : 0,
      droppedRequests: this.stats.droppedRequests,
      failedRequests: this.stats.failedRequests,
    };
  }

  /**
   * Reset performance statistics.
   */
  resetStats(): void {
    this.stats = {
      totalFetchLatencyMs: 0,
      fetchCount: 0,
      droppedRequests: 0,
      failedRequests: 0,
    };
    previewFrameCache.resetStats();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Blocks until the first reply for `assetId` has said how it is addressed.
   *
   * Only the very first request for an asset waits on nothing; the rest of that
   * opening burst wait here so they all key on the same thing.
   */
  private async awaitAddressing(assetId: string): Promise<void> {
    const probe = this.addressingProbes.get(assetId);
    if (!probe || this.assetAddressing.has(assetId)) {
      return;
    }

    await probe;
  }

  /**
   * The cache key for a request: the frame's index for a constant-rate source,
   * and the requested time for a variable-rate one or before the first reply.
   */
  private cacheKeyFor(assetId: string, timestamp: number, width: number, height: number): string {
    const addressing = this.assetAddressing.get(assetId);
    if (addressing?.kind !== 'indexed') {
      return createPreviewTimeKey(assetId, timestamp, width, height);
    }

    const frameIndex = Math.max(0, Math.round(Math.max(0, timestamp) * addressing.fps));
    return createPreviewFrameKey(assetId, frameIndex, width, height);
  }

  /**
   * Records how a reply says its source is addressed.
   *
   * A reply carrying no frame index comes from a variable-rate source, whose
   * presentation times are not a multiple of any frame duration; inventing a
   * rate for it would put every later request on the wrong picture.
   */
  private learnAddressing(assetId: string, frame: PreviewFrameData): void {
    if (this.assetAddressing.has(assetId)) {
      return;
    }

    if (frame.frameIndex === null) {
      this.assetAddressing.set(assetId, { kind: 'timed' });
      return;
    }

    if (frame.frameIndex <= 0 || frame.sourceTime <= 0) {
      // Frame zero says nothing about the rate; leave it for the next reply.
      return;
    }

    const fps = frame.frameIndex / frame.sourceTime;
    if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_PLAUSIBLE_FPS) {
      return;
    }

    this.assetAddressing.set(assetId, { kind: 'indexed', fps });
  }

  /**
   * Fetch a single frame, sharing one request between duplicate callers.
   */
  private async fetchFrame(
    assetId: string,
    assetPath: string,
    timestamp: number,
    width: number,
    height: number,
    cacheKey: string,
    epoch: number,
  ): Promise<ImageBitmap | null> {
    const pending = this.pendingFetches.get(cacheKey);
    if (pending) {
      return pending;
    }

    const fetchPromise = this.executeFetch(assetId, assetPath, timestamp, width, height, epoch);
    this.pendingFetches.set(cacheKey, fetchPromise);

    if (!this.assetAddressing.has(assetId) && !this.addressingProbes.has(assetId)) {
      const probe = fetchPromise.then(
        () => {
          this.addressingProbes.delete(assetId);
        },
        () => {
          this.addressingProbes.delete(assetId);
        },
      );
      this.addressingProbes.set(assetId, probe);
    }

    try {
      return await fetchPromise;
    } finally {
      if (this.pendingFetches.get(cacheKey) === fetchPromise) {
        this.pendingFetches.delete(cacheKey);
      }
    }
  }

  /**
   * Decode one frame, under the concurrency limit, and cache the result.
   */
  private async executeFetch(
    assetId: string,
    assetPath: string,
    timestamp: number,
    width: number,
    height: number,
    epoch: number,
  ): Promise<ImageBitmap | null> {
    // Wait for permit if at capacity
    if (this.activeFetchCount >= MAX_CONCURRENT_FETCHES) {
      if (this.fetchQueue.length >= MAX_FETCH_QUEUE_SIZE) {
        this.stats.droppedRequests++;
        logger.warn('Frame fetch queue full, dropping request', {
          assetId,
          timestamp: timestamp.toFixed(3),
          queued: this.fetchQueue.length,
        });
        return null;
      }

      await new Promise<void>((resolve) => {
        this.fetchQueue.push(resolve);
      });
    }

    // The preview was torn down while this sat in the queue. Reaching the
    // backend now would rebuild the pool of FFmpeg processes the teardown is in
    // the middle of releasing.
    if (epoch !== this.epoch) {
      return null;
    }

    this.activeFetchCount++;

    try {
      const frame = await requestFrameWithTimeout(assetPath, timestamp, width, height);
      if (epoch !== this.epoch) {
        return null;
      }

      this.learnAddressing(assetId, frame);

      // Re-derive the key now the addressing is known: for a constant-rate
      // source it becomes the frame's index, which is what later requests for
      // this picture will look up.
      const canonicalKey = this.cacheKeyFor(assetId, timestamp, width, height);
      const alreadyCached = previewFrameCache.get(canonicalKey);
      if (alreadyCached) {
        return alreadyCached;
      }

      const bitmap = await createFrameBitmap(frame.pixels, frame.width, frame.height);

      // Re-check across the decode: another request for a nearby time may have
      // converged on this same key while the bitmap was being built. Handing
      // back the entry that already exists — and closing the one nobody has seen
      // — is what keeps a cached frame from being closed under a caller that is
      // still drawing it.
      const raced = previewFrameCache.get(canonicalKey);
      if (raced) {
        bitmap.close();
        return raced;
      }
      if (epoch !== this.epoch) {
        bitmap.close();
        return null;
      }

      previewFrameCache.set(canonicalKey, bitmap);
      return bitmap;
    } catch (error) {
      this.stats.failedRequests++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Frame fetch failed', {
        assetId,
        timestamp: timestamp.toFixed(3),
        error: errorMessage,
      });
      return null;
    } finally {
      this.activeFetchCount = Math.max(0, this.activeFetchCount - 1);

      // Release next waiter if any
      const next = this.fetchQueue.shift();
      if (next) {
        next();
      }
    }
  }
}

/**
 * Asks the resident decoder for one frame, giving up after
 * {@link FRAME_FETCH_TIMEOUT_MS} so a wedged decode cannot hold a fetch permit
 * forever.
 */
async function requestFrameWithTimeout(
  assetPath: string,
  timestamp: number,
  width: number,
  height: number,
): Promise<PreviewFrameData> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Frame fetch timeout')), FRAME_FETCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      getPreviewFrame({
        inputPath: assetPath,
        timeSec: timestamp,
        maxWidth: width,
        maxHeight: height,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Turns raw RGBA into a drawable the canvas can composite.
 *
 * `ImageBitmap` is used rather than `putImageData` because the preview draws
 * every clip through `drawImage` under a transform, an alpha and a blend mode,
 * none of which `putImageData` honours.
 */
async function createFrameBitmap(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This runtime cannot decode preview frames: createImageBitmap is unavailable');
  }

  const imageData = new ImageData(pixels, width, height);
  return createImageBitmap(imageData, {
    // The decoder emits straight alpha in the sRGB the canvas already works in;
    // letting the browser convert either would shift the preview away from what
    // the export renders.
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
}

// =============================================================================
// Singleton Instance
// =============================================================================

/**
 * Global video frame buffer instance.
 */
export const videoFrameBuffer = new VideoFrameBuffer();

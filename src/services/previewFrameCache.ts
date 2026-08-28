/**
 * PreviewFrameCache
 *
 * Bounded LRU cache of decoded preview frames.
 *
 * The frames it holds are `ImageBitmap`s, which own memory outside the JS heap
 * and are only released by `close()`. Every eviction therefore closes the
 * bitmap it drops, and the cache is bounded by real bytes (`width * height * 4`)
 * rather than by a per-entry guess, because a 960x540 frame and a 1920x1080 one
 * differ by 4x.
 */

import { createLogger } from '@/services/logger';

const logger = createLogger('PreviewFrameCache');

/** Bytes an RGBA pixel occupies. */
const BYTES_PER_PIXEL = 4;

/** Default ceiling on cached frames. */
export const PREVIEW_FRAME_CACHE_MAX_ENTRIES = 96;

/**
 * Default ceiling on cached frame bytes.
 *
 * Which of the two bounds binds depends entirely on the footage: a 960x540
 * frame is 2 MB, so the entry count runs out first, while a full-resolution
 * 1080p frame is 8.3 MB and roughly twenty-three of them exhaust this instead.
 * That is the intended behaviour — the budget is about memory, not about frames.
 */
const DEFAULT_MAX_BYTES = 192 * 1024 * 1024;

/**
 * Frames the cache keeps regardless of the byte budget.
 *
 * A compositing pass draws every visible clip, so a cache that cannot hold a
 * whole pass would evict frames the very next pass asks for again. This floor
 * keeps a working set alive even when the frames are large enough that the byte
 * budget alone would not.
 */
const DEFAULT_MIN_ENTRIES = 12;

/**
 * What the cache stores: anything with intrinsic pixel dimensions that can be
 * released. `ImageBitmap` satisfies this.
 */
export interface ClosablePreviewFrame {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface PreviewFrameCacheOptions {
  /** Maximum number of frames held at once. */
  maxEntries?: number;
  /** Maximum total bytes held at once. */
  maxBytes?: number;
  /** Frames kept even when they exceed the byte budget between them. */
  minEntries?: number;
}

export interface PreviewFrameCacheStats {
  /** Frames currently held. */
  entries: number;
  /** Bytes currently held. */
  bytes: number;
  /** Fraction of lookups that found a frame (0-1). */
  hitRate: number;
  /** Lookups that found a frame. */
  hits: number;
  /** Lookups that did not. */
  misses: number;
  /** Frames closed to stay inside the bounds. */
  evictions: number;
}

interface CacheEntry<T extends ClosablePreviewFrame> {
  frame: T;
  bytes: number;
}

/**
 * The cache key for one decoded frame.
 *
 * The output size is part of the key because a frame decoded for a 960x540
 * canvas is not the frame a 480x270 canvas wants.
 */
export function createPreviewFrameKey(
  assetId: string,
  frameIndex: number,
  width: number,
  height: number,
): string {
  return `${assetId}|${width}x${height}|#${frameIndex}`;
}

/**
 * The cache key for a frame that can only be named by the time it answers for.
 *
 * Used before the first reply has said how a source is addressed, and for the
 * whole life of a variable-rate source, whose presentation times are not a
 * multiple of any frame duration. Keyed to the millisecond.
 */
export function createPreviewTimeKey(
  assetId: string,
  timeSec: number,
  width: number,
  height: number,
): string {
  return `${assetId}|${width}x${height}|@${timeSec.toFixed(3)}`;
}

/**
 * An LRU cache of decoded frames that closes what it drops.
 */
export class PreviewFrameCache<T extends ClosablePreviewFrame = ImageBitmap> {
  /** Insertion order is the LRU order; a hit re-inserts to mark it recent. */
  private readonly entries = new Map<string, CacheEntry<T>>();

  /**
   * Frames the current compositing pass has been handed and is about to draw.
   *
   * A pass gathers every visible clip's frame and only then draws them, so a
   * later frame in the same pass can push the cache over budget and evict — and
   * therefore `close()` — one the compositor is still holding. Drawing a
   * detached bitmap throws, and retrying the pass hits the same eviction, so the
   * preview thrashes instead of recovering. Pinned frames are skipped by
   * eviction, which is what makes a pass safe no matter how many clips it draws.
   */
  private readonly pinned = new Set<T>();

  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly minEntries: number;

  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: PreviewFrameCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? PREVIEW_FRAME_CACHE_MAX_ENTRIES);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.minEntries = Math.min(
      this.maxEntries,
      Math.max(1, options.minEntries ?? DEFAULT_MIN_ENTRIES),
    );
  }

  /** The frame stored under `key`, or `null`. */
  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Re-insert so this key becomes the most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.frame;
  }

  /** Whether a frame is stored under `key`, without affecting recency. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Stores `frame` under `key`, closing whatever it replaces and evicting the
   * least recently used frames until the cache is back inside its bounds.
   *
   * The frame just stored is never the one evicted, so a caller can always draw
   * what it just put in.
   */
  set(key: string, frame: T): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.totalBytes -= existing.bytes;
      if (existing.frame !== frame) {
        closeFrame(existing.frame);
      }
    }

    const bytes = frame.width * frame.height * BYTES_PER_PIXEL;
    this.entries.set(key, { frame, bytes });
    this.totalBytes += bytes;

    this.evictUntilWithinBounds(key);
  }

  /** Drops and closes the frame stored under `key`, if any. */
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    closeFrame(entry.frame);
  }

  /**
   * Starts a compositing pass: releases the previous pass's pins.
   *
   * Pins are released at the *start* of a pass rather than the end so a pass
   * that throws part-way cannot strand them and stop the cache evicting.
   */
  beginPass(): void {
    this.pinned.clear();
  }

  /**
   * Protects `frame` from eviction until the next {@link beginPass}.
   *
   * Ignored once the pinned set has grown to the entry ceiling, because a pass
   * that pins everything would stop eviction altogether and let the cache grow
   * without bound. A pass with that many clips is already past what the preview
   * can composite.
   */
  pin(frame: T): void {
    if (this.pinned.size >= this.maxEntries) {
      return;
    }

    this.pinned.add(frame);
  }

  /** Frames currently protected from eviction. */
  pinnedCount(): number {
    return this.pinned.size;
  }

  /** Drops and closes every frame. */
  clear(): void {
    this.pinned.clear();
    for (const entry of this.entries.values()) {
      closeFrame(entry.frame);
    }
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Current occupancy and hit rate. */
  getStats(): PreviewFrameCacheStats {
    const lookups = this.hits + this.misses;
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      hitRate: lookups > 0 ? this.hits / lookups : 0,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  /** Forgets hit/miss/eviction counters without touching the frames. */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Evicts the oldest unpinned frames until both bounds hold, never evicting
   * `keepKey`.
   *
   * The byte budget stops applying once the cache is down to `minEntries`, so
   * large frames shrink the working set rather than emptying it. That floor is a
   * thrash-avoidance heuristic, though — what actually guarantees the current
   * pass keeps every frame it is drawing is the pinned set.
   */
  private evictUntilWithinBounds(keepKey: string): void {
    while (
      this.entries.size > this.maxEntries ||
      (this.totalBytes > this.maxBytes && this.entries.size > this.minEntries)
    ) {
      let oldestKey: string | null = null;
      for (const [key, entry] of this.entries) {
        if (key !== keepKey && !this.pinned.has(entry.frame)) {
          oldestKey = key;
          break;
        }
      }

      // Everything left is either the frame just stored or in use by the pass
      // being composited. Dropping either would hand a caller a closed bitmap,
      // so the budget is allowed to overshoot until the pass ends.
      if (oldestKey === null) return;

      const entry = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (entry) {
        this.totalBytes -= entry.bytes;
        closeFrame(entry.frame);
      }
      this.evictions++;
    }
  }
}

/** Releases a frame's off-heap memory, tolerating an already-closed bitmap. */
function closeFrame(frame: ClosablePreviewFrame): void {
  try {
    frame.close();
  } catch (error) {
    logger.debug('Closing a cached preview frame failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Cache shared by the canvas preview path. */
export const previewFrameCache = new PreviewFrameCache();

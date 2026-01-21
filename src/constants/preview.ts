/**
 * Preview System Constants
 *
 * Centralized configuration for frame extraction, caching, and playback.
 * All magic numbers should be defined here with clear documentation.
 */

// =============================================================================
// Frame Extraction Configuration
// =============================================================================

/**
 * Frame extraction and caching configuration.
 * These values are tuned for a balance between performance and memory usage.
 */
export const FRAME_EXTRACTION = {
  /**
   * Maximum number of frames to keep in memory cache.
   * At ~100KB per frame (1080p JPEG), 100 frames = ~10MB
   */
  MAX_CACHE_ENTRIES: 100,

  /**
   * Maximum cache memory in megabytes.
   * Prevents memory exhaustion on systems with limited RAM.
   */
  MAX_CACHE_MEMORY_MB: 200,

  /**
   * Cache entry time-to-live in milliseconds.
   * Entries older than this are eligible for eviction.
   * Default: 5 minutes
   */
  CACHE_TTL_MS: 5 * 60 * 1000,

  /**
   * Seconds to prefetch ahead of current playhead.
   * Higher values improve scrubbing smoothness but use more memory.
   */
  PREFETCH_AHEAD_SEC: 2,

  /**
   * Interval between prefetched frames in seconds.
   * 1/15 = every 2 frames at 30fps, balancing smoothness and efficiency.
   */
  PREFETCH_INTERVAL_SEC: 1 / 15,

  /**
   * Maximum concurrent FFmpeg extraction calls.
   * Prevents IPC bottleneck while allowing parallelism.
   */
  MAX_CONCURRENT_EXTRACTIONS: 3,

  /**
   * Debounce time for rapid extraction requests in milliseconds.
   * Prevents excessive IPC calls during fast scrubbing.
   */
  DEBOUNCE_MS: 50,

  /**
   * Timestamp precision for cache keys (decimal places).
   * 2 = 0.01s precision = 10ms granularity
   */
  TIMESTAMP_PRECISION: 2,

  /**
   * Output format for extracted frames.
   * JPEG is faster to encode/decode than PNG.
   */
  OUTPUT_FORMAT: 'jpg' as const,

  /**
   * JPEG quality for extracted frames (1-31, lower is better).
   * 2 provides good quality with reasonable file size.
   */
  JPEG_QUALITY: 2,
} as const;

// =============================================================================
// Playback Configuration
// =============================================================================

/**
 * Playback loop and synchronization configuration.
 */
export const PLAYBACK = {
  /**
   * Target preview frames per second.
   * 30fps is industry standard for preview playback.
   */
  TARGET_FPS: 30,

  /**
   * Frame interval in milliseconds.
   * Calculated from TARGET_FPS for consistency.
   */
  get FRAME_INTERVAL_MS(): number {
    return 1000 / this.TARGET_FPS;
  },

  /**
   * Audio synchronization threshold in seconds.
   * If audio drifts more than this, force resync.
   */
  AUDIO_SYNC_THRESHOLD_SEC: 0.1,

  /**
   * Minimum playback rate.
   */
  MIN_RATE: 0.25,

  /**
   * Maximum playback rate.
   */
  MAX_RATE: 4,

  /**
   * Frame drop threshold in milliseconds.
   * If frame takes longer than this, skip to next frame.
   */
  FRAME_DROP_THRESHOLD_MS: 50,
} as const;

// =============================================================================
// Preview Player Configuration
// =============================================================================

/**
 * Preview player UI and rendering configuration.
 */
export const PREVIEW_PLAYER = {
  /**
   * Default preview canvas width.
   */
  DEFAULT_WIDTH: 1920,

  /**
   * Default preview canvas height.
   */
  DEFAULT_HEIGHT: 1080,

  /**
   * Preview scaling modes.
   */
  SCALE_MODES: {
    FIT: 'fit',
    FILL: 'fill',
    STRETCH: 'stretch',
  } as const,

  /**
   * Default background color for empty areas.
   */
  BACKGROUND_COLOR: '#000000',

  /**
   * Controls auto-hide delay in milliseconds.
   */
  CONTROLS_HIDE_DELAY_MS: 3000,
} as const;

// =============================================================================
// Cache Key Utilities
// =============================================================================

/**
 * Generate a cache key for a frame.
 * Format: `{assetId}:{timestamp with fixed precision}`
 */
export function createFrameCacheKey(assetId: string, timestamp: number): string {
  return `${assetId}:${timestamp.toFixed(FRAME_EXTRACTION.TIMESTAMP_PRECISION)}`;
}

/**
 * Parse a cache key back to its components.
 */
export function parseFrameCacheKey(key: string): { assetId: string; timestamp: number } | null {
  const parts = key.split(':');
  if (parts.length !== 2) return null;

  const timestamp = parseFloat(parts[1]);
  if (isNaN(timestamp)) return null;

  return {
    assetId: parts[0],
    timestamp,
  };
}

// =============================================================================
// Type Exports
// =============================================================================

export type FrameOutputFormat = typeof FRAME_EXTRACTION.OUTPUT_FORMAT;
export type ScaleMode = (typeof PREVIEW_PLAYER.SCALE_MODES)[keyof typeof PREVIEW_PLAYER.SCALE_MODES];

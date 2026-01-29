/**
 * Precision Constants
 *
 * Centralized configuration for numerical precision and comparison thresholds.
 * These values are critical for timeline operations where floating-point
 * precision affects user experience.
 */

// =============================================================================
// Epsilon Values for Floating-Point Comparison
// =============================================================================

/**
 * Precision constants for various comparison operations.
 *
 * Video editing requires careful balance between precision and tolerance:
 * - Too tight: False negatives due to IEEE 754 floating-point accumulation
 * - Too loose: Missed updates or incorrect equality checks
 */
export const PRECISION = {
  /**
   * Epsilon for time comparison (in seconds).
   * 1 microsecond - sufficient for video timecode precision.
   * Video frame duration at 60fps = ~16.67ms = 0.01667s
   * This is 16,670x smaller than a frame, providing ample precision.
   */
  TIME_EPSILON: 1e-6,

  /**
   * Epsilon for snap point comparison (in seconds).
   * Same as TIME_EPSILON for consistency.
   */
  SNAP_EPSILON: 1e-6,

  /**
   * Epsilon for frame-level comparison (in seconds).
   * 1 millisecond - useful when comparing at frame boundaries.
   * At 30fps, a frame is ~33ms, so 1ms provides sub-frame precision.
   */
  FRAME_EPSILON: 0.001,

  /**
   * Epsilon for position comparison (in pixels).
   * Sub-pixel precision for smooth rendering.
   */
  PIXEL_EPSILON: 0.01,
} as const;

// =============================================================================
// Video Synchronization Thresholds
// =============================================================================

/**
 * Thresholds for video sync operations.
 * These determine when to trigger seek vs. let playback continue.
 */
export const SYNC_THRESHOLDS = {
  /**
   * Threshold for seeking video element (in seconds).
   * If difference exceeds this, seek to new position.
   * 33ms = 1 frame at 30fps - ensures frame-accurate sync.
   */
  SEEK_THRESHOLD: 0.033,

  /**
   * Threshold for audio sync correction (in seconds).
   * Audio is more tolerant than video.
   */
  AUDIO_SYNC_THRESHOLD: 0.1,

  /**
   * Maximum acceptable drift before warning (in seconds).
   */
  MAX_DRIFT_THRESHOLD: 0.5,
} as const;

// =============================================================================
// Snap System Thresholds
// =============================================================================

/**
 * Thresholds for the magnetic snapping system.
 */
export const SNAP_THRESHOLDS = {
  /**
   * Base threshold in pixels.
   * This is divided by zoom to get time threshold.
   */
  BASE_THRESHOLD_PX: 10,

  /**
   * Minimum snap threshold (in seconds).
   * Prevents overly tight snapping at high zoom.
   */
  MIN_THRESHOLD: 0.05,

  /**
   * Maximum snap threshold (in seconds).
   * Prevents snapping from too far at low zoom.
   */
  MAX_THRESHOLD: 0.5,

  /**
   * Hysteresis multiplier for snap release.
   * Snap releases at threshold * this multiplier.
   * Prevents jitter when dragging near snap points.
   */
  HYSTERESIS_MULTIPLIER: 1.5,
} as const;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Compare two numbers with epsilon tolerance.
 * Returns true if they are approximately equal.
 *
 * @param a First number
 * @param b Second number
 * @param epsilon Tolerance (defaults to TIME_EPSILON)
 */
export function isApproximatelyEqual(
  a: number,
  b: number,
  epsilon: number = PRECISION.TIME_EPSILON
): boolean {
  // Handle NaN and Infinity cases
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return false;
  }
  return Math.abs(a - b) <= epsilon;
}

/**
 * Compare two time values for equality.
 * Uses TIME_EPSILON for comparison.
 */
export function isTimeEqual(a: number, b: number): boolean {
  return isApproximatelyEqual(a, b, PRECISION.TIME_EPSILON);
}

/**
 * Compare two time values to check if they are within one frame.
 * Uses FRAME_EPSILON for comparison.
 */
export function isWithinFrame(a: number, b: number): boolean {
  return isApproximatelyEqual(a, b, PRECISION.FRAME_EPSILON);
}

/**
 * Calculate snap threshold based on zoom level with bounds.
 *
 * @param zoom Pixels per second
 * @returns Threshold in seconds, clamped to MIN/MAX bounds
 */
export function calculateSnapThreshold(zoom: number): number {
  // Guard against invalid zoom values (zero, negative, NaN, Infinity)
  if (!Number.isFinite(zoom) || zoom <= 0) {
    return SNAP_THRESHOLDS.MAX_THRESHOLD;
  }
  const rawThreshold = SNAP_THRESHOLDS.BASE_THRESHOLD_PX / zoom;
  return Math.max(
    SNAP_THRESHOLDS.MIN_THRESHOLD,
    Math.min(SNAP_THRESHOLDS.MAX_THRESHOLD, rawThreshold)
  );
}

/**
 * Calculate snap release threshold (for hysteresis).
 *
 * @param snapThreshold The current snap threshold
 * @returns Release threshold (larger than snap threshold)
 */
export function calculateSnapReleaseThreshold(snapThreshold: number): number {
  return snapThreshold * SNAP_THRESHOLDS.HYSTERESIS_MULTIPLIER;
}

// =============================================================================
// Type Exports
// =============================================================================

export type PrecisionKey = keyof typeof PRECISION;
export type SyncThresholdKey = keyof typeof SYNC_THRESHOLDS;
export type SnapThresholdKey = keyof typeof SNAP_THRESHOLDS;

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
 *
 * IMPORTANT: These are base constants. For FPS-aware precision, use the
 * utility functions like `getFrameEpsilon(fps)` or `getSeekThreshold(fps)`.
 */
export const PRECISION = {
  /**
   * Epsilon for time comparison (in seconds).
   * 1 millisecond - practical precision for video editing.
   * This is about 1/16th of a frame at 60fps (16.67ms).
   *
   * Note: Previously 1e-6 (1 microsecond) which was too tight and caused
   * false negatives in time comparisons due to floating-point accumulation.
   */
  TIME_EPSILON: 0.001,

  /**
   * Epsilon for snap point comparison (in seconds).
   * 1 millisecond - matches TIME_EPSILON for consistency.
   */
  SNAP_EPSILON: 0.001,

  /**
   * Epsilon for frame-level comparison (in seconds).
   * 1 millisecond - useful when comparing at frame boundaries.
   * For FPS-specific precision, use `getFrameEpsilon(fps)`.
   */
  FRAME_EPSILON: 0.001,

  /**
   * Epsilon for position comparison (in pixels).
   * Sub-pixel precision for smooth rendering.
   */
  PIXEL_EPSILON: 0.01,

  /**
   * Sub-frame epsilon (in seconds).
   * Half the frame duration at 60fps (~8ms).
   * Used for very precise comparisons where frame-level isn't enough.
   */
  SUB_FRAME_EPSILON: 0.008,
} as const;

// =============================================================================
// Video Synchronization Thresholds
// =============================================================================

/**
 * Thresholds for video sync operations.
 * These determine when to trigger seek vs. let playback continue.
 *
 * For FPS-specific thresholds, use the utility functions below.
 */
export const SYNC_THRESHOLDS = {
  /**
   * Default threshold for seeking video element (in seconds).
   * 33ms = 1 frame at 30fps.
   * Use `getSeekThreshold(fps)` for FPS-aware threshold.
   */
  SEEK_THRESHOLD: 0.033,

  /**
   * Threshold for soft audio sync correction (in seconds).
   * Below this, playback continues without correction.
   */
  AUDIO_SYNC_THRESHOLD: 0.05, // 50ms - tighter than before

  /**
   * Threshold for moderate drift warning (in seconds).
   * Triggers gradual correction.
   */
  DRIFT_WARNING_THRESHOLD: 0.1, // 100ms

  /**
   * Maximum acceptable drift before hard resync (in seconds).
   * Forces immediate synchronization.
   */
  MAX_DRIFT_THRESHOLD: 0.3, // 300ms - tighter than before (was 500ms)

  /**
   * Threshold for external seek detection (in seconds).
   * Used to distinguish user seeks from playback progression.
   * Should be larger than 2 frames at slowest supported playback rate.
   */
  EXTERNAL_SEEK_THRESHOLD: 0.1,
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
// Frame-Accurate Seeking
// =============================================================================

/**
 * Default FPS for frame calculations when none specified.
 */
export const DEFAULT_FPS = 30;

/**
 * Snap a time value to the nearest frame boundary.
 * This ensures frame-accurate seeking for professional editing.
 *
 * @param time Time in seconds
 * @param fps Frames per second (defaults to 30)
 * @returns Time snapped to nearest frame boundary
 *
 * @example
 * snapTimeToFrame(1.033, 30) // Returns 1.0333... (frame 31)
 * snapTimeToFrame(1.01, 30)  // Returns 1.0 (frame 30)
 */
export function snapTimeToFrame(time: number, fps: number = DEFAULT_FPS): number {
  // Guard against invalid inputs
  if (!Number.isFinite(time) || !Number.isFinite(fps) || fps <= 0) {
    return Math.max(0, time || 0);
  }

  // Calculate frame duration
  const frameDuration = 1 / fps;

  // Round to nearest frame
  const frameNumber = Math.round(time / frameDuration);

  // Convert back to time
  return frameNumber * frameDuration;
}

/**
 * Snap a time value to the nearest frame boundary, rounding down.
 * Useful for start positions where you want to include the full frame.
 *
 * @param time Time in seconds
 * @param fps Frames per second (defaults to 30)
 * @returns Time snapped to frame boundary (floor)
 */
export function floorTimeToFrame(time: number, fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(time) || !Number.isFinite(fps) || fps <= 0) {
    return Math.max(0, time || 0);
  }

  const frameDuration = 1 / fps;
  const frameNumber = Math.floor(time / frameDuration);
  return frameNumber * frameDuration;
}

/**
 * Snap a time value to the nearest frame boundary, rounding up.
 * Useful for end positions where you want to include the full frame.
 *
 * @param time Time in seconds
 * @param fps Frames per second (defaults to 30)
 * @returns Time snapped to frame boundary (ceil)
 */
export function ceilTimeToFrame(time: number, fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(time) || !Number.isFinite(fps) || fps <= 0) {
    return Math.max(0, time || 0);
  }

  const frameDuration = 1 / fps;
  const frameNumber = Math.ceil(time / frameDuration);
  return frameNumber * frameDuration;
}

/**
 * Calculate the frame number for a given time.
 *
 * @param time Time in seconds
 * @param fps Frames per second (defaults to 30)
 * @returns Frame number (0-indexed)
 */
export function timeToFrame(time: number, fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(time) || !Number.isFinite(fps) || fps <= 0) {
    return 0;
  }
  return Math.floor(time * fps);
}

/**
 * Calculate the time for a given frame number.
 *
 * @param frame Frame number (0-indexed)
 * @param fps Frames per second (defaults to 30)
 * @returns Time in seconds
 */
export function frameToTime(frame: number, fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(frame) || !Number.isFinite(fps) || fps <= 0) {
    return 0;
  }
  return frame / fps;
}

// =============================================================================
// FPS-Aware Utility Functions
// =============================================================================

/**
 * Get frame epsilon based on FPS.
 * Returns half the frame duration for sub-frame precision.
 *
 * @param fps Frames per second
 * @returns Epsilon in seconds
 */
export function getFrameEpsilon(fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    return PRECISION.FRAME_EPSILON;
  }
  // Half frame duration provides sub-frame precision
  return 0.5 / fps;
}

/**
 * Get seek threshold based on FPS.
 * Returns one frame duration.
 *
 * @param fps Frames per second
 * @returns Threshold in seconds
 */
export function getSeekThreshold(fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    return SYNC_THRESHOLDS.SEEK_THRESHOLD;
  }
  return 1 / fps;
}

/**
 * Get external seek detection threshold based on FPS.
 * Returns 3 frames duration to account for playback rate variations.
 *
 * @param fps Frames per second
 * @returns Threshold in seconds
 */
export function getExternalSeekThreshold(fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    return SYNC_THRESHOLDS.EXTERNAL_SEEK_THRESHOLD;
  }
  return 3 / fps;
}

// =============================================================================
// Timecode Utilities (SMPTE)
// =============================================================================

/**
 * Timecode components structure.
 */
export interface Timecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
}

/**
 * Timecode format options.
 */
export interface TimecodeFormatOptions {
  /** Whether to show hours even when zero */
  showHours?: boolean;
  /** Use drop-frame format (for 29.97fps) */
  dropFrame?: boolean;
  /** Separator character between components */
  separator?: string;
  /** Frame separator (: for non-drop, ; for drop-frame) */
  frameSeparator?: string;
  /** Whether to show component labels (HH:MM:SS:FF format) - currently unused */
  showLabels?: boolean;
}

/**
 * Convert time in seconds to timecode components.
 *
 * @param timeSec Time in seconds
 * @param fps Frames per second
 * @returns Timecode components
 */
export function timeToTimecode(timeSec: number, fps: number = DEFAULT_FPS): Timecode {
  if (!Number.isFinite(timeSec) || !Number.isFinite(fps) || fps <= 0 || timeSec < 0) {
    return { hours: 0, minutes: 0, seconds: 0, frames: 0 };
  }

  const totalFrames = Math.floor(timeSec * fps);
  const framesPerSecond = Math.round(fps);
  const framesPerMinute = framesPerSecond * 60;
  const framesPerHour = framesPerMinute * 60;

  const hours = Math.floor(totalFrames / framesPerHour);
  const remainingAfterHours = totalFrames % framesPerHour;

  const minutes = Math.floor(remainingAfterHours / framesPerMinute);
  const remainingAfterMinutes = remainingAfterHours % framesPerMinute;

  const seconds = Math.floor(remainingAfterMinutes / framesPerSecond);
  const frames = remainingAfterMinutes % framesPerSecond;

  return { hours, minutes, seconds, frames };
}

/**
 * Convert timecode components to time in seconds.
 *
 * @param timecode Timecode components
 * @param fps Frames per second
 * @returns Time in seconds
 */
export function timecodeToTime(timecode: Timecode, fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    return 0;
  }

  const { hours, minutes, seconds, frames } = timecode;
  const totalFrames =
    hours * 60 * 60 * fps +
    minutes * 60 * fps +
    seconds * fps +
    frames;

  return totalFrames / fps;
}

/**
 * Format time as SMPTE timecode string (HH:MM:SS:FF).
 *
 * @param timeSec Time in seconds
 * @param fps Frames per second
 * @param options Format options
 * @returns Formatted timecode string
 *
 * @example
 * formatTimecode(3661.5, 30) // "01:01:01:15"
 * formatTimecode(61.5, 30, { showHours: false }) // "01:01:15"
 */
export function formatTimecode(
  timeSec: number,
  fps: number = DEFAULT_FPS,
  options: TimecodeFormatOptions = {}
): string {
  const {
    showHours = true,
    separator = ':',
    frameSeparator,
  } = options;

  const tc = timeToTimecode(timeSec, fps);
  const framesSep = frameSeparator ?? separator;

  const pad = (n: number, width: number = 2): string =>
    n.toString().padStart(width, '0');

  const parts: string[] = [];

  if (showHours || tc.hours > 0) {
    parts.push(pad(tc.hours));
  }

  parts.push(pad(tc.minutes));
  parts.push(pad(tc.seconds));

  const mainPart = parts.join(separator);
  const framePart = pad(tc.frames);

  return `${mainPart}${framesSep}${framePart}`;
}

/**
 * Format time as simple timestamp (MM:SS or HH:MM:SS).
 *
 * @param timeSec Time in seconds
 * @param showHours Whether to always show hours
 * @returns Formatted timestamp string
 *
 * @example
 * formatTimestamp(125.5) // "02:05"
 * formatTimestamp(3661.5) // "1:01:01"
 */
export function formatTimestamp(timeSec: number, showHours: boolean = false): string {
  if (!Number.isFinite(timeSec) || timeSec < 0) {
    return showHours ? '00:00:00' : '00:00';
  }

  const totalSeconds = Math.floor(timeSec);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number): string => n.toString().padStart(2, '0');

  if (showHours || hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }

  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Format time with milliseconds (MM:SS.mmm or HH:MM:SS.mmm).
 *
 * @param timeSec Time in seconds
 * @param showHours Whether to always show hours
 * @param precision Decimal places for milliseconds (default 3)
 * @returns Formatted timestamp string
 *
 * @example
 * formatTimestampMs(125.567) // "02:05.567"
 */
export function formatTimestampMs(
  timeSec: number,
  showHours: boolean = false,
  precision: number = 3
): string {
  if (!Number.isFinite(timeSec) || timeSec < 0) {
    return showHours ? '00:00:00.000' : '00:00.000';
  }

  const totalSeconds = Math.floor(timeSec);
  const ms = (timeSec - totalSeconds).toFixed(precision).substring(2);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number): string => n.toString().padStart(2, '0');

  if (showHours || hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}.${ms}`;
  }

  return `${pad(minutes)}:${pad(seconds)}.${ms}`;
}

/**
 * Parse a timecode string to seconds.
 *
 * @param timecodeStr Timecode string (HH:MM:SS:FF or MM:SS:FF or SS:FF)
 * @param fps Frames per second
 * @returns Time in seconds, or null if invalid
 *
 * @example
 * parseTimecode("01:02:03:15", 30) // 3723.5
 * parseTimecode("02:03:15", 30) // 123.5
 */
export function parseTimecode(timecodeStr: string, fps: number = DEFAULT_FPS): number | null {
  if (!timecodeStr || !Number.isFinite(fps) || fps <= 0) {
    return null;
  }

  // Support both : and ; separators
  const parts = timecodeStr.split(/[:;]/).map(p => parseInt(p, 10));

  if (parts.some(p => !Number.isFinite(p) || p < 0)) {
    return null;
  }

  let hours = 0, minutes = 0, seconds = 0, frames = 0;

  if (parts.length === 4) {
    [hours, minutes, seconds, frames] = parts;
  } else if (parts.length === 3) {
    [minutes, seconds, frames] = parts;
  } else if (parts.length === 2) {
    [seconds, frames] = parts;
  } else {
    return null;
  }

  // Validate ranges
  if (minutes >= 60 || seconds >= 60 || frames >= fps) {
    return null;
  }

  return timecodeToTime({ hours, minutes, seconds, frames }, fps);
}

// =============================================================================
// Type Exports
// =============================================================================

export type PrecisionKey = keyof typeof PRECISION;
export type SyncThresholdKey = keyof typeof SYNC_THRESHOLDS;
export type SnapThresholdKey = keyof typeof SNAP_THRESHOLDS;

/**
 * Timeline Utility Functions
 *
 * Core utilities for timeline time/pixel conversion, snapping, and bounds calculation.
 * Based on react-timeline-editor patterns for reliable video editing UX.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Timeline scale configuration for time/pixel conversions
 */
export interface TimelineScale {
  /** Pixels per second */
  zoom: number;
  /** Horizontal scroll offset in pixels */
  scrollX: number;
}

/**
 * Clip movement bounds constraints
 */
export interface ClipBounds {
  /** Minimum timeline position (usually 0) */
  minTimelineIn: number;
  /** Maximum timeline position before clip extends past timeline end */
  maxTimelineIn: number;
  /** Maximum amount clip can extend left (into source before current sourceIn) */
  maxExtendLeft: number;
  /** Maximum amount clip can extend right (source content after current sourceOut) */
  maxExtendRight: number;
  /** Minimum allowed clip duration */
  minClipDuration: number;
}

/**
 * Parameters for calculating clip bounds
 */
export interface ClipBoundsParams {
  /** Current clip duration in seconds */
  clipDuration: number;
  /** Current timeline start position in seconds */
  timelineStart: number;
  /** Total timeline duration in seconds */
  timelineDuration: number;
  /** Total source media duration in seconds */
  sourceDuration: number;
  /** Current source in point in seconds */
  sourceIn: number;
  /** Minimum allowed clip duration (default: 0.1) */
  minClipDuration?: number;
}

/**
 * Result of drag delta calculation with threshold
 */
export interface DragDeltaResult {
  /** Whether the delta should trigger an update */
  shouldUpdate: boolean;
  /** The snapped delta value (multiple of threshold) */
  snappedDelta: number;
  /** Remaining accumulated delta for next calculation */
  accumulatedDelta: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default minimum clip duration in seconds */
export const MIN_CLIP_DURATION = 0.1;

/** Default zoom level (pixels per second) */
export const DEFAULT_ZOOM = 100;

/** Common grid intervals in seconds */
export const GRID_INTERVALS = {
  FRAME_30FPS: 1 / 30,
  FRAME_24FPS: 1 / 24,
  FRAME_60FPS: 1 / 60,
  TENTH_SECOND: 0.1,
  QUARTER_SECOND: 0.25,
  HALF_SECOND: 0.5,
  SECOND: 1,
  FIVE_SECONDS: 5,
  TEN_SECONDS: 10,
} as const;

// =============================================================================
// Time <-> Pixel Conversion
// =============================================================================

/**
 * Converts timeline time (seconds) to pixel position
 *
 * @param time - Time in seconds
 * @param scale - Timeline scale configuration
 * @returns Pixel position (viewport-relative when scrollX > 0), or 0 if inputs are invalid
 *
 * @example
 * ```ts
 * const pixel = timeToPixel(5, { zoom: 100, scrollX: 0 }); // 500
 * const viewportPixel = timeToPixel(5, { zoom: 100, scrollX: 200 }); // 300
 * ```
 */
export function timeToPixel(time: number, scale: TimelineScale): number {
  // Guard against NaN/Infinity inputs
  if (!Number.isFinite(time) || !Number.isFinite(scale.zoom) || !Number.isFinite(scale.scrollX)) {
    return 0;
  }
  const result = time * scale.zoom - scale.scrollX;
  return Number.isFinite(result) ? result : 0;
}

/**
 * Converts pixel position to timeline time (seconds)
 *
 * @param pixel - Pixel position (viewport-relative)
 * @param scale - Timeline scale configuration
 * @returns Time in seconds, or 0 if zoom is invalid
 *
 * @example
 * ```ts
 * const time = pixelToTime(500, { zoom: 100, scrollX: 0 }); // 5
 * const time = pixelToTime(300, { zoom: 100, scrollX: 200 }); // 5
 * ```
 */
export function pixelToTime(pixel: number, scale: TimelineScale): number {
  // Guard against division by zero and invalid zoom values
  if (!scale.zoom || scale.zoom <= 0 || !Number.isFinite(scale.zoom)) {
    return 0;
  }
  const result = (pixel + scale.scrollX) / scale.zoom;
  // Guard against NaN/Infinity results
  return Number.isFinite(result) ? result : 0;
}

// =============================================================================
// Grid Snapping
// =============================================================================

/**
 * Snaps a time value to the nearest grid position
 *
 * Uses standard mathematical rounding: values at exactly 0.5 grid snap up.
 *
 * @param time - Time in seconds to snap
 * @param gridInterval - Grid interval in seconds (0 = no snapping)
 * @returns Snapped time value
 *
 * @example
 * ```ts
 * snapToGrid(1.3, 1); // 1
 * snapToGrid(1.5, 1); // 2
 * snapToGrid(1.7, 1); // 2
 * snapToGrid(0.3, 0.5); // 0.5
 * ```
 */
export function snapToGrid(time: number, gridInterval: number): number {
  if (gridInterval <= 0) {
    return time;
  }

  return Math.round(time / gridInterval) * gridInterval;
}

/**
 * Gets the appropriate grid interval based on zoom level
 *
 * Higher zoom = finer grid for precision editing
 *
 * @param zoom - Pixels per second
 * @returns Recommended grid interval in seconds
 */
export function getGridIntervalForZoom(zoom: number): number {
  if (zoom >= 500) return GRID_INTERVALS.FRAME_30FPS;
  if (zoom >= 200) return GRID_INTERVALS.TENTH_SECOND;
  if (zoom >= 100) return GRID_INTERVALS.QUARTER_SECOND;
  if (zoom >= 50) return GRID_INTERVALS.HALF_SECOND;
  if (zoom >= 25) return GRID_INTERVALS.SECOND;
  if (zoom >= 10) return GRID_INTERVALS.FIVE_SECONDS;
  return GRID_INTERVALS.TEN_SECONDS;
}

// =============================================================================
// Time Clamping
// =============================================================================

/**
 * Clamps a time value within specified bounds
 *
 * @param time - Time value to clamp
 * @param min - Minimum allowed value (default: 0)
 * @param max - Maximum allowed value (default: Infinity)
 * @returns Clamped time value
 */
export function clampTime(
  time: number,
  min: number = 0,
  max: number = Number.POSITIVE_INFINITY
): number {
  return Math.max(min, Math.min(max, time));
}

// =============================================================================
// Clip Bounds Calculation
// =============================================================================

/**
 * Calculates movement and resize bounds for a clip
 *
 * Determines how far a clip can be moved or extended based on:
 * - Timeline boundaries
 * - Source media duration
 * - Current clip position and range
 *
 * @param params - Clip configuration parameters
 * @returns Calculated bounds for the clip
 */
export function calculateClipBounds(params: ClipBoundsParams): ClipBounds {
  const {
    clipDuration,
    timelineDuration,
    sourceDuration,
    sourceIn,
    minClipDuration = MIN_CLIP_DURATION,
  } = params;

  // Validate inputs - clamp to safe values
  const safeClipDuration = Math.max(0, Number.isFinite(clipDuration) ? clipDuration : 0);
  const safeTimelineDuration = Math.max(0, Number.isFinite(timelineDuration) ? timelineDuration : 0);
  const safeSourceDuration = Math.max(0, Number.isFinite(sourceDuration) ? sourceDuration : 0);
  const safeSourceIn = Math.max(0, Number.isFinite(sourceIn) ? sourceIn : 0);
  const safeMinClipDuration = Math.max(0, Number.isFinite(minClipDuration) ? minClipDuration : MIN_CLIP_DURATION);

  return {
    minTimelineIn: 0,
    maxTimelineIn: Math.max(0, safeTimelineDuration - safeClipDuration),
    maxExtendLeft: safeSourceIn,
    maxExtendRight: Math.max(0, safeSourceDuration - safeSourceIn - safeClipDuration),
    minClipDuration: safeMinClipDuration,
  };
}

// =============================================================================
// Drag Delta Calculation
// =============================================================================

/**
 * Calculates drag delta with threshold-based accumulation
 *
 * This pattern (from react-timeline-editor) prevents jittery movement by:
 * 1. Accumulating small movements until threshold is reached
 * 2. Snapping to multiples of threshold
 * 3. Preserving remainder for next calculation
 *
 * @param newDelta - New movement delta
 * @param currentAccumulated - Currently accumulated delta
 * @param threshold - Movement threshold (grid size in pixels)
 * @returns Calculation result with update flag and values
 *
 * @example
 * ```ts
 * // Accumulating small movements
 * let acc = 0;
 * let result = calculateDragDelta(3, acc, 5);
 * // { shouldUpdate: false, accumulatedDelta: 3 }
 *
 * result = calculateDragDelta(3, result.accumulatedDelta, 5);
 * // { shouldUpdate: true, snappedDelta: 5, accumulatedDelta: 1 }
 * ```
 */
export function calculateDragDelta(
  newDelta: number,
  currentAccumulated: number,
  threshold: number
): DragDeltaResult {
  // Guard against NaN/Infinity inputs - return safe defaults
  if (!Number.isFinite(newDelta) || !Number.isFinite(currentAccumulated)) {
    return {
      shouldUpdate: false,
      snappedDelta: 0,
      accumulatedDelta: Number.isFinite(currentAccumulated) ? currentAccumulated : 0,
    };
  }

  // No threshold or invalid threshold = immediate update
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return {
      shouldUpdate: true,
      snappedDelta: newDelta,
      accumulatedDelta: 0,
    };
  }

  const totalDelta = currentAccumulated + newDelta;
  const absTotal = Math.abs(totalDelta);

  if (absTotal < threshold) {
    // Not enough movement yet
    return {
      shouldUpdate: false,
      snappedDelta: 0,
      accumulatedDelta: totalDelta,
    };
  }

  // Calculate how many threshold units we've crossed
  const sign = totalDelta >= 0 ? 1 : -1;
  const units = Math.floor(absTotal / threshold);
  const snappedDelta = sign * units * threshold;
  const remainder = totalDelta - snappedDelta;

  return {
    shouldUpdate: true,
    snappedDelta,
    accumulatedDelta: remainder,
  };
}

// =============================================================================
// Additional Utilities
// =============================================================================

/**
 * Calculates clip duration from source range and speed
 */
export function calculateClipDuration(
  sourceIn: number,
  sourceOut: number,
  speed: number = 1
): number {
  const safeSpeed = speed > 0 ? speed : 1;
  return (sourceOut - sourceIn) / safeSpeed;
}

/**
 * Calculates clip end time on timeline
 */
export function calculateClipEndTime(
  timelineIn: number,
  sourceIn: number,
  sourceOut: number,
  speed: number = 1
): number {
  return timelineIn + calculateClipDuration(sourceIn, sourceOut, speed);
}

/**
 * Checks if a point is within a clip's timeline range
 */
export function isTimeWithinClip(
  time: number,
  timelineIn: number,
  sourceIn: number,
  sourceOut: number,
  speed: number = 1
): boolean {
  const clipEnd = calculateClipEndTime(timelineIn, sourceIn, sourceOut, speed);
  return time >= timelineIn && time < clipEnd;
}

/**
 * Result of snap point search
 */
export interface SnapPointResult {
  /** The resulting time (either snapped or original) */
  time: number;
  /** Whether snapping occurred */
  snapped: boolean;
  /** Index of the snap point used, or -1 if not snapped */
  snapIndex: number;
}

/**
 * Finds the best snap point from a list of candidates
 *
 * @param time - Current time position
 * @param snapPoints - Array of potential snap points
 * @param threshold - Maximum distance to snap (in seconds)
 * @returns Snapped time or original time if no snap point is close enough
 */
export function findNearestSnapPoint(
  time: number,
  snapPoints: number[],
  threshold: number
): number {
  const result = findNearestSnapPointWithInfo(time, snapPoints, threshold);
  return result.time;
}

/**
 * Finds the best snap point from a list of candidates with additional info
 *
 * @param time - Current time position
 * @param snapPoints - Array of potential snap points
 * @param threshold - Maximum distance to snap (in seconds)
 * @returns SnapPointResult with time, snapped flag, and snap index
 */
export function findNearestSnapPointWithInfo(
  time: number,
  snapPoints: number[],
  threshold: number
): SnapPointResult {
  // Guard against invalid inputs
  if (!Number.isFinite(time) || !Number.isFinite(threshold) || threshold <= 0) {
    return { time, snapped: false, snapIndex: -1 };
  }

  if (!snapPoints || snapPoints.length === 0) {
    return { time, snapped: false, snapIndex: -1 };
  }

  let nearestDistance = threshold;
  let nearestIndex = -1;

  for (let i = 0; i < snapPoints.length; i++) {
    const point = snapPoints[i];
    if (!Number.isFinite(point)) continue;

    const distance = Math.abs(time - point);

    // Early exit: exact match
    if (distance === 0) {
      return { time: point, snapped: true, snapIndex: i };
    }

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }

  if (nearestIndex >= 0) {
    return {
      time: snapPoints[nearestIndex],
      snapped: true,
      snapIndex: nearestIndex,
    };
  }

  return { time, snapped: false, snapIndex: -1 };
}

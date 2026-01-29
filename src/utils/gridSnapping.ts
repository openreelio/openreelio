/**
 * Grid Snapping System
 *
 * Provides intelligent snapping behavior for timeline operations.
 * Supports snapping to clip edges, playhead, markers, and grid lines.
 * Includes hysteresis (snap lock) to prevent jitter when dragging.
 */

import type { SnapPoint, SnapPointType } from '@/types';
import {
  PRECISION,
  calculateSnapThreshold as calcThreshold,
  calculateSnapReleaseThreshold,
} from '@/constants/precision';

// Re-export for convenience
export type { SnapPoint, SnapPointType } from '@/types';

export interface SnapResult {
  /** Whether snapping occurred */
  snapped: boolean;
  /** The resulting time (snapped or original) */
  time: number;
  /** The snap point that was snapped to (if any) */
  snapPoint?: SnapPoint;
}

/**
 * State for snap hysteresis (snap lock).
 * Prevents jitter when dragging near snap points.
 */
export interface SnapHysteresisState {
  /** Whether currently snapped to a point */
  isSnapped: boolean;
  /** The snap point currently locked to */
  snapPoint: SnapPoint | null;
  /** The threshold at which snap will release */
  releaseThreshold: number;
}

/**
 * Create initial hysteresis state (not snapped).
 */
export function createInitialSnapState(): SnapHysteresisState {
  return {
    isSnapped: false,
    snapPoint: null,
    releaseThreshold: 0,
  };
}

export interface NearestSnapResult {
  /** The nearest snap point */
  point: SnapPoint;
  /** Distance to the snap point */
  distance: number;
}

export interface ClipInfo {
  id: string;
  startTime: number;
  endTime: number;
}

export interface GetSnapPointsOptions {
  /** Array of clips to create snap points from */
  clips: ClipInfo[];
  /** Current playhead time */
  playheadTime: number;
  /** Clip ID to exclude from snap points (e.g., the clip being dragged) */
  excludeClipId: string | null;
  /** Grid interval for grid snap points (optional) */
  gridInterval?: number;
  /** Timeline start time for grid generation */
  timelineStart?: number;
  /** Timeline end time for grid generation */
  timelineEnd?: number;
  /** Array of marker times (optional) */
  markers?: Array<{ id: string; time: number }>;
}

// =============================================================================
// Priority Map
// =============================================================================

/**
 * Priority order for snap point types.
 * Lower number = higher priority.
 */
const SNAP_TYPE_PRIORITY: Record<SnapPointType, number> = {
  playhead: 1,
  marker: 2,
  'clip-start': 3,
  'clip-end': 3,
  grid: 4,
};

// =============================================================================
// Snap Point Creation
// =============================================================================

/**
 * Creates snap points for a clip's start and end positions.
 */
export function createClipSnapPoints(
  clipId: string,
  startTime: number,
  endTime: number
): SnapPoint[] {
  return [
    { time: startTime, type: 'clip-start', clipId },
    { time: endTime, type: 'clip-end', clipId },
  ];
}

/**
 * Creates a playhead snap point.
 */
export function createPlayheadSnapPoint(time: number): SnapPoint {
  return { time, type: 'playhead' };
}

/**
 * Creates a marker snap point.
 */
export function createMarkerSnapPoint(markerId: string, time: number): SnapPoint {
  return { time, type: 'marker', markerId };
}

/**
 * Creates grid snap points within a range.
 */
export function createGridSnapPoints(
  start: number,
  end: number,
  interval: number
): SnapPoint[] {
  if (interval <= 0) return [];

  const points: SnapPoint[] = [];
  for (let t = start; t <= end; t += interval) {
    points.push({ time: t, type: 'grid' });
  }
  return points;
}

// =============================================================================
// Get All Snap Points
// =============================================================================

/**
 * Generates all snap points for the current timeline state.
 */
export function getSnapPoints(options: GetSnapPointsOptions): SnapPoint[] {
  const {
    clips,
    playheadTime,
    excludeClipId,
    gridInterval,
    timelineStart = 0,
    timelineEnd = 0,
    markers = [],
  } = options;

  const points: SnapPoint[] = [];

  // Add clip snap points
  for (const clip of clips) {
    if (clip.id === excludeClipId) continue;
    points.push(...createClipSnapPoints(clip.id, clip.startTime, clip.endTime));
  }

  // Add playhead snap point
  points.push(createPlayheadSnapPoint(playheadTime));

  // Add marker snap points
  for (const marker of markers) {
    points.push(createMarkerSnapPoint(marker.id, marker.time));
  }

  // Add grid snap points if interval specified
  if (gridInterval && gridInterval > 0 && timelineEnd > timelineStart) {
    points.push(...createGridSnapPoints(timelineStart, timelineEnd, gridInterval));
  }

  return points;
}

// =============================================================================
// Find Nearest Snap Point
// =============================================================================

/**
 * Finds the nearest snap point to a given time within a threshold.
 * Returns null if no snap point is within the threshold.
 */
/**
 * Checks if two numbers are approximately equal.
 * Uses centralized SNAP_EPSILON from precision constants.
 */
function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < PRECISION.SNAP_EPSILON;
}

export function findNearestSnapPoint(
  time: number,
  snapPoints: SnapPoint[],
  threshold: number
): NearestSnapResult | null {
  if (snapPoints.length === 0) return null;

  let nearest: NearestSnapResult | null = null;

  for (const point of snapPoints) {
    const distance = Math.abs(point.time - time);

    if (distance > threshold) continue;

    if (nearest === null) {
      nearest = { point, distance };
    } else if (distance < nearest.distance - PRECISION.SNAP_EPSILON) {
      // Clearly closer
      nearest = { point, distance };
    } else if (approxEqual(distance, nearest.distance)) {
      // Same distance (within epsilon) - use priority to decide
      const currentPriority = SNAP_TYPE_PRIORITY[point.type];
      const nearestPriority = SNAP_TYPE_PRIORITY[nearest.point.type];

      if (currentPriority < nearestPriority) {
        nearest = { point, distance };
      }
    }
  }

  return nearest;
}

// =============================================================================
// Snap to Nearest Point
// =============================================================================

/**
 * Attempts to snap a time value to the nearest snap point.
 * Returns the snapped time and information about the snap.
 */
export function snapToNearestPoint(
  time: number,
  snapPoints: SnapPoint[],
  threshold: number
): SnapResult {
  const nearest = findNearestSnapPoint(time, snapPoints, threshold);

  if (nearest === null) {
    return {
      snapped: false,
      time,
    };
  }

  return {
    snapped: true,
    time: nearest.point.time,
    snapPoint: nearest.point,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Calculates an appropriate snap threshold based on zoom level.
 * Higher zoom = smaller threshold (more precise).
 * Now includes MIN/MAX bounds to prevent extreme values.
 *
 * @param zoom Pixels per second
 * @returns Threshold in seconds, clamped between MIN_THRESHOLD and MAX_THRESHOLD
 */
export function calculateSnapThreshold(zoom: number): number {
  // Use centralized threshold calculation with bounds
  return calcThreshold(zoom);
}

/**
 * Performs snapping with hysteresis (snap lock).
 * Once snapped, stays snapped until the release threshold is exceeded.
 * This prevents jitter when dragging near snap points.
 *
 * @param time Current time position
 * @param snapPoints Available snap points
 * @param threshold Snap threshold (for initial snap)
 * @param currentState Current hysteresis state
 * @returns Snap result and updated hysteresis state
 */
export function snapWithHysteresis(
  time: number,
  snapPoints: SnapPoint[],
  threshold: number,
  currentState: SnapHysteresisState
): { result: SnapResult; newState: SnapHysteresisState } {
  // If currently snapped, check if we should release
  if (currentState.isSnapped && currentState.snapPoint) {
    const distance = Math.abs(time - currentState.snapPoint.time);

    // Stay snapped if within release threshold
    if (distance <= currentState.releaseThreshold) {
      return {
        result: {
          snapped: true,
          time: currentState.snapPoint.time,
          snapPoint: currentState.snapPoint,
        },
        newState: currentState,
      };
    }

    // Release snap - continue to find new snap point
  }

  // Find new snap point
  const nearest = findNearestSnapPoint(time, snapPoints, threshold);

  if (nearest === null) {
    // No snap point found - return unsnapped
    return {
      result: { snapped: false, time },
      newState: createInitialSnapState(),
    };
  }

  // Found snap point - create new snapped state with hysteresis
  const releaseThreshold = calculateSnapReleaseThreshold(threshold);

  return {
    result: {
      snapped: true,
      time: nearest.point.time,
      snapPoint: nearest.point,
    },
    newState: {
      isSnapped: true,
      snapPoint: nearest.point,
      releaseThreshold,
    },
  };
}

/**
 * Gets the visual snap indicator position.
 * Used to show a visual guide when snapping is about to occur.
 */
export function getSnapIndicatorPosition(
  time: number,
  snapPoints: SnapPoint[],
  threshold: number,
  zoom: number
): { show: boolean; x: number; snapType: SnapPointType } | null {
  const nearest = findNearestSnapPoint(time, snapPoints, threshold);

  if (nearest === null) return null;

  return {
    show: true,
    x: nearest.point.time * zoom,
    snapType: nearest.point.type,
  };
}

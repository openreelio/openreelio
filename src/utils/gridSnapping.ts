/**
 * Grid Snapping System
 *
 * Provides intelligent snapping behavior for timeline operations.
 * Supports snapping to clip edges, playhead, markers, and grid lines.
 */

import type { SnapPoint, SnapPointType } from '@/types';

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
 * Epsilon for floating point comparison
 */
const EPSILON = 1e-10;

/**
 * Checks if two numbers are approximately equal
 */
function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
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
    } else if (distance < nearest.distance - EPSILON) {
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
 */
export function calculateSnapThreshold(zoom: number): number {
  // At zoom 100 (100px/sec), threshold is 0.1 seconds (10px)
  // Threshold scales inversely with zoom
  const baseThreshold = 10; // pixels
  return baseThreshold / zoom;
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

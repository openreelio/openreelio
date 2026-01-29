/**
 * useTimelineCoordinates Hook
 *
 * Handles coordinate transformations between pixels and time units
 * on the timeline, including snapping functionality.
 *
 * Performance optimized:
 * - Clip snap points are cached separately from playhead snap point
 * - Grid snap points are cached separately
 * - Only recalculates when necessary dependencies change
 */

import { useCallback, useMemo, type RefObject, type MouseEvent } from 'react';
import {
  snapToNearestPoint,
  calculateSnapThreshold,
  createPlayheadSnapPoint,
  createGridSnapPoints,
  createClipSnapPoints,
} from '@/utils/gridSnapping';
import { getGridIntervalForZoom } from '@/utils/timeline';
import type { Sequence, SnapPoint } from '@/types';

// =============================================================================
// Types
// =============================================================================

// Re-export for convenience
export type { SnapPoint } from '@/types';

export interface UseTimelineCoordinatesOptions {
  /** Reference to the tracks area element */
  tracksAreaRef: RefObject<HTMLDivElement | null>;
  /** Current sequence data */
  sequence: Sequence | null;
  /** Current zoom level (pixels per second) */
  zoom: number;
  /** Horizontal scroll offset */
  scrollX: number;
  /** Total timeline duration in seconds */
  duration: number;
  /** Whether snapping is enabled */
  snapEnabled: boolean;
  /** Current playhead position for snap calculations */
  playhead: number;
  /** Track header width in pixels */
  trackHeaderWidth: number;
}

export interface UseTimelineCoordinatesResult {
  /** Grid interval based on zoom level */
  gridInterval: number;
  /** Available snap points */
  snapPoints: SnapPoint[];
  /** Snap threshold based on zoom */
  snapThreshold: number;
  /** Calculate time from mouse event, optionally with snapping */
  calculateTimeFromMouseEvent: (
    e: globalThis.MouseEvent | MouseEvent,
    applySnapping?: boolean
  ) => { time: number | null; snapPoint: SnapPoint | null };
  /** Convert time to pixel position */
  timeToPixel: (time: number) => number;
  /** Convert pixel position to time */
  pixelToTime: (pixel: number) => number;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for coordinate transformations on the timeline.
 *
 * @param options - Coordinate calculation options
 * @returns Coordinate utilities and snap points
 *
 * @example
 * ```tsx
 * const { calculateTimeFromMouseEvent, timeToPixel } = useTimelineCoordinates({
 *   tracksAreaRef,
 *   sequence,
 *   zoom,
 *   scrollX,
 *   duration,
 *   snapEnabled,
 *   playhead,
 *   trackHeaderWidth: TRACK_HEADER_WIDTH,
 * });
 * ```
 */
export function useTimelineCoordinates({
  tracksAreaRef,
  sequence,
  zoom,
  scrollX,
  duration,
  snapEnabled,
  playhead,
  trackHeaderWidth,
}: UseTimelineCoordinatesOptions): UseTimelineCoordinatesResult {
  // Calculate grid interval based on zoom
  const gridInterval = useMemo(() => getGridIntervalForZoom(zoom), [zoom]);

  /**
   * Clip snap points - only recalculated when sequence changes.
   * This is the expensive calculation that was previously running every frame.
   */
  const clipSnapPoints = useMemo(() => {
    if (!sequence || !snapEnabled) return [];

    const points: SnapPoint[] = [];
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        const endTime =
          clip.place.timelineInSec +
          (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
        points.push(...createClipSnapPoints(clip.id, clip.place.timelineInSec, endTime));
      }
    }
    return points;
  }, [sequence, snapEnabled]);

  /**
   * Grid snap points - recalculated when grid interval or duration changes.
   * Separate from clip points to avoid recalculating both together.
   */
  const gridSnapPoints = useMemo(() => {
    if (!snapEnabled || gridInterval <= 0 || duration <= 0) return [];
    return createGridSnapPoints(0, duration, gridInterval);
  }, [snapEnabled, gridInterval, duration]);

  /**
   * Playhead snap point - cheap to create, changes frequently during playback.
   * By separating this, we avoid recalculating expensive clip points.
   */
  const playheadSnapPoint = useMemo(() => {
    if (!snapEnabled) return null;
    return createPlayheadSnapPoint(playhead);
  }, [snapEnabled, playhead]);

  /**
   * Combined snap points - merges all snap point sources.
   * Only creates new array when any source changes.
   */
  const snapPoints = useMemo(() => {
    if (!snapEnabled) return [];

    const points: SnapPoint[] = [...clipSnapPoints, ...gridSnapPoints];
    if (playheadSnapPoint) {
      points.push(playheadSnapPoint);
    }
    return points;
  }, [snapEnabled, clipSnapPoints, gridSnapPoints, playheadSnapPoint]);

  // Calculate snap threshold based on zoom
  const snapThreshold = useMemo(() => calculateSnapThreshold(zoom), [zoom]);

  // Convert time to pixel position with input validation
  const timeToPixel = useCallback(
    (time: number): number => {
      // Guard against NaN/Infinity
      if (!Number.isFinite(time)) {
        return 0;
      }
      return time * zoom;
    },
    [zoom]
  );

  // Convert pixel position to time with input validation
  const pixelToTime = useCallback(
    (pixel: number): number => {
      // Guard against NaN/Infinity and division by zero
      if (!Number.isFinite(pixel) || zoom <= 0) {
        return 0;
      }
      return pixel / zoom;
    },
    [zoom]
  );

  // Calculate time from mouse event with optional snapping
  const calculateTimeFromMouseEvent = useCallback(
    (
      e: globalThis.MouseEvent | MouseEvent,
      applySnapping: boolean = false
    ): { time: number | null; snapPoint: SnapPoint | null } => {
      if (!tracksAreaRef.current) {
        return { time: null, snapPoint: null };
      }

      const rect = tracksAreaRef.current.getBoundingClientRect();
      const relativeX = e.clientX - rect.left - trackHeaderWidth + scrollX;
      let time = Math.max(0, Math.min(duration, relativeX / zoom));
      let snapPoint: SnapPoint | null = null;

      // Apply snapping if enabled
      if (applySnapping && snapEnabled && snapPoints.length > 0) {
        const snapResult = snapToNearestPoint(time, snapPoints, snapThreshold);
        if (snapResult.snapped) {
          time = snapResult.time;
          snapPoint = {
            time: snapResult.time,
            type: snapResult.snapPoint?.type || 'grid',
          };
        }
      }

      return { time, snapPoint };
    },
    [tracksAreaRef, scrollX, zoom, duration, snapEnabled, snapPoints, snapThreshold, trackHeaderWidth]
  );

  return {
    gridInterval,
    snapPoints,
    snapThreshold,
    calculateTimeFromMouseEvent,
    timeToPixel,
    pixelToTime,
  };
}

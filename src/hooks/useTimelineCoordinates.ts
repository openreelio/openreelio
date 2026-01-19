/**
 * useTimelineCoordinates Hook
 *
 * Handles coordinate transformations between pixels and time units
 * on the timeline, including snapping functionality.
 */

import { useCallback, useMemo, type RefObject, type MouseEvent } from 'react';
import { getSnapPoints, snapToNearestPoint, calculateSnapThreshold } from '@/utils/gridSnapping';
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

  // Calculate snap points for all clips
  const snapPoints = useMemo(() => {
    if (!sequence || !snapEnabled) return [];

    const clips = sequence.tracks.flatMap((track) =>
      track.clips.map((clip) => ({
        id: clip.id,
        startTime: clip.place.timelineInSec,
        endTime:
          clip.place.timelineInSec +
          (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed,
      }))
    );

    return getSnapPoints({
      clips,
      playheadTime: playhead,
      excludeClipId: null,
      gridInterval,
      timelineStart: 0,
      timelineEnd: duration,
    });
  }, [sequence, snapEnabled, playhead, gridInterval, duration]);

  // Calculate snap threshold based on zoom
  const snapThreshold = useMemo(() => calculateSnapThreshold(zoom), [zoom]);

  // Convert time to pixel position
  const timeToPixel = useCallback(
    (time: number): number => {
      return time * zoom;
    },
    [zoom]
  );

  // Convert pixel position to time
  const pixelToTime = useCallback(
    (pixel: number): number => {
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

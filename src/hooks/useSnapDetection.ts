/**
 * useSnapDetection Hook
 *
 * Detects snap points during timeline interactions (playhead, clip edges, markers, grid).
 * Returns helpers for building snap points and finding the nearest snap candidate.
 */

import { useCallback, useMemo } from 'react';
import type { SnapPoint } from '@/types';
import { SNAP_THRESHOLD_PX } from '@/constants/editing';

/** Extended snap point with visual properties */
export interface ExtendedSnapPoint extends SnapPoint {
  /** Pixel position (calculated from time * zoom - scrollX) */
  pixelX?: number;
  /** Label for the snap point */
  label?: string;
}

export interface UseSnapDetectionOptions {
  /** Whether snapping is enabled */
  enabled: boolean;
  /** Snap threshold in pixels */
  threshold?: number;
  /** Current zoom level */
  zoom: number;
  /** Current scroll position */
  scrollX: number;
  /** Playhead time */
  playheadTime: number;
  /** All clip edges (start and end times) */
  clipEdges: number[];
  /** Marker times */
  markerTimes?: number[];
  /** Grid interval in seconds (optional) */
  gridInterval?: number;
}

export interface UseSnapDetectionReturn {
  /** Find nearest snap point to a time */
  findSnapPoint: (
    time: number,
    excludeTimes?: number[],
  ) => { snappedTime: number; snapPoint: SnapPoint | null };
  /** Get all potential snap points */
  getAllSnapPoints: () => ExtendedSnapPoint[];
}

export function useSnapDetection(options: UseSnapDetectionOptions): UseSnapDetectionReturn {
  const {
    enabled,
    threshold = SNAP_THRESHOLD_PX,
    zoom,
    scrollX,
    playheadTime,
    clipEdges,
    markerTimes = [],
    gridInterval,
  } = options;

  const timeToPixel = useCallback(
    (time: number): number => {
      return time * zoom - scrollX;
    },
    [zoom, scrollX],
  );

  const getAllSnapPoints = useCallback((): ExtendedSnapPoint[] => {
    if (!enabled) return [];

    const points: ExtendedSnapPoint[] = [];

    // Playhead
    points.push({
      time: playheadTime,
      pixelX: timeToPixel(playheadTime),
      type: 'playhead',
      label: 'Playhead',
    });

    // Clip edges
    for (const edge of clipEdges) {
      points.push({
        time: edge,
        pixelX: timeToPixel(edge),
        type: 'clip-start', // Generic clip edge - could be start or end
      });
    }

    // Markers
    for (const marker of markerTimes) {
      points.push({
        time: marker,
        pixelX: timeToPixel(marker),
        type: 'marker',
      });
    }

    // Grid lines (if grid interval is specified)
    if (gridInterval && gridInterval > 0) {
      const visibleStart = scrollX / zoom;
      const visibleEnd = (scrollX + window.innerWidth) / zoom;

      const startGrid = Math.floor(visibleStart / gridInterval) * gridInterval;
      const endGrid = Math.ceil(visibleEnd / gridInterval) * gridInterval;

      for (let t = startGrid; t <= endGrid; t += gridInterval) {
        points.push({
          time: t,
          pixelX: timeToPixel(t),
          type: 'grid',
        });
      }
    }

    return points;
  }, [enabled, playheadTime, clipEdges, markerTimes, gridInterval, zoom, scrollX, timeToPixel]);

  const findSnapPoint = useCallback(
    (
      time: number,
      excludeTimes: number[] = [],
    ): { snappedTime: number; snapPoint: SnapPoint | null } => {
      if (!enabled) {
        return { snappedTime: time, snapPoint: null };
      }

      const points = getAllSnapPoints();
      const safeZoom = zoom > 0 ? zoom : 1;
      const thresholdTime = threshold / safeZoom;

      let nearestPoint: SnapPoint | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;

      for (const point of points) {
        // Skip excluded times
        if (excludeTimes.some((t) => Math.abs(t - point.time) < 0.001)) {
          continue;
        }

        const distance = Math.abs(point.time - time);
        if (distance < thresholdTime && distance < nearestDistance) {
          nearestDistance = distance;
          nearestPoint = point;
        }
      }

      if (nearestPoint) {
        return {
          snappedTime: nearestPoint.time,
          snapPoint: nearestPoint,
        };
      }

      return { snappedTime: time, snapPoint: null };
    },
    [enabled, threshold, zoom, getAllSnapPoints],
  );

  return useMemo(
    () => ({
      findSnapPoint,
      getAllSnapPoints,
    }),
    [findSnapPoint, getAllSnapPoints],
  );
}


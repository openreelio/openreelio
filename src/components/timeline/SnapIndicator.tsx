/**
 * SnapIndicator Component
 *
 * Renders visual indicator lines showing where snapping is occurring
 * during playhead scrubbing or clip dragging operations.
 *
 * @module components/timeline/SnapIndicator
 */

import { memo, useMemo, useCallback } from 'react';
import type { SnapPoint, SnapPointType } from '@/types';
import { SNAP_THRESHOLD_PX } from '@/constants/editing';

// =============================================================================
// Types
// =============================================================================

// Re-export for convenience
export type { SnapPoint } from '@/types';

/** Extended snap point with visual properties */
export interface ExtendedSnapPoint extends SnapPoint {
  /** Pixel position (calculated from time * zoom - scrollX) */
  pixelX?: number;
  /** Label for the snap point */
  label?: string;
}

interface SnapIndicatorProps {
  /** Active snap point to display (null if not snapping) */
  snapPoint: SnapPoint | null;
  /** Whether snapping should be shown */
  isActive: boolean;
  /** Current zoom level (pixels per second) */
  zoom: number;
  /** Track header width in pixels */
  trackHeaderWidth: number;
  /** Horizontal scroll offset */
  scrollX: number;
}

/** Props for multi-point snap indicator */
interface MultiSnapIndicatorProps {
  /** All active snap points to display */
  snapPoints: ExtendedSnapPoint[];
  /** Height of the indicator lines */
  height: number;
  /** Whether snapping is currently active */
  isSnapping: boolean;
  /** Offset from top of timeline area */
  topOffset?: number;
  /** Current zoom level */
  zoom: number;
  /** Current scroll position */
  scrollX: number;
  /** Track header width */
  trackHeaderWidth: number;
}

// =============================================================================
// Constants
// =============================================================================

const SNAP_COLORS: Record<SnapPointType | 'default', string> = {
  playhead: '#fbbf24', // amber-400
  'clip-start': '#60a5fa', // blue-400
  'clip-end': '#60a5fa', // blue-400
  marker: '#a78bfa', // violet-400
  grid: '#6b7280', // gray-500
  default: '#fbbf24', // amber-400
};

// =============================================================================
// Components
// =============================================================================

/**
 * Renders a vertical line indicator showing the snap position on the timeline.
 *
 * @example
 * ```tsx
 * <SnapIndicator
 *   snapPoint={activeSnapPoint}
 *   isActive={isScrubbing}
 *   zoom={zoom}
 *   trackHeaderWidth={TRACK_HEADER_WIDTH}
 *   scrollX={scrollX}
 * />
 * ```
 */
export function SnapIndicator({
  snapPoint,
  isActive,
  zoom,
  trackHeaderWidth,
  scrollX,
}: SnapIndicatorProps) {
  if (!snapPoint || !isActive) {
    return null;
  }

  const color = SNAP_COLORS[snapPoint.type] || SNAP_COLORS.default;

  return (
    <div
      data-testid="snap-indicator"
      className="absolute top-0 bottom-0 w-px pointer-events-none z-30"
      style={{
        left: `${trackHeaderWidth + snapPoint.time * zoom - scrollX}px`,
        backgroundColor: color,
        boxShadow: `0 0 4px ${color}`,
      }}
    />
  );
}

/**
 * Enhanced snap indicator for multiple snap points.
 *
 * Features:
 * - Shows vertical lines at snap positions
 * - Color-coded by snap type
 * - Indicator dots at line ends
 * - Optional labels
 */
export const MultiSnapIndicator = memo(function MultiSnapIndicator({
  snapPoints,
  height,
  isSnapping,
  topOffset = 0,
  zoom,
  scrollX,
  trackHeaderWidth,
}: MultiSnapIndicatorProps) {
  if (!isSnapping || snapPoints.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute inset-0 z-50"
      style={{ top: topOffset }}
      data-testid="multi-snap-indicator-container"
    >
      {snapPoints.map((point, index) => {
        const pixelX = point.pixelX ?? (trackHeaderWidth + point.time * zoom - scrollX);
        const color = SNAP_COLORS[point.type] || SNAP_COLORS.default;

        return (
          <div
            key={`${point.type}-${point.time}-${index}`}
            className="absolute transition-opacity duration-100"
            style={{
              left: pixelX,
              top: 0,
              height,
            }}
            data-testid={`snap-line-${point.type}`}
          >
            {/* Main snap line */}
            <div
              className="absolute w-px opacity-80"
              style={{
                height: '100%',
                backgroundColor: color,
                boxShadow: `0 0 4px ${color}`,
              }}
            />

            {/* Top indicator dot */}
            <div
              className="absolute -left-1 -top-1 h-2 w-2 rounded-full"
              style={{
                backgroundColor: color,
                boxShadow: `0 0 6px ${color}`,
              }}
            />

            {/* Bottom indicator dot */}
            <div
              className="absolute -left-1 h-2 w-2 rounded-full"
              style={{
                bottom: -4,
                backgroundColor: color,
                boxShadow: `0 0 6px ${color}`,
              }}
            />

            {/* Label (if provided) */}
            {point.label && (
              <div
                className="absolute left-2 top-0 whitespace-nowrap rounded bg-gray-800/90 px-1 py-0.5 text-xs text-white"
                style={{
                  borderLeft: `2px solid ${color}`,
                }}
              >
                {point.label}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

// =============================================================================
// Hook for snap detection
// =============================================================================

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
  findSnapPoint: (time: number, excludeTimes?: number[]) => { snappedTime: number; snapPoint: SnapPoint | null };
  /** Get all potential snap points */
  getAllSnapPoints: () => ExtendedSnapPoint[];
}

/**
 * Hook for detecting snap points during drag operations.
 *
 * @example
 * ```tsx
 * const { findSnapPoint } = useSnapDetection({
 *   enabled: snapEnabled,
 *   threshold: 10,
 *   zoom,
 *   scrollX,
 *   playheadTime: currentTime,
 *   clipEdges: getClipEdges(),
 * });
 *
 * const { snappedTime, snapPoint } = findSnapPoint(dragTime);
 * ```
 */
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

  const timeToPixel = useCallback((time: number): number => {
    return time * zoom - scrollX;
  }, [zoom, scrollX]);

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

  const findSnapPoint = useCallback((
    time: number,
    excludeTimes: number[] = []
  ): { snappedTime: number; snapPoint: SnapPoint | null } => {
    if (!enabled) {
      return { snappedTime: time, snapPoint: null };
    }

    const points = getAllSnapPoints();
    const thresholdTime = threshold / zoom;

    let nearestPoint: SnapPoint | null = null;
    let nearestDistance = Infinity;

    for (const point of points) {
      // Skip excluded times
      if (excludeTimes.some(t => Math.abs(t - point.time) < 0.001)) {
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
  }, [enabled, threshold, zoom, getAllSnapPoints]);

  return useMemo(() => ({
    findSnapPoint,
    getAllSnapPoints,
  }), [findSnapPoint, getAllSnapPoints]);
}

export default SnapIndicator;

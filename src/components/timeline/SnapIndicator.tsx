/**
 * SnapIndicator Component
 *
 * Renders visual indicator lines showing where snapping is occurring
 * during playhead scrubbing or clip dragging operations.
 *
 * @module components/timeline/SnapIndicator
 */

import { memo } from 'react';
import type { SnapPoint, SnapPointType } from '@/types';
import type { ExtendedSnapPoint } from '@/hooks/useSnapDetection';

// =============================================================================
// Types
// =============================================================================

// Re-export for convenience
export type { SnapPoint } from '@/types';

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

export default SnapIndicator;

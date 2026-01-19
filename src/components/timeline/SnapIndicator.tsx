/**
 * SnapIndicator Component
 *
 * Renders a visual indicator line showing where snapping is occurring
 * during playhead scrubbing or clip dragging operations.
 */

import type { SnapPoint } from '@/types';

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

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a vertical line indicator showing the snap position on the timeline.
 *
 * @param props - Component props
 * @returns Snap indicator element or null if not snapping
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

  return (
    <div
      data-testid="snap-indicator"
      className="absolute top-0 bottom-0 w-px bg-yellow-400 pointer-events-none z-30"
      style={{
        left: `${trackHeaderWidth + snapPoint.time * zoom - scrollX}px`,
      }}
    />
  );
}

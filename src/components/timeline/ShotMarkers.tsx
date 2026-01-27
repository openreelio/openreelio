/**
 * ShotMarkers Component
 *
 * Displays shot boundaries as vertical markers on the timeline.
 * Shots are visualized as subtle vertical lines at scene change points.
 */

import { useMemo, useCallback, type MouseEvent } from 'react';
import type { Shot } from '@/hooks/useShotDetection';

// =============================================================================
// Types
// =============================================================================

interface ShotMarkersProps {
  /** Array of detected shots to display */
  shots: Shot[];
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Horizontal scroll offset in pixels */
  scrollX?: number;
  /** Visible viewport width in pixels */
  viewportWidth?: number;
  /** Total timeline duration in seconds */
  duration?: number;
  /** Track header width offset in pixels */
  trackHeaderWidth?: number;
  /** Selected shot IDs */
  selectedShotIds?: string[];
  /** Whether interaction is disabled */
  disabled?: boolean;
  /** Shot click handler */
  onShotClick?: (shotId: string, timeSec: number) => void;
  /** Shot boundary click handler (to seek to that time) */
  onSeek?: (timeSec: number) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Buffer zone in pixels for virtualization */
const VIRTUALIZATION_BUFFER_PX = 50;

/** Shot marker colors */
const SHOT_MARKER_COLOR = 'rgba(251, 191, 36, 0.6)'; // Amber with transparency
const SHOT_MARKER_SELECTED_COLOR = 'rgba(251, 191, 36, 1)';

// =============================================================================
// Component
// =============================================================================

export function ShotMarkers({
  shots,
  zoom,
  scrollX = 0,
  viewportWidth = 1200,
  duration = 60,
  trackHeaderWidth = 0,
  selectedShotIds = [],
  disabled = false,
  onShotClick,
  onSeek,
}: ShotMarkersProps) {
  // Calculate content width
  const contentWidth = duration * zoom;

  // Get shot boundaries (start times only, excluding 0)
  // Each shot boundary represents a scene change point
  // Using index from map iteration instead of findIndex to avoid O(n²)
  const shotBoundaries = useMemo(() => {
    return shots
      .map((shot, index) => ({
        id: shot.id,
        timeSec: shot.startSec,
        shotIndex: index,
      }))
      .filter((boundary) => boundary.timeSec > 0.01); // Exclude the first boundary at 0
  }, [shots]);

  // Virtualize boundaries - only render visible ones
  const visibleBoundaries = useMemo(() => {
    const startTime = (scrollX - VIRTUALIZATION_BUFFER_PX) / zoom;
    const endTime = (scrollX + viewportWidth + VIRTUALIZATION_BUFFER_PX) / zoom;

    return shotBoundaries.filter((boundary) => {
      return boundary.timeSec >= startTime && boundary.timeSec <= endTime;
    });
  }, [shotBoundaries, zoom, scrollX, viewportWidth]);

  // Handle boundary click - memoized to prevent unnecessary re-renders
  const handleBoundaryClick = useCallback(
    (e: MouseEvent, boundaryId: string, timeSec: number) => {
      e.stopPropagation();
      if (disabled) return;

      if (onShotClick) {
        onShotClick(boundaryId, timeSec);
      }
      if (onSeek) {
        onSeek(timeSec);
      }
    },
    [disabled, onShotClick, onSeek]
  );

  // No markers to render if no shots or no boundaries (only shot starts at 0)
  if (shots.length === 0 || shotBoundaries.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="shot-markers"
      className="absolute inset-0 pointer-events-none overflow-hidden"
      style={{ zIndex: 5, left: trackHeaderWidth }}
    >
      {/* Scrollable container */}
      <div
        className="absolute inset-0"
        style={{
          width: `${contentWidth}px`,
          transform: `translateX(-${scrollX}px)`,
        }}
      >
        {/* Render visible shot boundaries */}
        {visibleBoundaries.map((boundary) => {
          const isSelected = selectedShotIds.includes(boundary.id);
          const left = boundary.timeSec * zoom;

          return (
            <div
              key={boundary.id}
              data-testid={`shot-marker-${boundary.id}`}
              className={`
                absolute top-0 bottom-0 w-px
                transition-colors duration-100
                ${disabled ? 'cursor-not-allowed' : 'cursor-pointer pointer-events-auto'}
                group
              `}
              style={{
                left: `${left}px`,
                backgroundColor: isSelected
                  ? SHOT_MARKER_SELECTED_COLOR
                  : SHOT_MARKER_COLOR,
              }}
              onClick={(e) => handleBoundaryClick(e, boundary.id, boundary.timeSec)}
              title={`Shot ${boundary.shotIndex + 1} at ${boundary.timeSec.toFixed(2)}s`}
            >
              {/* Wider hover target */}
              <div
                className="absolute -left-2 -right-2 top-0 bottom-0"
                style={{ zIndex: -1 }}
              />

              {/* Marker head (small triangle at top) */}
              <div
                className={`
                  absolute -top-0 left-1/2 -translate-x-1/2
                  w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px]
                  border-l-transparent border-r-transparent
                  transition-colors duration-100
                `}
                style={{
                  borderTopColor: isSelected
                    ? SHOT_MARKER_SELECTED_COLOR
                    : SHOT_MARKER_COLOR,
                }}
              />

              {/* Hover tooltip */}
              <div
                className={`
                  absolute top-2 left-1/2 -translate-x-1/2
                  px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap
                  bg-black/80 text-white
                  opacity-0 group-hover:opacity-100
                  transition-opacity duration-150
                  pointer-events-none
                `}
              >
                Shot {boundary.shotIndex + 1}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ShotMarkers;

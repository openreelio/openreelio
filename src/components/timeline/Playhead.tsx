/**
 * Playhead Component
 *
 * Displays the current playback position on the timeline with a draggable handle.
 * The playhead consists of:
 * - A vertical line indicating the current time position (spanning ruler and tracks)
 * - A draggable head marker at the top for direct manipulation
 *
 * @module components/timeline/Playhead
 */

import { memo, useCallback, type MouseEvent, type PointerEvent } from 'react';

// =============================================================================
// Types
// =============================================================================

/**
 * Props for the Playhead component.
 */
export interface PlayheadProps {
  /** Current position in seconds */
  position: number;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Horizontal scroll offset in pixels */
  scrollX?: number;
  /** Track header width in pixels */
  trackHeaderWidth?: number;
  /** Whether playback is active */
  isPlaying?: boolean;
  /** Whether the playhead is currently being dragged */
  isDragging?: boolean;
  /** Callback when drag starts (mouse) */
  onDragStart?: (e: MouseEvent) => void;
  /** Callback when pointer down (for touch support) */
  onPointerDown?: (e: PointerEvent) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Width of the playhead line in pixels */
const LINE_WIDTH = 2;

/** Size of the playhead head marker in pixels */
const HEAD_SIZE = 10;

/** Hover/interaction zone padding for the head (pixels) */
const HEAD_HIT_AREA_PADDING = 10;

/** Default track header width */
const DEFAULT_TRACK_HEADER_WIDTH = 192;

/** Height of the ruler area in pixels */
const RULER_HEIGHT = 24;

// =============================================================================
// Component
// =============================================================================

/**
 * Playhead component for timeline navigation.
 *
 * Features:
 * - Visual time position indicator
 * - Draggable head marker for direct seeking
 * - Touch-friendly hit area
 * - Visual feedback during drag operations
 * - Animation during playback
 * - Memoized for performance
 */
function PlayheadComponent({
  position,
  zoom,
  scrollX = 0,
  trackHeaderWidth = DEFAULT_TRACK_HEADER_WIDTH,
  isPlaying = false,
  isDragging = false,
  onDragStart,
  onPointerDown,
}: PlayheadProps) {
  // Calculate pixel position: (time * zoom) + trackHeader - scroll
  const pixelPosition = position * zoom + trackHeaderWidth - scrollX;

  /**
   * Handle mouse down on the playhead head.
   */
  const handleMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      onDragStart?.(e);
    },
    [onDragStart]
  );

  /**
   * Handle pointer down for touch/stylus support.
   */
  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      onPointerDown?.(e);
    },
    [onPointerDown]
  );

  // Determine visual state
  const isInteractive = Boolean(onDragStart || onPointerDown);
  const headCursor = isDragging ? 'grabbing' : isInteractive ? 'grab' : 'default';

  return (
    <div
      data-testid="playhead"
      data-playing={isPlaying ? 'true' : 'false'}
      data-dragging={isDragging ? 'true' : 'false'}
      className="absolute top-0 h-full z-30 pointer-events-none"
      style={{
        left: `${pixelPosition}px`,
        width: `${LINE_WIDTH}px`,
        willChange: isPlaying || isDragging ? 'left' : undefined,
      }}
    >
      {/* Vertical line - extends full height (ruler + tracks) */}
      <div
        data-testid="playhead-line"
        className="absolute top-0 left-0 w-full h-full pointer-events-none bg-timeline-playhead-line"
      />

      {/* Draggable head marker - positioned in ruler area */}
      <div
        data-testid="playhead-head"
        role="slider"
        aria-label="Playhead position"
        aria-valuemin={0}
        aria-valuenow={position}
        aria-orientation="horizontal"
        tabIndex={isInteractive ? 0 : -1}
        className={`
          absolute select-none touch-none
          ${isDragging ? 'scale-110' : 'hover:scale-105'}
          transition-transform duration-75
        `}
        style={{
          // Position the head in the ruler area, centered on the line
          top: `${(RULER_HEIGHT - HEAD_SIZE) / 2}px`,
          left: '50%',
          transform: 'translateX(-50%)',
          // Hit area for easier interaction
          width: `${HEAD_SIZE + HEAD_HIT_AREA_PADDING * 2}px`,
          height: `${HEAD_SIZE + HEAD_HIT_AREA_PADDING * 2}px`,
          // Enable pointer events for interaction
          pointerEvents: isInteractive ? 'auto' : 'none',
          cursor: headCursor,
        }}
        onMouseDown={handleMouseDown}
        onPointerDown={handlePointerDown}
      >
        {/* Visual head - downward pointing triangle */}
        <div
          data-testid="playhead-head-visual"
          className={`
            absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
            ${isDragging ? 'drop-shadow-lg' : ''}
          `}
          style={{
            width: 0,
            height: 0,
            borderLeft: `${HEAD_SIZE / 2}px solid transparent`,
            borderRight: `${HEAD_SIZE / 2}px solid transparent`,
            borderTop: `${HEAD_SIZE}px solid #ef4444`,
          }}
        />
      </div>
    </div>
  );
}

/**
 * Memoized Playhead component.
 */
export const Playhead = memo(PlayheadComponent);

export default Playhead;

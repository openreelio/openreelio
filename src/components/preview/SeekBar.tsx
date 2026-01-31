/**
 * SeekBar Component
 *
 * Video player seek bar with progress, buffer indicators, and draggable scrubber.
 *
 * Features:
 * - Visual distinction between played (colored) and unplayed (gray) portions
 * - Buffer bar showing loaded content
 * - Draggable scrubber thumb for seeking
 * - Hover preview showing target time
 * - Click-to-seek functionality
 * - Touch-friendly interaction
 */

import { useCallback, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { formatDuration } from '@/utils/formatters';

// =============================================================================
// Types
// =============================================================================

export interface SeekBarProps {
  /** Current playback time in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
  /** Buffered time in seconds */
  buffered?: number;
  /** Callback when user seeks to a position */
  onSeek?: (time: number) => void;
  /** Whether the seek bar is disabled */
  disabled?: boolean;
  /** Optional custom class name */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Scrubber thumb size in pixels */
const THUMB_SIZE = 14;

/** Seek bar height when not hovering */
const BAR_HEIGHT_NORMAL = 4;

/** Seek bar height when hovering */
const BAR_HEIGHT_HOVER = 6;

// =============================================================================
// Component
// =============================================================================

export function SeekBar({
  currentTime,
  duration,
  buffered = 0,
  onSeek,
  disabled = false,
  className = '',
}: SeekBarProps) {
  // ===========================================================================
  // State
  // ===========================================================================

  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [hoverPosition, setHoverPosition] = useState(0);
  const [hoverTime, setHoverTime] = useState(0);

  // ===========================================================================
  // Calculations
  // ===========================================================================

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Calculate time from a mouse/pointer event position.
   */
  const getTimeFromEvent = useCallback(
    (clientX: number): number => {
      if (!containerRef.current || duration <= 0) return 0;

      const rect = containerRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const percent = Math.max(0, Math.min(1, x / rect.width));
      return percent * duration;
    },
    [duration]
  );

  /**
   * Get horizontal position percentage from a mouse/pointer event.
   */
  const getPositionFromEvent = useCallback((clientX: number): number => {
    if (!containerRef.current) return 0;

    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.min(100, (x / rect.width) * 100));
  }, []);

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  /**
   * Handle click on the seek bar track.
   */
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (disabled || !onSeek || isDragging) return;

      const time = getTimeFromEvent(e.clientX);
      onSeek(time);
    },
    [disabled, onSeek, isDragging, getTimeFromEvent]
  );

  /**
   * Handle pointer down on the scrubber thumb or track.
   */
  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (disabled || !onSeek) return;

      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);

      // Capture pointer for smooth dragging outside element
      // Guard for test environments (jsdom) that don't support pointer capture
      const target = e.target as HTMLElement;
      if (typeof target.setPointerCapture === 'function') {
        target.setPointerCapture(e.pointerId);
      }

      // Seek to clicked position immediately
      const time = getTimeFromEvent(e.clientX);
      onSeek(time);
    },
    [disabled, onSeek, getTimeFromEvent]
  );

  /**
   * Handle pointer move during drag.
   */
  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!containerRef.current) return;

      // Update hover position for preview
      const position = getPositionFromEvent(e.clientX);
      const time = getTimeFromEvent(e.clientX);
      setHoverPosition(position);
      setHoverTime(time);

      // If dragging, seek to new position
      if (isDragging && onSeek && !disabled) {
        onSeek(time);
      }
    },
    [isDragging, onSeek, disabled, getTimeFromEvent, getPositionFromEvent]
  );

  /**
   * Handle pointer up to end drag.
   */
  const handlePointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;

      // Guard for test environments (jsdom) that don't support pointer capture
      const target = e.target as HTMLElement;
      if (typeof target.releasePointerCapture === 'function') {
        target.releasePointerCapture(e.pointerId);
      }
      setIsDragging(false);
    },
    [isDragging]
  );

  /**
   * Handle mouse enter for hover effects.
   */
  const handleMouseEnter = useCallback(() => {
    if (!disabled) {
      setIsHovering(true);
    }
  }, [disabled]);

  /**
   * Handle mouse leave.
   */
  const handleMouseLeave = useCallback(() => {
    setIsHovering(false);
  }, []);

  // ===========================================================================
  // Render
  // ===========================================================================

  const barHeight = isHovering || isDragging ? BAR_HEIGHT_HOVER : BAR_HEIGHT_NORMAL;
  const showThumb = isHovering || isDragging;

  return (
    <div
      ref={containerRef}
      data-testid="seek-bar"
      role="slider"
      aria-valuenow={currentTime}
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-label="Seek"
      aria-disabled={disabled}
      className={`
        relative w-full cursor-pointer select-none touch-none
        transition-all duration-150
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${className}
      `}
      style={{
        height: `${Math.max(barHeight, THUMB_SIZE)}px`,
        paddingTop: `${(Math.max(barHeight, THUMB_SIZE) - barHeight) / 2}px`,
        paddingBottom: `${(Math.max(barHeight, THUMB_SIZE) - barHeight) / 2}px`,
      }}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Track background (unplayed portion) */}
      <div
        data-testid="seek-bar-track"
        className="absolute left-0 right-0 rounded-full bg-gray-600/60"
        style={{
          height: `${barHeight}px`,
          top: '50%',
          transform: 'translateY(-50%)',
        }}
      />

      {/* Buffer bar */}
      <div
        data-testid="buffer-bar"
        className="absolute left-0 rounded-full bg-gray-500/80 transition-all duration-200"
        style={{
          width: `${bufferPercent}%`,
          height: `${barHeight}px`,
          top: '50%',
          transform: 'translateY(-50%)',
        }}
      />

      {/* Progress bar (played portion) */}
      <div
        data-testid="progress-bar"
        className="absolute left-0 rounded-full bg-red-500 transition-all duration-75"
        style={{
          width: `${progressPercent}%`,
          height: `${barHeight}px`,
          top: '50%',
          transform: 'translateY(-50%)',
        }}
      />

      {/* Hover preview line */}
      {isHovering && !isDragging && (
        <div
          data-testid="hover-preview-line"
          className="absolute top-0 bottom-0 w-0.5 bg-white/40 pointer-events-none"
          style={{
            left: `${hoverPosition}%`,
            transform: 'translateX(-50%)',
          }}
        />
      )}

      {/* Scrubber thumb */}
      <div
        data-testid="seek-bar-thumb"
        className={`
          absolute rounded-full bg-red-500 shadow-lg
          transition-all duration-100
          ${showThumb ? 'opacity-100 scale-100' : 'opacity-0 scale-75'}
          ${isDragging ? 'scale-125 shadow-xl' : ''}
        `}
        style={{
          width: `${THUMB_SIZE}px`,
          height: `${THUMB_SIZE}px`,
          left: `${progressPercent}%`,
          top: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }}
      />

      {/* Time tooltip on hover */}
      {isHovering && !isDragging && (
        <div
          data-testid="hover-time-tooltip"
          className="absolute bottom-full mb-2 px-2 py-1 bg-black/90 text-white text-xs rounded whitespace-nowrap pointer-events-none transform -translate-x-1/2"
          style={{
            left: `${hoverPosition}%`,
          }}
        >
          {formatDuration(hoverTime)}
        </div>
      )}

      {/* Current time tooltip during drag */}
      {isDragging && (
        <div
          data-testid="drag-time-tooltip"
          className="absolute bottom-full mb-2 px-2 py-1 bg-red-600 text-white text-xs font-medium rounded whitespace-nowrap pointer-events-none transform -translate-x-1/2"
          style={{
            left: `${progressPercent}%`,
          }}
        >
          {formatDuration(currentTime)}
        </div>
      )}
    </div>
  );
}

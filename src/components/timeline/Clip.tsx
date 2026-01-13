/**
 * Clip Component
 *
 * Displays a clip on the timeline with selection, drag, and trim support.
 */

import { useMemo, useRef, useCallback, type MouseEvent } from 'react';
import type { Clip as ClipType } from '@/types';

// =============================================================================
// Types
// =============================================================================

export type ClipDragType = 'move' | 'trim-left' | 'trim-right';

export interface ClipDragData {
  clipId: string;
  type: ClipDragType;
  startX: number;
  originalTimelineIn: number;
  originalSourceIn: number;
  originalSourceOut: number;
}

interface ClipProps {
  /** Clip data */
  clip: ClipType;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Whether clip is selected */
  selected: boolean;
  /** Whether interaction is disabled */
  disabled?: boolean;
  /** Click handler */
  onClick?: (clipId: string) => void;
  /** Double-click handler */
  onDoubleClick?: (clipId: string) => void;
  /** Drag start handler */
  onDragStart?: (data: ClipDragData) => void;
  /** Drag handler */
  onDrag?: (data: ClipDragData, deltaX: number) => void;
  /** Drag end handler */
  onDragEnd?: (data: ClipDragData) => void;
}

// =============================================================================
// Component
// =============================================================================

export function Clip({
  clip,
  zoom,
  selected,
  disabled = false,
  onClick,
  onDoubleClick,
  onDragStart,
  onDrag,
  onDragEnd,
}: ClipProps) {
  // Calculate dimensions
  const duration = (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
  const width = duration * zoom;
  const left = clip.place.timelineInSec * zoom;

  // Refs for drag state
  const dragDataRef = useRef<ClipDragData | null>(null);
  const isDraggingRef = useRef(false);

  // Background color
  const backgroundColor = useMemo(() => {
    if (clip.color) {
      return `rgb(${clip.color.r}, ${clip.color.g}, ${clip.color.b})`;
    }
    return undefined;
  }, [clip.color]);

  // Handle click
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!disabled && onClick && !isDraggingRef.current) {
      onClick(clip.id);
    }
  };

  // Handle double-click
  const handleDoubleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!disabled && onDoubleClick) {
      onDoubleClick(clip.id);
    }
  };

  // Handle mouse down for drag
  const handleMouseDown = useCallback((e: MouseEvent, type: ClipDragType) => {
    if (disabled || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    const dragData: ClipDragData = {
      clipId: clip.id,
      type,
      startX: e.clientX,
      originalTimelineIn: clip.place.timelineInSec,
      originalSourceIn: clip.range.sourceInSec,
      originalSourceOut: clip.range.sourceOutSec,
    };

    dragDataRef.current = dragData;
    isDraggingRef.current = false;

    const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
      if (!dragDataRef.current) return;

      const deltaX = moveEvent.clientX - dragDataRef.current.startX;

      // Consider it a drag if moved more than 3 pixels
      if (Math.abs(deltaX) > 3) {
        isDraggingRef.current = true;
      }

      if (isDraggingRef.current && onDrag) {
        onDrag(dragDataRef.current, deltaX);
      }
    };

    const handleMouseUp = () => {
      if (dragDataRef.current && isDraggingRef.current && onDragEnd) {
        onDragEnd(dragDataRef.current);
      }
      dragDataRef.current = null;

      // Reset isDragging after a small delay to prevent click from firing
      setTimeout(() => {
        isDraggingRef.current = false;
      }, 10);

      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    // Notify drag start
    if (onDragStart) {
      onDragStart(dragData);
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [clip, disabled, onDragStart, onDrag, onDragEnd]);

  const hasEffects = clip.effects.length > 0;
  const hasSpeedChange = clip.speed !== 1;

  return (
    <div
      data-testid={`clip-${clip.id}`}
      className={`
        absolute h-full rounded-sm cursor-pointer transition-shadow select-none
        ${selected ? 'ring-2 ring-primary-400 z-10' : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:brightness-110'}
        ${!backgroundColor ? 'bg-blue-600' : ''}
      `}
      style={{
        left: `${left}px`,
        width: `${Math.max(width, 4)}px`,
        backgroundColor,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseDown={(e) => handleMouseDown(e, 'move')}
    >
      {/* Clip content */}
      <div className="h-full p-1 overflow-hidden pointer-events-none">
        {/* Label */}
        {clip.label && (
          <span className="text-xs text-white truncate block">
            {clip.label}
          </span>
        )}

        {/* Indicators */}
        <div className="absolute bottom-1 right-1 flex gap-1">
          {/* Effects indicator */}
          {hasEffects && (
            <div
              data-testid="effects-indicator"
              className="w-3 h-3 bg-purple-500 rounded-full flex items-center justify-center"
              title={`${clip.effects.length} effect(s)`}
            >
              <span className="text-[8px] text-white">fx</span>
            </div>
          )}

          {/* Speed indicator */}
          {hasSpeedChange && (
            <div
              data-testid="speed-indicator"
              className="px-1 h-3 bg-orange-500 rounded text-[8px] text-white flex items-center"
            >
              {clip.speed}x
            </div>
          )}
        </div>
      </div>

      {/* Resize handles (always visible for better UX) */}
      <div
        data-testid="resize-handle-left"
        className={`
          absolute left-0 top-0 w-2 h-full cursor-ew-resize
          ${selected ? 'bg-primary-400 bg-opacity-50' : 'bg-white bg-opacity-0 hover:bg-opacity-20'}
        `}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, 'trim-left');
        }}
      />
      <div
        data-testid="resize-handle-right"
        className={`
          absolute right-0 top-0 w-2 h-full cursor-ew-resize
          ${selected ? 'bg-primary-400 bg-opacity-50' : 'bg-white bg-opacity-0 hover:bg-opacity-20'}
        `}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, 'trim-right');
        }}
      />
    </div>
  );
}

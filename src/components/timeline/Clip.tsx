/**
 * Clip Component
 *
 * Displays a clip on the timeline with selection and interaction support.
 */

import { useMemo, type MouseEvent } from 'react';
import type { Clip as ClipType } from '@/types';

// =============================================================================
// Types
// =============================================================================

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
}: ClipProps) {
  // Calculate dimensions
  const duration = clip.range.sourceOutSec - clip.range.sourceInSec;
  const width = duration * zoom;
  const left = clip.place.timelineInSec * zoom;

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
    if (!disabled && onClick) {
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

  const hasEffects = clip.effects.length > 0;
  const hasSpeedChange = clip.speed !== 1;

  return (
    <div
      data-testid={`clip-${clip.id}`}
      className={`
        absolute h-full rounded-sm cursor-pointer transition-shadow
        ${selected ? 'ring-2 ring-primary-400' : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:brightness-110'}
        ${!backgroundColor ? 'bg-blue-600' : ''}
      `}
      style={{
        left: `${left}px`,
        width: `${width}px`,
        backgroundColor,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {/* Clip content */}
      <div className="h-full p-1 overflow-hidden">
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

      {/* Resize handles (only when selected) */}
      {selected && (
        <>
          <div
            data-testid="resize-handle-left"
            className="absolute left-0 top-0 w-2 h-full cursor-ew-resize bg-white bg-opacity-0 hover:bg-opacity-20"
          />
          <div
            data-testid="resize-handle-right"
            className="absolute right-0 top-0 w-2 h-full cursor-ew-resize bg-white bg-opacity-0 hover:bg-opacity-20"
          />
        </>
      )}
    </div>
  );
}

/**
 * Clip Component
 *
 * Displays a clip on the timeline with selection, drag, and trim support.
 * Uses the useClipDrag hook for smooth drag operations with delta accumulation.
 */

import { useMemo, type MouseEvent } from 'react';
import { useClipDrag, type DragPreviewPosition, type ClipDragData } from '@/hooks/useClipDrag';
import type { Clip as ClipType } from '@/types';
import { AudioClipWaveform } from './AudioClipWaveform';

// =============================================================================
// Types
// =============================================================================

export type { ClipDragData, DragPreviewPosition };
export type ClipDragType = 'move' | 'trim-left' | 'trim-right';

/** Modifier keys pressed during click */
export interface ClickModifiers {
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Waveform display configuration for audio clips */
export interface ClipWaveformConfig {
  /** Asset ID for waveform caching */
  assetId: string;
  /** Path to audio/video file for waveform generation */
  inputPath: string;
  /** Total asset duration in seconds */
  totalDurationSec: number;
  /** Whether to show waveform (for audio clips) */
  enabled: boolean;
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
  /** Grid interval for snapping (0 = no snapping) */
  gridInterval?: number;
  /** Maximum source duration (for trim bounds) */
  maxSourceDuration?: number;
  /** Waveform configuration for audio clips */
  waveformConfig?: ClipWaveformConfig;
  /** Click handler with modifier keys */
  onClick?: (clipId: string, modifiers: ClickModifiers) => void;
  /** Double-click handler */
  onDoubleClick?: (clipId: string) => void;
  /** Drag start handler */
  onDragStart?: (data: ClipDragData) => void;
  /** Drag handler - receives computed preview position directly */
  onDrag?: (data: ClipDragData, previewPosition: DragPreviewPosition) => void;
  /** Drag end handler */
  onDragEnd?: (data: ClipDragData, finalPosition: DragPreviewPosition) => void;
}

// =============================================================================
// Component
// =============================================================================

export function Clip({
  clip,
  zoom,
  selected,
  disabled = false,
  gridInterval = 0,
  maxSourceDuration,
  waveformConfig,
  onClick,
  onDoubleClick,
  onDragStart,
  onDrag,
  onDragEnd,
}: ClipProps) {
  // Use the clip drag hook for smooth drag operations
  const { isDragging, previewPosition, handleMouseDown } = useClipDrag({
    clipId: clip.id,
    initialTimelineIn: clip.place.timelineInSec,
    initialSourceIn: clip.range.sourceInSec,
    initialSourceOut: clip.range.sourceOutSec,
    zoom,
    disabled,
    gridInterval,
    speed: clip.speed,
    maxSourceDuration,
    onDragStart,
    onDrag,
    onDragEnd,
  });

  // Calculate display dimensions (use preview position during drag)
  const displayPosition = useMemo(() => {
    if (isDragging && previewPosition) {
      return {
        duration: previewPosition.duration,
        left: previewPosition.timelineIn * zoom,
        width: previewPosition.duration * zoom,
      };
    }

    const duration = (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
    return {
      duration,
      left: clip.place.timelineInSec * zoom,
      width: duration * zoom,
    };
  }, [isDragging, previewPosition, clip, zoom]);

  // Background color
  const backgroundColor = useMemo(() => {
    if (clip.color) {
      return `rgb(${clip.color.r}, ${clip.color.g}, ${clip.color.b})`;
    }
    return undefined;
  }, [clip.color]);

  // Handle click (differentiate from drag)
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();

    // Don't trigger click if we were dragging
    if (isDragging) return;

    if (!disabled && onClick) {
      onClick(clip.id, {
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
      });
    }
  };

  // Handle double-click
  const handleDoubleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!disabled && onDoubleClick) {
      onDoubleClick(clip.id);
    }
  };

  // Handle mouse down on main clip area
  const handleClipMouseDown = (e: MouseEvent) => {
    handleMouseDown(e, 'move');
  };

  // Handle mouse down on left trim handle
  const handleLeftTrimMouseDown = (e: MouseEvent) => {
    e.stopPropagation();
    handleMouseDown(e, 'trim-left');
  };

  // Handle mouse down on right trim handle
  const handleRightTrimMouseDown = (e: MouseEvent) => {
    e.stopPropagation();
    handleMouseDown(e, 'trim-right');
  };

  const hasEffects = clip.effects.length > 0;
  const hasSpeedChange = clip.speed !== 1;

  return (
    <div
      data-testid={`clip-${clip.id}`}
      className={`
        absolute h-full rounded-sm cursor-pointer transition-shadow select-none
        ${selected ? 'ring-2 ring-primary-400 z-10' : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:brightness-110'}
        ${isDragging ? 'opacity-80 z-20' : ''}
        ${!backgroundColor ? 'bg-blue-600' : ''}
      `}
      style={{
        left: `${displayPosition.left}px`,
        width: `${Math.max(displayPosition.width, 4)}px`,
        backgroundColor,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleClipMouseDown}
    >
      {/* Audio Waveform (background layer) */}
      {waveformConfig?.enabled && displayPosition.width > 0 && (
        <AudioClipWaveform
          assetId={waveformConfig.assetId}
          inputPath={waveformConfig.inputPath}
          width={displayPosition.width}
          height={64} // Track height h-16 = 64px
          sourceInSec={clip.range.sourceInSec}
          sourceOutSec={clip.range.sourceOutSec}
          totalDurationSec={waveformConfig.totalDurationSec}
          opacity={0.6}
          className="absolute inset-0"
          showLoadingIndicator={false}
        />
      )}

      {/* Clip content */}
      <div className="h-full p-1 overflow-hidden pointer-events-none relative z-10">
        {/* Label */}
        {clip.label && <span className="text-xs text-white truncate block drop-shadow-sm">{clip.label}</span>}

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

      {/* Resize handles */}
      <div
        data-testid="resize-handle-left"
        className={`
          absolute left-0 top-0 w-2 h-full cursor-ew-resize
          ${selected ? 'bg-primary-400 bg-opacity-50' : 'bg-white bg-opacity-0 hover:bg-opacity-20'}
        `}
        onMouseDown={handleLeftTrimMouseDown}
      />
      <div
        data-testid="resize-handle-right"
        className={`
          absolute right-0 top-0 w-2 h-full cursor-ew-resize
          ${selected ? 'bg-primary-400 bg-opacity-50' : 'bg-white bg-opacity-0 hover:bg-opacity-20'}
        `}
        onMouseDown={handleRightTrimMouseDown}
      />
    </div>
  );
}

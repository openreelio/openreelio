/**
 * Clip Component
 *
 * Displays a clip on the timeline with selection, drag, and trim support.
 * Uses the useClipDrag hook for smooth drag operations with delta accumulation.
 */

import { useMemo, useRef, useEffect, type MouseEvent } from 'react';
import { Type } from 'lucide-react';
import { useClipDrag, type DragPreviewPosition, type ClipDragData } from '@/hooks/useClipDrag';
import { useWaveformPeaks } from '@/hooks/useWaveformPeaks';
import type { Clip as ClipType, SnapPoint, Asset } from '@/types';
import { isTextClip } from '@/types';
import { AudioClipWaveform } from './AudioClipWaveform';
import { WaveformPeaksDisplay } from './WaveformPeaksDisplay';
import { LazyThumbnailStrip } from './LazyThumbnailStrip';

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
  /** Use JSON-based peak data rendering (default: false = use image-based) */
  useJsonPeaks?: boolean;
  /** Waveform display color */
  color?: string;
}

/** Thumbnail display configuration for video clips */
export interface ClipThumbnailConfig {
  /** Asset for thumbnail extraction */
  asset: Asset;
  /** Whether thumbnails should be displayed */
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
  /** Thumbnail configuration for video clips */
  thumbnailConfig?: ClipThumbnailConfig;
  /** Snap points for intelligent snapping (clip edges, playhead, etc.) */
  snapPoints?: SnapPoint[];
  /** Snap threshold in seconds (distance within which snapping occurs) */
  snapThreshold?: number;
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
  /** Snap point change handler - called when snap point changes during drag */
  onSnapPointChange?: (snapPoint: import('@/types').SnapPoint | null) => void;
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
  thumbnailConfig,
  snapPoints = [],
  snapThreshold = 0,
  onClick,
  onDoubleClick,
  onDragStart,
  onDrag,
  onDragEnd,
  onSnapPointChange,
}: ClipProps) {
  // Use the clip drag hook for smooth drag operations
  const { isDragging, previewPosition, activeSnapPoint, handleMouseDown } = useClipDrag({
    clipId: clip.id,
    initialTimelineIn: clip.place.timelineInSec,
    initialSourceIn: clip.range.sourceInSec,
    initialSourceOut: clip.range.sourceOutSec,
    zoom,
    disabled,
    gridInterval,
    speed: clip.speed,
    maxSourceDuration,
    snapPoints,
    snapThreshold,
    onDragStart,
    onDrag,
    onDragEnd,
  });

  // Notify parent when snap point changes during drag (via effect to avoid calling during render)
  const prevSnapPointRef = useRef<import('@/types').SnapPoint | null>(null);
  useEffect(() => {
    if (activeSnapPoint !== prevSnapPointRef.current) {
      prevSnapPointRef.current = activeSnapPoint;
      onSnapPointChange?.(activeSnapPoint);
    }
  }, [activeSnapPoint, onSnapPointChange]);

  // Calculate display dimensions (use preview position during drag)
  const displayPosition = useMemo(() => {
    if (isDragging && previewPosition) {
      return {
        duration: previewPosition.duration,
        left: previewPosition.timelineIn * zoom,
        width: previewPosition.duration * zoom,
      };
    }

    const safeSpeed = clip.speed > 0 ? clip.speed : 1;
    const duration = (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
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

  // Track if a drag operation completed (threshold exceeded + released).
  // Set via effect when isDragging becomes true; read-and-reset in click handler.
  // This replaces the broken hadMouseDownRef which blocked ALL clicks.
  const dragCompletedRef = useRef(false);

  useEffect(() => {
    if (isDragging) {
      dragCompletedRef.current = true;
    }
  }, [isDragging]);

  // Handle click (differentiate from drag)
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();

    // Read and reset the drag-completed flag
    const wasDragCompleted = dragCompletedRef.current;
    dragCompletedRef.current = false;

    // Don't trigger click if actively dragging or just completed a drag
    if (isDragging || wasDragCompleted) return;

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

  // Determine if this is a text clip
  const isText = isTextClip(clip.assetId);

  // Determine if clip has visual content (thumbnails or waveform)
  // Text clips don't have visual content like thumbnails or waveforms
  const hasVisualContent = !isText && (thumbnailConfig?.enabled || waveformConfig?.enabled);

  // Display label for text clips (default to "Text" if no label)
  const displayLabel = clip.label ?? (isText ? 'Text' : undefined);

  return (
    <div
      data-testid={`clip-${clip.id}`}
      className={`
        absolute h-full rounded-sm cursor-pointer transition-shadow select-none overflow-hidden
        ${selected ? 'ring-2 ring-primary-400 z-10' : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:brightness-110'}
        ${isDragging ? 'opacity-80 z-20' : ''}
        ${isText ? 'bg-teal-600' : ''}
        ${!backgroundColor && !hasVisualContent && !isText ? 'bg-blue-600' : ''}
        ${hasVisualContent && !backgroundColor && !isText ? 'bg-gray-800' : ''}
      `}
      style={{
        left: `${displayPosition.left}px`,
        width: `${Math.max(displayPosition.width, 4)}px`,
        backgroundColor: isText ? undefined : backgroundColor,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleClipMouseDown}
    >
      {/* Video Thumbnails (background layer) - not for text clips */}
      {!isText && thumbnailConfig?.enabled && !waveformConfig?.enabled && displayPosition.width > 0 && (
        <LazyThumbnailStrip
          asset={thumbnailConfig.asset}
          sourceInSec={clip.range.sourceInSec}
          sourceOutSec={clip.range.sourceOutSec}
          width={displayPosition.width}
          height={64}
          className="absolute inset-0"
        />
      )}

      {/* Audio Waveform (background layer) - not for text clips */}
      {!isText && waveformConfig?.enabled && displayPosition.width > 0 && (
        <ClipWaveformRenderer
          config={waveformConfig}
          clipRange={clip.range}
          width={displayPosition.width}
          height={64}
        />
      )}

      {/* Text Clip Icon (background layer) */}
      {isText && (
        <div className="absolute inset-0 flex items-center justify-center opacity-20 pointer-events-none">
          <Type className="w-8 h-8 text-white" />
        </div>
      )}

      {/* Clip content */}
      <div className="h-full p-1 overflow-hidden pointer-events-none relative z-10">
        {/* Label */}
        {displayLabel && (
          <span className="text-xs text-white truncate block drop-shadow-sm">
            {displayLabel}
          </span>
        )}

        {/* Indicators */}
        <div className="absolute bottom-1 right-1 flex gap-1">
          {/* Text clip indicator */}
          {isText && (
            <div
              data-testid="text-clip-indicator"
              className="w-3 h-3 bg-teal-400 rounded-full flex items-center justify-center"
              title="Text clip"
            >
              <Type className="w-2 h-2 text-white" />
            </div>
          )}

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

// =============================================================================
// Sub-components
// =============================================================================

interface ClipWaveformRendererProps {
  config: ClipWaveformConfig;
  clipRange: ClipType['range'];
  width: number;
  height: number;
}

/**
 * Renders waveform for a clip using either image-based or JSON peak-based approach.
 */
function ClipWaveformRenderer({
  config,
  clipRange,
  width,
  height,
}: ClipWaveformRendererProps) {
  // Use JSON peaks if configured
  const { data: peaksData } = useWaveformPeaks(config.assetId, {
    enabled: config.useJsonPeaks === true,
    inputPath: config.inputPath,
  });

  // JSON-based rendering (WaveformPeaksDisplay)
  if (config.useJsonPeaks && peaksData) {
    return (
      <WaveformPeaksDisplay
        peaks={peaksData.peaks}
        width={width}
        height={height}
        samplesPerSecond={peaksData.samplesPerSecond}
        sourceInSec={clipRange.sourceInSec}
        sourceOutSec={clipRange.sourceOutSec}
        color={config.color || '#3b82f6'}
        opacity={0.6}
        mode="fill"
        mirrored={true}
        className="absolute inset-0 pointer-events-none"
      />
    );
  }

  // Fallback to image-based rendering (AudioClipWaveform)
  return (
    <AudioClipWaveform
      assetId={config.assetId}
      inputPath={config.inputPath}
      width={width}
      height={height}
      sourceInSec={clipRange.sourceInSec}
      sourceOutSec={clipRange.sourceOutSec}
      totalDurationSec={config.totalDurationSec}
      color={config.color}
      opacity={0.6}
      className="absolute inset-0"
      showLoadingIndicator={false}
    />
  );
}

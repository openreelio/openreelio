/**
 * useRazorTool Hook
 *
 * Implements razor/blade tool behavior for splitting clips at click position.
 * When razor tool is active, clicking on a clip splits it at the click position.
 *
 * @module hooks/useRazorTool
 */

import { useCallback, useEffect } from 'react';
import { useEditorToolStore, type EditorTool } from '@/stores/editorToolStore';
import type { Sequence, Clip } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface ClipAtPosition {
  clip: Clip;
  trackId: string;
  trackIndex: number;
}

export interface RazorSplitData {
  sequenceId: string;
  trackId: string;
  clipId: string;
  splitTime: number;
}

export interface UseRazorToolOptions {
  /** Current sequence data */
  sequence: Sequence | null;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Horizontal scroll offset */
  scrollX: number;
  /** Track header width in pixels */
  trackHeaderWidth?: number;
  /** Track height in pixels */
  trackHeight?: number;
  /** Callback when a clip should be split */
  onSplit?: (data: RazorSplitData) => void;
}

export interface UseRazorToolReturn {
  /** Whether razor tool is currently active */
  isActive: boolean;
  /** Current active tool */
  activeTool: EditorTool;
  /** Get cursor style for current tool state */
  getCursorStyle: () => string;
  /** Handle click on timeline area (splits clip if razor tool active) */
  handleTimelineClick: (
    clientX: number,
    clientY: number,
    containerRect: DOMRect
  ) => boolean;
  /** Find clip at a specific time position on a track */
  findClipAtTime: (trackId: string, time: number) => Clip | null;
  /** Find all clips at a specific pixel position */
  findClipsAtPosition: (
    pixelX: number,
    pixelY: number,
    containerRect: DOMRect
  ) => ClipAtPosition[];
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TRACK_HEADER_WIDTH = 192;
const DEFAULT_TRACK_HEIGHT = 48;

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for razor tool functionality.
 *
 * Features:
 * - Detects when razor tool is active
 * - Finds clips at click position
 * - Triggers split callback when clicking on clips
 * - Provides cursor style based on tool state
 *
 * @example
 * ```tsx
 * const { isActive, handleTimelineClick, getCursorStyle } = useRazorTool({
 *   sequence,
 *   zoom,
 *   scrollX,
 *   onSplit: (data) => {
 *     // Handle split
 *   },
 * });
 * ```
 */
export function useRazorTool(options: UseRazorToolOptions): UseRazorToolReturn {
  const {
    sequence,
    zoom,
    scrollX,
    trackHeaderWidth = DEFAULT_TRACK_HEADER_WIDTH,
    trackHeight = DEFAULT_TRACK_HEIGHT,
    onSplit,
  } = options;

  const { activeTool } = useEditorToolStore();

  const isActive = activeTool === 'razor';

  /**
   * Calculate time from pixel position
   */
  const pixelToTime = useCallback(
    (pixelX: number): number => {
      return (pixelX + scrollX) / zoom;
    },
    [scrollX, zoom]
  );

  /**
   * Find track index from pixel Y position
   */
  const getTrackIndexFromY = useCallback(
    (pixelY: number): number => {
      return Math.floor(pixelY / trackHeight);
    },
    [trackHeight]
  );

  /**
   * Get clip duration
   */
  const getClipDuration = useCallback((clip: Clip): number => {
    return (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
  }, []);

  /**
   * Find a clip at a specific time position on a specific track
   */
  const findClipAtTime = useCallback(
    (trackId: string, time: number): Clip | null => {
      if (!sequence) return null;

      const track = sequence.tracks.find((t) => t.id === trackId);
      if (!track) return null;

      for (const clip of track.clips) {
        const clipStart = clip.place.timelineInSec;
        const clipEnd = clipStart + getClipDuration(clip);

        if (time >= clipStart && time < clipEnd) {
          return clip;
        }
      }

      return null;
    },
    [sequence, getClipDuration]
  );

  /**
   * Find all clips at a specific pixel position
   */
  const findClipsAtPosition = useCallback(
    (
      pixelX: number,
      pixelY: number,
      containerRect: DOMRect
    ): ClipAtPosition[] => {
      if (!sequence) return [];

      // Adjust for container offset and track header
      const relativeX = pixelX - containerRect.left - trackHeaderWidth;
      const relativeY = pixelY - containerRect.top;

      // Early return if clicking in track header area
      if (relativeX < 0) return [];

      const time = pixelToTime(relativeX);
      const trackIndex = getTrackIndexFromY(relativeY);

      // Validate track index
      if (trackIndex < 0 || trackIndex >= sequence.tracks.length) {
        return [];
      }

      const track = sequence.tracks[trackIndex];
      const clip = findClipAtTime(track.id, time);

      if (clip) {
        return [{ clip, trackId: track.id, trackIndex }];
      }

      return [];
    },
    [sequence, trackHeaderWidth, pixelToTime, getTrackIndexFromY, findClipAtTime]
  );

  /**
   * Handle click on timeline area
   * Returns true if a split was performed
   */
  const handleTimelineClick = useCallback(
    (
      clientX: number,
      clientY: number,
      containerRect: DOMRect
    ): boolean => {
      // Only process when razor tool is active
      if (!isActive || !sequence || !onSplit) {
        return false;
      }

      const clipsAtPosition = findClipsAtPosition(clientX, clientY, containerRect);

      if (clipsAtPosition.length === 0) {
        return false;
      }

      // Calculate the exact split time
      const relativeX = clientX - containerRect.left - trackHeaderWidth;
      const splitTime = pixelToTime(relativeX);

      // Split each clip at the position
      for (const { clip, trackId } of clipsAtPosition) {
        const clipStart = clip.place.timelineInSec;
        const clipEnd = clipStart + getClipDuration(clip);

        // Only split if click is within the clip (not at edges)
        const edgeThreshold = 0.1; // 100ms from edge
        if (
          splitTime > clipStart + edgeThreshold &&
          splitTime < clipEnd - edgeThreshold
        ) {
          onSplit({
            sequenceId: sequence.id,
            trackId,
            clipId: clip.id,
            splitTime,
          });
        }
      }

      return clipsAtPosition.length > 0;
    },
    [
      isActive,
      sequence,
      onSplit,
      findClipsAtPosition,
      trackHeaderWidth,
      pixelToTime,
      getClipDuration,
    ]
  );

  /**
   * Get cursor style based on current tool
   */
  const getCursorStyle = useCallback((): string => {
    switch (activeTool) {
      case 'razor':
        return 'crosshair';
      case 'hand':
        return 'grab';
      case 'slip':
      case 'slide':
        return 'ew-resize';
      case 'ripple':
        return 'e-resize';
      case 'roll':
        return 'col-resize';
      case 'select':
      default:
        return 'default';
    }
  }, [activeTool]);

  // Log tool changes for debugging in development
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[RazorTool] Active tool changed to: ${activeTool}`);
    }
  }, [activeTool]);

  return {
    isActive,
    activeTool,
    getCursorStyle,
    handleTimelineClick,
    findClipAtTime,
    findClipsAtPosition,
  };
}

export default useRazorTool;

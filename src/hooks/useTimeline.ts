/**
 * useTimeline Hook
 *
 * Custom hook for timeline operations.
 * Wraps timelineStore with a cleaner API.
 */

import { useCallback, useMemo } from 'react';
import { useTimelineStore } from '@/stores';

// =============================================================================
// Types
// =============================================================================

export interface UseTimelineReturn {
  // Playback state
  playhead: number;
  isPlaying: boolean;

  // View state
  zoom: number;
  scrollX: number;
  scrollY: number;

  // Selection state
  selectedClipIds: string[];
  hasSelection: boolean;

  // Playback actions
  play: () => void;
  pause: () => void;
  togglePlayback: () => void;
  seek: (time: number) => void;
  stepForward: (frames?: number) => void;
  stepBackward: (frames?: number) => void;

  // Selection actions
  selectClip: (clipId: string, additive?: boolean) => void;
  deselectClip: (clipId: string) => void;
  clearSelection: () => void;
  selectAll: (clipIds: string[]) => void;

  // View actions
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setScroll: (x: number, y: number) => void;

  // Conversion utilities
  timeToPixels: (time: number) => number;
  pixelsToTime: (pixels: number) => number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_FPS = 30;
const ZOOM_STEP = 1.2;
const MIN_ZOOM = 10;
const MAX_ZOOM = 500;

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for managing timeline state and operations
 *
 * @returns Timeline state and actions
 *
 * @example
 * const { playhead, isPlaying, togglePlayback, seek } = useTimeline();
 */
export function useTimeline(): UseTimelineReturn {
  // Get state from store
  const playhead = useTimelineStore((state) => state.playhead);
  const isPlaying = useTimelineStore((state) => state.isPlaying);
  const zoom = useTimelineStore((state) => state.zoom);
  const scrollX = useTimelineStore((state) => state.scrollX);
  const scrollY = useTimelineStore((state) => state.scrollY);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);

  // Get actions from store
  const setPlayhead = useTimelineStore((state) => state.setPlayhead);
  const storePlay = useTimelineStore((state) => state.play);
  const storePause = useTimelineStore((state) => state.pause);
  const storeTogglePlayback = useTimelineStore((state) => state.togglePlayback);
  const setZoom = useTimelineStore((state) => state.setZoom);
  const setScrollX = useTimelineStore((state) => state.setScrollX);
  const setScrollY = useTimelineStore((state) => state.setScrollY);
  const storeSelectClip = useTimelineStore((state) => state.selectClip);
  const storeDeselectClip = useTimelineStore((state) => state.deselectClip);
  const clearClipSelection = useTimelineStore((state) => state.clearClipSelection);

  // Computed values
  const hasSelection = useMemo(
    () => selectedClipIds.length > 0,
    [selectedClipIds]
  );

  // Playback actions
  const play = useCallback(() => {
    storePlay();
  }, [storePlay]);

  const pause = useCallback(() => {
    storePause();
  }, [storePause]);

  const togglePlayback = useCallback(() => {
    storeTogglePlayback();
  }, [storeTogglePlayback]);

  const seek = useCallback(
    (time: number) => {
      setPlayhead(Math.max(0, time));
    },
    [setPlayhead]
  );

  const stepForward = useCallback(
    (frames: number = 1) => {
      const frameTime = 1 / DEFAULT_FPS;
      setPlayhead(playhead + frames * frameTime);
    },
    [playhead, setPlayhead]
  );

  const stepBackward = useCallback(
    (frames: number = 1) => {
      const frameTime = 1 / DEFAULT_FPS;
      setPlayhead(Math.max(0, playhead - frames * frameTime));
    },
    [playhead, setPlayhead]
  );

  // Selection actions
  const selectClip = useCallback(
    (clipId: string) => {
      storeSelectClip(clipId);
    },
    [storeSelectClip]
  );

  const deselectClip = useCallback(
    (clipId: string) => {
      storeDeselectClip(clipId);
    },
    [storeDeselectClip]
  );

  const clearSelection = useCallback(() => {
    clearClipSelection();
  }, [clearClipSelection]);

  const selectAll = useCallback(
    (clipIds: string[]) => {
      clearClipSelection();
      clipIds.forEach((id) => storeSelectClip(id));
    },
    [clearClipSelection, storeSelectClip]
  );

  // View actions
  const zoomIn = useCallback(() => {
    setZoom(Math.min(zoom * ZOOM_STEP, MAX_ZOOM));
  }, [zoom, setZoom]);

  const zoomOut = useCallback(() => {
    setZoom(Math.max(zoom / ZOOM_STEP, MIN_ZOOM));
  }, [zoom, setZoom]);

  const setScroll = useCallback(
    (x: number, y: number) => {
      setScrollX(x);
      setScrollY(y);
    },
    [setScrollX, setScrollY]
  );

  // Conversion utilities
  const timeToPixels = useCallback(
    (time: number): number => {
      return time * zoom;
    },
    [zoom]
  );

  const pixelsToTime = useCallback(
    (pixels: number): number => {
      return pixels / zoom;
    },
    [zoom]
  );

  return {
    // Playback state
    playhead,
    isPlaying,

    // View state
    zoom,
    scrollX,
    scrollY,

    // Selection state
    selectedClipIds,
    hasSelection,

    // Playback actions
    play,
    pause,
    togglePlayback,
    seek,
    stepForward,
    stepBackward,

    // Selection actions
    selectClip,
    deselectClip,
    clearSelection,
    selectAll,

    // View actions
    setZoom,
    zoomIn,
    zoomOut,
    setScroll,

    // Conversion utilities
    timeToPixels,
    pixelsToTime,
  };
}

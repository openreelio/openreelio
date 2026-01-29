/**
 * useTimeline Hook
 *
 * Custom hook for timeline operations.
 * Provides unified API for timeline state management.
 *
 * IMPORTANT: Playback state (playhead/currentTime, isPlaying, playbackRate)
 * is sourced from PlaybackStore as the single source of truth.
 * TimelineStore only manages view state (zoom, scroll, selection, snap).
 */

import { useCallback, useMemo } from 'react';
import { useTimelineStore, usePlaybackStore } from '@/stores';

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
 * Playback state is sourced from PlaybackStore (single source of truth).
 * View state is sourced from TimelineStore.
 *
 * @returns Timeline state and actions
 *
 * @example
 * const { playhead, isPlaying, togglePlayback, seek } = useTimeline();
 */
export function useTimeline(): UseTimelineReturn {
  // =========================================================================
  // Playback state from PlaybackStore (SINGLE SOURCE OF TRUTH)
  // =========================================================================
  const playhead = usePlaybackStore((state) => state.currentTime);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);

  // Playback actions from PlaybackStore
  const setCurrentTime = usePlaybackStore((state) => state.setCurrentTime);
  const storePlay = usePlaybackStore((state) => state.play);
  const storePause = usePlaybackStore((state) => state.pause);
  const storeTogglePlayback = usePlaybackStore((state) => state.togglePlayback);
  const storeStepForward = usePlaybackStore((state) => state.stepForward);
  const storeStepBackward = usePlaybackStore((state) => state.stepBackward);

  // =========================================================================
  // View state from TimelineStore
  // =========================================================================
  const zoom = useTimelineStore((state) => state.zoom);
  const scrollX = useTimelineStore((state) => state.scrollX);
  const scrollY = useTimelineStore((state) => state.scrollY);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);

  // View and selection actions from TimelineStore
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
      setCurrentTime(Math.max(0, time));
    },
    [setCurrentTime]
  );

  const stepForward = useCallback(
    (frames: number = 1) => {
      // Validate input: must be positive integer
      const validFrames = Math.max(1, Math.floor(Math.abs(frames)));
      // Single batch operation for performance - calculate total delta
      const frameDuration = 1 / DEFAULT_FPS;
      const totalDelta = validFrames * frameDuration;
      // Use seek for multi-frame steps to avoid N state updates
      if (validFrames === 1) {
        storeStepForward(DEFAULT_FPS);
      } else {
        const currentTime = usePlaybackStore.getState().currentTime;
        setCurrentTime(currentTime + totalDelta);
      }
    },
    [storeStepForward, setCurrentTime]
  );

  const stepBackward = useCallback(
    (frames: number = 1) => {
      // Validate input: must be positive integer
      const validFrames = Math.max(1, Math.floor(Math.abs(frames)));
      // Single batch operation for performance - calculate total delta
      const frameDuration = 1 / DEFAULT_FPS;
      const totalDelta = validFrames * frameDuration;
      // Use seek for multi-frame steps to avoid N state updates
      if (validFrames === 1) {
        storeStepBackward(DEFAULT_FPS);
      } else {
        const currentTime = usePlaybackStore.getState().currentTime;
        setCurrentTime(Math.max(0, currentTime - totalDelta));
      }
    },
    [storeStepBackward, setCurrentTime]
  );

  // Selection actions
  const selectClip = useCallback(
    (clipId: string, additive?: boolean) => {
      storeSelectClip(clipId, additive);
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

  // Conversion utilities with input validation
  const timeToPixels = useCallback(
    (time: number): number => {
      // Guard against NaN/Infinity
      if (!Number.isFinite(time)) {
        return 0;
      }
      return time * zoom;
    },
    [zoom]
  );

  const pixelsToTime = useCallback(
    (pixels: number): number => {
      // Guard against NaN/Infinity and division by zero
      if (!Number.isFinite(pixels) || zoom <= 0) {
        return 0;
      }
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

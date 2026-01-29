/**
 * Timeline Store
 *
 * Manages timeline view state including selection, zoom, scroll, and snap settings.
 * Uses Zustand with Immer for immutable state updates.
 *
 * IMPORTANT: Playback state (playhead, isPlaying, playbackRate) has been moved
 * to PlaybackStore as the single source of truth. The properties here are
 * maintained for backward compatibility but delegate to PlaybackStore.
 *
 * @see PlaybackStore for playback state management
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Clip, TimeSec } from '@/types';
import { usePlaybackStore } from './playbackStore';

// =============================================================================
// Types
// =============================================================================

interface TimelineState {
  // Selection state
  selectedClipIds: string[];
  selectedTrackIds: string[];

  // View state
  zoom: number; // pixels per second
  scrollX: number;
  scrollY: number;

  // Snap settings
  snapEnabled: boolean;
  snapToClips: boolean;
  snapToMarkers: boolean;
  snapToPlayhead: boolean;

  // =========================================================================
  // DEPRECATED: Playback state and actions
  // These are maintained for backward compatibility but delegate to PlaybackStore.
  // Use PlaybackStore directly for new code.
  // =========================================================================

  /** @deprecated Use usePlaybackStore().currentTime instead */
  readonly playhead: TimeSec;
  /** @deprecated Use usePlaybackStore().isPlaying instead */
  readonly isPlaying: boolean;
  /** @deprecated Use usePlaybackStore().playbackRate instead */
  readonly playbackRate: number;

  /** @deprecated Use usePlaybackStore().setCurrentTime instead */
  setPlayhead: (time: TimeSec) => void;
  /** @deprecated Use usePlaybackStore().play instead */
  play: () => void;
  /** @deprecated Use usePlaybackStore().pause instead */
  pause: () => void;
  /** @deprecated Use usePlaybackStore().togglePlayback instead */
  togglePlayback: () => void;
  /** @deprecated Use usePlaybackStore().setPlaybackRate instead */
  setPlaybackRate: (rate: number) => void;
  /** @deprecated Use usePlaybackStore().seekForward instead */
  seekForward: (seconds: number) => void;
  /** @deprecated Use usePlaybackStore().seekBackward instead */
  seekBackward: (seconds: number) => void;

  // Actions - Selection
  selectClip: (clipId: string, addToSelection?: boolean) => void;
  selectClips: (clipIds: string[]) => void;
  deselectClip: (clipId: string) => void;
  clearClipSelection: () => void;
  selectTrack: (trackId: string) => void;
  deselectTrack: (trackId: string) => void;
  clearTrackSelection: () => void;
  selectAll: (clips: Clip[]) => void;

  // Actions - View
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitToWindow: (sequenceDuration: TimeSec, viewportWidth: number) => void;
  setScrollX: (x: number) => void;
  setScrollY: (y: number) => void;
  scrollToPlayhead: (viewportWidth: number) => void;

  // Actions - Snap
  toggleSnap: () => void;
  setSnapToClips: (enabled: boolean) => void;
  setSnapToMarkers: (enabled: boolean) => void;
  setSnapToPlayhead: (enabled: boolean) => void;

  // Utilities
  timeToPixels: (time: TimeSec) => number;
  pixelsToTime: (pixels: number) => TimeSec;
  isClipSelected: (clipId: string) => boolean;

  // Reset
  reset: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const MIN_ZOOM = 10; // 10 pixels per second (zoomed out)
const MAX_ZOOM = 500; // 500 pixels per second (zoomed in)
const DEFAULT_ZOOM = 100; // 100 pixels per second
const ZOOM_STEP = 1.2;

// =============================================================================
// Store
// =============================================================================

export const useTimelineStore = create<TimelineState>()(
  immer((set, get) => ({
    // Initial state (view and selection only)
    selectedClipIds: [],
    selectedTrackIds: [],
    zoom: DEFAULT_ZOOM,
    scrollX: 0,
    scrollY: 0,
    snapEnabled: true,
    snapToClips: true,
    snapToMarkers: true,
    snapToPlayhead: true,

    // =========================================================================
    // DEPRECATED: Playback state getters (delegate to PlaybackStore)
    // =========================================================================

    /** @deprecated Use usePlaybackStore().currentTime instead */
    get playhead(): TimeSec {
      return usePlaybackStore.getState().currentTime;
    },

    /** @deprecated Use usePlaybackStore().isPlaying instead */
    get isPlaying(): boolean {
      return usePlaybackStore.getState().isPlaying;
    },

    /** @deprecated Use usePlaybackStore().playbackRate instead */
    get playbackRate(): number {
      return usePlaybackStore.getState().playbackRate;
    },

    // =========================================================================
    // DEPRECATED: Playback actions (delegate to PlaybackStore)
    // =========================================================================

    /** @deprecated Use usePlaybackStore().setCurrentTime instead */
    setPlayhead: (time: TimeSec) => {
      usePlaybackStore.getState().setCurrentTime(Math.max(0, time));
    },

    /** @deprecated Use usePlaybackStore().play instead */
    play: () => {
      usePlaybackStore.getState().play();
    },

    /** @deprecated Use usePlaybackStore().pause instead */
    pause: () => {
      usePlaybackStore.getState().pause();
    },

    /** @deprecated Use usePlaybackStore().togglePlayback instead */
    togglePlayback: () => {
      usePlaybackStore.getState().togglePlayback();
    },

    /** @deprecated Use usePlaybackStore().setPlaybackRate instead */
    setPlaybackRate: (rate: number) => {
      usePlaybackStore.getState().setPlaybackRate(rate);
    },

    /** @deprecated Use usePlaybackStore().seekForward instead */
    seekForward: (seconds: number) => {
      usePlaybackStore.getState().seekForward(seconds);
    },

    /** @deprecated Use usePlaybackStore().seekBackward instead */
    seekBackward: (seconds: number) => {
      usePlaybackStore.getState().seekBackward(seconds);
    },

    // Selection actions - consistently use array reassignment pattern
    selectClip: (clipId: string, addToSelection = false) => {
      set((state) => {
        if (addToSelection) {
          // Use spread + filter for consistent immutable-style pattern
          if (!state.selectedClipIds.includes(clipId)) {
            state.selectedClipIds = [...state.selectedClipIds, clipId];
          }
        } else {
          state.selectedClipIds = [clipId];
        }
      });
    },

    selectClips: (clipIds: string[]) => {
      set((state) => {
        state.selectedClipIds = [...clipIds];
      });
    },

    deselectClip: (clipId: string) => {
      set((state) => {
        state.selectedClipIds = state.selectedClipIds.filter((id) => id !== clipId);
      });
    },

    clearClipSelection: () => {
      set((state) => {
        state.selectedClipIds = [];
      });
    },

    selectTrack: (trackId: string) => {
      set((state) => {
        // Use spread + filter for consistent immutable-style pattern
        if (!state.selectedTrackIds.includes(trackId)) {
          state.selectedTrackIds = [...state.selectedTrackIds, trackId];
        }
      });
    },

    deselectTrack: (trackId: string) => {
      set((state) => {
        state.selectedTrackIds = state.selectedTrackIds.filter((id) => id !== trackId);
      });
    },

    clearTrackSelection: () => {
      set((state) => {
        state.selectedTrackIds = [];
      });
    },

    selectAll: (clips: Clip[]) => {
      set((state) => {
        state.selectedClipIds = clips.map((c) => c.id);
      });
    },

    // View actions
    setZoom: (zoom: number) => {
      set((state) => {
        state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      });
    },

    zoomIn: () => {
      set((state) => {
        state.zoom = Math.min(MAX_ZOOM, state.zoom * ZOOM_STEP);
      });
    },

    zoomOut: () => {
      set((state) => {
        state.zoom = Math.max(MIN_ZOOM, state.zoom / ZOOM_STEP);
      });
    },

    fitToWindow: (sequenceDuration: TimeSec, viewportWidth: number) => {
      if (sequenceDuration <= 0 || viewportWidth <= 0) return;

      set((state) => {
        const newZoom = viewportWidth / sequenceDuration;
        state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
        state.scrollX = 0;
      });
    },

    setScrollX: (x: number) => {
      set((state) => {
        state.scrollX = Math.max(0, x);
      });
    },

    setScrollY: (y: number) => {
      set((state) => {
        state.scrollY = Math.max(0, y);
      });
    },

    scrollToPlayhead: (viewportWidth: number) => {
      const state = get();
      // Access playhead directly from PlaybackStore since getter may not work with get()
      const playhead = usePlaybackStore.getState().currentTime;
      const playheadX = playhead * state.zoom;
      const margin = viewportWidth * 0.2;

      if (playheadX < state.scrollX + margin) {
        set((s) => {
          s.scrollX = Math.max(0, playheadX - margin);
        });
      } else if (playheadX > state.scrollX + viewportWidth - margin) {
        set((s) => {
          s.scrollX = playheadX - viewportWidth + margin;
        });
      }
    },

    // Snap actions
    toggleSnap: () => {
      set((state) => {
        state.snapEnabled = !state.snapEnabled;
      });
    },

    setSnapToClips: (enabled: boolean) => {
      set((state) => {
        state.snapToClips = enabled;
      });
    },

    setSnapToMarkers: (enabled: boolean) => {
      set((state) => {
        state.snapToMarkers = enabled;
      });
    },

    setSnapToPlayhead: (enabled: boolean) => {
      set((state) => {
        state.snapToPlayhead = enabled;
      });
    },

    // Utilities
    timeToPixels: (time: TimeSec) => {
      return time * get().zoom;
    },

    pixelsToTime: (pixels: number) => {
      return pixels / get().zoom;
    },

    isClipSelected: (clipId: string) => {
      return get().selectedClipIds.includes(clipId);
    },

    /**
     * Reset timeline state to initial values.
     * Called when project is closed to prevent stale state.
     *
     * Note: Playback state is reset via PlaybackStore.reset()
     */
    reset: () => {
      // Reset playback state via PlaybackStore
      usePlaybackStore.getState().reset();

      // Reset view and selection state
      set((state) => {
        state.selectedClipIds = [];
        state.selectedTrackIds = [];
        state.zoom = DEFAULT_ZOOM;
        state.scrollX = 0;
        state.scrollY = 0;
        state.snapEnabled = true;
        state.snapToClips = true;
        state.snapToMarkers = true;
        state.snapToPlayhead = true;
      });
    },
  }))
);

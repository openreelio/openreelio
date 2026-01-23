/**
 * Timeline Store
 *
 * Manages timeline state including playhead position, selection, zoom, and scroll.
 * Uses Zustand with Immer for immutable state updates.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Clip, TimeSec } from '@/types';

// =============================================================================
// Types
// =============================================================================

interface TimelineState {
  // Playback state
  playhead: TimeSec;
  isPlaying: boolean;
  playbackRate: number;

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

  // Actions - Playback
  setPlayhead: (time: TimeSec) => void;
  play: () => void;
  pause: () => void;
  togglePlayback: () => void;
  setPlaybackRate: (rate: number) => void;
  seekForward: (seconds: number) => void;
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
    // Initial state
    playhead: 0,
    isPlaying: false,
    playbackRate: 1,
    selectedClipIds: [],
    selectedTrackIds: [],
    zoom: DEFAULT_ZOOM,
    scrollX: 0,
    scrollY: 0,
    snapEnabled: true,
    snapToClips: true,
    snapToMarkers: true,
    snapToPlayhead: true,

    // Playback actions
    setPlayhead: (time: TimeSec) => {
      set((state) => {
        state.playhead = Math.max(0, time);
      });
    },

    play: () => {
      set((state) => {
        state.isPlaying = true;
      });
    },

    pause: () => {
      set((state) => {
        state.isPlaying = false;
      });
    },

    togglePlayback: () => {
      set((state) => {
        state.isPlaying = !state.isPlaying;
      });
    },

    setPlaybackRate: (rate: number) => {
      set((state) => {
        state.playbackRate = Math.max(0.1, Math.min(4, rate));
      });
    },

    seekForward: (seconds: number) => {
      set((state) => {
        state.playhead = Math.max(0, state.playhead + seconds);
      });
    },

    seekBackward: (seconds: number) => {
      set((state) => {
        state.playhead = Math.max(0, state.playhead - seconds);
      });
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
      const playheadX = state.playhead * state.zoom;
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
  }))
);

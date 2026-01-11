/**
 * Playback Store
 *
 * Global playback state management for video player and timeline synchronization.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

// =============================================================================
// Types
// =============================================================================

export interface PlaybackState {
  /** Whether playback is active */
  isPlaying: boolean;
  /** Current playback position in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
  /** Playback rate (1 = normal speed) */
  playbackRate: number;
  /** Volume level (0-1) */
  volume: number;
  /** Whether audio is muted */
  isMuted: boolean;
  /** Whether to loop playback */
  loop: boolean;
  /** Whether playback syncs with timeline */
  syncWithTimeline: boolean;
}

export interface PlaybackActions {
  /** Start playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Toggle play/pause */
  togglePlayback: () => void;
  /** Seek to specific time */
  seek: (time: number) => void;
  /** Seek forward by amount */
  seekForward: (amount: number) => void;
  /** Seek backward by amount */
  seekBackward: (amount: number) => void;
  /** Jump to start */
  goToStart: () => void;
  /** Jump to end */
  goToEnd: () => void;
  /** Step forward one frame */
  stepForward: (fps: number) => void;
  /** Step backward one frame */
  stepBackward: (fps: number) => void;
  /** Set current time (for external updates) */
  setCurrentTime: (time: number) => void;
  /** Set duration */
  setDuration: (duration: number) => void;
  /** Set volume */
  setVolume: (volume: number) => void;
  /** Toggle mute */
  toggleMute: () => void;
  /** Set muted state */
  setMuted: (muted: boolean) => void;
  /** Set playback rate */
  setPlaybackRate: (rate: number) => void;
  /** Toggle loop */
  toggleLoop: () => void;
  /** Set loop */
  setLoop: (loop: boolean) => void;
  /** Toggle sync with timeline */
  toggleSyncWithTimeline: () => void;
  /** Reset playback state */
  reset: () => void;
}

export type PlaybackStore = PlaybackState & PlaybackActions;

// =============================================================================
// Constants
// =============================================================================

const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 4;

// =============================================================================
// Initial State
// =============================================================================

const initialState: PlaybackState = {
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  volume: 1,
  isMuted: false,
  loop: false,
  syncWithTimeline: true,
};

// =============================================================================
// Store
// =============================================================================

export const usePlaybackStore = create<PlaybackStore>()(
  immer((set, get) => ({
    ...initialState,

    // =========================================================================
    // Play/Pause
    // =========================================================================

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

    // =========================================================================
    // Seeking
    // =========================================================================

    seek: (time: number) => {
      set((state) => {
        state.currentTime = Math.max(0, Math.min(state.duration, time));
      });
    },

    seekForward: (amount: number) => {
      const { currentTime, duration } = get();
      set((state) => {
        state.currentTime = Math.min(duration, currentTime + amount);
      });
    },

    seekBackward: (amount: number) => {
      const { currentTime } = get();
      set((state) => {
        state.currentTime = Math.max(0, currentTime - amount);
      });
    },

    goToStart: () => {
      set((state) => {
        state.currentTime = 0;
      });
    },

    goToEnd: () => {
      set((state) => {
        state.currentTime = state.duration;
      });
    },

    stepForward: (fps: number) => {
      if (fps <= 0) return; // Guard against invalid fps
      const frameTime = 1 / fps;
      const { currentTime, duration } = get();
      set((state) => {
        state.currentTime = Math.min(duration, currentTime + frameTime);
      });
    },

    stepBackward: (fps: number) => {
      if (fps <= 0) return; // Guard against invalid fps
      const frameTime = 1 / fps;
      const { currentTime } = get();
      set((state) => {
        state.currentTime = Math.max(0, currentTime - frameTime);
      });
    },

    // =========================================================================
    // Time Updates
    // =========================================================================

    setCurrentTime: (time: number) => {
      set((state) => {
        state.currentTime = time;
      });
    },

    setDuration: (duration: number) => {
      set((state) => {
        state.duration = duration;
      });
    },

    // =========================================================================
    // Volume
    // =========================================================================

    setVolume: (volume: number) => {
      set((state) => {
        state.volume = Math.max(0, Math.min(1, volume));
      });
    },

    toggleMute: () => {
      set((state) => {
        state.isMuted = !state.isMuted;
      });
    },

    setMuted: (muted: boolean) => {
      set((state) => {
        state.isMuted = muted;
      });
    },

    // =========================================================================
    // Playback Rate
    // =========================================================================

    setPlaybackRate: (rate: number) => {
      set((state) => {
        state.playbackRate = Math.max(
          MIN_PLAYBACK_RATE,
          Math.min(MAX_PLAYBACK_RATE, rate)
        );
      });
    },

    // =========================================================================
    // Loop
    // =========================================================================

    toggleLoop: () => {
      set((state) => {
        state.loop = !state.loop;
      });
    },

    setLoop: (loop: boolean) => {
      set((state) => {
        state.loop = loop;
      });
    },

    // =========================================================================
    // Sync
    // =========================================================================

    toggleSyncWithTimeline: () => {
      set((state) => {
        state.syncWithTimeline = !state.syncWithTimeline;
      });
    },

    // =========================================================================
    // Reset
    // =========================================================================

    reset: () => {
      set(() => ({ ...initialState }));
    },
  }))
);

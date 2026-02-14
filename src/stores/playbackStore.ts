/**
 * Playback Store
 *
 * Global playback state management for video player and timeline synchronization.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { recordPlaybackTrace } from '@/services/playbackTrace';

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
  /** Set playing state directly */
  setIsPlaying: (isPlaying: boolean, source?: string) => void;
  /** Seek to specific time */
  seek: (time: number, source?: string) => void;
  /** Seek forward by amount */
  seekForward: (amount: number, source?: string) => void;
  /** Seek backward by amount */
  seekBackward: (amount: number, source?: string) => void;
  /** Jump to start */
  goToStart: (source?: string) => void;
  /** Jump to end */
  goToEnd: (source?: string) => void;
  /** Step forward one frame */
  stepForward: (fps: number, source?: string) => void;
  /** Step backward one frame */
  stepBackward: (fps: number, source?: string) => void;
  /** Set current time (for external updates) */
  setCurrentTime: (time: number, source?: string) => void;
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

/**
 * Playback event detail type for seek events.
 */
export interface PlaybackSeekEventDetail {
  time: number;
  source?: string;
}

/**
 * Playback event detail type for update events.
 */
export interface PlaybackUpdateEventDetail {
  time: number;
  source?: string;
}

/**
 * Event names for playback events.
 */
export const PLAYBACK_EVENTS = {
  SEEK: 'playback-seek',
  UPDATE: 'playback-update',
} as const;

// =============================================================================
// Constants
// =============================================================================

const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 4;

function getSafeDuration(duration: number): number {
  if (!Number.isFinite(duration) || duration < 0) {
    return 0;
  }
  return duration;
}

function clampTimeToDuration(time: number, duration: number): number {
  if (!Number.isFinite(time)) {
    return 0;
  }
  const safeDuration = getSafeDuration(duration);
  if (safeDuration <= 0) {
    return Math.max(0, time);
  }
  return Math.max(0, Math.min(safeDuration, time));
}

function normalizeDelta(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value;
}

// =============================================================================
// Playback Events
// =============================================================================

/**
 * Dispatches a CustomEvent for playback seek operations.
 * Allows external components to react to seek events without subscribing to the store.
 *
 * @param time - The new playback time in seconds
 */
function dispatchSeekEvent(time: number, source?: string): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('playback-seek', {
        detail: { time, source },
      }),
    );
  }
}

/**
 * Dispatches a CustomEvent for regular playback time updates.
 * Used during playback to notify external components of time changes.
 *
 * @param time - The current playback time in seconds
 */
function dispatchUpdateEvent(time: number, source?: string): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('playback-update', {
        detail: { time, source },
      }),
    );
  }
}

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

    setIsPlaying: (isPlaying: boolean, source = 'set-is-playing') => {
      const { isPlaying: prevIsPlaying, currentTime } = get();
      set((state) => {
        state.isPlaying = isPlaying;
      });
      if (prevIsPlaying !== isPlaying) {
        recordPlaybackTrace(
          'play-state',
          source,
          currentTime,
          currentTime,
          isPlaying,
        );
      }
    },

    // =========================================================================
    // Seeking
    // =========================================================================

    seek: (time: number, source = 'seek') => {
      const { duration, currentTime, isPlaying } = get();
      const newTime = clampTimeToDuration(time, duration);
      set((state) => {
        state.currentTime = newTime;
      });
      dispatchSeekEvent(newTime, source);
      recordPlaybackTrace('seek', source, currentTime, newTime, isPlaying);
    },

    seekForward: (amount: number, source = 'seek-forward') => {
      const { currentTime, duration, isPlaying } = get();
      const delta = normalizeDelta(amount);
      const newTime = clampTimeToDuration(currentTime + delta, duration);
      set((state) => {
        state.currentTime = newTime;
      });
      dispatchSeekEvent(newTime, source);
      recordPlaybackTrace('seek', source, currentTime, newTime, isPlaying);
    },

    seekBackward: (amount: number, source = 'seek-backward') => {
      const { currentTime, duration, isPlaying } = get();
      const delta = normalizeDelta(amount);
      const newTime = clampTimeToDuration(currentTime - delta, duration);
      set((state) => {
        state.currentTime = newTime;
      });
      dispatchSeekEvent(newTime, source);
      recordPlaybackTrace('seek', source, currentTime, newTime, isPlaying);
    },

    goToStart: (source = 'go-to-start') => {
      const { currentTime, isPlaying } = get();
      set((state) => {
        state.currentTime = 0;
      });
      dispatchSeekEvent(0, source);
      recordPlaybackTrace('seek', source, currentTime, 0, isPlaying);
    },

    goToEnd: (source = 'go-to-end') => {
      const { duration, currentTime, isPlaying } = get();
      const endTime = clampTimeToDuration(duration, duration);
      set((state) => {
        state.currentTime = endTime;
      });
      dispatchSeekEvent(endTime, source);
      recordPlaybackTrace('seek', source, currentTime, endTime, isPlaying);
    },

    stepForward: (fps: number, source = 'step-forward') => {
      if (!Number.isFinite(fps) || fps <= 0) return; // Guard against invalid fps
      const frameTime = 1 / fps;
      const { currentTime, duration, isPlaying } = get();
      const newTime = clampTimeToDuration(currentTime + frameTime, duration);
      set((state) => {
        state.currentTime = newTime;
      });
      dispatchSeekEvent(newTime, source);
      recordPlaybackTrace('seek', source, currentTime, newTime, isPlaying);
    },

    stepBackward: (fps: number, source = 'step-backward') => {
      if (!Number.isFinite(fps) || fps <= 0) return; // Guard against invalid fps
      const frameTime = 1 / fps;
      const { currentTime, duration, isPlaying } = get();
      const newTime = clampTimeToDuration(currentTime - frameTime, duration);
      set((state) => {
        state.currentTime = newTime;
      });
      dispatchSeekEvent(newTime, source);
      recordPlaybackTrace('seek', source, currentTime, newTime, isPlaying);
    },

    // =========================================================================
    // Time Updates
    // =========================================================================

    setCurrentTime: (time: number, source = 'time-update') => {
      const { currentTime, duration, isPlaying } = get();
      const newTime = clampTimeToDuration(time, duration);
      set((state) => {
        state.currentTime = newTime;
      });
      // Use update event for regular time updates (during playback)
      // This is different from seek which is user-initiated
      dispatchUpdateEvent(newTime, source);
      recordPlaybackTrace('time-update', source, currentTime, newTime, isPlaying);
    },

    setDuration: (durationInput: number) => {
      const nextDuration = getSafeDuration(durationInput);
      set((state) => {
        state.duration = nextDuration;
        state.currentTime = clampTimeToDuration(state.currentTime, nextDuration);
      });
    },

    // =========================================================================
    // Volume
    // =========================================================================

    setVolume: (volume: number) => {
      set((state) => {
        state.volume = !Number.isFinite(volume) ? state.volume : Math.max(0, Math.min(1, volume));
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
        state.playbackRate = !Number.isFinite(rate)
          ? state.playbackRate
          : Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, rate));
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

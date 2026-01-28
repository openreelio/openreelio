/**
 * useTimelineEngine Hook
 *
 * Provides integration between the TimelineEngine class and React components.
 * Synchronizes engine state with Zustand stores and provides React-friendly APIs.
 */

import { useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { TimelineEngine } from '@/core/TimelineEngine';
import { usePlaybackStore } from '@/stores/playbackStore';

// =============================================================================
// Types
// =============================================================================

export interface UseTimelineEngineOptions {
  /** Total duration in seconds */
  duration: number;
  /** Frames per second for frame stepping */
  fps?: number;
  /** Whether to auto-dispose on unmount */
  autoDispose?: boolean;
}

export interface UseTimelineEngineReturn {
  /** The underlying engine instance */
  engine: TimelineEngine;
  /** Current playhead position in seconds */
  currentTime: number;
  /** Whether playback is active */
  isPlaying: boolean;
  /** Current playback rate */
  playbackRate: number;
  /** Whether loop is enabled */
  loop: boolean;
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
  /** Go to start */
  goToStart: () => void;
  /** Go to end */
  goToEnd: () => void;
  /** Step forward one frame */
  stepForward: () => void;
  /** Step backward one frame */
  stepBackward: () => void;
  /** Set playback rate */
  setPlaybackRate: (rate: number) => void;
  /** Toggle loop */
  toggleLoop: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useTimelineEngine(options: UseTimelineEngineOptions): UseTimelineEngineReturn {
  const { duration, fps = 30, autoDispose = true } = options;

  // Get store actions and state
  const playbackStore = usePlaybackStore();
  const { currentTime, isPlaying, playbackRate, loop } = playbackStore;
  const { setCurrentTime, setIsPlaying, setDuration } = playbackStore;

  const isApplyingEngineUpdateRef = useRef(false);

  // Create engine instance (stable reference)
  const engineRef = useRef<TimelineEngine | null>(null);

  // Store initial duration in a ref to avoid recreating engine
  const initialDurationRef = useRef(duration);

  // Lazy initialization of engine (only on first access)
  if (!engineRef.current) {
    engineRef.current = new TimelineEngine({
      duration: initialDurationRef.current,
      playbackRate: 1,
    });
  }

  const engine = engineRef.current;

  // Sync engine -> store. Use layout effect to avoid illegal state updates during render,
  // while still ensuring the store is initialized before the user can interact.
  useLayoutEffect(() => {
    const storeApi = usePlaybackStore as unknown as { getState?: () => unknown };
    const getState = typeof storeApi.getState === 'function' ? storeApi.getState : null;

    /**
     * Safely compare two numbers with tolerance, handling NaN values.
     * Returns true if values are approximately equal (within epsilon).
     * NaN values are never considered equal to anything.
     */
    const isApproximatelyEqual = (a: number, b: number, epsilon = 1e-9): boolean => {
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return false;
      }
      return Math.abs(a - b) <= epsilon;
    };

    engine.syncWithStore({
      setCurrentTime: (time) => {
        // Guard against NaN/Infinity values from engine
        if (!Number.isFinite(time)) {
          return;
        }
        if (getState) {
          const state = getState() as { currentTime?: number } | null;
          if (
            state &&
            typeof state.currentTime === 'number' &&
            isApproximatelyEqual(state.currentTime, time)
          ) {
            return;
          }
        }
        isApplyingEngineUpdateRef.current = true;
        setCurrentTime(time);
        isApplyingEngineUpdateRef.current = false;
      },
      setIsPlaying: (playing) => {
        if (getState) {
          const state = getState() as { isPlaying?: boolean } | null;
          if (state && typeof state.isPlaying === 'boolean' && state.isPlaying === playing) {
            return;
          }
        }
        isApplyingEngineUpdateRef.current = true;
        setIsPlaying(playing);
        isApplyingEngineUpdateRef.current = false;
      },
      setDuration: (nextDuration) => {
        // Guard against NaN/Infinity values from engine
        if (!Number.isFinite(nextDuration) || nextDuration < 0) {
          return;
        }
        if (getState) {
          const state = getState() as { duration?: number } | null;
          if (
            state &&
            typeof state.duration === 'number' &&
            isApproximatelyEqual(state.duration, nextDuration)
          ) {
            return;
          }
        }
        isApplyingEngineUpdateRef.current = true;
        setDuration(nextDuration);
        isApplyingEngineUpdateRef.current = false;
      },
    });

    return () => {
      if (autoDispose) {
        engine.dispose();
      }
    };
  }, [engine, setCurrentTime, setIsPlaying, setDuration, autoDispose]);

  // Keep engine state in sync when playback state is mutated outside the engine.
  // This prevents desynchronization bugs where UI code updates the Zustand store
  // directly (e.g., via keyboard shortcuts) and the TimelineEngine never starts.
  useEffect(() => {
    const storeApi = usePlaybackStore as unknown as {
      subscribe?: (listener: (state: unknown, prevState?: unknown) => void) => unknown;
    };

    if (typeof storeApi.subscribe !== 'function') {
      return;
    }

    const unsubscribe = storeApi.subscribe((state: unknown) => {
      if (isApplyingEngineUpdateRef.current) return;
      if (!state || typeof state !== 'object') return;

      const next = state as { isPlaying?: boolean; currentTime?: number; playbackRate?: number; loop?: boolean };

      // Sync isPlaying state
      if (typeof next.isPlaying === 'boolean' && next.isPlaying !== engine.isPlaying) {
        if (next.isPlaying) engine.play();
        else engine.pause();
      }

      // Sync currentTime with NaN guard
      if (
        typeof next.currentTime === 'number' &&
        Number.isFinite(next.currentTime) &&
        Number.isFinite(engine.currentTime) &&
        Math.abs(next.currentTime - engine.currentTime) > 1e-6
      ) {
        engine.seek(next.currentTime);
      }

      // Sync playbackRate with validation
      if (
        typeof next.playbackRate === 'number' &&
        Number.isFinite(next.playbackRate) &&
        next.playbackRate > 0 &&
        next.playbackRate !== engine.playbackRate
      ) {
        engine.setPlaybackRate(next.playbackRate);
      }

      // Sync loop state
      if (typeof next.loop === 'boolean' && next.loop !== engine.loop) {
        engine.setLoop(next.loop);
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [engine]);

  // Update duration when it changes
  useEffect(() => {
    engine.setDuration(duration);
  }, [engine, duration]);

  // ===========================================================================
  // Callbacks
  // ===========================================================================

  const play = useCallback(() => {
    engine.play();
  }, [engine]);

  const pause = useCallback(() => {
    engine.pause();
  }, [engine]);

  const togglePlayback = useCallback(() => {
    engine.togglePlayback();
  }, [engine]);

  const seek = useCallback(
    (time: number) => {
      engine.seek(time);
    },
    [engine],
  );

  const seekForward = useCallback(
    (amount: number) => {
      engine.seekForward(amount);
    },
    [engine],
  );

  const seekBackward = useCallback(
    (amount: number) => {
      engine.seekBackward(amount);
    },
    [engine],
  );

  const goToStart = useCallback(() => {
    engine.goToStart();
  }, [engine]);

  const goToEnd = useCallback(() => {
    engine.goToEnd();
  }, [engine]);

  const stepForward = useCallback(() => {
    engine.stepForward(fps);
  }, [engine, fps]);

  const stepBackward = useCallback(() => {
    engine.stepBackward(fps);
  }, [engine, fps]);

  const setPlaybackRate = useCallback(
    (rate: number) => {
      engine.setPlaybackRate(rate);
      playbackStore.setPlaybackRate(rate);
    },
    [engine, playbackStore],
  );

  const toggleLoop = useCallback(() => {
    engine.toggleLoop();
    playbackStore.toggleLoop();
  }, [engine, playbackStore]);

  // ===========================================================================
  // Return
  // ===========================================================================

  return useMemo(
    () => ({
      engine,
      currentTime,
      isPlaying,
      playbackRate,
      loop,
      play,
      pause,
      togglePlayback,
      seek,
      seekForward,
      seekBackward,
      goToStart,
      goToEnd,
      stepForward,
      stepBackward,
      setPlaybackRate,
      toggleLoop,
    }),
    [
      engine,
      currentTime,
      isPlaying,
      playbackRate,
      loop,
      play,
      pause,
      togglePlayback,
      seek,
      seekForward,
      seekBackward,
      goToStart,
      goToEnd,
      stepForward,
      stepBackward,
      setPlaybackRate,
      toggleLoop,
    ],
  );
}


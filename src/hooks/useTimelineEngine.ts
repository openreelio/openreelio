/**
 * useTimelineEngine Hook
 *
 * Provides integration between the TimelineEngine class and React components.
 * Synchronizes engine state with Zustand stores and provides React-friendly APIs.
 */

import { useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { TimelineEngine } from '@/core/TimelineEngine';
import {
  PLAYBACK_EVENTS,
  type PlaybackSeekEventDetail,
  usePlaybackStore,
} from '@/stores/playbackStore';
import { PRECISION, isApproximatelyEqual } from '@/constants/precision';

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
  seek: (time: number, source?: string) => void;
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
  const pendingTimeSourceRef = useRef<string | null>(null);

  /**
   * Track the last time value that the engine explicitly set.
   * This allows us to detect external seeks by comparing time values,
   * not just timestamps, which fixes the issue where continuous playback
   * blocks external seek updates.
   */
  const lastEngineTimeRef = useRef<number>(0);

  /**
   * Track engine updates using timestamp for play/pause state only.
   */
  const lastEngineStateUpdateRef = useRef<number>(0);

  /**
   * Grace period for ignoring store updates for play/pause state.
   * 50ms is enough for React's batching to complete.
   */
  const STATE_UPDATE_GRACE_MS = 50;

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
     * Mark that an engine state update (play/pause) is in progress.
     */
    const markEngineStateUpdate = () => {
      lastEngineStateUpdateRef.current = performance.now();
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
            isApproximatelyEqual(state.currentTime, time, PRECISION.TIME_EPSILON)
          ) {
            return;
          }
        }
        // Track the time value that engine set (for external seek detection)
        lastEngineTimeRef.current = time;
        const source = pendingTimeSourceRef.current ?? (engine.isPlaying ? 'engine-tick' : 'engine-sync');
        pendingTimeSourceRef.current = null;
        setCurrentTime(time, source);
      },
      setIsPlaying: (playing) => {
        if (getState) {
          const state = getState() as { isPlaying?: boolean } | null;
          if (state && typeof state.isPlaying === 'boolean' && state.isPlaying === playing) {
            return;
          }
        }
        markEngineStateUpdate();
        setIsPlaying(playing, 'engine-play-state');
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
            isApproximatelyEqual(state.duration, nextDuration, PRECISION.TIME_EPSILON)
          ) {
            return;
          }
        }
        markEngineStateUpdate();
        setDuration(nextDuration);
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
      if (!state || typeof state !== 'object') return;

      const next = state as { isPlaying?: boolean; currentTime?: number; playbackRate?: number; loop?: boolean };

      // Check if state updates (play/pause) originated from the engine
      const timeSinceStateUpdate = performance.now() - lastEngineStateUpdateRef.current;
      const isEngineStateUpdate = timeSinceStateUpdate < STATE_UPDATE_GRACE_MS;

      // Sync isPlaying state (use timestamp-based check for play/pause)
      if (!isEngineStateUpdate && typeof next.isPlaying === 'boolean' && next.isPlaying !== engine.isPlaying) {
        if (next.isPlaying) engine.play();
        else engine.pause();
      }

      // Sync currentTime: Use VALUE-BASED detection for external seeks
      // This fixes the issue where continuous playback blocked external seek updates
      if (
        typeof next.currentTime === 'number' &&
        Number.isFinite(next.currentTime) &&
        Number.isFinite(engine.currentTime)
      ) {
        const isPaused = typeof next.isPlaying === 'boolean' ? !next.isPlaying : !engine.isPlaying;

        // During active playback, explicit user-intent seeks are applied via PLAYBACK_EVENTS.SEEK.
        // Ignoring generic time-update writes here prevents non-authoritative preview loops
        // from forcing engine seeks and causing playhead jitter/snap-back.
        if (isPaused) {
          // Compare store's currentTime with the last time the ENGINE set.
          // This prevents echo loops without requiring timestamp-based guards.
          const timeDiffFromLastEngineSet = Math.abs(next.currentTime - lastEngineTimeRef.current);
          const timeDiffFromEngineNow = Math.abs(next.currentTime - engine.currentTime);

          // When paused: always sync (above epsilon) so small seeks/steps are reflected.
          const requiredDeltaFromLastEngineSet = PRECISION.TIME_EPSILON;

          // If the store's time differs from what the engine last set (by the required delta)
          // AND differs from the engine's current time, treat it as an external seek.
          const isExternalSeek =
            timeDiffFromLastEngineSet > requiredDeltaFromLastEngineSet &&
            timeDiffFromEngineNow > PRECISION.TIME_EPSILON;

          if (isExternalSeek) {
            // Update our tracking ref to prevent echo
            lastEngineTimeRef.current = next.currentTime;
            pendingTimeSourceRef.current = 'store-external-seek';
            engine.seek(next.currentTime);
            if (pendingTimeSourceRef.current === 'store-external-seek') {
              pendingTimeSourceRef.current = null;
            }
          }
        }
      }

      // Sync playbackRate with validation (use timestamp check)
      if (
        !isEngineStateUpdate &&
        typeof next.playbackRate === 'number' &&
        Number.isFinite(next.playbackRate) &&
        next.playbackRate > 0 &&
        next.playbackRate !== engine.playbackRate
      ) {
        engine.setPlaybackRate(next.playbackRate);
      }

      // Sync loop state (use timestamp check)
      if (!isEngineStateUpdate && typeof next.loop === 'boolean' && next.loop !== engine.loop) {
        engine.setLoop(next.loop);
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [engine]);

  // Handle explicit seek events from PlaybackStore.seek* actions.
  // These represent user-intent seeks (scrubbing, seek bar drag, keyboard jump)
  // and must be applied immediately even during active playback.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleSeek = (event: Event) => {
      const customEvent = event as CustomEvent<PlaybackSeekEventDetail>;
      const targetTime = customEvent.detail?.time;
      const source = customEvent.detail?.source ?? 'playback-seek-event';

      if (!Number.isFinite(targetTime) || !Number.isFinite(engine.currentTime)) {
        return;
      }

      if (isApproximatelyEqual(engine.currentTime, targetTime, PRECISION.TIME_EPSILON)) {
        return;
      }

      lastEngineTimeRef.current = targetTime;
      pendingTimeSourceRef.current = `seek-event:${source}`;
      engine.seek(targetTime);
      if (pendingTimeSourceRef.current === `seek-event:${source}`) {
        pendingTimeSourceRef.current = null;
      }
    };

    window.addEventListener(PLAYBACK_EVENTS.SEEK, handleSeek);
    return () => {
      window.removeEventListener(PLAYBACK_EVENTS.SEEK, handleSeek);
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
    (time: number, source: string = 'timeline-engine-api') => {
      pendingTimeSourceRef.current = source;
      engine.seek(time);
      if (pendingTimeSourceRef.current === source) {
        pendingTimeSourceRef.current = null;
      }
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


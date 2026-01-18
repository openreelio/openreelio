/**
 * useTimelineEngine Hook
 *
 * Provides integration between the TimelineEngine class and React components.
 * Synchronizes engine state with Zustand stores and provides React-friendly APIs.
 */

import { useEffect, useRef, useMemo, useCallback } from 'react';
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

  // Create engine instance (stable reference)
  // Using a ref to ensure the engine is only created once
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

  // Sync engine with store (only on mount and when store changes)
  useEffect(() => {
    engine.syncWithStore({
      setCurrentTime: playbackStore.setCurrentTime,
      setIsPlaying: playbackStore.setIsPlaying,
      setDuration: playbackStore.setDuration,
    });

    return () => {
      if (autoDispose) {
        engine.dispose();
      }
    };
  }, [engine, playbackStore, autoDispose]);

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
    [engine]
  );

  const seekForward = useCallback(
    (amount: number) => {
      engine.seekForward(amount);
    },
    [engine]
  );

  const seekBackward = useCallback(
    (amount: number) => {
      engine.seekBackward(amount);
    },
    [engine]
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
    [engine, playbackStore]
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
    ]
  );
}

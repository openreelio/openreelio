/**
 * usePlaybackLoop Hook
 *
 * Provides a RAF-based playback loop for timeline preview.
 * Features:
 * - FPS throttling to target frame rate
 * - Frame drop detection and handling
 * - Integration with playback store
 * - Automatic cleanup on unmount
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { usePlaybackStore } from '@/stores/playbackStore';
import { PLAYBACK } from '@/constants/preview';
import { playbackMonitor } from '@/services/playbackMonitor';

// =============================================================================
// Types
// =============================================================================

export interface UsePlaybackLoopOptions {
  /**
   * Callback invoked on each frame with current playback time.
   */
  onFrame: (currentTime: number) => void;

  /**
   * Total duration of the sequence in seconds.
   */
  duration: number;

  /**
   * Target frames per second (default: 30).
   */
  targetFps?: number;

  /**
   * Whether to allow frame dropping when behind schedule.
   * Default: true
   */
  allowFrameDrop?: boolean;

  /**
   * Callback invoked when playback ends.
   */
  onEnded?: () => void;
}

export interface UsePlaybackLoopReturn {
  /**
   * Whether the playback loop is currently active.
   */
  isActive: boolean;

  /**
   * Total number of frames rendered.
   */
  frameCount: number;

  /**
   * Actual FPS achieved (rolling average).
   */
  actualFps: number;

  /**
   * Number of frames dropped.
   */
  droppedFrames: number;
}

// =============================================================================
// Constants
// =============================================================================

const FPS_SAMPLE_SIZE = 30; // Frames to average for FPS calculation

// =============================================================================
// Hook
// =============================================================================

/**
 * RAF-based playback loop for timeline preview.
 *
 * Integrates with playbackStore for play/pause/seek control.
 *
 * @example
 * ```typescript
 * const { isActive, actualFps } = usePlaybackLoop({
 *   onFrame: (time) => {
 *     // Render frame at `time`
 *     await extractFrame(time);
 *   },
 *   duration: sequence.duration,
 *   onEnded: () => console.log('Playback ended'),
 * });
 * ```
 */
export function usePlaybackLoop(options: UsePlaybackLoopOptions): UsePlaybackLoopReturn {
  const {
    onFrame,
    duration,
    targetFps = PLAYBACK.TARGET_FPS,
    allowFrameDrop = true,
    onEnded,
  } = options;

  // Playback store state
  const {
    isPlaying,
    currentTime,
    playbackRate,
    loop,
    setCurrentTime,
    setIsPlaying,
  } = usePlaybackStore();

  // State
  const [isActive, setIsActive] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [actualFps, setActualFps] = useState(0);
  const [droppedFrames, setDroppedFrames] = useState(0);

  // Refs for RAF loop
  const rafIdRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const lastPlaybackTimeRef = useRef<number>(currentTime);
  const frameTimesRef = useRef<number[]>([]);
  const isMountedRef = useRef(true);

  // Stable ref for onFrame callback (prevents playbackLoop recreation on every render)
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  // Target frame interval
  const frameIntervalMs = 1000 / targetFps;

  /**
   * Calculate rolling FPS average
   */
  const updateFps = useCallback((frameTime: number) => {
    frameTimesRef.current.push(frameTime);

    if (frameTimesRef.current.length > FPS_SAMPLE_SIZE) {
      frameTimesRef.current.shift();
    }

    if (frameTimesRef.current.length >= 2) {
      const times = frameTimesRef.current;
      const totalTime = times[times.length - 1] - times[0];
      const fps = ((times.length - 1) / totalTime) * 1000;
      setActualFps(Math.round(fps * 10) / 10);
    }
  }, []);

  /**
   * Main playback loop
   *
   * Optimized RAF scheduling:
   * - Uses proper frame timing to reduce unnecessary callbacks
   * - Handles frame drops gracefully
   * - Maintains accurate time progression
   */
  const playbackLoop = useCallback(
    (timestamp: number) => {
      if (!isMountedRef.current) return;

      // First frame initialization
      if (lastFrameTimeRef.current === 0) {
        lastFrameTimeRef.current = timestamp;
        rafIdRef.current = requestAnimationFrame(playbackLoop);
        return;
      }

      // Calculate delta time
      const deltaMs = timestamp - lastFrameTimeRef.current;

      // FPS throttling - skip frame but don't reschedule immediately
      // This reduces unnecessary RAF callbacks
      if (deltaMs < frameIntervalMs) {
        // Only schedule if we're still playing
        if (isMountedRef.current) {
          rafIdRef.current = requestAnimationFrame(playbackLoop);
        }
        return;
      }

      // Calculate how many frames we should have rendered
      const framesElapsed = Math.floor(deltaMs / frameIntervalMs);

      // Frame drop detection - only count actual drops
      if (allowFrameDrop && framesElapsed > 1) {
        const droppedCount = framesElapsed - 1;
        setDroppedFrames((prev) => prev + droppedCount);
        // Report to performance monitor
        playbackMonitor.recordDroppedFrames(droppedCount);
      }

      // Calculate actual time delta (cap to prevent huge jumps)
      // Use framesElapsed * frameIntervalMs for smoother timing
      const cappedDeltaMs = Math.min(
        framesElapsed * frameIntervalMs,
        PLAYBACK.FRAME_DROP_THRESHOLD_MS * 2
      );
      const deltaSec = (cappedDeltaMs / 1000) * playbackRate;

      // Update playback time
      let newTime = lastPlaybackTimeRef.current + deltaSec;

      // Handle end of sequence
      if (newTime >= duration) {
        if (loop) {
          // Loop back to start
          newTime = newTime % duration;
        } else {
          // Stop playback and return to start (standard NLE behavior)
          setIsPlaying(false);
          setIsActive(false);
          setCurrentTime(0);

          // Render the first frame so the preview shows the start position
          onFrameRef.current(0);

          onEnded?.();

          // Reset for next play session
          lastFrameTimeRef.current = 0;
          lastPlaybackTimeRef.current = 0;
          return;
        }
      }

      // Update store
      setCurrentTime(newTime);
      lastPlaybackTimeRef.current = newTime;

      // Adjust lastFrameTimeRef to account for any accumulated sub-frame time
      // This prevents drift over long playback sessions
      lastFrameTimeRef.current = timestamp - (deltaMs % frameIntervalMs);

      // Update stats
      setFrameCount((prev) => prev + 1);
      updateFps(timestamp);

      // Call frame callback (using ref for stability)
      // Track render time for performance monitoring
      const frameStartTime = performance.now();
      onFrameRef.current(newTime);
      const frameEndTime = performance.now();
      const renderTimeMs = frameEndTime - frameStartTime;

      // Report frame render to performance monitor
      playbackMonitor.recordFrame(renderTimeMs, false);

      // Schedule next frame
      rafIdRef.current = requestAnimationFrame(playbackLoop);
    },
    [
      frameIntervalMs,
      playbackRate,
      duration,
      loop,
      allowFrameDrop,
      setCurrentTime,
      setIsPlaying,
      onEnded,
      updateFps,
    ]
  );

  /**
   * Start the playback loop
   */
  const startLoop = useCallback(() => {
    if (rafIdRef.current !== null) return; // Already running

    lastFrameTimeRef.current = performance.now();
    lastPlaybackTimeRef.current = usePlaybackStore.getState().currentTime;
    frameTimesRef.current = [];
    setIsActive(true);

    // Start performance monitoring
    playbackMonitor.start();

    rafIdRef.current = requestAnimationFrame(playbackLoop);
  }, [playbackLoop]);

  /**
   * Stop the playback loop
   */
  const stopLoop = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setIsActive(false);

    // Stop performance monitoring and log summary
    if (playbackMonitor.active) {
      playbackMonitor.stop();
    }
  }, []);

  // Respond to play/pause changes
  useEffect(() => {
    if (isPlaying) {
      startLoop();
    } else {
      stopLoop();
    }

    return () => {
      stopLoop();
    };
  }, [isPlaying, startLoop, stopLoop]);

  // Sync with external seek
  useEffect(() => {
    // Update lastPlaybackTimeRef when currentTime changes externally
    // (e.g., user scrubbing timeline)
    if (!isPlaying) {
      lastPlaybackTimeRef.current = currentTime;
    }
  }, [currentTime, isPlaying]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      stopLoop();
    };
  }, [stopLoop]);

  return {
    isActive,
    frameCount,
    actualFps,
    droppedFrames,
  };
}

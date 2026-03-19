/**
 * JKL Shuttle Control Hook
 *
 * Industry-standard shuttle transport control for NLE editors.
 * J = reverse (repeated presses increase speed: -1x → -2x → -4x → -8x)
 * K = stop/pause immediately
 * L = forward (repeated presses increase speed: 1x → 2x → 4x → 8x)
 * K+J (held) = step one frame backward
 * K+L (held) = step one frame forward
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { PLAYBACK } from '@/constants/preview';
import { SHUTTLE_SPEEDS } from '@/constants/editing';

// =============================================================================
// Re-exports & Constants
// =============================================================================

export { SHUTTLE_SPEEDS };

/** Index of the stop position (speed 0) in SHUTTLE_SPEEDS */
export const SHUTTLE_STOP_INDEX = SHUTTLE_SPEEDS.indexOf(0 as (typeof SHUTTLE_SPEEDS)[number]);

export type ShuttleSpeed = (typeof SHUTTLE_SPEEDS)[number];

// =============================================================================
// Types
// =============================================================================

export interface UseJKLShuttleOptions {
  /** Start forward playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Set playback rate (positive values only). Defaults to no-op for read-only monitors. */
  setPlaybackRate?: (rate: number) => void;
  /** Step one frame forward */
  stepForward: () => void;
  /** Step one frame backward */
  stepBackward: () => void;
  /**
   * Seek relative to current position.
   * Negative values seek backward, positive seek forward.
   * Used for reverse playback interval.
   */
  seekRelative: (deltaSec: number) => void;
  /** Whether shuttle controls are active (default: true) */
  enabled?: boolean;
}

export interface UseJKLShuttleReturn {
  /** Current shuttle speed (-8 to 8, 0 = stopped) */
  shuttleSpeed: ShuttleSpeed;
  /**
   * Process a keydown event. Returns true if the event was consumed by shuttle.
   * Caller should call e.preventDefault() when true is returned.
   */
  handleKeyDown: (key: string, ctrl: boolean, shift: boolean) => boolean;
  /** Process a keyup event (required for K+J/K+L combo detection) */
  handleKeyUp: (key: string) => void;
  /** Reset shuttle to stop state without affecting playback */
  resetShuttle: () => void;
}

// =============================================================================
// Hook
// =============================================================================

export function useJKLShuttle(options: UseJKLShuttleOptions): UseJKLShuttleReturn {
  const {
    play,
    pause,
    setPlaybackRate = () => {},
    stepForward,
    stepBackward,
    seekRelative,
    enabled = true,
  } = options;

  // Reactive state for UI indicator
  const [shuttleSpeed, setShuttleSpeed] = useState<ShuttleSpeed>(0);

  // Ref-based state to avoid stale closures in event handlers
  const shuttleIndexRef = useRef(SHUTTLE_STOP_INDEX);
  const kHeldRef = useRef(false);
  const reverseIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearReverseInterval = useCallback(() => {
    if (reverseIntervalRef.current !== null) {
      clearInterval(reverseIntervalRef.current);
      reverseIntervalRef.current = null;
    }
  }, []);

  /**
   * Apply a shuttle speed: update state, configure playback accordingly.
   * - Speed 0: pause, reset rate
   * - Positive: set rate, play forward
   * - Negative: pause native playback, reverse handled by interval effect
   */
  const applyShuttleSpeed = useCallback(
    (speed: ShuttleSpeed) => {
      setShuttleSpeed(speed);
      clearReverseInterval();

      if (speed === 0) {
        pause();
        setPlaybackRate(1);
      } else if (speed > 0) {
        setPlaybackRate(speed);
        play();
      } else {
        // Reverse: pause native playback; interval effect will drive backward seeking
        pause();
        setPlaybackRate(1);
      }
    },
    [play, pause, setPlaybackRate, clearReverseInterval],
  );

  // Reverse playback effect: periodically seek backward at the shuttle speed rate.
  // Runs at TARGET_FPS intervals, each step covers (1/fps * absSpeed) seconds.
  useEffect(() => {
    if (shuttleSpeed >= 0) {
      return;
    }

    const fps = PLAYBACK.TARGET_FPS;
    const absSpeed = Math.abs(shuttleSpeed);
    const intervalMs = 1000 / fps;
    const stepSec = (1 / fps) * absSpeed;

    reverseIntervalRef.current = setInterval(() => {
      seekRelative(-stepSec);
    }, intervalMs);

    return clearReverseInterval;
  }, [shuttleSpeed, seekRelative, clearReverseInterval]);

  const handleKeyDown = useCallback(
    (key: string, ctrl: boolean, shift: boolean): boolean => {
      if (!enabled || ctrl || shift) return false;

      const lowerKey = key.toLowerCase();

      // K — Stop immediately
      if (lowerKey === 'k') {
        kHeldRef.current = true;
        shuttleIndexRef.current = SHUTTLE_STOP_INDEX;
        applyShuttleSpeed(0);
        return true;
      }

      // J — Reverse (or frame step backward when K is held)
      if (lowerKey === 'j') {
        if (kHeldRef.current) {
          stepBackward();
          return true;
        }
        if (shuttleIndexRef.current > 0) {
          shuttleIndexRef.current--;
          applyShuttleSpeed(SHUTTLE_SPEEDS[shuttleIndexRef.current]);
        }
        return true;
      }

      // L — Forward (or frame step forward when K is held)
      if (lowerKey === 'l') {
        if (kHeldRef.current) {
          stepForward();
          return true;
        }
        if (shuttleIndexRef.current < SHUTTLE_SPEEDS.length - 1) {
          shuttleIndexRef.current++;
          applyShuttleSpeed(SHUTTLE_SPEEDS[shuttleIndexRef.current]);
        }
        return true;
      }

      return false;
    },
    [enabled, applyShuttleSpeed, stepForward, stepBackward],
  );

  const handleKeyUp = useCallback((key: string): void => {
    if (key.toLowerCase() === 'k') {
      kHeldRef.current = false;
    }
  }, []);

  const resetShuttle = useCallback((): void => {
    shuttleIndexRef.current = SHUTTLE_STOP_INDEX;
    kHeldRef.current = false;
    clearReverseInterval();
    setShuttleSpeed(0);
    setPlaybackRate(1);
  }, [clearReverseInterval, setPlaybackRate]);

  // Cleanup reverse interval on unmount
  useEffect(() => {
    return clearReverseInterval;
  }, [clearReverseInterval]);

  return useMemo(
    () => ({ shuttleSpeed, handleKeyDown, handleKeyUp, resetShuttle }),
    [shuttleSpeed, handleKeyDown, handleKeyUp, resetShuttle],
  );
}

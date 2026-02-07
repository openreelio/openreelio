/**
 * usePlaybackLoop Hook Tests
 *
 * TDD tests for RAF-based playback loop with frame timing control.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePlaybackLoop } from './usePlaybackLoop';
import { usePlaybackStore } from '@/stores/playbackStore';

describe('usePlaybackLoop', () => {
  // Track RAF calls
  let rafCallback: ((time: number) => void) | null = null;
  let rafId = 0;
  let cancelled = false;

  const mockRaf = vi.fn((callback: (time: number) => void) => {
    rafCallback = callback;
    cancelled = false; // Reset cancelled flag when new RAF is scheduled
    return ++rafId;
  });

  const mockCancelRaf = vi.fn(() => {
    cancelled = true;
    rafCallback = null;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    rafCallback = null;
    rafId = 0;
    cancelled = false;

    // Mock RAF
    vi.stubGlobal('requestAnimationFrame', mockRaf);
    vi.stubGlobal('cancelAnimationFrame', mockCancelRaf);

    // Reset playback store
    usePlaybackStore.getState().reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Helper to simulate multiple RAF frames
   */
  function runFrames(count: number, intervalMs: number = 33) {
    let time = performance.now();
    for (let i = 0; i < count && rafCallback && !cancelled; i++) {
      time += intervalMs;
      const cb = rafCallback;
      rafCallback = null;
      cb(time);
    }
  }

  // ===========================================================================
  // Basic Playback
  // ===========================================================================

  describe('Basic Playback', () => {
    it('should not start loop when not playing', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      expect(mockRaf).not.toHaveBeenCalled();
    });

    it('should start loop when playing', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().play();
      });

      expect(mockRaf).toHaveBeenCalled();
    });

    it('should stop loop when paused', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().play();
      });

      expect(mockRaf).toHaveBeenCalled();

      act(() => {
        usePlaybackStore.getState().pause();
      });

      expect(mockCancelRaf).toHaveBeenCalled();
    });

    it('should call onFrame callback during playback', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().play();
      });

      // Simulate frames
      act(() => {
        runFrames(5, 40);
      });

      expect(onFrame).toHaveBeenCalled();
    });

    it('should stay passive when disabled', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ enabled: false, onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().play();
      });

      expect(mockRaf).not.toHaveBeenCalled();
      expect(usePlaybackStore.getState().currentTime).toBe(0);
    });
  });

  // ===========================================================================
  // Time Progression
  // ===========================================================================

  describe('Time Progression', () => {
    it('should advance currentTime during playback', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().setCurrentTime(0);
        usePlaybackStore.getState().play();
      });

      // Simulate frames
      act(() => {
        runFrames(30, 40);
      });

      const { currentTime } = usePlaybackStore.getState();
      expect(currentTime).toBeGreaterThan(0); // Should have advanced
    });

    it('should respect playback rate', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().setCurrentTime(0);
        usePlaybackStore.getState().setPlaybackRate(2); // 2x speed
        usePlaybackStore.getState().play();
      });

      // Simulate frames
      act(() => {
        runFrames(10, 50);
      });

      const { currentTime } = usePlaybackStore.getState();
      // At 2x speed, time should advance faster
      expect(currentTime).toBeGreaterThan(0);
    });

    it('should stop at duration', () => {
      const onFrame = vi.fn();
      const onEnded = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 0.5, onEnded }));

      act(() => {
        usePlaybackStore.getState().setCurrentTime(0.4);
        usePlaybackStore.getState().play();
      });

      // Simulate frames past duration
      act(() => {
        runFrames(20, 50);
      });

      expect(onEnded).toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
    });

    it('should loop when loop is enabled', () => {
      const onFrame = vi.fn();
      const onEnded = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 0.5, onEnded }));

      act(() => {
        usePlaybackStore.getState().setCurrentTime(0.4);
        usePlaybackStore.getState().setLoop(true);
        usePlaybackStore.getState().play();
      });

      // Simulate frames past duration
      act(() => {
        runFrames(10, 50);
      });

      // Should have looped, not ended
      expect(onEnded).not.toHaveBeenCalled();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
  });

  // ===========================================================================
  // Frame Rate Control
  // ===========================================================================

  describe('Frame Rate Control', () => {
    it('should throttle to target FPS', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 10, targetFps: 30 }));

      act(() => {
        usePlaybackStore.getState().play();
      });

      // Simulate very fast frames (faster than 30fps)
      // 100 frames at 5ms each = 500ms total
      act(() => {
        runFrames(100, 5);
      });

      // Should have throttled to ~30fps (500ms / 33.33ms = ~15 frames)
      // Allow some tolerance for implementation details
      expect(onFrame.mock.calls.length).toBeLessThan(50);
    });

    it('should skip frames when behind schedule', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({
        onFrame,
        duration: 10,
        targetFps: 30,
        allowFrameDrop: true,
      }));

      act(() => {
        usePlaybackStore.getState().play();
      });

      // Simulate a long frame (simulating slow processing)
      act(() => {
        runFrames(1, 100); // 100ms frame = very slow
      });

      // Should have advanced time appropriately despite slow frame
      const { currentTime } = usePlaybackStore.getState();
      expect(currentTime).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Callbacks
  // ===========================================================================

  describe('Callbacks', () => {
    it('should call onFrame with current time', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().setCurrentTime(5);
        usePlaybackStore.getState().play();
      });

      // Use 40ms interval to exceed 30fps threshold (33.33ms)
      act(() => {
        runFrames(3, 40);
      });

      expect(onFrame).toHaveBeenCalledWith(expect.any(Number));
      const calledTime = onFrame.mock.calls[0][0];
      expect(calledTime).toBeGreaterThanOrEqual(5);
    });

    it('should call onEnded when playback ends', () => {
      const onEnded = vi.fn();
      // Use shorter duration for reliable testing
      renderHook(() => usePlaybackLoop({ onFrame: vi.fn(), duration: 0.5, onEnded }));

      act(() => {
        usePlaybackStore.getState().setCurrentTime(0.4);
        usePlaybackStore.getState().play();
      });

      // Run frames to exceed duration
      act(() => {
        runFrames(10, 50);
      });

      expect(onEnded).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // State Synchronization
  // ===========================================================================

  describe('State Synchronization', () => {
    it('should sync with playback store isPlaying', () => {
      const onFrame = vi.fn();
      const { result } = renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      expect(result.current.isActive).toBe(false);

      act(() => {
        usePlaybackStore.getState().play();
      });

      expect(result.current.isActive).toBe(true);

      act(() => {
        usePlaybackStore.getState().pause();
      });

      expect(result.current.isActive).toBe(false);
    });

    it('should provide frame statistics', () => {
      const onFrame = vi.fn();
      const { result } = renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().play();
      });

      // Simulate some frames
      act(() => {
        runFrames(10, 33);
      });

      expect(result.current.frameCount).toBeGreaterThan(0);
      expect(result.current.actualFps).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  describe('Cleanup', () => {
    it('should cancel RAF on unmount', () => {
      const onFrame = vi.fn();
      const { unmount } = renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().play();
      });

      unmount();

      expect(mockCancelRaf).toHaveBeenCalled();
    });

    it('should not call callbacks after unmount', () => {
      const onFrame = vi.fn();
      const { unmount } = renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().play();
      });

      unmount();
      const callCountBefore = onFrame.mock.calls.length;

      // Try to advance frame after unmount - should not call callback
      act(() => {
        runFrames(1, 33);
      });

      expect(onFrame.mock.calls.length).toBe(callCountBefore);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle zero duration', () => {
      const onFrame = vi.fn();
      const onEnded = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 0, onEnded }));

      act(() => {
        usePlaybackStore.getState().play();
      });

      // Should immediately end - use 40ms to exceed FPS threshold
      act(() => {
        runFrames(3, 40);
      });

      expect(onEnded).toHaveBeenCalled();
    });

    it('should handle seek when paused then resumed', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      // Set store duration so seek works correctly (seek clamps to [0, duration])
      act(() => {
        usePlaybackStore.getState().setDuration(10);
        usePlaybackStore.getState().setCurrentTime(0);
        usePlaybackStore.getState().play();
      });

      // Run a few frames
      act(() => {
        runFrames(3, 40);
      });

      // Pause, seek to 5, then resume
      act(() => {
        usePlaybackStore.getState().pause();
      });

      act(() => {
        usePlaybackStore.getState().seek(5);
      });

      act(() => {
        usePlaybackStore.getState().play();
      });

      // Run more frames after resuming
      act(() => {
        runFrames(3, 40);
      });

      // Check that onFrame was called with time >= 5 after resume
      expect(onFrame.mock.calls.length).toBeGreaterThan(0);
      const lastCallTime = onFrame.mock.calls[onFrame.mock.calls.length - 1][0];
      expect(lastCallTime).toBeGreaterThanOrEqual(5);
    });

    it('should handle rate change during playback', () => {
      const onFrame = vi.fn();
      renderHook(() => usePlaybackLoop({ onFrame, duration: 10 }));

      act(() => {
        usePlaybackStore.getState().setCurrentTime(0);
        usePlaybackStore.getState().setPlaybackRate(1);
        usePlaybackStore.getState().play();
      });

      // Change to 0.5x speed
      act(() => {
        usePlaybackStore.getState().setPlaybackRate(0.5);
      });

      act(() => {
        runFrames(1, 1000); // 1 second
      });

      // At 0.5x speed, should have advanced ~0.5 seconds
      const { currentTime } = usePlaybackStore.getState();
      expect(currentTime).toBeLessThan(1);
    });
  });
});

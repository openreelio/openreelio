/**
 * useJKLShuttle Hook Tests (BDD)
 *
 * Feature: JKL Shuttle Control
 *   Industry-standard J/K/L shuttle transport for NLE editing.
 *
 *   Scenario: L key cycles through forward speeds
 *     Given shuttle is stopped (speed 0)
 *     When L is pressed repeatedly
 *     Then speed cycles 1x → 2x → 4x → 8x
 *
 *   Scenario: J key cycles through reverse speeds
 *     Given shuttle is stopped (speed 0)
 *     When J is pressed repeatedly
 *     Then speed cycles -1x → -2x → -4x → -8x
 *
 *   Scenario: K key stops immediately
 *     Given shuttle is at forward 4x
 *     When K is pressed
 *     Then speed resets to 0 and playback pauses
 *
 *   Scenario: K+J steps one frame backward
 *     Given K is held down
 *     When J is pressed
 *     Then stepBackward is called (single frame)
 *
 *   Scenario: K+L steps one frame forward
 *     Given K is held down
 *     When L is pressed
 *     Then stepForward is called (single frame)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useJKLShuttle, SHUTTLE_SPEEDS, SHUTTLE_STOP_INDEX } from './useJKLShuttle';
import type { UseJKLShuttleOptions } from './useJKLShuttle';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockOptions(overrides: Partial<UseJKLShuttleOptions> = {}): UseJKLShuttleOptions {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    setPlaybackRate: vi.fn(),
    stepForward: vi.fn(),
    stepBackward: vi.fn(),
    seekRelative: vi.fn(),
    enabled: true,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('useJKLShuttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // L key — forward speed cycling
  // ---------------------------------------------------------------------------

  describe('L key (forward)', () => {
    it('should cycle through forward speeds when L is pressed repeatedly', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // Initial: stopped
      expect(result.current.shuttleSpeed).toBe(0);

      // L pressed once → 1x forward
      act(() => {
        result.current.handleKeyDown('l', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(1);
      expect(opts.play).toHaveBeenCalled();
      expect(opts.setPlaybackRate).toHaveBeenCalledWith(1);

      // L pressed again → 2x
      act(() => {
        result.current.handleKeyDown('l', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(2);
      expect(opts.setPlaybackRate).toHaveBeenCalledWith(2);

      // L pressed again → 4x
      act(() => {
        result.current.handleKeyDown('l', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(4);

      // L pressed again → 8x (maximum)
      act(() => {
        result.current.handleKeyDown('l', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(8);

      // L pressed at max → stays at 8x
      act(() => {
        result.current.handleKeyDown('l', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(8);
    });

    it('should return true when L key is consumed', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      let consumed = false;
      act(() => {
        consumed = result.current.handleKeyDown('l', false, false);
      });
      expect(consumed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // J key — reverse speed cycling
  // ---------------------------------------------------------------------------

  describe('J key (reverse)', () => {
    it('should cycle through reverse speeds when J is pressed repeatedly', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // J pressed once → -1x reverse
      act(() => {
        result.current.handleKeyDown('j', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(-1);
      expect(opts.pause).toHaveBeenCalled();

      // J pressed again → -2x
      act(() => {
        result.current.handleKeyDown('j', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(-2);

      // J pressed again → -4x
      act(() => {
        result.current.handleKeyDown('j', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(-4);

      // J pressed again → -8x (maximum reverse)
      act(() => {
        result.current.handleKeyDown('j', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(-8);

      // J at minimum → stays at -8x
      act(() => {
        result.current.handleKeyDown('j', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(-8);
    });

    it('should trigger reverse playback interval for negative speeds', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // Enter reverse mode
      act(() => {
        result.current.handleKeyDown('j', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(-1);

      // Advance timer to trigger interval callback
      act(() => {
        vi.advanceTimersByTime(100); // ~3 frames at 30fps
      });

      // seekRelative should have been called with negative values
      expect(opts.seekRelative).toHaveBeenCalled();
      const lastCall = (opts.seekRelative as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(lastCall[0]).toBeLessThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // K key — stop immediately
  // ---------------------------------------------------------------------------

  describe('K key (stop)', () => {
    it('should stop immediately and reset shuttle to 0', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // Go to forward 4x
      act(() => {
        result.current.handleKeyDown('l', false, false); // 1x
        result.current.handleKeyDown('l', false, false); // 2x
        result.current.handleKeyDown('l', false, false); // 4x
      });
      expect(result.current.shuttleSpeed).toBe(4);

      // K stops
      act(() => {
        result.current.handleKeyDown('k', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(0);
      expect(opts.pause).toHaveBeenCalled();
      expect(opts.setPlaybackRate).toHaveBeenCalledWith(1);
    });

    it('should stop reverse playback when K is pressed', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // Go to reverse -2x
      act(() => {
        result.current.handleKeyDown('j', false, false); // -1x
        result.current.handleKeyDown('j', false, false); // -2x
      });
      expect(result.current.shuttleSpeed).toBe(-2);

      // K stops
      act(() => {
        result.current.handleKeyDown('k', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(0);

      // Verify no more reverse seeking after stop
      vi.clearAllMocks();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(opts.seekRelative).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // K+J combo — frame step backward
  // ---------------------------------------------------------------------------

  describe('K+J combo (frame step backward)', () => {
    it('should step one frame backward when K is held and J is pressed', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // Hold K (keydown)
      act(() => {
        result.current.handleKeyDown('k', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(0);

      // Press J while K is held
      act(() => {
        result.current.handleKeyDown('j', false, false);
      });
      expect(opts.stepBackward).toHaveBeenCalledTimes(1);
      // Shuttle speed should remain 0 (frame step, not shuttle change)
      expect(result.current.shuttleSpeed).toBe(0);
    });

    it('should allow multiple frame steps while K is held', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // Hold K
      act(() => {
        result.current.handleKeyDown('k', false, false);
      });

      // Press J three times
      act(() => {
        result.current.handleKeyDown('j', false, false);
        result.current.handleKeyDown('j', false, false);
        result.current.handleKeyDown('j', false, false);
      });
      expect(opts.stepBackward).toHaveBeenCalledTimes(3);
    });
  });

  // ---------------------------------------------------------------------------
  // K+L combo — frame step forward
  // ---------------------------------------------------------------------------

  describe('K+L combo (frame step forward)', () => {
    it('should step one frame forward when K is held and L is pressed', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // Hold K
      act(() => {
        result.current.handleKeyDown('k', false, false);
      });

      // Press L while K is held
      act(() => {
        result.current.handleKeyDown('l', false, false);
      });
      expect(opts.stepForward).toHaveBeenCalledTimes(1);
      expect(result.current.shuttleSpeed).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // K release — resume normal shuttle behavior
  // ---------------------------------------------------------------------------

  describe('K key release', () => {
    it('should resume normal J/L behavior after K is released', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // Hold K
      act(() => {
        result.current.handleKeyDown('k', false, false);
      });

      // Frame step with K+L
      act(() => {
        result.current.handleKeyDown('l', false, false);
      });
      expect(opts.stepForward).toHaveBeenCalledTimes(1);

      // Release K
      act(() => {
        result.current.handleKeyUp('k');
      });

      // Now L should cycle shuttle speed (not frame step)
      act(() => {
        result.current.handleKeyDown('l', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(1);
      expect(opts.stepForward).toHaveBeenCalledTimes(1); // No additional frame step
    });
  });

  // ---------------------------------------------------------------------------
  // Speed indicator state updates
  // ---------------------------------------------------------------------------

  describe('shuttleSpeed state (indicator)', () => {
    it('should update shuttleSpeed reactively for UI indicator', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      expect(result.current.shuttleSpeed).toBe(0);

      act(() => {
        result.current.handleKeyDown('l', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(1);

      act(() => {
        result.current.handleKeyDown('j', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(0);

      act(() => {
        result.current.handleKeyDown('j', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(-1);
    });
  });

  // ---------------------------------------------------------------------------
  // resetShuttle
  // ---------------------------------------------------------------------------

  describe('resetShuttle', () => {
    it('should reset shuttle to stop and set playback rate to 1', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // Go to 4x forward
      act(() => {
        result.current.handleKeyDown('l', false, false);
        result.current.handleKeyDown('l', false, false);
        result.current.handleKeyDown('l', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(4);

      // Reset
      act(() => {
        result.current.resetShuttle();
      });
      expect(result.current.shuttleSpeed).toBe(0);
      expect(opts.setPlaybackRate).toHaveBeenLastCalledWith(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Modifier keys — should not be consumed
  // ---------------------------------------------------------------------------

  describe('modifier keys', () => {
    it('should not consume J/K/L when Ctrl is held', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      let consumed = false;
      act(() => {
        consumed = result.current.handleKeyDown('l', true, false);
      });
      expect(consumed).toBe(false);
      expect(result.current.shuttleSpeed).toBe(0);
    });

    it('should not consume J/K/L when Shift is held', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      let consumed = false;
      act(() => {
        consumed = result.current.handleKeyDown('j', false, true);
      });
      expect(consumed).toBe(false);
      expect(result.current.shuttleSpeed).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Disabled state
  // ---------------------------------------------------------------------------

  describe('enabled option', () => {
    it('should not respond to keys when disabled', () => {
      const opts = createMockOptions({ enabled: false });
      const { result } = renderHook(() => useJKLShuttle(opts));

      let consumed = false;
      act(() => {
        consumed = result.current.handleKeyDown('l', false, false);
      });
      expect(consumed).toBe(false);
      expect(result.current.shuttleSpeed).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Bidirectional transitions — J after L
  // ---------------------------------------------------------------------------

  describe('bidirectional transitions', () => {
    it('should decelerate from forward to reverse when J is pressed', () => {
      const opts = createMockOptions();
      const { result } = renderHook(() => useJKLShuttle(opts));

      // Go forward 2x
      act(() => {
        result.current.handleKeyDown('l', false, false); // 1x
        result.current.handleKeyDown('l', false, false); // 2x
      });
      expect(result.current.shuttleSpeed).toBe(2);

      // Press J → should decelerate: 2x → 1x → 0 → -1x
      act(() => {
        result.current.handleKeyDown('j', false, false); // 1x
      });
      expect(result.current.shuttleSpeed).toBe(1);

      act(() => {
        result.current.handleKeyDown('j', false, false); // 0
      });
      expect(result.current.shuttleSpeed).toBe(0);

      act(() => {
        result.current.handleKeyDown('j', false, false); // -1x
      });
      expect(result.current.shuttleSpeed).toBe(-1);
    });
  });

  // ---------------------------------------------------------------------------
  // Unmount cleanup
  // ---------------------------------------------------------------------------

  describe('unmount cleanup', () => {
    it('should clear reverse interval on unmount so no seekRelative calls occur', () => {
      const opts = createMockOptions();
      const { result, unmount } = renderHook(() => useJKLShuttle(opts));

      // Enter reverse mode
      act(() => {
        result.current.handleKeyDown('j', false, false);
      });
      expect(result.current.shuttleSpeed).toBe(-1);

      // Verify reverse interval is active
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(opts.seekRelative).toHaveBeenCalled();

      // Clear mock call history, then unmount
      vi.clearAllMocks();
      unmount();

      // Advance timers after unmount — no more seekRelative calls should happen
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(opts.seekRelative).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Constants validation
  // ---------------------------------------------------------------------------

  describe('constants', () => {
    it('should have correct SHUTTLE_SPEEDS array', () => {
      expect(SHUTTLE_SPEEDS).toEqual([-8, -4, -2, -1, 0, 1, 2, 4, 8]);
    });

    it('should have SHUTTLE_STOP_INDEX pointing to speed 0', () => {
      expect(SHUTTLE_SPEEDS[SHUTTLE_STOP_INDEX]).toBe(0);
    });
  });
});

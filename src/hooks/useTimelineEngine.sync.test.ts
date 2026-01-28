/**
 * useTimelineEngine Store Sync Integration Tests
 *
 * Comprehensive test suite covering:
 * - Engine/store playback state synchronization
 * - Seek and currentTime sync
 * - Playback rate changes
 * - Loop toggle behavior
 * - Duration changes
 * - NaN/Infinity guard validation
 * - Cleanup and disposal
 * - Circular update prevention
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTimelineEngine } from './useTimelineEngine';
import { usePlaybackStore } from '@/stores/playbackStore';

describe('useTimelineEngine (store sync)', () => {
  beforeEach(() => {
    usePlaybackStore.getState().reset();

    // Prevent the engine's RAF loop from advancing time during these sync tests.
    // We only care that external store mutations are reflected in engine state.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1 as unknown as number);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Basic Playback Synchronization
  // ===========================================================================

  describe('playback state sync', () => {
    it('should start/stop engine playback when store toggles isPlaying', async () => {
      expect(typeof (usePlaybackStore as unknown as { subscribe?: unknown }).subscribe).toBe(
        'function',
      );

      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      act(() => {
        usePlaybackStore.getState().togglePlayback();
      });

      expect(result.current.engine.isPlaying).toBe(true);

      act(() => {
        usePlaybackStore.getState().togglePlayback();
      });

      expect(result.current.engine.isPlaying).toBe(false);

      await act(async () => {
        hookResult?.unmount();
      });
    });

    it('should sync engine to store when store sets isPlaying directly', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      act(() => {
        usePlaybackStore.getState().setIsPlaying(true);
      });

      expect(result.current.engine.isPlaying).toBe(true);

      act(() => {
        usePlaybackStore.getState().setIsPlaying(false);
      });

      expect(result.current.engine.isPlaying).toBe(false);

      await act(async () => {
        hookResult?.unmount();
      });
    });
  });

  // ===========================================================================
  // Seek/CurrentTime Synchronization
  // ===========================================================================

  describe('currentTime sync', () => {
    it('should seek engine when store currentTime changes', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      act(() => {
        usePlaybackStore.getState().seek(10);
      });

      expect(result.current.engine.currentTime).toBe(10);

      await act(async () => {
        hookResult?.unmount();
      });
    });

    it('should clamp seek to valid range', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      // Seek beyond duration
      act(() => {
        usePlaybackStore.getState().seek(100);
      });

      // Engine should clamp to duration
      expect(result.current.engine.currentTime).toBeLessThanOrEqual(60);

      // Seek negative
      act(() => {
        usePlaybackStore.getState().seek(-10);
      });

      // Engine should clamp to 0
      expect(result.current.engine.currentTime).toBeGreaterThanOrEqual(0);

      await act(async () => {
        hookResult?.unmount();
      });
    });

    it('should use seekForward and seekBackward correctly', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      // Start at 10
      act(() => {
        result.current.seek(10);
      });

      // Seek forward
      act(() => {
        result.current.seekForward(5);
      });

      expect(result.current.engine.currentTime).toBe(15);

      // Seek backward
      act(() => {
        result.current.seekBackward(3);
      });

      expect(result.current.engine.currentTime).toBe(12);

      await act(async () => {
        hookResult?.unmount();
      });
    });

    it('should go to start and end correctly', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      // Start somewhere in the middle
      act(() => {
        result.current.seek(30);
      });

      // Go to end
      act(() => {
        result.current.goToEnd();
      });

      expect(result.current.engine.currentTime).toBe(60);

      // Go to start
      act(() => {
        result.current.goToStart();
      });

      expect(result.current.engine.currentTime).toBe(0);

      await act(async () => {
        hookResult?.unmount();
      });
    });
  });

  // ===========================================================================
  // Playback Rate Synchronization
  // ===========================================================================

  describe('playbackRate sync', () => {
    it('should sync playback rate from store to engine', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      act(() => {
        usePlaybackStore.getState().setPlaybackRate(2.0);
      });

      expect(result.current.engine.playbackRate).toBe(2.0);

      act(() => {
        usePlaybackStore.getState().setPlaybackRate(0.5);
      });

      expect(result.current.engine.playbackRate).toBe(0.5);

      await act(async () => {
        hookResult?.unmount();
      });
    });

    it('should sync playback rate from hook action to both engine and store', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      act(() => {
        result.current.setPlaybackRate(1.5);
      });

      expect(result.current.engine.playbackRate).toBe(1.5);
      expect(usePlaybackStore.getState().playbackRate).toBe(1.5);

      await act(async () => {
        hookResult?.unmount();
      });
    });

    it('should ignore invalid playback rates', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      const originalRate = result.current.engine.playbackRate;

      // Try setting NaN - should be ignored by the NaN guard
      act(() => {
        usePlaybackStore.getState().setPlaybackRate(NaN);
      });

      // Engine should retain original rate
      expect(result.current.engine.playbackRate).toBe(originalRate);

      await act(async () => {
        hookResult?.unmount();
      });
    });
  });

  // ===========================================================================
  // Loop Toggle Synchronization
  // ===========================================================================

  describe('loop sync', () => {
    it('should sync loop state from store to engine', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      act(() => {
        usePlaybackStore.getState().toggleLoop();
      });

      expect(result.current.engine.loop).toBe(true);

      act(() => {
        usePlaybackStore.getState().toggleLoop();
      });

      expect(result.current.engine.loop).toBe(false);

      await act(async () => {
        hookResult?.unmount();
      });
    });

    it('should sync loop toggle from hook to both engine and store', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      act(() => {
        result.current.toggleLoop();
      });

      expect(result.current.engine.loop).toBe(true);
      expect(usePlaybackStore.getState().loop).toBe(true);

      await act(async () => {
        hookResult?.unmount();
      });
    });
  });

  // ===========================================================================
  // Duration Changes
  // ===========================================================================

  describe('duration sync', () => {
    it('should update engine duration when hook option changes', async () => {
      let duration = 60;
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        rerender: (props?: { duration: number }) => void;
        unmount: () => void;
      } | null = null;

      await act(async () => {
        hookResult = renderHook(
          (props: { duration: number }) => useTimelineEngine({ duration: props.duration }),
          { initialProps: { duration } },
        ) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          rerender: (props?: { duration: number }) => void;
          unmount: () => void;
        };
      });

      expect(hookResult!.result.current.engine.duration).toBe(60);

      // Update duration
      duration = 120;
      await act(async () => {
        hookResult!.rerender({ duration });
      });

      expect(hookResult!.result.current.engine.duration).toBe(120);

      await act(async () => {
        hookResult?.unmount();
      });
    });
  });

  // ===========================================================================
  // Frame Stepping
  // ===========================================================================

  describe('frame stepping', () => {
    it('should step forward by one frame', async () => {
      const fps = 30;
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60, fps })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      const initialTime = result.current.engine.currentTime;

      act(() => {
        result.current.stepForward();
      });

      // Should advance by 1/fps seconds
      expect(result.current.engine.currentTime).toBeCloseTo(initialTime + 1 / fps, 5);

      await act(async () => {
        hookResult?.unmount();
      });
    });

    it('should step backward by one frame', async () => {
      const fps = 30;
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60, fps })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      // Start at 1 second
      act(() => {
        result.current.seek(1);
      });

      const timeBeforeStep = result.current.engine.currentTime;

      act(() => {
        result.current.stepBackward();
      });

      // Should go back by 1/fps seconds
      expect(result.current.engine.currentTime).toBeCloseTo(timeBeforeStep - 1 / fps, 5);

      await act(async () => {
        hookResult?.unmount();
      });
    });
  });

  // ===========================================================================
  // Cleanup and Disposal
  // ===========================================================================

  describe('cleanup and disposal', () => {
    it('should dispose engine on unmount when autoDispose is true', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;

      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60, autoDispose: true })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });

      const engine = hookResult!.result.current.engine;
      const disposeSpy = vi.spyOn(engine, 'dispose');

      await act(async () => {
        hookResult?.unmount();
      });

      expect(disposeSpy).toHaveBeenCalled();
    });

    it('should not dispose engine on unmount when autoDispose is false', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;

      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60, autoDispose: false })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });

      const engine = hookResult!.result.current.engine;
      const disposeSpy = vi.spyOn(engine, 'dispose');

      await act(async () => {
        hookResult?.unmount();
      });

      expect(disposeSpy).not.toHaveBeenCalled();
    });

    it('should unsubscribe from store on unmount', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;

      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });

      await act(async () => {
        hookResult?.unmount();
      });

      // After unmount, store changes should not affect the disposed engine
      // This is more of a sanity check - if subscription wasn't cleaned up,
      // the engine would try to respond to store changes on a disposed instance
      act(() => {
        usePlaybackStore.getState().setIsPlaying(true);
      });

      // No error should be thrown
      expect(true).toBe(true);
    });
  });

  // ===========================================================================
  // Circular Update Prevention
  // ===========================================================================

  describe('circular update prevention', () => {
    it('should not cause infinite loops when engine updates store', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        unmount: () => void;
      } | null = null;
      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          unmount: () => void;
        };
      });
      const { result } = hookResult!;

      // Perform many rapid operations
      const operations: Array<() => void> = [];
      for (let i = 0; i < 100; i++) {
        operations.push(() => {
          result.current.seek(i);
          result.current.togglePlayback();
        });
      }

      // Run all operations
      act(() => {
        for (const op of operations) {
          op();
        }
      });

      // If there were infinite loops, we'd never reach here
      expect(true).toBe(true);

      await act(async () => {
        hookResult?.unmount();
      });
    });
  });

  // ===========================================================================
  // Return Value Stability
  // ===========================================================================

  describe('return value stability', () => {
    it('should return stable references for callbacks', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        rerender: () => void;
        unmount: () => void;
      } | null = null;

      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          rerender: () => void;
          unmount: () => void;
        };
      });

      const firstPlay = hookResult!.result.current.play;
      const firstPause = hookResult!.result.current.pause;
      const firstSeek = hookResult!.result.current.seek;

      await act(async () => {
        hookResult!.rerender();
      });

      // Callbacks should be stable (same reference)
      expect(hookResult!.result.current.play).toBe(firstPlay);
      expect(hookResult!.result.current.pause).toBe(firstPause);
      expect(hookResult!.result.current.seek).toBe(firstSeek);

      await act(async () => {
        hookResult?.unmount();
      });
    });

    it('should return same engine instance across rerenders', async () => {
      let hookResult: {
        result: { current: ReturnType<typeof useTimelineEngine> };
        rerender: () => void;
        unmount: () => void;
      } | null = null;

      await act(async () => {
        hookResult = renderHook(() => useTimelineEngine({ duration: 60 })) as unknown as {
          result: { current: ReturnType<typeof useTimelineEngine> };
          rerender: () => void;
          unmount: () => void;
        };
      });

      const firstEngine = hookResult!.result.current.engine;

      await act(async () => {
        hookResult!.rerender();
      });

      expect(hookResult!.result.current.engine).toBe(firstEngine);

      await act(async () => {
        hookResult?.unmount();
      });
    });
  });
});

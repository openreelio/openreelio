/**
 * useTimelineEngine Hook Tests
 *
 * Tests for the timeline engine React integration hook including:
 * - Engine initialization and configuration
 * - Store synchronization
 * - Playback controls
 * - Seeking and navigation
 * - Frame stepping
 * - Playback rate control
 * - Loop functionality
 * - Cleanup on unmount
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTimelineEngine } from './useTimelineEngine';
import { usePlaybackStore } from '@/stores/playbackStore';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@/stores/playbackStore');

// =============================================================================
// Test Setup
// =============================================================================

describe('useTimelineEngine', () => {
  const mockSetCurrentTime = vi.fn();
  const mockSetIsPlaying = vi.fn();
  const mockSetDuration = vi.fn();
  const mockSetPlaybackRate = vi.fn();
  const mockToggleLoop = vi.fn();

  const defaultPlaybackStore = {
    currentTime: 0,
    isPlaying: false,
    playbackRate: 1,
    loop: false,
    setCurrentTime: mockSetCurrentTime,
    setIsPlaying: mockSetIsPlaying,
    setDuration: mockSetDuration,
    setPlaybackRate: mockSetPlaybackRate,
    toggleLoop: mockToggleLoop,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(usePlaybackStore).mockReturnValue(defaultPlaybackStore);

    // Mock requestAnimationFrame
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      return setTimeout(() => callback(performance.now()), 16) as unknown as number;
    });

    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      clearTimeout(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ===========================================================================
  // Initialization
  // ===========================================================================

  describe('initialization', () => {
    it('should create engine with default options', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      expect(result.current.engine).toBeDefined();
      expect(result.current.currentTime).toBe(0);
      expect(result.current.isPlaying).toBe(false);
    });

    it('should sync duration with store on mount', () => {
      renderHook(() => useTimelineEngine({ duration: 60 }));

      expect(mockSetDuration).toHaveBeenCalledWith(60);
    });

    it('should accept fps option', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60, fps: 24 })
      );

      expect(result.current.engine).toBeDefined();
    });

    it('should use default fps of 30 if not specified', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      // Test stepForward uses 30fps
      act(() => {
        result.current.stepForward();
      });

      // Engine should seek by 1/30 second
      expect(result.current.engine.currentTime).toBeCloseTo(1 / 30, 5);
    });
  });

  // ===========================================================================
  // State from Store
  // ===========================================================================

  describe('state from store', () => {
    it('should return currentTime from store', () => {
      vi.mocked(usePlaybackStore).mockReturnValue({
        ...defaultPlaybackStore,
        currentTime: 15,
      });

      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      expect(result.current.currentTime).toBe(15);
    });

    it('should return isPlaying from store', () => {
      vi.mocked(usePlaybackStore).mockReturnValue({
        ...defaultPlaybackStore,
        isPlaying: true,
      });

      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      expect(result.current.isPlaying).toBe(true);
    });

    it('should return playbackRate from store', () => {
      vi.mocked(usePlaybackStore).mockReturnValue({
        ...defaultPlaybackStore,
        playbackRate: 2,
      });

      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      expect(result.current.playbackRate).toBe(2);
    });

    it('should return loop from store', () => {
      vi.mocked(usePlaybackStore).mockReturnValue({
        ...defaultPlaybackStore,
        loop: true,
      });

      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      expect(result.current.loop).toBe(true);
    });
  });

  // ===========================================================================
  // Playback Controls
  // ===========================================================================

  describe('playback controls', () => {
    it('should call engine.play on play()', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.play();
      });

      expect(result.current.engine.isPlaying).toBe(true);
    });

    it('should call engine.pause on pause()', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.play();
        result.current.pause();
      });

      expect(result.current.engine.isPlaying).toBe(false);
    });

    it('should toggle playback state', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.togglePlayback();
      });

      expect(result.current.engine.isPlaying).toBe(true);

      act(() => {
        result.current.togglePlayback();
      });

      expect(result.current.engine.isPlaying).toBe(false);
    });
  });

  // ===========================================================================
  // Seeking
  // ===========================================================================

  describe('seeking', () => {
    it('should seek to specific time', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.seek(30);
      });

      expect(result.current.engine.currentTime).toBe(30);
      expect(mockSetCurrentTime).toHaveBeenCalledWith(30);
    });

    it('should clamp seek time to duration', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.seek(100);
      });

      expect(result.current.engine.currentTime).toBe(60);
    });

    it('should clamp seek time to 0', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.seek(-10);
      });

      expect(result.current.engine.currentTime).toBe(0);
    });

    it('should seek forward by amount', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.seek(10);
        result.current.seekForward(5);
      });

      expect(result.current.engine.currentTime).toBe(15);
    });

    it('should seek backward by amount', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.seek(10);
        result.current.seekBackward(3);
      });

      expect(result.current.engine.currentTime).toBe(7);
    });

    it('should go to start', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.seek(30);
        result.current.goToStart();
      });

      expect(result.current.engine.currentTime).toBe(0);
    });

    it('should go to end', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.goToEnd();
      });

      expect(result.current.engine.currentTime).toBe(60);
    });
  });

  // ===========================================================================
  // Frame Stepping
  // ===========================================================================

  describe('frame stepping', () => {
    it('should step forward one frame at default fps', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.stepForward();
      });

      // One frame at 30fps = 1/30 second
      expect(result.current.engine.currentTime).toBeCloseTo(1 / 30, 5);
    });

    it('should step backward one frame at default fps', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.seek(1);
        result.current.stepBackward();
      });

      // 1 - 1/30 = 29/30
      expect(result.current.engine.currentTime).toBeCloseTo(1 - 1 / 30, 5);
    });

    it('should use custom fps for stepping', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60, fps: 24 })
      );

      act(() => {
        result.current.stepForward();
      });

      // One frame at 24fps = 1/24 second
      expect(result.current.engine.currentTime).toBeCloseTo(1 / 24, 5);
    });

    it('should clamp step backward to 0', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.stepBackward();
      });

      expect(result.current.engine.currentTime).toBe(0);
    });
  });

  // ===========================================================================
  // Playback Rate
  // ===========================================================================

  describe('playback rate', () => {
    it('should set playback rate', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.setPlaybackRate(2);
      });

      expect(result.current.engine.playbackRate).toBe(2);
      expect(mockSetPlaybackRate).toHaveBeenCalledWith(2);
    });

    it('should clamp playback rate to minimum', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.setPlaybackRate(0.1);
      });

      // Min playback rate is 0.25
      expect(result.current.engine.playbackRate).toBe(0.25);
    });

    it('should clamp playback rate to maximum', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.setPlaybackRate(10);
      });

      // Max playback rate is 4
      expect(result.current.engine.playbackRate).toBe(4);
    });
  });

  // ===========================================================================
  // Loop Control
  // ===========================================================================

  describe('loop control', () => {
    it('should toggle loop', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.toggleLoop();
      });

      expect(result.current.engine.loop).toBe(true);
      expect(mockToggleLoop).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.toggleLoop();
      });

      expect(result.current.engine.loop).toBe(false);
    });
  });

  // ===========================================================================
  // Duration Update
  // ===========================================================================

  describe('duration update', () => {
    it('should update engine duration when prop changes', () => {
      const { result, rerender } = renderHook(
        ({ duration }) => useTimelineEngine({ duration }),
        { initialProps: { duration: 60 } }
      );

      expect(result.current.engine.duration).toBe(60);

      rerender({ duration: 120 });

      expect(result.current.engine.duration).toBe(120);
    });

    it('should clamp current time when duration decreases', () => {
      const { result, rerender } = renderHook(
        ({ duration }) => useTimelineEngine({ duration }),
        { initialProps: { duration: 60 } }
      );

      act(() => {
        result.current.seek(50);
      });

      rerender({ duration: 30 });

      expect(result.current.engine.currentTime).toBe(30);
    });
  });

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  describe('cleanup', () => {
    it('should dispose engine on unmount by default', () => {
      const { result, unmount } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      const engine = result.current.engine;
      const disposeSpy = vi.spyOn(engine, 'dispose');

      unmount();

      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('should not dispose engine on unmount when autoDispose is false', () => {
      const { result, unmount } = renderHook(() =>
        useTimelineEngine({ duration: 60, autoDispose: false })
      );

      const engine = result.current.engine;
      const disposeSpy = vi.spyOn(engine, 'dispose');

      unmount();

      expect(disposeSpy).not.toHaveBeenCalled();
    });

    it('should stop playback when disposed', () => {
      const { result, unmount } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      act(() => {
        result.current.play();
      });

      expect(result.current.engine.isPlaying).toBe(true);

      unmount();

      expect(result.current.engine.isPlaying).toBe(false);
    });
  });

  // ===========================================================================
  // Return Value Structure
  // ===========================================================================

  describe('return value structure', () => {
    it('should return all expected properties and methods', () => {
      const { result } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      // Engine instance
      expect(result.current.engine).toBeDefined();

      // State
      expect(result.current).toHaveProperty('currentTime');
      expect(result.current).toHaveProperty('isPlaying');
      expect(result.current).toHaveProperty('playbackRate');
      expect(result.current).toHaveProperty('loop');

      // Playback methods
      expect(typeof result.current.play).toBe('function');
      expect(typeof result.current.pause).toBe('function');
      expect(typeof result.current.togglePlayback).toBe('function');

      // Seeking methods
      expect(typeof result.current.seek).toBe('function');
      expect(typeof result.current.seekForward).toBe('function');
      expect(typeof result.current.seekBackward).toBe('function');
      expect(typeof result.current.goToStart).toBe('function');
      expect(typeof result.current.goToEnd).toBe('function');

      // Frame stepping
      expect(typeof result.current.stepForward).toBe('function');
      expect(typeof result.current.stepBackward).toBe('function');

      // Rate and loop
      expect(typeof result.current.setPlaybackRate).toBe('function');
      expect(typeof result.current.toggleLoop).toBe('function');
    });
  });

  // ===========================================================================
  // Engine Stability
  // ===========================================================================

  describe('engine stability', () => {
    it('should maintain same engine instance across re-renders', () => {
      const { result, rerender } = renderHook(() =>
        useTimelineEngine({ duration: 60 })
      );

      const firstEngine = result.current.engine;

      rerender();

      expect(result.current.engine).toBe(firstEngine);
    });

    it('should not create new engine when duration changes', () => {
      const { result, rerender } = renderHook(
        ({ duration }) => useTimelineEngine({ duration }),
        { initialProps: { duration: 60 } }
      );

      const firstEngine = result.current.engine;

      rerender({ duration: 120 });

      expect(result.current.engine).toBe(firstEngine);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useToastStore, useToast } from '@/hooks/useToast';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePlaybackStore } from '@/stores/playbackStore';

// Mock dependencies
vi.mock('@/stores/playbackStore', () => ({
  usePlaybackStore: vi.fn(),
}));

vi.mock('@/stores/timelineStore', () => ({
  useTimelineStore: vi.fn(() => ({
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    selectedClipIds: [],
    clearClipSelection: vi.fn(),
  })),
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: vi.fn(() => ({
    undo: vi.fn(),
    redo: vi.fn(),
    saveProject: vi.fn(),
    isLoaded: true,
  })),
}));

describe('Destructive Design System Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clearToasts();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // 1. Toast System Stress Test
  // ---------------------------------------------------------------------------
  describe('Toast System Resilience', () => {
    it('should handle rapid-fire toast creation without memory leaks', () => {
      const { result } = renderHook(() => useToast());

      // Simulate 100 rapid error events (e.g., batch processing failure)
      act(() => {
        for (let i = 0; i < 100; i++) {
          result.current.showError(`Error ${i}`);
        }
      });

      // Should cap at MAX_TOASTS (5) to prevent DOM flooding
      expect(result.current.toasts.length).toBe(5);
      expect(result.current.toasts[4].message).toBe('Error 99'); // Should show latest
    });

    it('should generate unique IDs even in same millisecond', () => {
      const { result } = renderHook(() => useToast());
      const ids = new Set();

      act(() => {
        for (let i = 0; i < 50; i++) {
          ids.add(result.current.showInfo('test'));
        }
      });

      expect(ids.size).toBe(50); // No collisions allowed
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Keyboard Shuttle Logic (J/K/L)
  // ---------------------------------------------------------------------------
  describe('Shuttle Control Stability', () => {
    let mockSetPlaybackRate: any;
    let mockPlay: any;
    let mockPause: any;

    beforeEach(() => {
      mockSetPlaybackRate = vi.fn();
      mockPlay = vi.fn();
      mockPause = vi.fn();

      (usePlaybackStore as any).mockReturnValue({
        togglePlayback: vi.fn(),
        setCurrentTime: vi.fn(),
        currentTime: 0,
        duration: 100,
        setPlaybackRate: mockSetPlaybackRate,
        play: mockPlay,
        pause: mockPause,
        isPlaying: false,
      });
    });

    it('should handle rapid J/L key presses without race conditions', () => {
      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // Simulate rapid 'L' pressing (Forward 1x -> 2x -> 4x)
      const lEvent = new KeyboardEvent('keydown', { key: 'l' });

      act(() => {
        window.dispatchEvent(lEvent); // 1x
        window.dispatchEvent(lEvent); // 2x
        window.dispatchEvent(lEvent); // 4x
      });

      expect(mockSetPlaybackRate).toHaveBeenLastCalledWith(4);
      expect(mockPlay).toHaveBeenCalled();
    });

    it('should reset shuttle speed on K (Stop)', () => {
      renderHook(() => useKeyboardShortcuts({ enabled: true }));

      // Rev up to 8x
      const lEvent = new KeyboardEvent('keydown', { key: 'l' });
      act(() => {
        for (let i = 0; i < 4; i++) window.dispatchEvent(lEvent);
      });

      // Hit Stop
      const kEvent = new KeyboardEvent('keydown', { key: 'k' });
      act(() => window.dispatchEvent(kEvent));

      expect(mockPause).toHaveBeenCalled();
      expect(mockSetPlaybackRate).toHaveBeenLastCalledWith(1); // Reset to normal speed
    });
  });
});

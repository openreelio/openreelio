/**
 * useTimeline Hook Tests
 *
 * Tests for timeline operations wrapper hook including:
 * - Playback state and controls
 * - View state (zoom, scroll)
 * - Selection management
 * - Conversion utilities
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTimeline } from './useTimeline';
import { useTimelineStore } from '@/stores';

type TimelineStoreSelector = NonNullable<Parameters<typeof useTimelineStore>[0]>;
type TimelineStoreState = Parameters<TimelineStoreSelector>[0];

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@/stores', () => ({
  useTimelineStore: vi.fn(),
}));

// =============================================================================
// Test Setup
// =============================================================================

describe('useTimeline', () => {
  const mockSetPlayhead = vi.fn();
  const mockPlay = vi.fn();
  const mockPause = vi.fn();
  const mockTogglePlayback = vi.fn();
  const mockSetZoom = vi.fn();
  const mockSetScrollX = vi.fn();
  const mockSetScrollY = vi.fn();
  const mockSelectClip = vi.fn();
  const mockDeselectClip = vi.fn();
  const mockClearClipSelection = vi.fn();

  const defaultStoreState = {
    playhead: 5,
    isPlaying: false,
    zoom: 100,
    scrollX: 0,
    scrollY: 0,
    selectedClipIds: [] as string[],
    setPlayhead: mockSetPlayhead,
    play: mockPlay,
    pause: mockPause,
    togglePlayback: mockTogglePlayback,
    setZoom: mockSetZoom,
    setScrollX: mockSetScrollX,
    setScrollY: mockSetScrollY,
    selectClip: mockSelectClip,
    deselectClip: mockDeselectClip,
    clearClipSelection: mockClearClipSelection,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTimelineStore).mockImplementation((selector) => {
      if (typeof selector === 'function') {
        return selector(defaultStoreState as unknown as TimelineStoreState);
      }
      return defaultStoreState;
    });
  });

  // ===========================================================================
  // Playback State
  // ===========================================================================

  describe('playback state', () => {
    it('should return current playhead position', () => {
      const { result } = renderHook(() => useTimeline());
      expect(result.current.playhead).toBe(5);
    });

    it('should return isPlaying state', () => {
      const { result } = renderHook(() => useTimeline());
      expect(result.current.isPlaying).toBe(false);
    });

    it('should reflect isPlaying when true', () => {
      vi.mocked(useTimelineStore).mockImplementation((selector) => {
        const state = { ...defaultStoreState, isPlaying: true };
        if (typeof selector === 'function') {
          return selector(state as unknown as TimelineStoreState);
        }
        return state;
      });

      const { result } = renderHook(() => useTimeline());
      expect(result.current.isPlaying).toBe(true);
    });
  });

  // ===========================================================================
  // Playback Actions
  // ===========================================================================

  describe('playback actions', () => {
    it('should call play action', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.play();
      });

      expect(mockPlay).toHaveBeenCalledTimes(1);
    });

    it('should call pause action', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.pause();
      });

      expect(mockPause).toHaveBeenCalledTimes(1);
    });

    it('should call togglePlayback action', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.togglePlayback();
      });

      expect(mockTogglePlayback).toHaveBeenCalledTimes(1);
    });

    it('should seek to specific time', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.seek(10);
      });

      expect(mockSetPlayhead).toHaveBeenCalledWith(10);
    });

    it('should clamp seek time to minimum 0', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.seek(-5);
      });

      expect(mockSetPlayhead).toHaveBeenCalledWith(0);
    });

    it('should step forward by default 1 frame', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.stepForward();
      });

      // 5 + 1/30 (one frame at 30fps)
      expect(mockSetPlayhead).toHaveBeenCalledWith(expect.closeTo(5 + 1 / 30, 5));
    });

    it('should step forward by specified frames', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.stepForward(5);
      });

      // 5 + 5/30 (five frames at 30fps)
      expect(mockSetPlayhead).toHaveBeenCalledWith(expect.closeTo(5 + 5 / 30, 5));
    });

    it('should step backward by default 1 frame', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.stepBackward();
      });

      // 5 - 1/30 (one frame at 30fps)
      expect(mockSetPlayhead).toHaveBeenCalledWith(expect.closeTo(5 - 1 / 30, 5));
    });

    it('should step backward by specified frames', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.stepBackward(3);
      });

      // 5 - 3/30 (three frames at 30fps)
      expect(mockSetPlayhead).toHaveBeenCalledWith(expect.closeTo(5 - 3 / 30, 5));
    });

    it('should clamp step backward to minimum 0', () => {
      vi.mocked(useTimelineStore).mockImplementation((selector) => {
        const state = { ...defaultStoreState, playhead: 0 };
        if (typeof selector === 'function') {
          return selector(state as unknown as TimelineStoreState);
        }
        return state;
      });

      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.stepBackward();
      });

      expect(mockSetPlayhead).toHaveBeenCalledWith(0);
    });
  });

  // ===========================================================================
  // View State
  // ===========================================================================

  describe('view state', () => {
    it('should return zoom level', () => {
      const { result } = renderHook(() => useTimeline());
      expect(result.current.zoom).toBe(100);
    });

    it('should return scrollX position', () => {
      vi.mocked(useTimelineStore).mockImplementation((selector) => {
        const state = { ...defaultStoreState, scrollX: 50 };
        if (typeof selector === 'function') {
          return selector(state as unknown as TimelineStoreState);
        }
        return state;
      });

      const { result } = renderHook(() => useTimeline());
      expect(result.current.scrollX).toBe(50);
    });

    it('should return scrollY position', () => {
      vi.mocked(useTimelineStore).mockImplementation((selector) => {
        const state = { ...defaultStoreState, scrollY: 25 };
        if (typeof selector === 'function') {
          return selector(state as unknown as TimelineStoreState);
        }
        return state;
      });

      const { result } = renderHook(() => useTimeline());
      expect(result.current.scrollY).toBe(25);
    });
  });

  // ===========================================================================
  // View Actions
  // ===========================================================================

  describe('view actions', () => {
    it('should set zoom level', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.setZoom(150);
      });

      expect(mockSetZoom).toHaveBeenCalledWith(150);
    });

    it('should zoom in by multiplier', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.zoomIn();
      });

      // zoom * 1.2 = 100 * 1.2 = 120, clamped to max 500
      expect(mockSetZoom).toHaveBeenCalledWith(120);
    });

    it('should zoom out by multiplier', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.zoomOut();
      });

      // zoom / 1.2 = 100 / 1.2 = 83.33, clamped to min 10
      expect(mockSetZoom).toHaveBeenCalledWith(expect.closeTo(100 / 1.2, 2));
    });

    it('should clamp zoom to maximum', () => {
      vi.mocked(useTimelineStore).mockImplementation((selector) => {
        const state = { ...defaultStoreState, zoom: 490 };
        if (typeof selector === 'function') {
          return selector(state as unknown as TimelineStoreState);
        }
        return state;
      });

      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.zoomIn();
      });

      expect(mockSetZoom).toHaveBeenCalledWith(500);
    });

    it('should clamp zoom to minimum', () => {
      vi.mocked(useTimelineStore).mockImplementation((selector) => {
        const state = { ...defaultStoreState, zoom: 11 };
        if (typeof selector === 'function') {
          return selector(state as unknown as TimelineStoreState);
        }
        return state;
      });

      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.zoomOut();
      });

      expect(mockSetZoom).toHaveBeenCalledWith(10);
    });

    it('should set scroll position', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.setScroll(100, 50);
      });

      expect(mockSetScrollX).toHaveBeenCalledWith(100);
      expect(mockSetScrollY).toHaveBeenCalledWith(50);
    });
  });

  // ===========================================================================
  // Selection State
  // ===========================================================================

  describe('selection state', () => {
    it('should return selectedClipIds', () => {
      vi.mocked(useTimelineStore).mockImplementation((selector) => {
        const state = { ...defaultStoreState, selectedClipIds: ['clip-1', 'clip-2'] };
        if (typeof selector === 'function') {
          return selector(state as unknown as TimelineStoreState);
        }
        return state;
      });

      const { result } = renderHook(() => useTimeline());
      expect(result.current.selectedClipIds).toEqual(['clip-1', 'clip-2']);
    });

    it('should return hasSelection as false when no clips selected', () => {
      const { result } = renderHook(() => useTimeline());
      expect(result.current.hasSelection).toBe(false);
    });

    it('should return hasSelection as true when clips are selected', () => {
      vi.mocked(useTimelineStore).mockImplementation((selector) => {
        const state = { ...defaultStoreState, selectedClipIds: ['clip-1'] };
        if (typeof selector === 'function') {
          return selector(state as unknown as TimelineStoreState);
        }
        return state;
      });

      const { result } = renderHook(() => useTimeline());
      expect(result.current.hasSelection).toBe(true);
    });
  });

  // ===========================================================================
  // Selection Actions
  // ===========================================================================

  describe('selection actions', () => {
    it('should select a clip', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.selectClip('clip-1');
      });

      expect(mockSelectClip).toHaveBeenCalledWith('clip-1');
    });

    it('should deselect a clip', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.deselectClip('clip-1');
      });

      expect(mockDeselectClip).toHaveBeenCalledWith('clip-1');
    });

    it('should clear selection', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.clearSelection();
      });

      expect(mockClearClipSelection).toHaveBeenCalledTimes(1);
    });

    it('should select all clips from array', () => {
      const { result } = renderHook(() => useTimeline());

      act(() => {
        result.current.selectAll(['clip-1', 'clip-2', 'clip-3']);
      });

      expect(mockClearClipSelection).toHaveBeenCalledTimes(1);
      expect(mockSelectClip).toHaveBeenCalledWith('clip-1');
      expect(mockSelectClip).toHaveBeenCalledWith('clip-2');
      expect(mockSelectClip).toHaveBeenCalledWith('clip-3');
      expect(mockSelectClip).toHaveBeenCalledTimes(3);
    });

    it('should clear selection before selecting all', () => {
      const { result } = renderHook(() => useTimeline());

      const callOrder: string[] = [];
      mockClearClipSelection.mockImplementation(() => {
        callOrder.push('clear');
      });
      mockSelectClip.mockImplementation(() => {
        callOrder.push('select');
      });

      act(() => {
        result.current.selectAll(['clip-1', 'clip-2']);
      });

      expect(callOrder[0]).toBe('clear');
      expect(callOrder.slice(1)).toEqual(['select', 'select']);
    });
  });

  // ===========================================================================
  // Conversion Utilities
  // ===========================================================================

  describe('conversion utilities', () => {
    it('should convert time to pixels', () => {
      const { result } = renderHook(() => useTimeline());

      expect(result.current.timeToPixels(5)).toBe(500); // 5 seconds * 100 zoom = 500 pixels
    });

    it('should convert pixels to time', () => {
      const { result } = renderHook(() => useTimeline());

      expect(result.current.pixelsToTime(500)).toBe(5); // 500 pixels / 100 zoom = 5 seconds
    });

    it('should use current zoom for conversions', () => {
      vi.mocked(useTimelineStore).mockImplementation((selector) => {
        const state = { ...defaultStoreState, zoom: 200 };
        if (typeof selector === 'function') {
          return selector(state as unknown as never);
        }
        return state;
      });

      const { result } = renderHook(() => useTimeline());

      expect(result.current.timeToPixels(5)).toBe(1000); // 5 * 200 = 1000
      expect(result.current.pixelsToTime(1000)).toBe(5); // 1000 / 200 = 5
    });

    it('should handle zero time', () => {
      const { result } = renderHook(() => useTimeline());

      expect(result.current.timeToPixels(0)).toBe(0);
    });

    it('should handle zero pixels', () => {
      const { result } = renderHook(() => useTimeline());

      expect(result.current.pixelsToTime(0)).toBe(0);
    });
  });

  // ===========================================================================
  // Return Value Stability
  // ===========================================================================

  describe('return value stability', () => {
    it('should return all expected properties', () => {
      const { result } = renderHook(() => useTimeline());

      expect(result.current).toHaveProperty('playhead');
      expect(result.current).toHaveProperty('isPlaying');
      expect(result.current).toHaveProperty('zoom');
      expect(result.current).toHaveProperty('scrollX');
      expect(result.current).toHaveProperty('scrollY');
      expect(result.current).toHaveProperty('selectedClipIds');
      expect(result.current).toHaveProperty('hasSelection');
      expect(result.current).toHaveProperty('play');
      expect(result.current).toHaveProperty('pause');
      expect(result.current).toHaveProperty('togglePlayback');
      expect(result.current).toHaveProperty('seek');
      expect(result.current).toHaveProperty('stepForward');
      expect(result.current).toHaveProperty('stepBackward');
      expect(result.current).toHaveProperty('selectClip');
      expect(result.current).toHaveProperty('deselectClip');
      expect(result.current).toHaveProperty('clearSelection');
      expect(result.current).toHaveProperty('selectAll');
      expect(result.current).toHaveProperty('setZoom');
      expect(result.current).toHaveProperty('zoomIn');
      expect(result.current).toHaveProperty('zoomOut');
      expect(result.current).toHaveProperty('setScroll');
      expect(result.current).toHaveProperty('timeToPixels');
      expect(result.current).toHaveProperty('pixelsToTime');
    });

    it('should return functions for all actions', () => {
      const { result } = renderHook(() => useTimeline());

      expect(typeof result.current.play).toBe('function');
      expect(typeof result.current.pause).toBe('function');
      expect(typeof result.current.togglePlayback).toBe('function');
      expect(typeof result.current.seek).toBe('function');
      expect(typeof result.current.stepForward).toBe('function');
      expect(typeof result.current.stepBackward).toBe('function');
      expect(typeof result.current.selectClip).toBe('function');
      expect(typeof result.current.deselectClip).toBe('function');
      expect(typeof result.current.clearSelection).toBe('function');
      expect(typeof result.current.selectAll).toBe('function');
      expect(typeof result.current.setZoom).toBe('function');
      expect(typeof result.current.zoomIn).toBe('function');
      expect(typeof result.current.zoomOut).toBe('function');
      expect(typeof result.current.setScroll).toBe('function');
      expect(typeof result.current.timeToPixels).toBe('function');
      expect(typeof result.current.pixelsToTime).toBe('function');
    });
  });
});

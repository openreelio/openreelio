/**
 * useClipDrag Hook Tests
 *
 * TDD: Tests for clip drag/resize hook with delta accumulation
 * Based on react-timeline-editor's row_rnd patterns
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useClipDrag, type UseClipDragOptions } from './useClipDrag';

// =============================================================================
// Test Setup
// =============================================================================

const createMouseEvent = (
  type: string,
  clientX: number,
  clientY: number = 0,
  button: number = 0,
): MouseEvent => {
  return new MouseEvent(type, {
    clientX,
    clientY,
    button,
    bubbles: true,
  });
};

describe('useClipDrag', () => {
  const defaultOptions: UseClipDragOptions = {
    clipId: 'clip-1',
    initialTimelineIn: 5,
    initialSourceIn: 0,
    initialSourceOut: 10,
    zoom: 100,
    disabled: false,
    gridInterval: 0,
    onDragStart: vi.fn(),
    onDrag: vi.fn(),
    onDragEnd: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Basic Initialization Tests
  // ===========================================================================

  describe('initialization', () => {
    it('returns initial state correctly', () => {
      const { result } = renderHook(() => useClipDrag(defaultOptions));

      expect(result.current.isDragging).toBe(false);
      expect(result.current.dragType).toBeNull();
      expect(result.current.previewPosition).toBeNull();
    });

    it('provides drag handlers', () => {
      const { result } = renderHook(() => useClipDrag(defaultOptions));

      expect(typeof result.current.handleMouseDown).toBe('function');
    });
  });

  // ===========================================================================
  // Move Drag Tests
  // ===========================================================================

  describe('move drag', () => {
    it('starts drag on mousedown and ends on mouseup', () => {
      const onDragStart = vi.fn();
      const onDragEnd = vi.fn();
      const { result } = renderHook(() =>
        useClipDrag({ ...defaultOptions, onDragStart, onDragEnd }),
      );

      // Simulate mousedown
      act(() => {
        const event = createMouseEvent('mousedown', 100);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      expect(result.current.isDragging).toBe(true);
      expect(result.current.dragType).toBe('move');
      expect(onDragStart).toHaveBeenCalledWith({
        clipId: 'clip-1',
        type: 'move',
        startX: 100,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      });

      // Simulate mouseup
      act(() => {
        const event = createMouseEvent('mouseup', 200);
        document.dispatchEvent(event);
      });

      expect(result.current.isDragging).toBe(false);
      expect(result.current.dragType).toBeNull();
      expect(onDragEnd).toHaveBeenCalled();
    });

    it('calculates preview position during drag', () => {
      const onDrag = vi.fn();
      const { result } = renderHook(() => useClipDrag({ ...defaultOptions, onDrag }));

      // Start drag at x=100
      act(() => {
        const event = createMouseEvent('mousedown', 100);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Move to x=200 (100px = 1 second at zoom 100)
      act(() => {
        const event = createMouseEvent('mousemove', 200);
        document.dispatchEvent(event);
      });

      expect(onDrag).toHaveBeenCalledWith(
        expect.objectContaining({ clipId: 'clip-1', type: 'move' }),
        expect.objectContaining({
          timelineIn: expect.any(Number),
          sourceIn: expect.any(Number),
          sourceOut: expect.any(Number),
          duration: expect.any(Number),
        }),
      );

      // Preview should show new position
      expect(result.current.previewPosition).not.toBeNull();
      expect(result.current.previewPosition?.timelineIn).toBeCloseTo(6, 5); // 5 + 1
    });

    it('prevents dragging past timeline start (time < 0)', () => {
      const { result } = renderHook(() => useClipDrag({ ...defaultOptions, initialTimelineIn: 1 }));

      // Start drag
      act(() => {
        const event = createMouseEvent('mousedown', 200);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Move left by 300px (3 seconds) - would go to -2 seconds
      act(() => {
        const event = createMouseEvent('mousemove', -100);
        document.dispatchEvent(event);
      });

      // Should clamp to 0
      expect(result.current.previewPosition?.timelineIn).toBe(0);
    });

    it('does not start drag when disabled', () => {
      const onDragStart = vi.fn();
      const { result } = renderHook(() =>
        useClipDrag({ ...defaultOptions, disabled: true, onDragStart }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 100);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      expect(result.current.isDragging).toBe(false);
      expect(onDragStart).not.toHaveBeenCalled();
    });

    it('ignores non-left-click', () => {
      const onDragStart = vi.fn();
      const { result } = renderHook(() => useClipDrag({ ...defaultOptions, onDragStart }));

      // Right-click
      act(() => {
        const event = createMouseEvent('mousedown', 100, 0, 2);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      expect(result.current.isDragging).toBe(false);
      expect(onDragStart).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Trim Left Tests
  // ===========================================================================

  describe('trim-left drag', () => {
    it('adjusts sourceIn and timelineIn when trimming left edge', () => {
      const onDrag = vi.fn();
      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialSourceIn: 2,
          initialSourceOut: 12,
          initialTimelineIn: 5,
          onDrag,
        }),
      );

      // Start trim-left
      act(() => {
        const event = createMouseEvent('mousedown', 100);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'trim-left');
      });

      expect(result.current.dragType).toBe('trim-left');

      // Move right by 100px (1 second) - trimming in
      act(() => {
        const event = createMouseEvent('mousemove', 200);
        document.dispatchEvent(event);
      });

      // sourceIn should increase, timelineIn should increase
      expect(result.current.previewPosition?.sourceIn).toBeCloseTo(3, 5);
      expect(result.current.previewPosition?.timelineIn).toBeCloseTo(6, 5);
      // Duration should decrease
      expect(result.current.previewPosition?.duration).toBeCloseTo(9, 5);
    });

    it('prevents trimming below minimum duration', () => {
      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialSourceIn: 0,
          initialSourceOut: 2, // 2 second clip
          minDuration: 1,
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 100);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'trim-left');
      });

      // Try to trim 1.5 seconds (would leave 0.5s, below min)
      act(() => {
        const event = createMouseEvent('mousemove', 250);
        document.dispatchEvent(event);
      });

      // Duration should be clamped to minDuration
      expect(result.current.previewPosition?.duration).toBeGreaterThanOrEqual(1);
    });

    it('prevents trimming past source start', () => {
      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialSourceIn: 1, // Already 1 second into source
          initialSourceOut: 10,
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 200);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'trim-left');
      });

      // Move left by 200px (2 seconds) - would go past source start
      act(() => {
        const event = createMouseEvent('mousemove', 0);
        document.dispatchEvent(event);
      });

      // sourceIn should be clamped to 0 (can extend to source start)
      expect(result.current.previewPosition?.sourceIn).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // Trim Right Tests
  // ===========================================================================

  describe('trim-right drag', () => {
    it('adjusts sourceOut when trimming right edge', () => {
      const onDrag = vi.fn();
      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialSourceIn: 0,
          initialSourceOut: 10,
          onDrag,
        }),
      );

      // Start trim-right
      act(() => {
        const event = createMouseEvent('mousedown', 500);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'trim-right');
      });

      expect(result.current.dragType).toBe('trim-right');

      // Move left by 200px (2 seconds) - trimming the end
      act(() => {
        const event = createMouseEvent('mousemove', 300);
        document.dispatchEvent(event);
      });

      // sourceOut should decrease
      expect(result.current.previewPosition?.sourceOut).toBeCloseTo(8, 5);
      // Duration should decrease
      expect(result.current.previewPosition?.duration).toBeCloseTo(8, 5);
      // timelineIn should stay the same
      expect(result.current.previewPosition?.timelineIn).toBe(5);
    });

    it('prevents trimming below minimum duration', () => {
      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialSourceIn: 0,
          initialSourceOut: 2,
          minDuration: 1,
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 200);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'trim-right');
      });

      // Try to trim 1.5 seconds
      act(() => {
        const event = createMouseEvent('mousemove', 50);
        document.dispatchEvent(event);
      });

      expect(result.current.previewPosition?.duration).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // Grid Snapping Tests
  // ===========================================================================

  describe('grid snapping', () => {
    it('snaps position to grid during move', () => {
      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          gridInterval: 1, // 1 second grid
          initialTimelineIn: 5,
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 500);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Move by 150px (1.5 seconds)
      act(() => {
        const event = createMouseEvent('mousemove', 650);
        document.dispatchEvent(event);
      });

      // Should snap to 7 (5 + 1.5 -> 7)
      expect(result.current.previewPosition?.timelineIn).toBe(7);
    });

    it('snaps duration to grid during trim', () => {
      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          gridInterval: 1,
          initialSourceIn: 0,
          initialSourceOut: 10,
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 1000);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'trim-right');
      });

      // Trim by 150px (1.5 seconds)
      act(() => {
        const event = createMouseEvent('mousemove', 850);
        document.dispatchEvent(event);
      });

      // Duration should snap (10 - 1.5 = 8.5 -> 9 or 8)
      const duration = result.current.previewPosition?.duration ?? 0;
      expect(duration % 1).toBeCloseTo(0, 5);
    });
  });

  // ===========================================================================
  // Cleanup Tests
  // ===========================================================================

  describe('cleanup', () => {
    it('removes event listeners on unmount during drag', () => {
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
      const { result, unmount } = renderHook(() => useClipDrag(defaultOptions));

      // Start drag
      act(() => {
        const event = createMouseEvent('mousedown', 100);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Unmount while dragging
      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(removeEventListenerSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
    });
  });

  // ===========================================================================
  // Speed Modifier Tests
  // ===========================================================================

  describe('speed modifier', () => {
    it('accounts for speed when calculating duration', () => {
      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialSourceIn: 0,
          initialSourceOut: 10,
          speed: 2, // 2x speed = 5 second clip
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 100);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Initial duration should account for speed
      expect(result.current.previewPosition?.duration).toBe(5);
    });
  });

  // ===========================================================================
  // Snap Points Integration Tests
  // ===========================================================================

  describe('snap points integration', () => {
    it('should snap to nearby clip edge when snapPoints provided', () => {
      const snapPoints = [
        { time: 10, type: 'clip-end' as const, clipId: 'other-clip' },
      ];

      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialTimelineIn: 5,
          snapPoints,
          snapThreshold: 0.2, // 0.2 seconds = 20px at zoom 100
        }),
      );

      // Start drag
      act(() => {
        const event = createMouseEvent('mousedown', 500);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Move to position that would be 9.9s (within 0.2s of 10s snap point)
      // Delta = 490px = 4.9s → 5 + 4.9 = 9.9s
      act(() => {
        const event = createMouseEvent('mousemove', 990);
        document.dispatchEvent(event);
      });

      // Should snap to 10s
      expect(result.current.previewPosition?.timelineIn).toBe(10);
    });

    it('should snap to playhead when within threshold', () => {
      const snapPoints = [
        { time: 15, type: 'playhead' as const },
      ];

      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialTimelineIn: 5,
          snapPoints,
          snapThreshold: 0.15,
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 500);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Move to position ~14.9s (within 0.15s of 15s playhead)
      act(() => {
        const event = createMouseEvent('mousemove', 1490);
        document.dispatchEvent(event);
      });

      // Should snap to 15s playhead
      expect(result.current.previewPosition?.timelineIn).toBe(15);
    });

    it('should NOT snap when outside threshold', () => {
      const snapPoints = [
        { time: 10, type: 'clip-end' as const, clipId: 'other-clip' },
      ];

      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialTimelineIn: 5,
          snapPoints,
          snapThreshold: 0.1, // 0.1 seconds
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 500);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Move to 9.5s (0.5s away from 10s snap point, beyond threshold)
      act(() => {
        const event = createMouseEvent('mousemove', 950);
        document.dispatchEvent(event);
      });

      // Should NOT snap, stay at 9.5s
      expect(result.current.previewPosition?.timelineIn).toBeCloseTo(9.5, 1);
    });

    it('should report active snap point when snapping', () => {
      const snapPoints = [
        { time: 10, type: 'clip-end' as const, clipId: 'other-clip' },
      ];

      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialTimelineIn: 5,
          snapPoints,
          snapThreshold: 0.2,
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 500);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Move to position that will snap to 10s
      act(() => {
        const event = createMouseEvent('mousemove', 990);
        document.dispatchEvent(event);
      });

      // Should report the active snap point
      expect(result.current.activeSnapPoint).toBeDefined();
      expect(result.current.activeSnapPoint?.time).toBe(10);
      expect(result.current.activeSnapPoint?.type).toBe('clip-end');
    });

    it('should clear active snap point when not snapping', () => {
      const snapPoints = [
        { time: 10, type: 'clip-end' as const, clipId: 'other-clip' },
      ];

      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialTimelineIn: 5,
          snapPoints,
          snapThreshold: 0.1,
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 500);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Move to position outside snap threshold
      act(() => {
        const event = createMouseEvent('mousemove', 800);
        document.dispatchEvent(event);
      });

      expect(result.current.activeSnapPoint).toBeNull();
    });

    it('should prioritize playhead over clip edges when equidistant', () => {
      const snapPoints = [
        { time: 10, type: 'clip-end' as const, clipId: 'other-clip' },
        { time: 10, type: 'playhead' as const },
      ];

      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialTimelineIn: 5,
          snapPoints,
          snapThreshold: 0.2,
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 500);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Move to snap at 10s
      act(() => {
        const event = createMouseEvent('mousemove', 1000);
        document.dispatchEvent(event);
      });

      // Should snap to playhead (higher priority)
      expect(result.current.activeSnapPoint?.type).toBe('playhead');
    });

    it('should still use gridInterval when no snapPoints provided', () => {
      const { result } = renderHook(() =>
        useClipDrag({
          ...defaultOptions,
          initialTimelineIn: 5,
          gridInterval: 1, // 1 second grid
        }),
      );

      act(() => {
        const event = createMouseEvent('mousedown', 500);
        result.current.handleMouseDown(event as unknown as React.MouseEvent, 'move');
      });

      // Move by 150px (1.5 seconds)
      act(() => {
        const event = createMouseEvent('mousemove', 650);
        document.dispatchEvent(event);
      });

      // Should snap to 7s (grid snapping)
      expect(result.current.previewPosition?.timelineIn).toBe(7);
    });
  });
});

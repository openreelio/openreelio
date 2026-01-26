/**
 * usePlayheadDrag Hook Tests
 *
 * Comprehensive tests for the playhead dragging functionality including:
 * - Basic drag operations
 * - Snapping behavior
 * - Playback state preservation
 * - Event listener management
 * - Edge cases and error conditions
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { usePlayheadDrag } from './usePlayheadDrag';
import type { SnapPoint } from '@/types';

// =============================================================================
// Test Utilities
// =============================================================================

const createMockContainerRef = (
  rect: Partial<DOMRect> = {}
): React.RefObject<HTMLDivElement> => {
  const element = {
    getBoundingClientRect: () => ({
      left: 200,
      top: 100,
      right: 1200,
      bottom: 500,
      width: 1000,
      height: 400,
      x: 200,
      y: 100,
      toJSON: () => ({}),
      ...rect,
    }),
  } as HTMLDivElement;

  return { current: element };
};

const createMockMouseEvent = (
  options: Partial<{
    clientX: number;
    clientY: number;
    button: number;
  }> = {}
): React.MouseEvent => {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientX: options.clientX ?? 400,
    clientY: options.clientY ?? 200,
    button: options.button ?? 0,
  } as unknown as React.MouseEvent;
};

const createMockPointerEvent = (
  options: Partial<{
    clientX: number;
    clientY: number;
    pointerId: number;
    isPrimary: boolean;
  }> = {}
): React.PointerEvent => {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientX: options.clientX ?? 400,
    clientY: options.clientY ?? 200,
    pointerId: options.pointerId ?? 1,
    isPrimary: options.isPrimary ?? true,
    target: {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    },
  } as unknown as React.PointerEvent;
};

const createMockNativeEvent = (
  options: Partial<{
    clientX: number;
    clientY: number;
  }> = {}
): MouseEvent | PointerEvent => {
  return {
    clientX: options.clientX ?? 400,
    clientY: options.clientY ?? 200,
  } as unknown as MouseEvent;
};

const createDefaultSnapPoints = (): SnapPoint[] => [
  { time: 0, type: 'grid' },
  { time: 1, type: 'clip-start', clipId: 'clip-1' },
  { time: 2, type: 'clip-end', clipId: 'clip-1' },
  { time: 5, type: 'playhead' },
  { time: 10, type: 'marker', markerId: 'marker-1' },
];

// =============================================================================
// Tests
// =============================================================================

describe('usePlayheadDrag', () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let windowAddEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let windowRemoveEventListenerSpy: ReturnType<typeof vi.spyOn>;
  let performanceNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addEventListenerSpy = vi.spyOn(document, 'addEventListener');
    removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
    windowAddEventListenerSpy = vi.spyOn(window, 'addEventListener');
    windowRemoveEventListenerSpy = vi.spyOn(window, 'removeEventListener');
    performanceNowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
    windowAddEventListenerSpy.mockRestore();
    windowRemoveEventListenerSpy.mockRestore();
    performanceNowSpy.mockRestore();
    vi.clearAllMocks();
  });

  const createDefaultOptions = () => ({
    containerRef: createMockContainerRef(),
    zoom: 100, // 100px per second
    scrollX: 0,
    duration: 60,
    trackHeaderWidth: 192,
    isPlaying: false,
    togglePlayback: vi.fn(),
    seek: vi.fn(),
    snapEnabled: false,
    snapPoints: [] as SnapPoint[],
    snapThreshold: 0.1,
    onSnapChange: vi.fn(),
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  describe('initial state', () => {
    it('should return isDragging as false initially', () => {
      const { result } = renderHook(() => usePlayheadDrag(createDefaultOptions()));
      expect(result.current.isDragging).toBe(false);
    });

    it('should return handleDragStart function', () => {
      const { result } = renderHook(() => usePlayheadDrag(createDefaultOptions()));
      expect(typeof result.current.handleDragStart).toBe('function');
    });

    it('should return handlePointerDown function', () => {
      const { result } = renderHook(() => usePlayheadDrag(createDefaultOptions()));
      expect(typeof result.current.handlePointerDown).toBe('function');
    });
  });

  // ===========================================================================
  // Mouse Drag Tests
  // ===========================================================================

  describe('mouse drag', () => {
    it('should start dragging on mouse down (left button)', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      const event = createMockMouseEvent({ clientX: 400 });

      act(() => {
        result.current.handleDragStart(event);
      });

      expect(result.current.isDragging).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('should not start dragging on right-click', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      const event = createMockMouseEvent({ button: 2 });

      act(() => {
        result.current.handleDragStart(event);
      });

      expect(result.current.isDragging).toBe(false);
    });

    it('should calculate initial time from mouse position', () => {
      const options = createDefaultOptions();
      // Container left: 200, trackHeaderWidth: 192, scrollX: 0
      // clientX: 492 => relativeX = 492 - 200 - 192 + 0 = 100 => time = 100 / 100 = 1s
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 492 }));
      });

      expect(options.seek).toHaveBeenCalledWith(1);
    });

    it('should clamp time to valid range', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      // Position before timeline start (should clamp to 0)
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 100 }));
      });

      expect(options.seek).toHaveBeenCalledWith(0);
    });

    it('should add document event listeners on drag start', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      expect(addEventListenerSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(addEventListenerSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
      expect(windowAddEventListenerSpy).toHaveBeenCalledWith('blur', expect.any(Function));
    });

    it('should update position on mouse move', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      // Advance time to bypass throttle
      performanceNowSpy.mockReturnValue(0);

      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 492 }));
      });

      expect(options.seek).toHaveBeenCalledWith(1);

      // Get mousemove handler
      const mousemoveCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mousemove'
      );
      const mousemoveHandler = mousemoveCall?.[1] as (e: MouseEvent) => void;

      // Advance time past throttle interval
      performanceNowSpy.mockReturnValue(20);

      act(() => {
        // Move to clientX: 592 => relativeX = 592 - 200 - 192 = 200 => time = 2s
        mousemoveHandler(createMockNativeEvent({ clientX: 592 }));
      });

      expect(options.seek).toHaveBeenCalledWith(2);
    });

    it('should throttle mouse move updates', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      performanceNowSpy.mockReturnValue(0);

      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 492 }));
      });

      const mousemoveCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mousemove'
      );
      const mousemoveHandler = mousemoveCall?.[1] as (e: MouseEvent) => void;

      // Move immediately (should be throttled)
      performanceNowSpy.mockReturnValue(5);

      act(() => {
        mousemoveHandler(createMockNativeEvent({ clientX: 592 }));
      });

      // Should not have been called again (throttled)
      expect(options.seek).toHaveBeenCalledTimes(1);

      // Move after throttle interval
      performanceNowSpy.mockReturnValue(20);

      act(() => {
        mousemoveHandler(createMockNativeEvent({ clientX: 592 }));
      });

      expect(options.seek).toHaveBeenCalledTimes(2);
    });

    it('should end dragging on mouse up', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      expect(result.current.isDragging).toBe(true);

      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      expect(result.current.isDragging).toBe(false);
    });

    it('should remove event listeners on drag end', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      expect(removeEventListenerSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(removeEventListenerSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
      expect(windowRemoveEventListenerSpy).toHaveBeenCalledWith('blur', expect.any(Function));
    });
  });

  // ===========================================================================
  // Pointer Events Tests
  // ===========================================================================

  describe('pointer events (touch support)', () => {
    it('should start dragging on pointer down', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      const event = createMockPointerEvent({ isPrimary: true });

      act(() => {
        result.current.handlePointerDown(event);
      });

      expect(result.current.isDragging).toBe(true);
      expect((event.target as HTMLElement).setPointerCapture).toHaveBeenCalledWith(1);
    });

    it('should not start dragging for non-primary pointers', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      const event = createMockPointerEvent({ isPrimary: false });

      act(() => {
        result.current.handlePointerDown(event);
      });

      expect(result.current.isDragging).toBe(false);
    });

    it('should add pointer event listeners on drag start', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handlePointerDown(createMockPointerEvent());
      });

      expect(addEventListenerSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
      expect(addEventListenerSpy).toHaveBeenCalledWith('pointerup', expect.any(Function));
      expect(addEventListenerSpy).toHaveBeenCalledWith('pointercancel', expect.any(Function));
    });
  });

  // ===========================================================================
  // Playback State Tests
  // ===========================================================================

  describe('playback state', () => {
    it('should pause playback on drag start when playing', () => {
      const options = { ...createDefaultOptions(), isPlaying: true };
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      expect(options.togglePlayback).toHaveBeenCalledTimes(1);
    });

    it('should not pause playback on drag start when paused', () => {
      const options = { ...createDefaultOptions(), isPlaying: false };
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      expect(options.togglePlayback).not.toHaveBeenCalled();
    });

    it('should resume playback on drag end if was playing', () => {
      const options = { ...createDefaultOptions(), isPlaying: true };
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      expect(options.togglePlayback).toHaveBeenCalledTimes(1);

      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      expect(options.togglePlayback).toHaveBeenCalledTimes(2);
    });

    it('should not resume playback on drag end if was not playing', () => {
      const options = { ...createDefaultOptions(), isPlaying: false };
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      expect(options.togglePlayback).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Snapping Tests
  // ===========================================================================

  describe('snapping', () => {
    it('should apply snapping when enabled', () => {
      const options = {
        ...createDefaultOptions(),
        snapEnabled: true,
        snapPoints: createDefaultSnapPoints(),
        snapThreshold: 0.2, // 0.2 seconds
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      performanceNowSpy.mockReturnValue(0);

      // Position near 1s snap point (clip-start)
      // clientX: 500 => relativeX = 500 - 200 - 192 = 108 => time = 1.08s
      // Should snap to 1s (within 0.2s threshold)
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
      });

      expect(options.seek).toHaveBeenCalledWith(1);
    });

    it('should not snap when disabled', () => {
      const options = {
        ...createDefaultOptions(),
        snapEnabled: false,
        snapPoints: createDefaultSnapPoints(),
        snapThreshold: 0.2,
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      // clientX: 500 => relativeX = 500 - 200 - 192 = 108 => time = 1.08s
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
      });

      expect(options.seek).toHaveBeenCalledWith(1.08);
    });

    it('should call onSnapChange with snap point when snapping', () => {
      const options = {
        ...createDefaultOptions(),
        snapEnabled: true,
        snapPoints: createDefaultSnapPoints(),
        snapThreshold: 0.2,
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      performanceNowSpy.mockReturnValue(0);

      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
      });

      expect(options.onSnapChange).toHaveBeenCalledWith(
        expect.objectContaining({
          time: 1,
          type: 'clip-start',
        })
      );
    });

    it('should call onSnapChange with null when not snapping', () => {
      const options = {
        ...createDefaultOptions(),
        snapEnabled: true,
        snapPoints: createDefaultSnapPoints(),
        snapThreshold: 0.05, // Very tight threshold
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      performanceNowSpy.mockReturnValue(0);

      // Position far from any snap point
      // clientX: 700 => relativeX = 700 - 200 - 192 = 308 => time = 3.08s
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 700 }));
      });

      expect(options.onSnapChange).toHaveBeenCalledWith(null);
    });

    it('should clear snap indicator on drag end', () => {
      const options = {
        ...createDefaultOptions(),
        snapEnabled: true,
        snapPoints: createDefaultSnapPoints(),
        snapThreshold: 0.2,
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
      });

      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      expect(options.onSnapChange).toHaveBeenLastCalledWith(null);
    });

    it('should snap during drag move', () => {
      const options = {
        ...createDefaultOptions(),
        snapEnabled: true,
        snapPoints: createDefaultSnapPoints(),
        snapThreshold: 0.2,
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      performanceNowSpy.mockReturnValue(0);

      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 400 }));
      });

      const mousemoveCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mousemove'
      );
      const mousemoveHandler = mousemoveCall?.[1] as (e: MouseEvent) => void;

      performanceNowSpy.mockReturnValue(20);

      // Move near 2s snap point (clip-end)
      // clientX: 600 => relativeX = 600 - 200 - 192 = 208 => time = 2.08s
      act(() => {
        mousemoveHandler(createMockNativeEvent({ clientX: 600 }));
      });

      expect(options.seek).toHaveBeenLastCalledWith(2);
      expect(options.onSnapChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          time: 2,
          type: 'clip-end',
        })
      );
    });
  });

  // ===========================================================================
  // Scroll Offset Tests
  // ===========================================================================

  describe('scroll offset', () => {
    it('should account for horizontal scroll', () => {
      const options = {
        ...createDefaultOptions(),
        scrollX: 500, // Scrolled 500px to the right
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      // clientX: 492 with scrollX: 500
      // relativeX = 492 - 200 - 192 + 500 = 600 => time = 6s
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 492 }));
      });

      expect(options.seek).toHaveBeenCalledWith(6);
    });
  });

  // ===========================================================================
  // Duration Boundary Tests
  // ===========================================================================

  describe('duration boundaries', () => {
    it('should clamp to start of timeline', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      // Position before timeline (negative time)
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 100 }));
      });

      expect(options.seek).toHaveBeenCalledWith(0);
    });

    it('should clamp to end of timeline', () => {
      const options = {
        ...createDefaultOptions(),
        duration: 10, // 10 seconds
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      // Position way past timeline end
      // clientX: 2000 => relativeX = 2000 - 200 - 192 = 1608 => time = 16.08s
      // Should clamp to 10s
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 2000 }));
      });

      expect(options.seek).toHaveBeenCalledWith(10);
    });
  });

  // ===========================================================================
  // Window Blur Tests
  // ===========================================================================

  describe('window blur handling', () => {
    it('should end drag on window blur', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      expect(result.current.isDragging).toBe(true);

      const blurCall = windowAddEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'blur'
      );
      const blurHandler = blurCall?.[1] as () => void;

      act(() => {
        blurHandler();
      });

      expect(result.current.isDragging).toBe(false);
    });

    it('should resume playback on window blur if was playing', () => {
      const options = { ...createDefaultOptions(), isPlaying: true };
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      expect(options.togglePlayback).toHaveBeenCalledTimes(1);

      const blurCall = windowAddEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'blur'
      );
      const blurHandler = blurCall?.[1] as () => void;

      act(() => {
        blurHandler();
      });

      expect(options.togglePlayback).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // Cleanup Tests
  // ===========================================================================

  describe('cleanup on unmount', () => {
    it('should clean up event listeners on unmount during drag', () => {
      const options = createDefaultOptions();
      const { result, unmount } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
      expect(removeEventListenerSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
      expect(windowRemoveEventListenerSpy).toHaveBeenCalledWith('blur', expect.any(Function));
    });

    it('should not throw on unmount when not dragging', () => {
      const options = createDefaultOptions();
      const { unmount } = renderHook(() => usePlayheadDrag(options));

      expect(() => unmount()).not.toThrow();
    });
  });

  // ===========================================================================
  // Null Container Tests
  // ===========================================================================

  describe('null container handling', () => {
    it('should not start drag if container ref is null', () => {
      const options = {
        ...createDefaultOptions(),
        containerRef: { current: null },
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      // Should not crash and should not start dragging
      expect(result.current.isDragging).toBe(false);
      expect(options.seek).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Multiple Drag Sessions Tests
  // ===========================================================================

  describe('multiple drag sessions', () => {
    it('should handle consecutive drag sessions', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => usePlayheadDrag(options));

      // First drag session
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 492 }));
      });
      expect(result.current.isDragging).toBe(true);

      const mouseupCall1 = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler1 = mouseupCall1?.[1] as () => void;

      act(() => {
        mouseupHandler1();
      });
      expect(result.current.isDragging).toBe(false);

      // Clear calls
      addEventListenerSpy.mockClear();

      // Second drag session
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 592 }));
      });
      expect(result.current.isDragging).toBe(true);

      expect(addEventListenerSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
    });
  });

  // ===========================================================================
  // Callback without onSnapChange Tests
  // ===========================================================================

  describe('optional callbacks', () => {
    it('should work without onSnapChange callback', () => {
      const options = { ...createDefaultOptions(), onSnapChange: undefined };
      const { result } = renderHook(() => usePlayheadDrag(options));

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      expect(result.current.isDragging).toBe(true);

      const mouseupCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mouseup'
      );
      const mouseupHandler = mouseupCall?.[1] as () => void;

      act(() => {
        mouseupHandler();
      });

      expect(result.current.isDragging).toBe(false);
    });
  });

  // ===========================================================================
  // Zoom Level Tests
  // ===========================================================================

  describe('zoom level handling', () => {
    it('should correctly calculate time at different zoom levels', () => {
      const options = {
        ...createDefaultOptions(),
        zoom: 200, // 200px per second (more zoomed in)
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      // clientX: 492 => relativeX = 492 - 200 - 192 = 100 => time = 100 / 200 = 0.5s
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 492 }));
      });

      expect(options.seek).toHaveBeenCalledWith(0.5);
    });

    it('should correctly calculate time at low zoom levels', () => {
      const options = {
        ...createDefaultOptions(),
        zoom: 50, // 50px per second (more zoomed out)
      };
      const { result } = renderHook(() => usePlayheadDrag(options));

      // clientX: 492 => relativeX = 492 - 200 - 192 = 100 => time = 100 / 50 = 2s
      act(() => {
        result.current.handleDragStart(createMockMouseEvent({ clientX: 492 }));
      });

      expect(options.seek).toHaveBeenCalledWith(2);
    });
  });

  // ===========================================================================
  // Props Update Tests
  // ===========================================================================

  describe('props updates during drag', () => {
    it('should use latest zoom value during drag', () => {
      const options = createDefaultOptions();
      const { result, rerender } = renderHook(
        (props) => usePlayheadDrag(props),
        { initialProps: options }
      );

      performanceNowSpy.mockReturnValue(0);

      act(() => {
        result.current.handleDragStart(createMockMouseEvent());
      });

      // Update zoom
      rerender({ ...options, zoom: 200 });

      const mousemoveCall = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'mousemove'
      );
      const mousemoveHandler = mousemoveCall?.[1] as (e: MouseEvent) => void;

      performanceNowSpy.mockReturnValue(20);

      // Move with new zoom value
      // clientX: 492 => relativeX = 492 - 200 - 192 = 100 => time = 100 / 200 = 0.5s
      act(() => {
        mousemoveHandler(createMockNativeEvent({ clientX: 492 }));
      });

      expect(options.seek).toHaveBeenLastCalledWith(0.5);
    });
  });

  // ===========================================================================
  // Destructive Test Scenarios - Edge Cases & Invalid Inputs
  // ===========================================================================

  describe('destructive tests - edge cases', () => {
    describe('division by zero protection', () => {
      it('should handle zoom = 0 without throwing', () => {
        const options = {
          ...createDefaultOptions(),
          zoom: 0,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();

        // Should still seek (using MIN_ZOOM fallback)
        expect(options.seek).toHaveBeenCalled();
      });

      it('should handle negative zoom without throwing', () => {
        const options = {
          ...createDefaultOptions(),
          zoom: -100,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();

        expect(options.seek).toHaveBeenCalled();
      });
    });

    describe('NaN and Infinity protection', () => {
      it('should handle NaN zoom', () => {
        const options = {
          ...createDefaultOptions(),
          zoom: NaN,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();

        expect(options.seek).toHaveBeenCalled();
      });

      it('should handle Infinity zoom', () => {
        const options = {
          ...createDefaultOptions(),
          zoom: Infinity,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();

        expect(options.seek).toHaveBeenCalled();
      });

      it('should handle NaN duration', () => {
        const options = {
          ...createDefaultOptions(),
          duration: NaN,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();

        expect(options.seek).toHaveBeenCalled();
        // Should clamp to 0 when duration is invalid
        expect(options.seek).toHaveBeenCalledWith(0);
      });

      it('should handle negative duration', () => {
        const options = {
          ...createDefaultOptions(),
          duration: -10,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();

        expect(options.seek).toHaveBeenCalledWith(0);
      });

      it('should handle NaN scrollX', () => {
        const options = {
          ...createDefaultOptions(),
          scrollX: NaN,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();

        expect(options.seek).toHaveBeenCalled();
      });
    });

    describe('invalid snap points', () => {
      it('should handle empty snap points array', () => {
        const options = {
          ...createDefaultOptions(),
          snapEnabled: true,
          snapPoints: [],
          snapThreshold: 0.5,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();

        expect(options.onSnapChange).toHaveBeenCalledWith(null);
      });

      it('should handle snap points with NaN time values', () => {
        const options = {
          ...createDefaultOptions(),
          snapEnabled: true,
          snapPoints: [
            { time: NaN, type: 'grid' as const },
            { time: 1, type: 'clip-start' as const, clipId: 'clip-1' },
          ],
          snapThreshold: 0.5,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();
      });

      it('should handle null snap threshold', () => {
        const options = {
          ...createDefaultOptions(),
          snapEnabled: true,
          snapPoints: createDefaultSnapPoints(),
          snapThreshold: 0 as number,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();

        // Should not snap with 0 threshold
        expect(options.onSnapChange).toHaveBeenCalledWith(null);
      });

      it('should handle negative snap threshold', () => {
        const options = {
          ...createDefaultOptions(),
          snapEnabled: true,
          snapPoints: createDefaultSnapPoints(),
          snapThreshold: -1,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();
      });
    });

    describe('race condition prevention', () => {
      it('should prevent double drag start', () => {
        const options = createDefaultOptions();
        const { result } = renderHook(() => usePlayheadDrag(options));

        // First drag start
        act(() => {
          result.current.handleDragStart(createMockMouseEvent({ clientX: 400 }));
        });

        expect(result.current.isDragging).toBe(true);
        const firstSeekCallCount = options.seek.mock.calls.length;

        // Try to start another drag while already dragging
        act(() => {
          result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
        });

        // Should not start a new drag or call seek again
        expect(options.seek.mock.calls.length).toBe(firstSeekCallCount);
      });

      it('should prevent mixed mouse/pointer event double trigger', () => {
        const options = createDefaultOptions();
        const { result } = renderHook(() => usePlayheadDrag(options));

        // Start with mouse
        act(() => {
          result.current.handleDragStart(createMockMouseEvent({ clientX: 400 }));
        });

        const firstCallCount = options.seek.mock.calls.length;

        // Try pointer while mouse drag is active
        act(() => {
          result.current.handlePointerDown(createMockPointerEvent({ clientX: 500 }));
        });

        expect(options.seek.mock.calls.length).toBe(firstCallCount);
      });
    });

    describe('extreme values', () => {
      it('should handle very large zoom values', () => {
        const options = {
          ...createDefaultOptions(),
          zoom: 1e10,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();
      });

      it('should handle very small zoom values', () => {
        const options = {
          ...createDefaultOptions(),
          zoom: 0.001,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();
      });

      it('should handle very large duration', () => {
        const options = {
          ...createDefaultOptions(),
          duration: 3600 * 24, // 24 hours
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();
      });

      it('should handle very large scrollX', () => {
        const options = {
          ...createDefaultOptions(),
          scrollX: 1e6,
        };
        const { result } = renderHook(() => usePlayheadDrag(options));

        expect(() => {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 500 }));
          });
        }).not.toThrow();

        // Time should be clamped to duration
        expect(options.seek).toHaveBeenCalledWith(60); // max duration
      });
    });

    describe('rapid operations', () => {
      it('should handle rapid drag start/end cycles', () => {
        const options = createDefaultOptions();
        const { result } = renderHook(() => usePlayheadDrag(options));

        for (let i = 0; i < 10; i++) {
          act(() => {
            result.current.handleDragStart(createMockMouseEvent({ clientX: 400 + i * 10 }));
          });

          const mouseupCall = addEventListenerSpy.mock.calls.find(
            (call) => call[0] === 'mouseup'
          );
          const mouseupHandler = mouseupCall?.[1] as () => void;

          act(() => {
            mouseupHandler();
          });

          // Reset for next iteration
          addEventListenerSpy.mockClear();
        }

        expect(result.current.isDragging).toBe(false);
      });

      it('should handle rapid prop updates during drag', () => {
        const options = createDefaultOptions();
        const { result, rerender } = renderHook(
          (props) => usePlayheadDrag(props),
          { initialProps: options }
        );

        performanceNowSpy.mockReturnValue(0);

        act(() => {
          result.current.handleDragStart(createMockMouseEvent({ clientX: 400 }));
        });

        // Rapidly update props
        for (let i = 0; i < 50; i++) {
          rerender({ ...options, zoom: 100 + i, scrollX: i * 10 });
        }

        expect(result.current.isDragging).toBe(true);
      });
    });

    describe('memory safety', () => {
      it('should clean up all listeners after multiple unmounts', () => {
        const options = createDefaultOptions();

        for (let i = 0; i < 5; i++) {
          const { result, unmount } = renderHook(() => usePlayheadDrag(options));

          act(() => {
            result.current.handleDragStart(createMockMouseEvent());
          });

          unmount();
        }

        // Verify cleanup was called each time
        expect(removeEventListenerSpy.mock.calls.length).toBeGreaterThan(0);
      });
    });
  });
});

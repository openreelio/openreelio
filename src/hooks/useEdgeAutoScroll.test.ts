/**
 * useEdgeAutoScroll Hook Tests
 *
 * Tests for the automatic edge scrolling functionality including:
 * - Scroll activation at edges
 * - Speed calculation based on distance
 * - Boundary clamping
 * - Cleanup on unmount
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEdgeAutoScroll } from './useEdgeAutoScroll';

// =============================================================================
// Test Utilities
// =============================================================================

const createMockContainerRef = (
  rect: Partial<DOMRect> = {},
  scrollState: { scrollLeft: number } = { scrollLeft: 0 }
): React.RefObject<HTMLElement> => {
  const element = {
    getBoundingClientRect: () => ({
      left: 100,
      right: 1100,
      top: 0,
      bottom: 400,
      width: 1000,
      height: 400,
      x: 100,
      y: 0,
      toJSON: () => ({}),
      ...rect,
    }),
    get scrollLeft() {
      return scrollState.scrollLeft;
    },
    set scrollLeft(value: number) {
      scrollState.scrollLeft = value;
    },
    clientWidth: 1000,
  } as unknown as HTMLElement;

  return { current: element };
};

// =============================================================================
// Tests
// =============================================================================

describe('useEdgeAutoScroll', () => {
  let rafCallback: FrameRequestCallback | null = null;
  let rafId = 0;
  let mockTime = 0;

  beforeEach(() => {
    mockTime = 1000; // Start at 1000ms to avoid edge cases

    // Mock performance.now to control time
    vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

    // Mock requestAnimationFrame
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafCallback = callback;
      return ++rafId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      rafCallback = null;
    });
  });

  afterEach(() => {
    rafCallback = null;
    rafId = 0;
    mockTime = 0;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  const flushRaf = (deltaMs: number = 16) => {
    if (rafCallback) {
      const cb = rafCallback;
      rafCallback = null;
      // Advance time before calling callback to ensure proper delta time calculation
      mockTime += deltaMs;
      cb(mockTime);
    }
  };

  const createDefaultOptions = (overrides: Partial<Parameters<typeof useEdgeAutoScroll>[0]> = {}) => ({
    isActive: false,
    getMouseClientX: vi.fn().mockReturnValue(600),
    scrollContainerRef: createMockContainerRef(),
    contentWidth: 2000,
    onScrollChange: vi.fn(),
    ...overrides,
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  describe('initial state', () => {
    it('should return isAutoScrolling as false initially', () => {
      const { result } = renderHook(() => useEdgeAutoScroll(createDefaultOptions()));
      expect(result.current.isAutoScrolling).toBe(false);
    });

    it('should not start RAF loop when inactive', () => {
      renderHook(() => useEdgeAutoScroll(createDefaultOptions({ isActive: false })));
      expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Activation Tests
  // ===========================================================================

  describe('activation', () => {
    it('should start RAF loop when active', () => {
      renderHook(() => useEdgeAutoScroll(createDefaultOptions({ isActive: true })));
      expect(window.requestAnimationFrame).toHaveBeenCalled();
    });

    it('should stop RAF loop when deactivated', () => {
      const { rerender } = renderHook(
        (props) => useEdgeAutoScroll(props),
        { initialProps: createDefaultOptions({ isActive: true }) }
      );

      expect(window.requestAnimationFrame).toHaveBeenCalled();

      rerender(createDefaultOptions({ isActive: false }));

      expect(window.cancelAnimationFrame).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Left Edge Scrolling Tests
  // ===========================================================================

  describe('left edge scrolling', () => {
    it('should scroll left when mouse is near left edge', () => {
      const scrollState = { scrollLeft: 500 };
      const containerRef = createMockContainerRef({}, scrollState);
      const onScrollChange = vi.fn();

      const options = createDefaultOptions({
        isActive: true,
        getMouseClientX: vi.fn().mockReturnValue(120), // 20px from left edge (100 + 20)
        scrollContainerRef: containerRef,
        onScrollChange,
      });

      renderHook(() => useEdgeAutoScroll(options));

      act(() => {
        flushRaf();
      });

      // Should have scrolled left (negative direction)
      expect(scrollState.scrollLeft).toBeLessThan(500);
      expect(onScrollChange).toHaveBeenCalledWith(scrollState.scrollLeft);
    });

    it('should not scroll left when already at start', () => {
      const scrollState = { scrollLeft: 0 };
      const containerRef = createMockContainerRef({}, scrollState);
      const onScrollChange = vi.fn();

      const options = createDefaultOptions({
        isActive: true,
        getMouseClientX: vi.fn().mockReturnValue(120),
        scrollContainerRef: containerRef,
        onScrollChange,
      });

      renderHook(() => useEdgeAutoScroll(options));

      act(() => {
        flushRaf();
      });

      expect(scrollState.scrollLeft).toBe(0);
      expect(onScrollChange).not.toHaveBeenCalled();
    });

    it('should scroll faster when closer to edge', () => {
      // Test with mouse very close to edge
      const scrollState1 = { scrollLeft: 500 };
      const containerRef1 = createMockContainerRef({}, scrollState1);

      const options1 = createDefaultOptions({
        isActive: true,
        getMouseClientX: vi.fn().mockReturnValue(105), // 5px from edge
        scrollContainerRef: containerRef1,
      });

      renderHook(() => useEdgeAutoScroll(options1));
      act(() => flushRaf());
      const scrollAmount1 = 500 - scrollState1.scrollLeft;

      // Test with mouse farther from edge
      const scrollState2 = { scrollLeft: 500 };
      const containerRef2 = createMockContainerRef({}, scrollState2);

      const options2 = createDefaultOptions({
        isActive: true,
        getMouseClientX: vi.fn().mockReturnValue(140), // 40px from edge
        scrollContainerRef: containerRef2,
      });

      const { unmount } = renderHook(() => useEdgeAutoScroll(options2));
      act(() => flushRaf());
      const scrollAmount2 = 500 - scrollState2.scrollLeft;
      unmount();

      // Closer to edge should scroll faster
      expect(scrollAmount1).toBeGreaterThan(scrollAmount2);
    });
  });

  // ===========================================================================
  // Right Edge Scrolling Tests
  // ===========================================================================

  describe('right edge scrolling', () => {
    it('should scroll right when mouse is near right edge', () => {
      const scrollState = { scrollLeft: 500 };
      const containerRef = createMockContainerRef({}, scrollState);
      const onScrollChange = vi.fn();

      const options = createDefaultOptions({
        isActive: true,
        getMouseClientX: vi.fn().mockReturnValue(1080), // 20px from right edge (1100 - 20)
        scrollContainerRef: containerRef,
        contentWidth: 2000,
        onScrollChange,
      });

      renderHook(() => useEdgeAutoScroll(options));

      act(() => {
        flushRaf();
      });

      // Should have scrolled right (positive direction)
      expect(scrollState.scrollLeft).toBeGreaterThan(500);
      expect(onScrollChange).toHaveBeenCalledWith(scrollState.scrollLeft);
    });

    it('should not scroll right when already at end', () => {
      // contentWidth: 2000, viewportWidth: 1000, maxScroll: 1000
      const scrollState = { scrollLeft: 1000 };
      const containerRef = createMockContainerRef({}, scrollState);
      const onScrollChange = vi.fn();

      const options = createDefaultOptions({
        isActive: true,
        getMouseClientX: vi.fn().mockReturnValue(1080),
        scrollContainerRef: containerRef,
        contentWidth: 2000,
        onScrollChange,
      });

      renderHook(() => useEdgeAutoScroll(options));

      act(() => {
        flushRaf();
      });

      expect(scrollState.scrollLeft).toBe(1000);
      expect(onScrollChange).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // No Scrolling Tests
  // ===========================================================================

  describe('no scrolling in center', () => {
    it('should not scroll when mouse is in center of viewport', () => {
      const scrollState = { scrollLeft: 500 };
      const containerRef = createMockContainerRef({}, scrollState);
      const onScrollChange = vi.fn();

      const options = createDefaultOptions({
        isActive: true,
        getMouseClientX: vi.fn().mockReturnValue(600), // Center of viewport
        scrollContainerRef: containerRef,
        onScrollChange,
      });

      renderHook(() => useEdgeAutoScroll(options));

      act(() => {
        flushRaf();
      });

      expect(scrollState.scrollLeft).toBe(500);
      expect(onScrollChange).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Cleanup Tests
  // ===========================================================================

  describe('cleanup', () => {
    it('should cancel RAF on unmount', () => {
      const { unmount } = renderHook(() =>
        useEdgeAutoScroll(createDefaultOptions({ isActive: true }))
      );

      expect(window.requestAnimationFrame).toHaveBeenCalled();

      unmount();

      expect(window.cancelAnimationFrame).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Null Container Tests
  // ===========================================================================

  describe('null container handling', () => {
    it('should handle null container ref gracefully', () => {
      const options = createDefaultOptions({
        isActive: true,
        scrollContainerRef: { current: null },
      });

      expect(() => {
        const { result } = renderHook(() => useEdgeAutoScroll(options));
        act(() => flushRaf());
        expect(result.current.isAutoScrolling).toBe(false);
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle content width smaller than viewport', () => {
      const scrollState = { scrollLeft: 0 };
      const containerRef = createMockContainerRef({}, scrollState);

      const options = createDefaultOptions({
        isActive: true,
        getMouseClientX: vi.fn().mockReturnValue(1080),
        scrollContainerRef: containerRef,
        contentWidth: 500, // Smaller than viewport (1000)
      });

      expect(() => {
        renderHook(() => useEdgeAutoScroll(options));
        act(() => flushRaf());
      }).not.toThrow();

      // Should not scroll since content fits in viewport
      expect(scrollState.scrollLeft).toBe(0);
    });

    it('should clamp scroll to valid range', () => {
      const scrollState = { scrollLeft: 950 };
      const containerRef = createMockContainerRef({}, scrollState);

      const options = createDefaultOptions({
        isActive: true,
        getMouseClientX: vi.fn().mockReturnValue(1095), // Very close to right edge
        scrollContainerRef: containerRef,
        contentWidth: 2000,
      });

      renderHook(() => useEdgeAutoScroll(options));

      // Scroll multiple times
      for (let i = 0; i < 10; i++) {
        act(() => flushRaf());
      }

      // Should be clamped to maxScroll (1000)
      expect(scrollState.scrollLeft).toBeLessThanOrEqual(1000);
    });
  });
});

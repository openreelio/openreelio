/**
 * useTimelineNavigation Hook Tests
 *
 * TDD: RED phase - Tests written before implementation
 * Tests for timeline scroll and zoom handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTimelineNavigation } from './useTimelineNavigation';
import type { RefObject, WheelEvent } from 'react';

// =============================================================================
// Mock Setup
// =============================================================================

const createMockRef = (width = 800): RefObject<HTMLDivElement> => ({
  current: {
    clientWidth: width,
    clientHeight: 400,
  } as HTMLDivElement,
});

const createWheelEvent = (options: Partial<WheelEvent> = {}): WheelEvent => ({
  deltaX: 0,
  deltaY: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  preventDefault: vi.fn(),
  ...options,
} as unknown as WheelEvent);

// =============================================================================
// Tests
// =============================================================================

describe('useTimelineNavigation', () => {
  let zoomIn: ReturnType<typeof vi.fn>;
  let zoomOut: ReturnType<typeof vi.fn>;
  let setScrollX: ReturnType<typeof vi.fn>;
  let fitToWindow: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    zoomIn = vi.fn();
    zoomOut = vi.fn();
    setScrollX = vi.fn();
    fitToWindow = vi.fn();
  });

  // ===========================================================================
  // Zoom with Ctrl+Wheel Tests
  // ===========================================================================

  describe('zoom with Ctrl+wheel', () => {
    it('should zoom in when scrolling up with Ctrl key', () => {
      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 0,
          duration: 60,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 192,
        })
      );

      const event = createWheelEvent({ deltaY: -100, ctrlKey: true });

      act(() => {
        result.current.handleWheel(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(zoomIn).toHaveBeenCalledTimes(1);
      expect(zoomOut).not.toHaveBeenCalled();
    });

    it('should zoom out when scrolling down with Ctrl key', () => {
      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 0,
          duration: 60,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 192,
        })
      );

      const event = createWheelEvent({ deltaY: 100, ctrlKey: true });

      act(() => {
        result.current.handleWheel(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(zoomOut).toHaveBeenCalledTimes(1);
      expect(zoomIn).not.toHaveBeenCalled();
    });

    it('should zoom in with Meta key (Mac)', () => {
      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 0,
          duration: 60,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 192,
        })
      );

      const event = createWheelEvent({ deltaY: -100, metaKey: true });

      act(() => {
        result.current.handleWheel(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(zoomIn).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Horizontal Scroll with Shift+Wheel Tests
  // ===========================================================================

  describe('horizontal scroll with Shift+wheel', () => {
    it('should scroll horizontally when using Shift+wheel', () => {
      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 100,
          duration: 60,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 192,
        })
      );

      const event = createWheelEvent({ deltaY: 50, shiftKey: true });

      act(() => {
        result.current.handleWheel(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(setScrollX).toHaveBeenCalledWith(150); // 100 + 0 + 50
    });

    it('should use deltaX for horizontal scroll with Shift', () => {
      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 100,
          duration: 60,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 192,
        })
      );

      const event = createWheelEvent({ deltaX: 30, deltaY: 20, shiftKey: true });

      act(() => {
        result.current.handleWheel(event);
      });

      expect(setScrollX).toHaveBeenCalledWith(150); // 100 + 30 + 20
    });

    it('should not trigger zoom or scroll without modifier keys', () => {
      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 100,
          duration: 60,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 192,
        })
      );

      const event = createWheelEvent({ deltaY: 50 });

      act(() => {
        result.current.handleWheel(event);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(zoomIn).not.toHaveBeenCalled();
      expect(zoomOut).not.toHaveBeenCalled();
      expect(setScrollX).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Fit to Window Tests
  // ===========================================================================

  describe('fit to window', () => {
    it('should call fitToWindow with duration and viewport width', () => {
      const mockRef = createMockRef(800);

      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 0,
          duration: 120,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 192,
          tracksAreaRef: mockRef,
        })
      );

      act(() => {
        result.current.handleFitToWindow();
      });

      // 800 - 192 = 608px viewport width
      expect(fitToWindow).toHaveBeenCalledWith(120, 608);
    });

    it('should not call fitToWindow when ref is null', () => {
      const nullRef: RefObject<HTMLDivElement> = { current: null };

      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 0,
          duration: 120,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 192,
          tracksAreaRef: nullRef,
        })
      );

      act(() => {
        result.current.handleFitToWindow();
      });

      expect(fitToWindow).not.toHaveBeenCalled();
    });

    it('should not call fitToWindow when ref is not provided', () => {
      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 0,
          duration: 120,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 192,
        })
      );

      act(() => {
        result.current.handleFitToWindow();
      });

      expect(fitToWindow).not.toHaveBeenCalled();
    });

    it('should calculate correct viewport width with different track header width', () => {
      const mockRef = createMockRef(1000);

      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 0,
          duration: 60,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 250, // Custom track header width
          tracksAreaRef: mockRef,
        })
      );

      act(() => {
        result.current.handleFitToWindow();
      });

      // 1000 - 250 = 750px viewport width
      expect(fitToWindow).toHaveBeenCalledWith(60, 750);
    });
  });

  // ===========================================================================
  // Combined Behavior Tests
  // ===========================================================================

  describe('priority of modifiers', () => {
    it('should prioritize Ctrl over Shift when both are pressed', () => {
      const { result } = renderHook(() =>
        useTimelineNavigation({
          scrollX: 0,
          duration: 60,
          zoomIn,
          zoomOut,
          setScrollX,
          fitToWindow,
          trackHeaderWidth: 192,
        })
      );

      const event = createWheelEvent({ deltaY: -100, ctrlKey: true, shiftKey: true });

      act(() => {
        result.current.handleWheel(event);
      });

      // Should zoom, not scroll
      expect(zoomIn).toHaveBeenCalledTimes(1);
      expect(setScrollX).not.toHaveBeenCalled();
    });
  });
});

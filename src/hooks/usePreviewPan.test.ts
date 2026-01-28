/**
 * usePreviewPan Hook Tests
 *
 * Tests for preview canvas panning:
 * - Middle mouse button drag
 * - Alt+left click drag
 * - Pan bounds constraint
 * - Panning state management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreviewPan } from './usePreviewPan';
import { usePreviewStore } from '@/stores/previewStore';

// Mock container ref
function createMockContainerRef() {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return { current: element };
}

describe('usePreviewPan', () => {
  let containerRef: { current: HTMLElement };

  beforeEach(() => {
    // Reset store to initial state
    usePreviewStore.setState({
      zoomLevel: 1.0,
      zoomMode: 'fit',
      panX: 0,
      panY: 0,
      isPanning: false,
    });

    containerRef = createMockContainerRef();
  });

  afterEach(() => {
    // Clean up DOM
    if (containerRef.current && containerRef.current.parentNode) {
      containerRef.current.parentNode.removeChild(containerRef.current);
    }
  });

  // ===========================================================================
  // Initial State
  // ===========================================================================

  describe('initial state', () => {
    it('should return initial pan values from store', () => {
      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 1920,
          displayHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      expect(result.current.panX).toBe(0);
      expect(result.current.panY).toBe(0);
      expect(result.current.isPanning).toBe(false);
    });

    it('should return pan values when store has values', () => {
      usePreviewStore.setState({ panX: 100, panY: 50 });

      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 1920,
          displayHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      expect(result.current.panX).toBe(100);
      expect(result.current.panY).toBe(50);
    });
  });

  // ===========================================================================
  // setPan
  // ===========================================================================

  describe('setPan', () => {
    it('should set pan offset', () => {
      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 1920,
          displayHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      act(() => {
        result.current.setPan(50, 30);
      });

      expect(result.current.panX).toBe(50);
      expect(result.current.panY).toBe(30);
    });
  });

  // ===========================================================================
  // resetPan
  // ===========================================================================

  describe('resetPan', () => {
    it('should reset pan to center (0, 0)', () => {
      usePreviewStore.setState({ panX: 100, panY: 50 });

      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 1920,
          displayHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      act(() => {
        result.current.resetPan();
      });

      expect(result.current.panX).toBe(0);
      expect(result.current.panY).toBe(0);
    });
  });

  // ===========================================================================
  // Middle Mouse Drag
  // ===========================================================================

  describe('middle mouse drag', () => {
    it('should start panning on middle mouse button down', () => {
      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 1920,
          displayHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      act(() => {
        const mouseDown = new MouseEvent('mousedown', {
          button: 1, // Middle button
          clientX: 100,
          clientY: 100,
          bubbles: true,
        });
        containerRef.current.dispatchEvent(mouseDown);
      });

      expect(result.current.isPanning).toBe(true);
    });

    it('should update pan on mouse move during drag', () => {
      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 2000, // Larger than container
          displayHeight: 1500,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      // Start drag
      act(() => {
        const mouseDown = new MouseEvent('mousedown', {
          button: 1,
          clientX: 100,
          clientY: 100,
          bubbles: true,
        });
        containerRef.current.dispatchEvent(mouseDown);
      });

      // Move mouse
      act(() => {
        const mouseMove = new MouseEvent('mousemove', {
          clientX: 150, // +50
          clientY: 120, // +20
          bubbles: true,
        });
        window.dispatchEvent(mouseMove);
      });

      // Pan should be updated (constrained to bounds)
      expect(result.current.panX).not.toBe(0);
    });

    it('should stop panning on mouse up', () => {
      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 1920,
          displayHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      // Start drag
      act(() => {
        const mouseDown = new MouseEvent('mousedown', {
          button: 1,
          clientX: 100,
          clientY: 100,
          bubbles: true,
        });
        containerRef.current.dispatchEvent(mouseDown);
      });

      expect(result.current.isPanning).toBe(true);

      // Release
      act(() => {
        const mouseUp = new MouseEvent('mouseup', { bubbles: true });
        window.dispatchEvent(mouseUp);
      });

      expect(result.current.isPanning).toBe(false);
    });
  });

  // ===========================================================================
  // Alt+Left Click Drag
  // ===========================================================================

  describe('alt+left click drag', () => {
    it('should start panning on Alt+left click', () => {
      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 1920,
          displayHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      act(() => {
        const mouseDown = new MouseEvent('mousedown', {
          button: 0, // Left button
          altKey: true,
          clientX: 100,
          clientY: 100,
          bubbles: true,
        });
        containerRef.current.dispatchEvent(mouseDown);
      });

      expect(result.current.isPanning).toBe(true);
    });

    it('should not start panning on plain left click', () => {
      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 1920,
          displayHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      act(() => {
        const mouseDown = new MouseEvent('mousedown', {
          button: 0, // Left button, no alt
          altKey: false,
          clientX: 100,
          clientY: 100,
          bubbles: true,
        });
        containerRef.current.dispatchEvent(mouseDown);
      });

      expect(result.current.isPanning).toBe(false);
    });
  });

  // ===========================================================================
  // Pan Bounds
  // ===========================================================================

  describe('pan bounds', () => {
    it('should not allow panning when content fits within container', () => {
      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 400, // Smaller than container
          displayHeight: 300,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      // Start drag
      act(() => {
        const mouseDown = new MouseEvent('mousedown', {
          button: 1,
          clientX: 100,
          clientY: 100,
          bubbles: true,
        });
        containerRef.current.dispatchEvent(mouseDown);
      });

      // Try to pan
      act(() => {
        const mouseMove = new MouseEvent('mousemove', {
          clientX: 300,
          clientY: 300,
          bubbles: true,
        });
        window.dispatchEvent(mouseMove);
      });

      // Pan should be constrained to 0 since content fits
      expect(result.current.panX).toBe(0);
      expect(result.current.panY).toBe(0);
    });

    it('should constrain pan to overflow bounds', () => {
      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 1600, // 800 overflow
          displayHeight: 1200, // 600 overflow
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      // Start drag
      act(() => {
        const mouseDown = new MouseEvent('mousedown', {
          button: 1,
          clientX: 0,
          clientY: 0,
          bubbles: true,
        });
        containerRef.current.dispatchEvent(mouseDown);
      });

      // Try to pan beyond bounds
      act(() => {
        const mouseMove = new MouseEvent('mousemove', {
          clientX: 1000, // Try to pan way beyond bounds
          clientY: 1000,
          bubbles: true,
        });
        window.dispatchEvent(mouseMove);
      });

      // Pan should be constrained
      // overflowX = 1600 - 800 = 800, max pan = 400
      // overflowY = 1200 - 600 = 600, max pan = 300
      expect(result.current.panX).toBeLessThanOrEqual(400);
      expect(result.current.panY).toBeLessThanOrEqual(300);
    });
  });

  // ===========================================================================
  // Disabled State
  // ===========================================================================

  describe('disabled state', () => {
    it('should not start panning when disabled', () => {
      const { result } = renderHook(() =>
        usePreviewPan({
          containerRef,
          displayWidth: 1920,
          displayHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: false,
        }),
      );

      act(() => {
        const mouseDown = new MouseEvent('mousedown', {
          button: 1,
          clientX: 100,
          clientY: 100,
          bubbles: true,
        });
        containerRef.current.dispatchEvent(mouseDown);
      });

      expect(result.current.isPanning).toBe(false);
    });
  });

  // ===========================================================================
  // Null Container Ref
  // ===========================================================================

  describe('null container ref', () => {
    it('should handle null container ref gracefully', () => {
      const nullRef = { current: null };

      expect(() => {
        renderHook(() =>
          usePreviewPan({
            containerRef: nullRef,
            displayWidth: 1920,
            displayHeight: 1080,
            containerWidth: 800,
            containerHeight: 600,
            enabled: true,
          }),
        );
      }).not.toThrow();
    });
  });
});

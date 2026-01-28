/**
 * usePreviewZoom Hook Tests
 *
 * Tests for preview zoom calculations and wheel-based zoom control:
 * - Fit/Fill zoom calculations
 * - Effective zoom based on mode
 * - Display dimension calculations
 * - Ctrl+wheel zoom behavior
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreviewZoom } from './usePreviewZoom';
import { usePreviewStore } from '@/stores/previewStore';

// Mock container ref
function createMockContainerRef() {
  const element = document.createElement('div');
  return { current: element };
}

describe('usePreviewZoom', () => {
  beforeEach(() => {
    // Reset store to initial state
    usePreviewStore.setState({
      zoomLevel: 1.0,
      zoomMode: 'fit',
      panX: 0,
      panY: 0,
      isPanning: false,
    });
  });

  // ===========================================================================
  // Fit/Fill Calculations
  // ===========================================================================

  describe('fit/fill calculations', () => {
    it('should calculate fitZoom correctly for landscape canvas in portrait container', () => {
      const containerRef = createMockContainerRef();

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      // Fit should scale to fit within container
      // scaleX = 800/1920 = 0.417
      // scaleY = 600/1080 = 0.556
      // fitZoom = min(0.417, 0.556) = 0.417
      expect(result.current.effectiveZoom).toBeCloseTo(800 / 1920, 2);
    });

    it('should calculate fillZoom correctly', () => {
      const containerRef = createMockContainerRef();

      usePreviewStore.setState({ zoomMode: 'fill' });

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      // Fill should scale to fill container
      // scaleX = 800/1920 = 0.417
      // scaleY = 600/1080 = 0.556
      // fillZoom = max(0.417, 0.556) = 0.556
      expect(result.current.effectiveZoom).toBeCloseTo(600 / 1080, 2);
    });

    it('should handle zero dimensions gracefully', () => {
      const containerRef = createMockContainerRef();

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 0,
          canvasHeight: 0,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      // Should default to 1 when dimensions are invalid
      expect(result.current.effectiveZoom).toBe(1);
    });
  });

  // ===========================================================================
  // Effective Zoom
  // ===========================================================================

  describe('effectiveZoom', () => {
    it('should return fitZoom when mode is fit', () => {
      const containerRef = createMockContainerRef();
      usePreviewStore.setState({ zoomMode: 'fit' });

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 960,
          containerHeight: 540,
          enabled: true,
        }),
      );

      // 960/1920 = 0.5, 540/1080 = 0.5, fitZoom = 0.5
      expect(result.current.effectiveZoom).toBeCloseTo(0.5, 2);
    });

    it('should return 1.0 when mode is 100%', () => {
      const containerRef = createMockContainerRef();
      usePreviewStore.setState({ zoomMode: '100%' });

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      expect(result.current.effectiveZoom).toBe(1.0);
    });

    it('should return zoomLevel when mode is custom', () => {
      const containerRef = createMockContainerRef();
      usePreviewStore.setState({ zoomMode: 'custom', zoomLevel: 1.5 });

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      expect(result.current.effectiveZoom).toBe(1.5);
    });
  });

  // ===========================================================================
  // Display Dimensions
  // ===========================================================================

  describe('display dimensions', () => {
    it('should calculate displayWidth correctly', () => {
      const containerRef = createMockContainerRef();
      usePreviewStore.setState({ zoomMode: '100%' });

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      expect(result.current.displayWidth).toBe(1920);
      expect(result.current.displayHeight).toBe(1080);
    });

    it('should calculate display dimensions at custom zoom', () => {
      const containerRef = createMockContainerRef();
      usePreviewStore.setState({ zoomMode: 'custom', zoomLevel: 0.5 });

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      expect(result.current.displayWidth).toBe(960);
      expect(result.current.displayHeight).toBe(540);
    });
  });

  // ===========================================================================
  // Zoom Percentage
  // ===========================================================================

  describe('zoomPercentage', () => {
    it('should format percentage correctly at 100%', () => {
      const containerRef = createMockContainerRef();
      usePreviewStore.setState({ zoomMode: '100%' });

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 960,
          containerHeight: 540,
          enabled: true,
        }),
      );

      expect(result.current.zoomPercentage).toBe('100%');
    });

    it('should format percentage correctly at custom zoom', () => {
      const containerRef = createMockContainerRef();
      usePreviewStore.setState({ zoomMode: 'custom', zoomLevel: 1.5 });

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      expect(result.current.zoomPercentage).toBe('150%');
    });
  });

  // ===========================================================================
  // Actions
  // ===========================================================================

  describe('actions', () => {
    it('should call store zoomIn', () => {
      const containerRef = createMockContainerRef();

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      const initialZoom = usePreviewStore.getState().zoomLevel;

      act(() => {
        result.current.zoomIn();
      });

      expect(usePreviewStore.getState().zoomLevel).toBeGreaterThan(initialZoom);
    });

    it('should call store zoomOut', () => {
      const containerRef = createMockContainerRef();

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      const initialZoom = usePreviewStore.getState().zoomLevel;

      act(() => {
        result.current.zoomOut();
      });

      expect(usePreviewStore.getState().zoomLevel).toBeLessThan(initialZoom);
    });

    it('should call store setZoomLevel', () => {
      const containerRef = createMockContainerRef();

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      act(() => {
        result.current.setZoomLevel(2.0);
      });

      expect(usePreviewStore.getState().zoomLevel).toBe(2.0);
      expect(usePreviewStore.getState().zoomMode).toBe('custom');
    });

    it('should call store setZoomMode', () => {
      const containerRef = createMockContainerRef();

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      act(() => {
        result.current.setZoomMode('fill');
      });

      expect(usePreviewStore.getState().zoomMode).toBe('fill');
    });

    it('should call store resetView', () => {
      const containerRef = createMockContainerRef();
      usePreviewStore.setState({ zoomMode: 'custom', zoomLevel: 2.0, panX: 100, panY: 50 });

      const { result } = renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      act(() => {
        result.current.resetView();
      });

      const state = usePreviewStore.getState();
      expect(state.zoomMode).toBe('fit');
      expect(state.zoomLevel).toBe(1.0);
      expect(state.panX).toBe(0);
      expect(state.panY).toBe(0);
    });
  });

  // ===========================================================================
  // Wheel Zoom
  // ===========================================================================

  describe('wheel zoom', () => {
    it('should zoom in on Ctrl+wheel up', () => {
      const containerRef = createMockContainerRef();

      renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      const initialZoom = usePreviewStore.getState().zoomLevel;

      // Simulate Ctrl+wheel up
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        ctrlKey: true,
      });

      act(() => {
        containerRef.current?.dispatchEvent(wheelEvent);
      });

      expect(usePreviewStore.getState().zoomLevel).toBeGreaterThan(initialZoom);
    });

    it('should zoom out on Ctrl+wheel down', () => {
      const containerRef = createMockContainerRef();

      renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      const initialZoom = usePreviewStore.getState().zoomLevel;

      // Simulate Ctrl+wheel down
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: 100,
        ctrlKey: true,
      });

      act(() => {
        containerRef.current?.dispatchEvent(wheelEvent);
      });

      expect(usePreviewStore.getState().zoomLevel).toBeLessThan(initialZoom);
    });

    it('should not zoom without Ctrl key', () => {
      const containerRef = createMockContainerRef();

      renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: true,
        }),
      );

      const initialZoom = usePreviewStore.getState().zoomLevel;

      // Simulate wheel without Ctrl
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        ctrlKey: false,
      });

      act(() => {
        containerRef.current?.dispatchEvent(wheelEvent);
      });

      expect(usePreviewStore.getState().zoomLevel).toBe(initialZoom);
    });

    it('should not zoom when disabled', () => {
      const containerRef = createMockContainerRef();

      renderHook(() =>
        usePreviewZoom({
          containerRef,
          canvasWidth: 1920,
          canvasHeight: 1080,
          containerWidth: 800,
          containerHeight: 600,
          enabled: false,
        }),
      );

      const initialZoom = usePreviewStore.getState().zoomLevel;

      const wheelEvent = new WheelEvent('wheel', {
        deltaY: -100,
        ctrlKey: true,
      });

      act(() => {
        containerRef.current?.dispatchEvent(wheelEvent);
      });

      expect(usePreviewStore.getState().zoomLevel).toBe(initialZoom);
    });
  });
});

/**
 * PreviewStore Tests
 *
 * Tests for the preview panel state management including:
 * - Zoom level controls
 * - Zoom mode switching
 * - Pan offset management
 * - Reset functionality
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { usePreviewStore, ZOOM_PRESETS } from './previewStore';

describe('previewStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    usePreviewStore.setState({
      zoomLevel: 1.0,
      zoomMode: 'fit',
      panX: 0,
      panY: 0,
      isPanning: false,
    });
  });

  // ===========================================================================
  // Initial State
  // ===========================================================================

  describe('initial state', () => {
    it('should have correct initial values', () => {
      const state = usePreviewStore.getState();

      expect(state.zoomLevel).toBe(1.0);
      expect(state.zoomMode).toBe('fit');
      expect(state.panX).toBe(0);
      expect(state.panY).toBe(0);
      expect(state.isPanning).toBe(false);
    });
  });

  // ===========================================================================
  // Zoom Level
  // ===========================================================================

  describe('setZoomLevel', () => {
    it('should set zoom level within valid range', () => {
      usePreviewStore.getState().setZoomLevel(2.0);
      expect(usePreviewStore.getState().zoomLevel).toBe(2.0);
    });

    it('should clamp zoom level to minimum (0.1)', () => {
      usePreviewStore.getState().setZoomLevel(0.05);
      expect(usePreviewStore.getState().zoomLevel).toBe(0.1);
    });

    it('should clamp zoom level to maximum (4.0)', () => {
      usePreviewStore.getState().setZoomLevel(10.0);
      expect(usePreviewStore.getState().zoomLevel).toBe(4.0);
    });

    it('should switch to custom mode when setting zoom level', () => {
      usePreviewStore.getState().setZoomLevel(1.5);
      expect(usePreviewStore.getState().zoomMode).toBe('custom');
    });
  });

  describe('zoomIn', () => {
    it('should increase zoom level by step', () => {
      const initialZoom = usePreviewStore.getState().zoomLevel;
      usePreviewStore.getState().zoomIn();
      expect(usePreviewStore.getState().zoomLevel).toBeGreaterThan(initialZoom);
    });

    it('should switch to custom mode', () => {
      usePreviewStore.getState().zoomIn();
      expect(usePreviewStore.getState().zoomMode).toBe('custom');
    });

    it('should not exceed maximum zoom', () => {
      // Set to near maximum
      usePreviewStore.setState({ zoomLevel: 3.9, zoomMode: 'custom' });
      usePreviewStore.getState().zoomIn();
      expect(usePreviewStore.getState().zoomLevel).toBeLessThanOrEqual(4.0);
    });
  });

  describe('zoomOut', () => {
    it('should decrease zoom level by step', () => {
      const initialZoom = usePreviewStore.getState().zoomLevel;
      usePreviewStore.getState().zoomOut();
      expect(usePreviewStore.getState().zoomLevel).toBeLessThan(initialZoom);
    });

    it('should switch to custom mode', () => {
      usePreviewStore.getState().zoomOut();
      expect(usePreviewStore.getState().zoomMode).toBe('custom');
    });

    it('should not go below minimum zoom', () => {
      // Set to near minimum
      usePreviewStore.setState({ zoomLevel: 0.15, zoomMode: 'custom' });
      usePreviewStore.getState().zoomOut();
      expect(usePreviewStore.getState().zoomLevel).toBeGreaterThanOrEqual(0.1);
    });
  });

  // ===========================================================================
  // Zoom Mode
  // ===========================================================================

  describe('setZoomMode', () => {
    it('should set zoom mode to fit', () => {
      usePreviewStore.getState().setZoomMode('fit');
      expect(usePreviewStore.getState().zoomMode).toBe('fit');
    });

    it('should set zoom mode to fill', () => {
      usePreviewStore.getState().setZoomMode('fill');
      expect(usePreviewStore.getState().zoomMode).toBe('fill');
    });

    it('should set zoom mode to 100%', () => {
      usePreviewStore.getState().setZoomMode('100%');
      expect(usePreviewStore.getState().zoomMode).toBe('100%');
      expect(usePreviewStore.getState().zoomLevel).toBe(1.0);
    });

    it('should set zoom mode to custom', () => {
      usePreviewStore.getState().setZoomMode('custom');
      expect(usePreviewStore.getState().zoomMode).toBe('custom');
    });

    it('should reset pan when switching to non-custom modes', () => {
      // Set some pan offset
      usePreviewStore.setState({ panX: 100, panY: 50, zoomMode: 'custom' });

      usePreviewStore.getState().setZoomMode('fit');

      expect(usePreviewStore.getState().panX).toBe(0);
      expect(usePreviewStore.getState().panY).toBe(0);
    });

    it('should preserve pan when staying in custom mode', () => {
      usePreviewStore.setState({ panX: 100, panY: 50, zoomMode: 'custom' });

      usePreviewStore.getState().setZoomMode('custom');

      expect(usePreviewStore.getState().panX).toBe(100);
      expect(usePreviewStore.getState().panY).toBe(50);
    });
  });

  // ===========================================================================
  // Pan
  // ===========================================================================

  describe('setPan', () => {
    it('should set pan offset', () => {
      usePreviewStore.getState().setPan(100, 50);

      expect(usePreviewStore.getState().panX).toBe(100);
      expect(usePreviewStore.getState().panY).toBe(50);
    });

    it('should allow negative pan values', () => {
      usePreviewStore.getState().setPan(-50, -30);

      expect(usePreviewStore.getState().panX).toBe(-50);
      expect(usePreviewStore.getState().panY).toBe(-30);
    });
  });

  describe('startPanning / stopPanning', () => {
    it('should set isPanning to true when starting', () => {
      usePreviewStore.getState().startPanning();
      expect(usePreviewStore.getState().isPanning).toBe(true);
    });

    it('should set isPanning to false when stopping', () => {
      usePreviewStore.setState({ isPanning: true });
      usePreviewStore.getState().stopPanning();
      expect(usePreviewStore.getState().isPanning).toBe(false);
    });
  });

  // ===========================================================================
  // Reset
  // ===========================================================================

  describe('resetView', () => {
    it('should reset all values to initial state', () => {
      // Change all values
      usePreviewStore.setState({
        zoomLevel: 2.5,
        zoomMode: 'custom',
        panX: 100,
        panY: 50,
        isPanning: true,
      });

      usePreviewStore.getState().resetView();

      const state = usePreviewStore.getState();
      expect(state.zoomLevel).toBe(1.0);
      expect(state.zoomMode).toBe('fit');
      expect(state.panX).toBe(0);
      expect(state.panY).toBe(0);
      expect(state.isPanning).toBe(false);
    });
  });

  // ===========================================================================
  // ZOOM_PRESETS
  // ===========================================================================

  describe('ZOOM_PRESETS', () => {
    it('should have expected presets', () => {
      expect(ZOOM_PRESETS).toBeDefined();
      expect(ZOOM_PRESETS.length).toBeGreaterThan(0);
    });

    it('should have 100% preset', () => {
      const preset100 = ZOOM_PRESETS.find((p) => p.value === 1.0);
      expect(preset100).toBeDefined();
      expect(preset100?.label).toBe('100%');
    });

    it('should have all values between 0 and 4', () => {
      for (const preset of ZOOM_PRESETS) {
        expect(preset.value).toBeGreaterThanOrEqual(0.1);
        expect(preset.value).toBeLessThanOrEqual(4.0);
      }
    });
  });
});

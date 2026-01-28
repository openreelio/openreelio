/**
 * Preview Store
 *
 * Manages preview panel zoom and pan state.
 * Provides zoom controls (fit, fill, percentage) and pan offset for the preview canvas.
 *
 * ## Design Notes
 *
 * - **Pan Reset on Mode Change**: Switching zoom modes (except to 'custom') automatically
 *   resets pan to (0, 0). This ensures the canvas is centered when using fit/fill modes.
 *   If you need to preserve pan during mode changes, use `setZoomLevel()` instead which
 *   only changes to 'custom' mode without affecting pan.
 *
 * - **Validation**: All numeric inputs are validated for NaN/Infinity to prevent
 *   corrupted state. Invalid values are silently ignored.
 *
 * - **Bounds**: Zoom is clamped to [MIN_ZOOM, MAX_ZOOM]. Pan has no built-in bounds
 *   as valid bounds depend on canvas/container dimensions (handled by usePreviewPan).
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

// =============================================================================
// Types
// =============================================================================

export type ZoomMode = 'fit' | 'fill' | '100%' | 'custom';

export interface PreviewState {
  /** Current zoom level (1.0 = 100%) */
  zoomLevel: number;
  /** Current zoom mode */
  zoomMode: ZoomMode;
  /** Pan offset X (pixels) */
  panX: number;
  /** Pan offset Y (pixels) */
  panY: number;
  /** Whether currently panning */
  isPanning: boolean;
}

export interface PreviewActions {
  /**
   * Set zoom level (clamped to MIN_ZOOM - MAX_ZOOM).
   * Automatically switches to 'custom' mode.
   * Invalid values (NaN, Infinity) are ignored.
   */
  setZoomLevel: (level: number) => void;
  /**
   * Set zoom mode.
   * Note: Switching to any mode except 'custom' will reset pan to (0, 0).
   */
  setZoomMode: (mode: ZoomMode) => void;
  /**
   * Set pan offset in pixels.
   * Invalid values (NaN, Infinity) are ignored.
   */
  setPan: (x: number, y: number) => void;
  /** Start panning interaction */
  startPanning: () => void;
  /** Stop panning interaction */
  stopPanning: () => void;
  /** Reset view to fit mode with pan at origin */
  resetView: () => void;
  /** Zoom in by ZOOM_STEP multiplier */
  zoomIn: () => void;
  /** Zoom out by ZOOM_STEP multiplier */
  zoomOut: () => void;
}

export type PreviewStore = PreviewState & PreviewActions;

// =============================================================================
// Constants
// =============================================================================

/** Minimum zoom level (10%) */
export const MIN_ZOOM = 0.1;
/** Maximum zoom level (400%) */
export const MAX_ZOOM = 4.0;
/** Zoom step multiplier for in/out operations (25% change) */
export const ZOOM_STEP = 1.25;

/** Maximum allowed pan offset to prevent overflow issues */
const MAX_PAN = 100000;

// Common zoom presets
export const ZOOM_PRESETS = [
  { label: '25%', value: 0.25 },
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '100%', value: 1.0 },
  { label: '150%', value: 1.5 },
  { label: '200%', value: 2.0 },
] as const;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Validate a number is finite and optionally within bounds.
 * Returns the clamped value or undefined if invalid.
 */
function validateNumber(value: number, min?: number, max?: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  if (min !== undefined && max !== undefined) {
    return Math.max(min, Math.min(max, value));
  }
  if (min !== undefined) {
    return Math.max(min, value);
  }
  if (max !== undefined) {
    return Math.min(max, value);
  }
  return value;
}

// =============================================================================
// Initial State
// =============================================================================

const initialState: PreviewState = {
  zoomLevel: 1.0,
  zoomMode: 'fit',
  panX: 0,
  panY: 0,
  isPanning: false,
};

// =============================================================================
// Store
// =============================================================================

export const usePreviewStore = create<PreviewStore>()(
  immer((set) => ({
    ...initialState,

    setZoomLevel: (level: number) => {
      const validated = validateNumber(level, MIN_ZOOM, MAX_ZOOM);
      if (validated === undefined) {
        return; // Silently ignore invalid input
      }
      set((state) => {
        state.zoomLevel = validated;
        state.zoomMode = 'custom';
      });
    },

    setZoomMode: (mode: ZoomMode) => {
      set((state) => {
        state.zoomMode = mode;
        // Reset pan when switching to non-custom modes for consistent centering
        if (mode !== 'custom') {
          state.panX = 0;
          state.panY = 0;
        }
        // Set zoom level for fixed modes
        if (mode === '100%') {
          state.zoomLevel = 1.0;
        }
      });
    },

    setPan: (x: number, y: number) => {
      const validX = validateNumber(x, -MAX_PAN, MAX_PAN);
      const validY = validateNumber(y, -MAX_PAN, MAX_PAN);
      if (validX === undefined || validY === undefined) {
        return; // Silently ignore invalid input
      }
      set((state) => {
        state.panX = validX;
        state.panY = validY;
      });
    },

    startPanning: () => {
      set((state) => {
        state.isPanning = true;
      });
    },

    stopPanning: () => {
      set((state) => {
        state.isPanning = false;
      });
    },

    resetView: () => {
      set((state) => {
        state.zoomLevel = 1.0;
        state.zoomMode = 'fit';
        state.panX = 0;
        state.panY = 0;
        state.isPanning = false;
      });
    },

    zoomIn: () => {
      set((state) => {
        const newLevel = state.zoomLevel * ZOOM_STEP;
        state.zoomLevel = Math.min(MAX_ZOOM, newLevel);
        state.zoomMode = 'custom';
      });
    },

    zoomOut: () => {
      set((state) => {
        const newLevel = state.zoomLevel / ZOOM_STEP;
        state.zoomLevel = Math.max(MIN_ZOOM, newLevel);
        state.zoomMode = 'custom';
      });
    },
  })),
);

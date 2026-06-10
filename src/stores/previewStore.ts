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
export type PreviewPlaybackQuality = 'full' | 'half' | 'quarter';
export type PreviewMediaPreference = 'auto' | 'proxy' | 'renderCache';

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
  /** Whether program monitor safe-margin overlays are visible */
  showSafeMargins: boolean;
  /** Whether program monitor composition guide overlays are visible */
  showGuides: boolean;
  /** Program monitor render resolution for canvas preview playback */
  playbackQuality: PreviewPlaybackQuality;
  /** Program monitor media source preference */
  mediaPreference: PreviewMediaPreference;
  /** Current program monitor canvas used by video scopes analysis */
  programPreviewCanvas: HTMLCanvasElement | null;
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
  /** Toggle program monitor safe-margin overlays */
  toggleSafeMargins: () => void;
  /** Toggle program monitor composition guide overlays */
  toggleGuides: () => void;
  /** Set program monitor render resolution */
  setPlaybackQuality: (quality: PreviewPlaybackQuality) => void;
  /** Set program monitor media source preference */
  setMediaPreference: (preference: PreviewMediaPreference) => void;
  /** Register the current program monitor canvas for finishing tools */
  setProgramPreviewCanvas: (canvas: HTMLCanvasElement | null) => void;
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

export const PREVIEW_PLAYBACK_QUALITY_SCALE: Record<PreviewPlaybackQuality, number> = {
  full: 1,
  half: 0.5,
  quarter: 0.25,
};

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

function isPreviewPlaybackQuality(value: unknown): value is PreviewPlaybackQuality {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PREVIEW_PLAYBACK_QUALITY_SCALE, value)
  );
}

function isPreviewMediaPreference(value: unknown): value is PreviewMediaPreference {
  return value === 'auto' || value === 'proxy' || value === 'renderCache';
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
  showSafeMargins: false,
  showGuides: false,
  playbackQuality: 'full',
  mediaPreference: 'auto',
  programPreviewCanvas: null,
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
        state.showSafeMargins = false;
        state.showGuides = false;
        state.playbackQuality = initialState.playbackQuality;
        state.mediaPreference = initialState.mediaPreference;
        state.programPreviewCanvas = null;
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

    toggleSafeMargins: () => {
      set((state) => {
        state.showSafeMargins = !state.showSafeMargins;
      });
    },

    toggleGuides: () => {
      set((state) => {
        state.showGuides = !state.showGuides;
      });
    },

    setPlaybackQuality: (quality: PreviewPlaybackQuality) => {
      if (!isPreviewPlaybackQuality(quality)) {
        return;
      }

      set((state) => {
        state.playbackQuality = quality;
      });
    },

    setMediaPreference: (preference: PreviewMediaPreference) => {
      if (!isPreviewMediaPreference(preference)) {
        return;
      }

      set((state) => {
        state.mediaPreference = preference;
      });
    },

    setProgramPreviewCanvas: (canvas: HTMLCanvasElement | null) => {
      set((state) => {
        (state as PreviewStore).programPreviewCanvas = canvas;
      });
    },
  })),
);

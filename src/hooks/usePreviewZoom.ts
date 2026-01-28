/**
 * usePreviewZoom Hook
 *
 * Manages preview canvas zoom calculations and wheel-based zoom control.
 * Calculates display dimensions based on sequence format and zoom level.
 */

import { useEffect, useMemo, type RefObject } from 'react';
import { usePreviewStore, type ZoomMode } from '@/stores/previewStore';

// =============================================================================
// Types
// =============================================================================

export interface UsePreviewZoomOptions {
  /** Reference to the container element for wheel events */
  containerRef: RefObject<HTMLElement | null>;
  /** Canvas width from sequence format */
  canvasWidth: number;
  /** Canvas height from sequence format */
  canvasHeight: number;
  /** Container width for fit/fill calculations */
  containerWidth: number;
  /** Container height for fit/fill calculations */
  containerHeight: number;
  /** Whether zoom controls are enabled */
  enabled?: boolean;
}

export interface UsePreviewZoomReturn {
  /** Current zoom level */
  zoomLevel: number;
  /** Current zoom mode */
  zoomMode: ZoomMode;
  /** Effective zoom (accounts for fit/fill modes) */
  effectiveZoom: number;
  /** Display width after zoom */
  displayWidth: number;
  /** Display height after zoom */
  displayHeight: number;
  /** Set zoom level */
  setZoomLevel: (level: number) => void;
  /** Set zoom mode */
  setZoomMode: (mode: ZoomMode) => void;
  /** Zoom in */
  zoomIn: () => void;
  /** Zoom out */
  zoomOut: () => void;
  /** Reset to fit */
  resetView: () => void;
  /** Current zoom as percentage string */
  zoomPercentage: string;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function usePreviewZoom({
  containerRef,
  canvasWidth,
  canvasHeight,
  containerWidth,
  containerHeight,
  enabled = true,
}: UsePreviewZoomOptions): UsePreviewZoomReturn {
  // Store state
  const zoomLevel = usePreviewStore((state) => state.zoomLevel);
  const zoomMode = usePreviewStore((state) => state.zoomMode);
  const setZoomLevel = usePreviewStore((state) => state.setZoomLevel);
  const setZoomMode = usePreviewStore((state) => state.setZoomMode);
  const zoomIn = usePreviewStore((state) => state.zoomIn);
  const zoomOut = usePreviewStore((state) => state.zoomOut);
  const resetView = usePreviewStore((state) => state.resetView);

  // Calculate fit/fill zoom levels
  const { fitZoom, fillZoom } = useMemo(() => {
    if (canvasWidth <= 0 || canvasHeight <= 0 || containerWidth <= 0 || containerHeight <= 0) {
      return { fitZoom: 1, fillZoom: 1 };
    }

    const scaleX = containerWidth / canvasWidth;
    const scaleY = containerHeight / canvasHeight;

    return {
      fitZoom: Math.min(scaleX, scaleY),
      fillZoom: Math.max(scaleX, scaleY),
    };
  }, [canvasWidth, canvasHeight, containerWidth, containerHeight]);

  // Calculate effective zoom based on mode
  const effectiveZoom = useMemo(() => {
    switch (zoomMode) {
      case 'fit':
        return fitZoom;
      case 'fill':
        return fillZoom;
      case '100%':
        return 1.0;
      case 'custom':
      default:
        return zoomLevel;
    }
  }, [zoomMode, zoomLevel, fitZoom, fillZoom]);

  // Calculate display dimensions
  const displayWidth = canvasWidth * effectiveZoom;
  const displayHeight = canvasHeight * effectiveZoom;

  // Format zoom percentage
  const zoomPercentage = useMemo(() => {
    const percent = Math.round(effectiveZoom * 100);
    return `${percent}%`;
  }, [effectiveZoom]);

  // Handle Ctrl+wheel zoom
  useEffect(() => {
    if (!enabled || !containerRef.current) return;

    const container = containerRef.current;

    const handleWheel = (e: WheelEvent) => {
      // Only zoom on Ctrl+wheel
      if (!e.ctrlKey && !e.metaKey) return;

      e.preventDefault();

      // Zoom in or out based on wheel direction
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [enabled, containerRef, zoomIn, zoomOut]);

  return {
    zoomLevel,
    zoomMode,
    effectiveZoom,
    displayWidth,
    displayHeight,
    setZoomLevel,
    setZoomMode,
    zoomIn,
    zoomOut,
    resetView,
    zoomPercentage,
  };
}

/**
 * usePreviewPan Hook
 *
 * Manages preview canvas panning via mouse drag.
 * Supports middle-mouse-button drag and constrains pan to bounds.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { usePreviewStore } from '@/stores/previewStore';

// =============================================================================
// Types
// =============================================================================

export interface UsePreviewPanOptions {
  /** Reference to the container element for mouse events */
  containerRef: RefObject<HTMLElement | null>;
  /** Display width after zoom */
  displayWidth: number;
  /** Display height after zoom */
  displayHeight: number;
  /** Container width */
  containerWidth: number;
  /** Container height */
  containerHeight: number;
  /** Whether panning is enabled */
  enabled?: boolean;
}

export interface UsePreviewPanReturn {
  /** Current pan X offset */
  panX: number;
  /** Current pan Y offset */
  panY: number;
  /** Whether currently panning */
  isPanning: boolean;
  /** Set pan position */
  setPan: (x: number, y: number) => void;
  /** Reset pan to center */
  resetPan: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function usePreviewPan({
  containerRef,
  displayWidth,
  displayHeight,
  containerWidth,
  containerHeight,
  enabled = true,
}: UsePreviewPanOptions): UsePreviewPanReturn {
  // Store state
  const panX = usePreviewStore((state) => state.panX);
  const panY = usePreviewStore((state) => state.panY);
  const isPanning = usePreviewStore((state) => state.isPanning);
  const setPan = usePreviewStore((state) => state.setPan);
  const startPanning = usePreviewStore((state) => state.startPanning);
  const stopPanning = usePreviewStore((state) => state.stopPanning);

  // Track drag state
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // Calculate pan bounds (only allow panning when content is larger than container)
  const calculateBounds = useCallback(() => {
    const overflowX = Math.max(0, displayWidth - containerWidth);
    const overflowY = Math.max(0, displayHeight - containerHeight);

    return {
      minX: -overflowX / 2,
      maxX: overflowX / 2,
      minY: -overflowY / 2,
      maxY: overflowY / 2,
    };
  }, [displayWidth, displayHeight, containerWidth, containerHeight]);

  // Constrain pan to bounds
  const constrainPan = useCallback(
    (x: number, y: number): { x: number; y: number } => {
      const bounds = calculateBounds();
      return {
        x: Math.max(bounds.minX, Math.min(bounds.maxX, x)),
        y: Math.max(bounds.minY, Math.min(bounds.maxY, y)),
      };
    },
    [calculateBounds],
  );

  // Store panX/panY in refs to avoid stale closures while preventing unnecessary re-renders
  const panXRef = useRef(panX);
  const panYRef = useRef(panY);
  panXRef.current = panX;
  panYRef.current = panY;

  // Handle mouse down (middle button to pan)
  useEffect(() => {
    if (!enabled || !containerRef.current) return;

    const container = containerRef.current;

    const handleMouseDown = (e: MouseEvent) => {
      // Middle mouse button (button 1) or Alt+left click
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        e.preventDefault();
        dragStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          panX: panXRef.current,
          panY: panYRef.current,
        };
        startPanning();
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;

      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      const newPan = constrainPan(
        dragStartRef.current.panX + deltaX,
        dragStartRef.current.panY + deltaY,
      );

      setPan(newPan.x, newPan.y);
    };

    const handleMouseUp = () => {
      if (dragStartRef.current) {
        dragStartRef.current = null;
        stopPanning();
      }
    };

    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [enabled, containerRef, constrainPan, setPan, startPanning, stopPanning]);

  // Reset pan to center
  const resetPan = useCallback(() => {
    setPan(0, 0);
  }, [setPan]);

  return {
    panX,
    panY,
    isPanning,
    setPan,
    resetPan,
  };
}

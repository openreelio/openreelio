/**
 * useTimelinePan Hook
 *
 * Handles panning/scrolling the timeline via:
 * - Middle mouse button drag (always available)
 * - Hand tool drag (when hand tool is active)
 * - Shift + drag (alternative method)
 *
 * @module hooks/useTimelinePan
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface UseTimelinePanOptions {
  /** Current horizontal scroll position */
  scrollX: number;
  /** Current vertical scroll position */
  scrollY: number;
  /** Callback to update horizontal scroll */
  setScrollX: (x: number) => void;
  /** Callback to update vertical scroll */
  setScrollY?: (y: number) => void;
  /** Maximum horizontal scroll value */
  maxScrollX: number;
  /** Maximum vertical scroll value */
  maxScrollY?: number;
  /** Whether the hand tool is currently active */
  isHandToolActive: boolean;
  /** Whether panning is enabled */
  enabled?: boolean;
}

export interface UseTimelinePanResult {
  /** Whether the user is currently panning */
  isPanning: boolean;
  /** Handler for mouse down events */
  handleMouseDown: (e: React.MouseEvent) => void;
  /** Cursor style to apply */
  panCursor: string;
}

// =============================================================================
// Hook
// =============================================================================

export function useTimelinePan({
  scrollX,
  scrollY,
  setScrollX,
  setScrollY,
  maxScrollX,
  maxScrollY = 0,
  isHandToolActive,
  enabled = true,
}: UseTimelinePanOptions): UseTimelinePanResult {
  const [isPanning, setIsPanning] = useState(false);

  // Track drag state
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    startScrollX: number;
    startScrollY: number;
  } | null>(null);

  // Store latest values in refs for event handlers
  const latestRef = useRef({
    scrollX,
    scrollY,
    maxScrollX,
    maxScrollY,
    setScrollX,
    setScrollY,
  });

  useEffect(() => {
    latestRef.current = {
      scrollX,
      scrollY,
      maxScrollX,
      maxScrollY,
      setScrollX,
      setScrollY,
    };
  }, [scrollX, scrollY, maxScrollX, maxScrollY, setScrollX, setScrollY]);

  /**
   * Start panning
   */
  const startPan = useCallback((clientX: number, clientY: number) => {
    const { scrollX: sx, scrollY: sy } = latestRef.current;

    dragStateRef.current = {
      startX: clientX,
      startY: clientY,
      startScrollX: sx,
      startScrollY: sy,
    };

    setIsPanning(true);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }, []);

  /**
   * Handle mouse move during panning
   */
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const drag = dragStateRef.current;
    if (!drag) return;

    const { maxScrollX: msx, maxScrollY: msy, setScrollX: ssx, setScrollY: ssy } =
      latestRef.current;

    // Calculate delta from start position
    const deltaX = drag.startX - e.clientX;
    const deltaY = drag.startY - e.clientY;

    // Update scroll position
    const newScrollX = Math.max(0, Math.min(msx, drag.startScrollX + deltaX));
    ssx(newScrollX);

    if (ssy && msy > 0) {
      const newScrollY = Math.max(0, Math.min(msy, drag.startScrollY + deltaY));
      ssy(newScrollY);
    }
  }, []);

  /**
   * End panning
   */
  const endPan = useCallback(() => {
    dragStateRef.current = null;
    setIsPanning(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  /**
   * Handle mouse up to end panning
   * Note: Defined before handleMouseDown to satisfy dependency order
   */
  const handleMouseUp = useCallback(() => {
    endPan();
    document.removeEventListener('mousemove', handleMouseMove);
    // Self-reference is safe here as we're removing the listener
    document.removeEventListener('mouseup', handleMouseUp);
  }, [endPan, handleMouseMove]);

  /**
   * Handle mouse down on the timeline
   */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled) return;

      // Middle mouse button (always allows panning)
      const isMiddleButton = e.button === 1;

      // Left button with hand tool or shift key
      const isLeftWithModifier =
        e.button === 0 && (isHandToolActive || e.shiftKey);

      if (isMiddleButton || isLeftWithModifier) {
        e.preventDefault();
        e.stopPropagation();
        startPan(e.clientX, e.clientY);

        // Add document listeners
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
      }
    },
    [enabled, isHandToolActive, startPan, handleMouseMove, handleMouseUp]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (isPanning) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, [handleMouseMove, handleMouseUp, isPanning]);

  // Determine cursor style
  const panCursor = isPanning
    ? 'cursor-grabbing'
    : isHandToolActive
      ? 'cursor-grab'
      : '';

  return {
    isPanning,
    handleMouseDown,
    panCursor,
  };
}

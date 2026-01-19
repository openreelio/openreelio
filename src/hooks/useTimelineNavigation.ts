/**
 * useTimelineNavigation Hook
 *
 * Manages scroll and zoom handlers for the Timeline component.
 * Extracted from Timeline.tsx to improve maintainability and testability.
 */

import { useCallback, type RefObject, type WheelEvent } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface UseTimelineNavigationProps {
  /** Current horizontal scroll position */
  scrollX: number;
  /** Total timeline duration in seconds */
  duration: number;
  /** Callback to zoom in */
  zoomIn: () => void;
  /** Callback to zoom out */
  zoomOut: () => void;
  /** Callback to set horizontal scroll position */
  setScrollX: (value: number) => void;
  /** Callback to fit timeline to window */
  fitToWindow: (duration: number, viewportWidth: number) => void;
  /** Width of track header in pixels */
  trackHeaderWidth: number;
  /** Ref to the tracks area element for viewport calculations */
  tracksAreaRef?: RefObject<HTMLDivElement>;
}

export interface UseTimelineNavigationResult {
  /** Handle wheel events for zoom and scroll */
  handleWheel: (e: WheelEvent) => void;
  /** Handle fit to window action */
  handleFitToWindow: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useTimelineNavigation({
  scrollX,
  duration,
  zoomIn,
  zoomOut,
  setScrollX,
  fitToWindow,
  trackHeaderWidth,
  tracksAreaRef,
}: UseTimelineNavigationProps): UseTimelineNavigationResult {
  // ===========================================================================
  // Wheel Handler
  // ===========================================================================

  /**
   * Handle wheel events for zoom (Ctrl/Meta) and horizontal scroll (Shift).
   * Ctrl/Meta + wheel: zoom in/out
   * Shift + wheel: horizontal scroll
   */
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      // Ctrl or Meta key: zoom
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          zoomIn();
        } else {
          zoomOut();
        }
        return;
      }

      // Shift key: horizontal scroll
      if (e.shiftKey) {
        e.preventDefault();
        setScrollX(scrollX + e.deltaX + e.deltaY);
      }
    },
    [zoomIn, zoomOut, setScrollX, scrollX]
  );

  // ===========================================================================
  // Fit to Window Handler
  // ===========================================================================

  /**
   * Fit the timeline to the available window width.
   * Calculates the viewport width by subtracting the track header width.
   */
  const handleFitToWindow = useCallback(() => {
    if (tracksAreaRef?.current) {
      const viewportWidth = tracksAreaRef.current.clientWidth - trackHeaderWidth;
      fitToWindow(duration, viewportWidth);
    }
  }, [duration, fitToWindow, trackHeaderWidth, tracksAreaRef]);

  // ===========================================================================
  // Return
  // ===========================================================================

  return {
    handleWheel,
    handleFitToWindow,
  };
}

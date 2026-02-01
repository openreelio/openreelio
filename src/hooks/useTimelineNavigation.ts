/**
 * useTimelineNavigation Hook
 *
 * Manages scroll and zoom handlers for the Timeline component.
 * Extracted from Timeline.tsx to improve maintainability and testability.
 *
 * Enhanced with Remotion-inspired features:
 * - Zoom with cursor preservation (zooms centered on cursor position)
 * - Smart viewport scrolling to keep playhead visible
 * - Configurable zoom behavior
 */

import { useCallback, useRef, type RefObject, type WheelEvent } from 'react';
import {
  zoomWithCursorPreservation,
  ensureTimeInViewportAuto,
  calculatePlayheadFollowScroll,
  type ViewportState,
} from '@/utils/timelineScrollLogic';

// =============================================================================
// Types
// =============================================================================

export interface UseTimelineNavigationProps {
  /** Current horizontal scroll position */
  scrollX: number;
  /** Current zoom level (pixels per second) */
  zoom: number;
  /** Total timeline duration in seconds */
  duration: number;
  /** Current playhead position in seconds */
  playheadTime?: number;
  /** Callback to zoom in */
  zoomIn: () => void;
  /** Callback to zoom out */
  zoomOut: () => void;
  /** Callback to set zoom level directly */
  setZoom?: (zoom: number) => void;
  /** Callback to set horizontal scroll position */
  setScrollX: (value: number) => void;
  /** Callback to fit timeline to window */
  fitToWindow: (duration: number, viewportWidth: number) => void;
  /** Width of track header in pixels */
  trackHeaderWidth: number;
  /** Ref to the tracks area element for viewport calculations */
  tracksAreaRef?: RefObject<HTMLDivElement>;
  /** Whether to preserve cursor position during zoom (default: true) */
  preserveCursorOnZoom?: boolean;
  /** Whether to auto-scroll to follow playhead during playback (default: false) */
  followPlayhead?: boolean;
  /** Minimum zoom level */
  minZoom?: number;
  /** Maximum zoom level */
  maxZoom?: number;
  /** Zoom step factor (default: 1.2) */
  zoomStepFactor?: number;
}

export interface UseTimelineNavigationResult {
  /** Handle wheel events for zoom and scroll */
  handleWheel: (e: WheelEvent) => void;
  /** Handle fit to window action */
  handleFitToWindow: () => void;
  /** Ensure a specific time is visible in viewport */
  ensureTimeVisible: (time: number) => void;
  /** Scroll to follow playhead if needed */
  scrollToFollowPlayhead: () => void;
  /** Zoom centered on a specific time */
  zoomToTime: (time: number, zoomIn: boolean) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MIN_ZOOM = 10;
const DEFAULT_MAX_ZOOM = 500;
const DEFAULT_ZOOM_STEP_FACTOR = 1.2;

// =============================================================================
// Hook Implementation
// =============================================================================

export function useTimelineNavigation({
  scrollX,
  zoom,
  duration,
  playheadTime = 0,
  zoomIn,
  zoomOut,
  setZoom,
  setScrollX,
  fitToWindow,
  trackHeaderWidth,
  tracksAreaRef,
  preserveCursorOnZoom = true,
  followPlayhead = false,
  minZoom = DEFAULT_MIN_ZOOM,
  maxZoom = DEFAULT_MAX_ZOOM,
  zoomStepFactor = DEFAULT_ZOOM_STEP_FACTOR,
}: UseTimelineNavigationProps): UseTimelineNavigationResult {
  // Track last mouse position for zoom cursor preservation
  const lastMouseXRef = useRef<number>(0);

  /**
   * Gets the current viewport state for scroll calculations.
   */
  const getViewportState = useCallback((): ViewportState | null => {
    if (!tracksAreaRef?.current) return null;

    const viewportWidth = tracksAreaRef.current.clientWidth - trackHeaderWidth;
    return {
      scrollX,
      zoom,
      viewportWidth,
      duration,
    };
  }, [scrollX, zoom, duration, trackHeaderWidth, tracksAreaRef]);

  // ===========================================================================
  // Wheel Handler with Cursor Preservation
  // ===========================================================================

  /**
   * Handle wheel events for zoom (Ctrl/Meta) and horizontal scroll (Shift).
   * Ctrl/Meta + wheel: zoom in/out with cursor position preservation
   * Shift + wheel: horizontal scroll
   */
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      // Track mouse position for zoom preservation
      lastMouseXRef.current = e.clientX;

      // Ctrl or Meta key: zoom with cursor preservation
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();

        const viewportState = getViewportState();

        // Use enhanced zoom with cursor preservation if available
        if (preserveCursorOnZoom && setZoom && viewportState && tracksAreaRef?.current) {
          const rect = tracksAreaRef.current.getBoundingClientRect();
          const cursorX = e.clientX - rect.left - trackHeaderWidth;

          const zoomDirection = e.deltaY < 0 ? 1 : -1;
          const newZoom = zoom * Math.pow(zoomStepFactor, zoomDirection);
          const clampedZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));

          // Calculate new scroll to preserve cursor position
          const result = zoomWithCursorPreservation(
            zoom,
            clampedZoom,
            cursorX,
            scrollX
          );

          setZoom(result.zoom);
          setScrollX(result.scrollX);
        } else {
          // Fallback to simple zoom in/out
          if (e.deltaY < 0) {
            zoomIn();
          } else {
            zoomOut();
          }
        }
        return;
      }

      // Shift key: horizontal scroll (use deltaY only for consistent behavior)
      if (e.shiftKey) {
        e.preventDefault();
        setScrollX(Math.max(0, scrollX + e.deltaY));
      }
    },
    [
      zoom,
      scrollX,
      zoomIn,
      zoomOut,
      setZoom,
      setScrollX,
      preserveCursorOnZoom,
      zoomStepFactor,
      minZoom,
      maxZoom,
      trackHeaderWidth,
      tracksAreaRef,
      getViewportState,
    ]
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
  // Ensure Time Visible
  // ===========================================================================

  /**
   * Ensures a specific time position is visible in the viewport.
   * Automatically chooses the best scroll mode based on position.
   */
  const ensureTimeVisible = useCallback(
    (time: number) => {
      const viewportState = getViewportState();
      if (!viewportState) return;

      const newScrollX = ensureTimeInViewportAuto(time, viewportState);
      if (newScrollX !== scrollX) {
        setScrollX(newScrollX);
      }
    },
    [scrollX, setScrollX, getViewportState]
  );

  // ===========================================================================
  // Playhead Following
  // ===========================================================================

  /**
   * Scrolls the viewport to follow the playhead if it's approaching the edge.
   * Should be called during playback to keep playhead visible.
   */
  const scrollToFollowPlayhead = useCallback(() => {
    if (!followPlayhead) return;

    const viewportState = getViewportState();
    if (!viewportState) return;

    const newScrollX = calculatePlayheadFollowScroll(playheadTime, viewportState);
    if (newScrollX !== null) {
      setScrollX(newScrollX);
    }
  }, [followPlayhead, playheadTime, setScrollX, getViewportState]);

  // ===========================================================================
  // Zoom to Time
  // ===========================================================================

  /**
   * Zooms in or out centered on a specific time position.
   */
  const zoomToTime = useCallback(
    (time: number, shouldZoomIn: boolean) => {
      if (!setZoom) {
        // Fallback to simple zoom
        if (shouldZoomIn) zoomIn();
        else zoomOut();
        return;
      }

      const viewportState = getViewportState();
      if (!viewportState) return;

      const zoomDirection = shouldZoomIn ? 1 : -1;
      const newZoom = zoom * Math.pow(zoomStepFactor, zoomDirection);
      const clampedZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));

      // Calculate viewport X position for the time
      const timePixelPosition = time * zoom;
      const cursorX = timePixelPosition - scrollX;

      const result = zoomWithCursorPreservation(
        zoom,
        clampedZoom,
        cursorX,
        scrollX
      );

      setZoom(result.zoom);
      setScrollX(result.scrollX);
    },
    [zoom, scrollX, zoomIn, zoomOut, setZoom, setScrollX, zoomStepFactor, minZoom, maxZoom, getViewportState]
  );

  // ===========================================================================
  // Return
  // ===========================================================================

  return {
    handleWheel,
    handleFitToWindow,
    ensureTimeVisible,
    scrollToFollowPlayhead,
    zoomToTime,
  };
}

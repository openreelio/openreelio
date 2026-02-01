/**
 * Timeline Scroll Logic Utilities
 *
 * Provides sophisticated viewport management for the timeline component.
 * Inspired by Remotion's timeline-scroll-logic.ts with adaptations for OpenReelio.
 *
 * Key features:
 * - Frame/time to pixel interpolation with viewport awareness
 * - Multiple cursor positioning modes for smart scrolling
 * - Zoom preservation maintains cursor position during zoom operations
 * - Auto-paging when cursor exits viewport boundaries
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Viewport positioning mode for ensuring a time position is visible.
 */
export type ViewportMode =
  | 'fit-left'    // Position at left edge with margin
  | 'fit-right'   // Position at right edge with margin
  | 'page-left'   // Page left by viewport width
  | 'page-right'  // Page right by viewport width
  | 'center';     // Center the position in viewport

/**
 * Current viewport state for calculations.
 */
export interface ViewportState {
  /** Current horizontal scroll position in pixels */
  scrollX: number;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Viewport width in pixels */
  viewportWidth: number;
  /** Total timeline duration in seconds */
  duration?: number;
}

/**
 * Result of a zoom operation with cursor preservation.
 */
export interface ZoomResult {
  /** New zoom level */
  zoom: number;
  /** New scroll position to maintain cursor position */
  scrollX: number;
}

/**
 * Viewport bounds information.
 */
export interface ViewportBounds {
  /** Start time visible in viewport (seconds) */
  startTime: number;
  /** End time visible in viewport (seconds) */
  endTime: number;
  /** Visible duration (seconds) */
  visibleDuration: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default margin as percentage of viewport width */
const DEFAULT_MARGIN_PERCENT = 0.1;

/** Minimum scroll position */
const MIN_SCROLL = 0;

// =============================================================================
// Core Conversion Functions
// =============================================================================

/**
 * Converts time (seconds) to pixel position.
 *
 * @param time - Time in seconds
 * @param zoom - Zoom level (pixels per second)
 * @returns Pixel position from timeline start
 */
export function timeToPixels(time: number, zoom: number): number {
  return time * zoom;
}

/**
 * Converts pixel position to time (seconds).
 *
 * @param pixels - Pixel position from timeline start
 * @param zoom - Zoom level (pixels per second)
 * @returns Time in seconds
 */
export function pixelsToTime(pixels: number, zoom: number): number {
  if (zoom === 0) return 0;
  return pixels / zoom;
}

/**
 * Gets time position from X coordinate relative to viewport.
 *
 * @param x - X coordinate relative to viewport left edge
 * @param state - Current viewport state
 * @returns Time in seconds
 */
export function getTimeFromViewportX(x: number, state: ViewportState): number {
  return pixelsToTime(state.scrollX + x, state.zoom);
}

/**
 * Gets X coordinate relative to viewport from time position.
 *
 * @param time - Time in seconds
 * @param state - Current viewport state
 * @returns X coordinate relative to viewport left edge
 */
export function getViewportXFromTime(time: number, state: ViewportState): number {
  return timeToPixels(time, state.zoom) - state.scrollX;
}

// =============================================================================
// Viewport Bounds
// =============================================================================

/**
 * Calculates the visible time bounds of the viewport.
 *
 * @param state - Current viewport state
 * @returns Viewport bounds with start/end times
 */
export function getViewportBounds(state: ViewportState): ViewportBounds {
  const startTime = pixelsToTime(state.scrollX, state.zoom);
  const endTime = pixelsToTime(state.scrollX + state.viewportWidth, state.zoom);

  return {
    startTime,
    endTime,
    visibleDuration: endTime - startTime,
  };
}

/**
 * Checks if a time position is visible within the viewport.
 *
 * @param time - Time in seconds to check
 * @param state - Current viewport state
 * @param margin - Optional margin in pixels (default: 0)
 * @returns True if time is within visible bounds
 */
export function isTimeInViewport(
  time: number,
  state: ViewportState,
  margin: number = 0
): boolean {
  const pixelPosition = timeToPixels(time, state.zoom);
  const viewportStart = state.scrollX + margin;
  const viewportEnd = state.scrollX + state.viewportWidth - margin;

  return pixelPosition >= viewportStart && pixelPosition <= viewportEnd;
}

// =============================================================================
// Smart Scrolling
// =============================================================================

/**
 * Calculates scroll offset to ensure a time position is visible in viewport.
 * Supports multiple positioning modes for different use cases.
 *
 * @param time - Time in seconds to ensure is visible
 * @param mode - Positioning mode
 * @param state - Current viewport state
 * @param marginPercent - Margin as percentage of viewport (default: 10%)
 * @returns New scroll position, or current scrollX if already visible
 */
export function ensureTimeInViewport(
  time: number,
  mode: ViewportMode,
  state: ViewportState,
  marginPercent: number = DEFAULT_MARGIN_PERCENT
): number {
  const { scrollX, zoom, viewportWidth } = state;
  const pixelPosition = timeToPixels(time, zoom);
  const margin = viewportWidth * marginPercent;

  // Check if already in viewport (with margin)
  if (isTimeInViewport(time, state, margin)) {
    return scrollX;
  }

  switch (mode) {
    case 'fit-left':
      // Position time at left edge with margin
      return Math.max(MIN_SCROLL, pixelPosition - margin);

    case 'fit-right':
      // Position time at right edge with margin
      return Math.max(MIN_SCROLL, pixelPosition - viewportWidth + margin);

    case 'center':
      // Center time in viewport
      return Math.max(MIN_SCROLL, pixelPosition - viewportWidth / 2);

    case 'page-left':
      // Page left by viewport width (minus margin for overlap)
      return Math.max(MIN_SCROLL, scrollX - viewportWidth + margin);

    case 'page-right':
      // Page right by viewport width (minus margin for overlap)
      return scrollX + viewportWidth - margin;

    default:
      return scrollX;
  }
}

/**
 * Determines the best mode to use for ensuring a time is in viewport.
 * Automatically chooses based on where the time is relative to current view.
 *
 * @param time - Time in seconds
 * @param state - Current viewport state
 * @returns Recommended viewport mode
 */
export function getAutoViewportMode(time: number, state: ViewportState): ViewportMode {
  const bounds = getViewportBounds(state);

  if (time < bounds.startTime) {
    // Time is before viewport - fit at left
    return 'fit-left';
  } else if (time > bounds.endTime) {
    // Time is after viewport - fit at right
    return 'fit-right';
  }

  // Already in viewport
  return 'center';
}

/**
 * Ensures time is in viewport using automatic mode selection.
 *
 * @param time - Time in seconds
 * @param state - Current viewport state
 * @returns New scroll position
 */
export function ensureTimeInViewportAuto(time: number, state: ViewportState): number {
  const mode = getAutoViewportMode(time, state);
  return ensureTimeInViewport(time, mode, state);
}

// =============================================================================
// Zoom with Cursor Preservation
// =============================================================================

/**
 * Calculates new scroll position to preserve cursor position during zoom.
 * Uses UV coordinate correction to maintain visual stability.
 *
 * The algorithm:
 * 1. Convert cursor viewport position to time (using old zoom)
 * 2. Calculate new scroll so cursor remains at same viewport X
 *
 * @param currentZoom - Current zoom level (pixels per second)
 * @param newZoom - Target zoom level
 * @param cursorX - Cursor X position relative to viewport left edge
 * @param scrollX - Current scroll position
 * @returns New zoom and scroll values
 */
export function zoomWithCursorPreservation(
  currentZoom: number,
  newZoom: number,
  cursorX: number,
  scrollX: number
): ZoomResult {
  // Guard against division by zero
  if (currentZoom === 0) {
    return { zoom: newZoom, scrollX };
  }

  // Convert cursor viewport position to timeline time
  const cursorTime = pixelsToTime(scrollX + cursorX, currentZoom);

  // Calculate new scroll to keep cursor at same visual position
  const newCursorPixelPosition = timeToPixels(cursorTime, newZoom);
  const newScrollX = newCursorPixelPosition - cursorX;

  return {
    zoom: newZoom,
    scrollX: Math.max(MIN_SCROLL, newScrollX),
  };
}

/**
 * Zooms centered on a specific time position.
 *
 * @param currentZoom - Current zoom level
 * @param newZoom - Target zoom level
 * @param centerTime - Time to center zoom on
 * @param viewportWidth - Viewport width in pixels
 * @returns New zoom and scroll values
 */
export function zoomCenteredOnTime(
  _currentZoom: number,
  newZoom: number,
  centerTime: number,
  viewportWidth: number
): ZoomResult {
  // Position the center time at viewport center
  const centerPixels = timeToPixels(centerTime, newZoom);
  const newScrollX = centerPixels - viewportWidth / 2;

  return {
    zoom: newZoom,
    scrollX: Math.max(MIN_SCROLL, newScrollX),
  };
}

/**
 * Zooms centered on the playhead position.
 *
 * @param currentZoom - Current zoom level
 * @param newZoom - Target zoom level
 * @param playheadTime - Current playhead time in seconds
 * @param viewportWidth - Viewport width in pixels
 * @param scrollX - Current scroll position
 * @returns New zoom and scroll values
 */
export function zoomCenteredOnPlayhead(
  currentZoom: number,
  newZoom: number,
  playheadTime: number,
  viewportWidth: number,
  scrollX: number
): ZoomResult {
  // Check if playhead is currently in viewport
  const playheadViewportX = getViewportXFromTime(playheadTime, {
    scrollX,
    zoom: currentZoom,
    viewportWidth,
  });

  const isInViewport = playheadViewportX >= 0 && playheadViewportX <= viewportWidth;

  if (isInViewport) {
    // Keep playhead at its current viewport position
    return zoomWithCursorPreservation(currentZoom, newZoom, playheadViewportX, scrollX);
  } else {
    // Center viewport on playhead
    return zoomCenteredOnTime(currentZoom, newZoom, playheadTime, viewportWidth);
  }
}

// =============================================================================
// Fit to Window
// =============================================================================

/**
 * Calculates zoom level to fit entire timeline in viewport.
 *
 * @param duration - Total timeline duration in seconds
 * @param viewportWidth - Viewport width in pixels
 * @param padding - Optional padding on each side (default: 20px)
 * @returns Zoom level to fit timeline
 */
export function calculateFitToWindowZoom(
  duration: number,
  viewportWidth: number,
  padding: number = 20
): number {
  if (duration <= 0 || viewportWidth <= padding * 2) {
    return 100; // Default zoom
  }

  const availableWidth = viewportWidth - padding * 2;
  return availableWidth / duration;
}

/**
 * Calculates zoom and scroll to fit a time range in viewport.
 *
 * @param startTime - Range start in seconds
 * @param endTime - Range end in seconds
 * @param viewportWidth - Viewport width in pixels
 * @param padding - Optional padding on each side (default: 20px)
 * @returns Zoom and scroll values
 */
export function fitTimeRangeToViewport(
  startTime: number,
  endTime: number,
  viewportWidth: number,
  padding: number = 20
): ZoomResult {
  const duration = endTime - startTime;

  if (duration <= 0) {
    return { zoom: 100, scrollX: 0 };
  }

  const zoom = calculateFitToWindowZoom(duration, viewportWidth, padding);
  const scrollX = timeToPixels(startTime, zoom) - padding;

  return {
    zoom,
    scrollX: Math.max(MIN_SCROLL, scrollX),
  };
}

// =============================================================================
// Playhead Following
// =============================================================================

/**
 * Determines if viewport should auto-scroll to follow playhead.
 * Returns new scroll position if scrolling is needed, otherwise null.
 *
 * @param playheadTime - Current playhead time
 * @param state - Current viewport state
 * @param followMargin - Margin before triggering scroll (default: 20% of viewport)
 * @returns New scroll position or null if no scroll needed
 */
export function calculatePlayheadFollowScroll(
  playheadTime: number,
  state: ViewportState,
  followMargin: number = 0.2
): number | null {
  const playheadX = getViewportXFromTime(playheadTime, state);
  const margin = state.viewportWidth * followMargin;

  // Check if playhead is approaching right edge
  if (playheadX > state.viewportWidth - margin) {
    // Scroll to put playhead at left margin
    return timeToPixels(playheadTime, state.zoom) - margin;
  }

  // Check if playhead is before viewport (e.g., after seeking backward)
  if (playheadX < 0) {
    return timeToPixels(playheadTime, state.zoom) - margin;
  }

  return null;
}

// =============================================================================
// Snapping Helpers
// =============================================================================

/**
 * Snaps a time value to the nearest frame boundary.
 *
 * @param time - Time in seconds
 * @param fps - Frames per second
 * @returns Time snapped to nearest frame
 */
export function snapTimeToFrame(time: number, fps: number): number {
  if (fps <= 0) return time;
  const frame = Math.round(time * fps);
  return frame / fps;
}

/**
 * Snaps a pixel position to the nearest frame boundary.
 *
 * @param pixels - Pixel position
 * @param zoom - Zoom level
 * @param fps - Frames per second
 * @returns Pixel position snapped to nearest frame
 */
export function snapPixelsToFrame(pixels: number, zoom: number, fps: number): number {
  const time = pixelsToTime(pixels, zoom);
  const snappedTime = snapTimeToFrame(time, fps);
  return timeToPixels(snappedTime, zoom);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Clamps a value between min and max bounds.
 *
 * @param value - Value to clamp
 * @param min - Minimum bound
 * @param max - Maximum bound
 * @returns Clamped value
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Smoothly interpolates between two zoom levels for animation.
 *
 * @param currentZoom - Current zoom level
 * @param targetZoom - Target zoom level
 * @param t - Interpolation factor (0-1)
 * @returns Interpolated zoom level
 */
export function smoothZoom(currentZoom: number, targetZoom: number, t: number): number {
  // Use exponential interpolation for natural feel
  const logCurrent = Math.log(currentZoom);
  const logTarget = Math.log(targetZoom);
  const logInterpolated = logCurrent + (logTarget - logCurrent) * t;
  return Math.exp(logInterpolated);
}

/**
 * Calculates exponential zoom step for consistent perceptual scaling.
 *
 * @param baseZoom - Current zoom level
 * @param steps - Number of steps (positive = zoom in, negative = zoom out)
 * @param stepFactor - Zoom factor per step (default: 1.2)
 * @returns New zoom level
 */
export function calculateZoomStep(
  baseZoom: number,
  steps: number,
  stepFactor: number = 1.2
): number {
  return baseZoom * Math.pow(stepFactor, steps);
}

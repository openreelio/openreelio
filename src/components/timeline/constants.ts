/**
 * Timeline Constants
 *
 * Centralized constants for timeline component dimensions and settings.
 * Eliminates magic numbers and ensures consistency across components.
 */

// =============================================================================
// Dimension Constants
// =============================================================================

/** Width of track header in pixels (w-48 = 12rem = 192px) */
export const TRACK_HEADER_WIDTH = 192;

/** Height of each track in pixels (h-16 = 4rem = 64px) */
export const TRACK_HEIGHT = 64;

// =============================================================================
// Timeline Settings
// =============================================================================

/** Default timeline duration in seconds when no clips exist */
export const DEFAULT_TIMELINE_DURATION = 60;

/** Default frames per second for timeline */
export const DEFAULT_FPS = 30;

// =============================================================================
// Zoom Constants
// =============================================================================

/** Minimum zoom level (pixels per second) */
export const MIN_ZOOM = 10;

/** Maximum zoom level (pixels per second) */
export const MAX_ZOOM = 500;

/** Default zoom level (pixels per second) */
export const DEFAULT_ZOOM = 100;

/** Zoom step multiplier */
export const ZOOM_STEP = 1.2;

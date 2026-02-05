/**
 * Editing Constants
 *
 * Centralized constants for editing operations.
 * No magic numbers - all values defined here with documentation.
 *
 * @module constants/editing
 */

// =============================================================================
// Snapping Constants
// =============================================================================

/** Distance in pixels to detect snap targets */
export const SNAP_THRESHOLD_PX = 10;

/** Distance in pixels for magnetic snap effect */
export const MAGNETIC_SNAP_DISTANCE_PX = 5;

/** Types of snap targets (matching SnapPointType from types) */
export const SNAP_TARGETS = ['playhead', 'clip-start', 'clip-end', 'marker', 'grid'] as const;
export type SnapTarget = (typeof SNAP_TARGETS)[number];

// =============================================================================
// Clipboard Constants
// =============================================================================

/** Maximum number of items in clipboard */
export const MAX_CLIPBOARD_ITEMS = 100;

/** Clipboard expiry time in milliseconds (1 hour) */
export const CLIPBOARD_EXPIRY_MS = 3600000;

// =============================================================================
// Trim & Edit Constants
// =============================================================================

/** Minimum clip duration in seconds */
export const MIN_CLIP_DURATION_SEC = 0.1;

/** Edge detection distance in pixels for trim handles */
export const EDGE_DETECTION_PX = 4;

/** Edge threshold for razor split (prevent split too close to edge) */
export const RAZOR_EDGE_THRESHOLD_SEC = 0.1;

// =============================================================================
// Ripple Edit Constants
// =============================================================================

/** Animation duration for ripple operations in milliseconds */
export const RIPPLE_ANIMATION_MS = 150;

/** Minimum gap between clips in ripple mode (seconds) */
export const MIN_CLIP_GAP_SEC = 0;

// =============================================================================
// Tool Constants
// =============================================================================

/** Delay before cursor change takes effect (prevents flicker) */
export const CURSOR_CHANGE_DELAY_MS = 50;

/** Double-click threshold in milliseconds */
export const DOUBLE_CLICK_THRESHOLD_MS = 300;

// =============================================================================
// Keyboard Shortcut Constants
// =============================================================================

/** Modifier keys */
export const MODIFIER_KEYS = ['ctrl', 'shift', 'alt', 'meta'] as const;
export type ModifierKey = (typeof MODIFIER_KEYS)[number];

/** Shortcut categories */
export const SHORTCUT_CATEGORIES = [
  'playback',
  'navigation',
  'editing',
  'tools',
  'selection',
  'view',
  'file',
  'multicam',
] as const;
export type ShortcutCategory = (typeof SHORTCUT_CATEGORIES)[number];

// =============================================================================
// Timeline Constants
// =============================================================================

/** Default track header width in pixels */
export const DEFAULT_TRACK_HEADER_WIDTH = 192;

/** Default track height in pixels */
export const DEFAULT_TRACK_HEIGHT = 48;

/** Minimum zoom level (pixels per second) */
export const MIN_ZOOM = 10;

/** Maximum zoom level (pixels per second) */
export const MAX_ZOOM = 500;

/** Default zoom level (pixels per second) */
export const DEFAULT_ZOOM = 100;

// =============================================================================
// Playback Constants
// =============================================================================

/** Shuttle speeds for J/K/L control */
export const SHUTTLE_SPEEDS = [-8, -4, -2, -1, 0, 1, 2, 4, 8] as const;

/** Default playback speed */
export const DEFAULT_PLAYBACK_SPEED = 1;

/** Frame step amount in seconds (for 30fps) */
export const FRAME_STEP_SEC = 1 / 30;

/** Seek step for arrow keys in seconds */
export const SEEK_STEP_SEC = 1;

/** Large seek step for Shift+arrow in seconds */
export const LARGE_SEEK_STEP_SEC = 5;

// =============================================================================
// Auto-Follow Constants
// =============================================================================

/** Default margin from edge for auto-follow (20% of viewport) */
export const AUTO_FOLLOW_EDGE_MARGIN = 0.2;

/** Scroll throttle time in milliseconds (~60fps) */
export const SCROLL_THROTTLE_MS = 16;

/** Scroll smoothing factor (higher = faster) */
export const SCROLL_SMOOTHING = 0.15;

// =============================================================================
// Export all constants as a single object for convenience
// =============================================================================

export const EDITING_CONSTANTS = {
  // Snapping
  SNAP_THRESHOLD_PX,
  MAGNETIC_SNAP_DISTANCE_PX,
  SNAP_TARGETS,

  // Clipboard
  MAX_CLIPBOARD_ITEMS,
  CLIPBOARD_EXPIRY_MS,

  // Trim & Edit
  MIN_CLIP_DURATION_SEC,
  EDGE_DETECTION_PX,
  RAZOR_EDGE_THRESHOLD_SEC,

  // Ripple
  RIPPLE_ANIMATION_MS,
  MIN_CLIP_GAP_SEC,

  // Tools
  CURSOR_CHANGE_DELAY_MS,
  DOUBLE_CLICK_THRESHOLD_MS,

  // Keyboard
  MODIFIER_KEYS,
  SHORTCUT_CATEGORIES,

  // Timeline
  DEFAULT_TRACK_HEADER_WIDTH,
  DEFAULT_TRACK_HEIGHT,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,

  // Playback
  SHUTTLE_SPEEDS,
  DEFAULT_PLAYBACK_SPEED,
  FRAME_STEP_SEC,
  SEEK_STEP_SEC,
  LARGE_SEEK_STEP_SEC,

  // Auto-Follow
  AUTO_FOLLOW_EDGE_MARGIN,
  SCROLL_THROTTLE_MS,
  SCROLL_SMOOTHING,
} as const;

export default EDITING_CONSTANTS;

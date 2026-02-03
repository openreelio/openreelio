/**
 * Motion Tracking Utility
 *
 * Provides definitions and utilities for motion tracking.
 * Supports point tracking, region tracking, and planar tracking.
 *
 * @module utils/motionTracking
 */

import { nanoid } from 'nanoid';

// =============================================================================
// Types
// =============================================================================

/**
 * Available tracking methods
 */
export type TrackingMethod = 'point' | 'region' | 'planar';

/**
 * Tracking method definition
 */
export interface TrackingMethodDef {
  /** Display label */
  label: string;
  /** Human-readable description */
  description: string;
}

/**
 * A tracked point position at a specific time
 */
export interface TrackKeyframe {
  /** Time in seconds */
  time: number;
  /** X position */
  x: number;
  /** Y position */
  y: number;
  /** Tracking confidence (0-1) */
  confidence: number;
  /** Optional scale factor */
  scale?: number;
  /** Optional rotation in degrees */
  rotation?: number;
}

/**
 * A single track point
 */
export interface TrackPoint {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Initial X position */
  x: number;
  /** Initial Y position */
  y: number;
  /** Keyframes with tracked positions */
  keyframes: TrackKeyframe[];
  /** Whether this track point is enabled */
  enabled: boolean;
  /** Color for visualization */
  color: string;
}

/**
 * A tracked rectangular region
 */
export interface TrackRegion {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** X position of top-left corner */
  x: number;
  /** Y position of top-left corner */
  y: number;
  /** Width of the region */
  width: number;
  /** Height of the region */
  height: number;
  /** Keyframes with tracked positions */
  keyframes: TrackKeyframe[];
  /** Whether this region is enabled */
  enabled: boolean;
  /** Color for visualization */
  color: string;
}

/**
 * Tracking settings
 */
export interface TrackingSettings {
  /** Tracking method to use */
  method: TrackingMethod;
  /** Size of the search area in pixels */
  searchAreaSize: number;
  /** Size of the pattern/feature to track in pixels */
  patternSize: number;
  /** Minimum confidence threshold (0-1) */
  confidenceThreshold: number;
  /** Whether to track backwards */
  trackBackwards: boolean;
  /** Subpixel accuracy */
  subpixelAccuracy: boolean;
}

/**
 * A complete motion track for a clip
 */
export interface MotionTrack {
  /** Unique identifier */
  id: string;
  /** ID of the clip this track belongs to */
  clipId: string;
  /** Track points */
  points: TrackPoint[];
  /** Track regions */
  regions: TrackRegion[];
  /** Tracking settings */
  settings: TrackingSettings;
  /** Whether the track is locked (no modifications) */
  locked: boolean;
  /** Creation timestamp */
  createdAt: string;
}

/**
 * 2D transform properties
 */
export interface Transform2D {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

/**
 * Interpolated track data
 */
export interface InterpolatedTrackData {
  x: number;
  y: number;
  confidence: number;
  scale?: number;
  rotation?: number;
}

/**
 * Track bounds result
 */
export interface TrackBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Options for applying track to transform
 */
export interface ApplyTrackOptions {
  applyPosition: boolean;
  applyScale?: boolean;
  applyRotation?: boolean;
  offsetX?: number;
  offsetY?: number;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * All tracking methods
 */
export const ALL_TRACKING_METHODS: readonly TrackingMethod[] = [
  'point',
  'region',
  'planar',
] as const;

/**
 * Tracking method definitions
 */
export const TRACKING_METHODS: Record<TrackingMethod, TrackingMethodDef> = {
  point: {
    label: 'Point Tracking',
    description:
      'Track a single point feature across frames. Best for tracking distinct corners or high-contrast points.',
  },
  region: {
    label: 'Region Tracking',
    description:
      'Track a rectangular region across frames. Useful for tracking objects with consistent patterns.',
  },
  planar: {
    label: 'Planar Tracking',
    description:
      'Track a planar surface with perspective correction. Best for screens, signs, or flat surfaces.',
  },
};

/**
 * Default tracking settings
 */
export const DEFAULT_TRACKING_SETTINGS: TrackingSettings = {
  method: 'point',
  searchAreaSize: 100,
  patternSize: 25,
  confidenceThreshold: 0.75,
  trackBackwards: false,
  subpixelAccuracy: true,
};

/**
 * Default track point values
 */
export const DEFAULT_TRACK_POINT: Pick<TrackPoint, 'x' | 'y'> = {
  x: 0,
  y: 0,
};

/**
 * Default colors for track points
 */
export const TRACK_COLORS: readonly string[] = [
  '#FF6B6B', // Red
  '#4ECDC4', // Teal
  '#45B7D1', // Blue
  '#96CEB4', // Green
  '#FFEAA7', // Yellow
  '#DDA0DD', // Plum
  '#98D8C8', // Mint
  '#F7DC6F', // Gold
] as const;

/**
 * Color index manager for deterministic color assignment.
 * Encapsulates state to avoid global mutation issues.
 */
class ColorIndexManager {
  private index = 0;

  /**
   * Get the next color in the sequence
   */
  getNext(): string {
    const color = TRACK_COLORS[this.index % TRACK_COLORS.length];
    this.index++;
    return color;
  }

  /**
   * Get a color at a specific index (deterministic)
   */
  getAtIndex(index: number): string {
    return TRACK_COLORS[Math.abs(index) % TRACK_COLORS.length];
  }

  /**
   * Reset the color index to the beginning
   */
  reset(): void {
    this.index = 0;
  }

  /**
   * Get current index (for debugging/testing)
   */
  getCurrentIndex(): number {
    return this.index;
  }
}

/**
 * Singleton color manager instance.
 * Use resetColorIndex() in tests for deterministic behavior.
 */
const colorManager = new ColorIndexManager();

/**
 * Get the next track color in sequence.
 * Colors cycle through TRACK_COLORS array.
 */
function getNextColor(): string {
  return colorManager.getNext();
}

/**
 * Get a color at a specific index (deterministic, for testing)
 */
export function getColorAtIndex(index: number): string {
  return colorManager.getAtIndex(index);
}

/**
 * Reset the color index to zero.
 * Call this in test setup for deterministic color assignment.
 */
export function resetColorIndex(): void {
  colorManager.reset();
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a new track point
 */
export function createTrackPoint(
  x: number,
  y: number,
  options?: { name?: string; color?: string }
): TrackPoint {
  return {
    id: nanoid(),
    name: options?.name ?? `Point ${Date.now() % 1000}`,
    x,
    y,
    keyframes: [],
    enabled: true,
    color: options?.color ?? getNextColor(),
  };
}

/**
 * Create a new track region
 */
export function createTrackRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  options?: { name?: string; color?: string }
): TrackRegion {
  return {
    id: nanoid(),
    name: options?.name ?? `Region ${Date.now() % 1000}`,
    x,
    y,
    width,
    height,
    keyframes: [],
    enabled: true,
    color: options?.color ?? getNextColor(),
  };
}

/**
 * Create a new motion track for a clip
 */
export function createMotionTrack(
  clipId: string,
  options?: { settings?: TrackingSettings }
): MotionTrack {
  return {
    id: nanoid(),
    clipId,
    points: [],
    regions: [],
    settings: options?.settings ?? { ...DEFAULT_TRACKING_SETTINGS },
    locked: false,
    createdAt: new Date().toISOString(),
  };
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Check if a track point is valid
 */
export function isValidTrackPoint(point: TrackPoint | null | undefined): boolean {
  if (!point) return false;
  if (typeof point.x !== 'number' || isNaN(point.x)) return false;
  if (typeof point.y !== 'number' || isNaN(point.y)) return false;
  if (!point.id) return false;
  return true;
}

/**
 * Check if a track region is valid
 */
export function isValidTrackRegion(region: TrackRegion | null | undefined): boolean {
  if (!region) return false;
  if (typeof region.x !== 'number' || isNaN(region.x)) return false;
  if (typeof region.y !== 'number' || isNaN(region.y)) return false;
  if (typeof region.width !== 'number' || region.width <= 0) return false;
  if (typeof region.height !== 'number' || region.height <= 0) return false;
  if (!region.id) return false;
  return true;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the display label for a tracking method
 */
export function getTrackingMethodLabel(method: TrackingMethod): string {
  return TRACKING_METHODS[method]?.label ?? method;
}

/**
 * Get the description for a tracking method
 */
export function getTrackingMethodDescription(method: TrackingMethod): string {
  return TRACKING_METHODS[method]?.description ?? '';
}

/**
 * Interpolate track data at a given time
 */
export function interpolateTrackData(
  keyframes: TrackKeyframe[],
  time: number
): InterpolatedTrackData | null {
  if (keyframes.length === 0) return null;

  // Sort keyframes by time
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);

  // Before first keyframe
  if (time <= sorted[0].time) {
    const kf = sorted[0];
    return {
      x: kf.x,
      y: kf.y,
      confidence: kf.confidence,
      scale: kf.scale,
      rotation: kf.rotation,
    };
  }

  // After last keyframe
  if (time >= sorted[sorted.length - 1].time) {
    const kf = sorted[sorted.length - 1];
    return {
      x: kf.x,
      y: kf.y,
      confidence: kf.confidence,
      scale: kf.scale,
      rotation: kf.rotation,
    };
  }

  // Find surrounding keyframes
  let prevKf = sorted[0];
  let nextKf = sorted[1];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time >= time) {
      prevKf = sorted[i - 1];
      nextKf = sorted[i];
      break;
    }
  }

  // Linear interpolation
  const t = (time - prevKf.time) / (nextKf.time - prevKf.time);
  return {
    x: prevKf.x + (nextKf.x - prevKf.x) * t,
    y: prevKf.y + (nextKf.y - prevKf.y) * t,
    confidence: prevKf.confidence + (nextKf.confidence - prevKf.confidence) * t,
    scale:
      prevKf.scale !== undefined && nextKf.scale !== undefined
        ? prevKf.scale + (nextKf.scale - prevKf.scale) * t
        : undefined,
    rotation:
      prevKf.rotation !== undefined && nextKf.rotation !== undefined
        ? prevKf.rotation + (nextKf.rotation - prevKf.rotation) * t
        : undefined,
  };
}

/**
 * Calculate the bounds of tracked positions
 */
export function calculateTrackBounds(
  keyframes: TrackKeyframe[]
): TrackBounds | null {
  if (keyframes.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const kf of keyframes) {
    if (kf.x < minX) minX = kf.x;
    if (kf.x > maxX) maxX = kf.x;
    if (kf.y < minY) minY = kf.y;
    if (kf.y > maxY) maxY = kf.y;
  }

  return { minX, maxX, minY, maxY };
}

/**
 * Apply track data to a transform
 */
export function applyTrackToTransform(
  trackData: InterpolatedTrackData,
  baseTransform: Transform2D,
  options: ApplyTrackOptions
): Transform2D {
  const result = { ...baseTransform };

  if (options.applyPosition) {
    const offsetX = options.offsetX ?? 0;
    const offsetY = options.offsetY ?? 0;
    result.x = trackData.x + offsetX;
    result.y = trackData.y + offsetY;
  }

  if (options.applyScale && trackData.scale !== undefined) {
    result.scaleX = baseTransform.scaleX * trackData.scale;
    result.scaleY = baseTransform.scaleY * trackData.scale;
  }

  if (options.applyRotation && trackData.rotation !== undefined) {
    result.rotation = baseTransform.rotation + trackData.rotation;
  }

  return result;
}

/**
 * Check if a tracking method is valid
 */
export function isValidTrackingMethod(
  value: unknown
): value is TrackingMethod {
  if (typeof value !== 'string') return false;
  return ALL_TRACKING_METHODS.includes(value as TrackingMethod);
}

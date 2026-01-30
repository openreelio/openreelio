/**
 * Keyframe Interpolation Utilities
 *
 * Provides interpolation functions for animating parameter values between keyframes.
 * Supports various easing functions including linear, ease-in, ease-out, and bezier curves.
 *
 * Security: All numeric inputs are validated against NaN/Infinity to prevent
 * injection of invalid values that could corrupt rendering or cause crashes.
 */

import type { Keyframe, ParamValue, Easing } from '@/types';
import { evaluateCubicBezier, BEZIER_PRESETS, type BezierPoints } from './bezierCurve';

// =============================================================================
// Types
// =============================================================================

/** Simple value type after interpolation */
export type InterpolatedValue =
  | number
  | boolean
  | string
  | [number, number, number, number] // RGBA color
  | [number, number]; // Point or Range

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validates that a numeric value is finite (not NaN or Infinity).
 * Returns true if valid, false otherwise.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Clamps a value to a safe range and ensures it's finite.
 * Returns fallback for invalid inputs to prevent propagation of NaN/Infinity.
 */
function safeNumber(value: number, fallback: number = 0): number {
  if (!isFiniteNumber(value)) {
    return fallback;
  }
  return value;
}

/**
 * Type guard for validating ParamValue structure at runtime.
 * Ensures the value property exists and matches the declared type.
 */
function isValidParamValue(pv: unknown): pv is { type: string; value: unknown } {
  return (
    typeof pv === 'object' &&
    pv !== null &&
    'type' in pv &&
    'value' in pv &&
    typeof (pv as { type: unknown }).type === 'string'
  );
}

/**
 * Safely extracts numeric value from ParamValue with validation.
 * Returns fallback if value is invalid or not a number.
 */
function safeNumericValue(pv: unknown, fallback: number): number {
  if (!isValidParamValue(pv)) return fallback;
  const val = pv.value;
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

/**
 * Safely extracts color array from ParamValue with validation.
 * Returns null if invalid, allowing caller to handle fallback.
 */
function safeColorValue(pv: unknown): [number, number, number, number] | null {
  if (!isValidParamValue(pv)) return null;
  const val = pv.value;
  if (!Array.isArray(val) || val.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    if (typeof val[i] !== 'number' || !Number.isFinite(val[i])) return null;
  }
  return val as [number, number, number, number];
}

/**
 * Safely extracts point/range array from ParamValue with validation.
 * Returns null if invalid, allowing caller to handle fallback.
 */
function safeTupleValue(pv: unknown): [number, number] | null {
  if (!isValidParamValue(pv)) return null;
  const val = pv.value;
  if (!Array.isArray(val) || val.length !== 2) return null;
  if (typeof val[0] !== 'number' || !Number.isFinite(val[0])) return null;
  if (typeof val[1] !== 'number' || !Number.isFinite(val[1])) return null;
  return val as [number, number];
}

/** Options for getValueAtTime */
export interface InterpolationOptions {
  /** Default value to return if no keyframes exist */
  defaultValue?: InterpolatedValue;
}

/** Easing function type */
export type EasingFunction = (t: number) => number;

// =============================================================================
// Easing Functions
// =============================================================================

/**
 * Collection of easing functions for keyframe interpolation.
 * Each function takes a normalized time value (0-1) and returns a normalized output (0-1).
 */
export const easingFunctions: Record<Easing, EasingFunction> = {
  /**
   * Linear interpolation - constant rate of change
   */
  linear: (t: number): number => t,

  /**
   * Ease In - starts slow, accelerates
   * Uses quadratic curve: t^2
   */
  ease_in: (t: number): number => t * t,

  /**
   * Ease Out - starts fast, decelerates
   * Uses quadratic curve: 1 - (1-t)^2
   */
  ease_out: (t: number): number => 1 - (1 - t) * (1 - t),

  /**
   * Ease In Out - starts slow, accelerates, then decelerates
   * Uses smoothstep function
   */
  ease_in_out: (t: number): number => {
    if (t < 0.5) {
      return 2 * t * t;
    }
    return 1 - Math.pow(-2 * t + 2, 2) / 2;
  },

  /**
   * Step - holds at 0 until the very end, then jumps to 1
   * Used for discrete transitions
   */
  step: (t: number): number => (t >= 1 ? 1 : 0),

  /**
   * Hold - always returns 0, effectively holding the previous value
   * The next keyframe's value is only used when we reach the exact keyframe time
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  hold: (_t: number): number => 0,

  /**
   * Cubic Bezier - default ease curve
   * Uses CSS standard ease curve: cubic-bezier(0.25, 0.1, 0.25, 1.0)
   * For custom control points, use getEasingFunctionWithBezier()
   */
  cubic_bezier: (t: number): number => {
    return evaluateCubicBezier(t, BEZIER_PRESETS.ease as BezierPoints);
  },
};

/**
 * Get the easing function for a keyframe, using custom Bezier points if available.
 *
 * @param keyframe - The keyframe containing easing information
 * @returns Easing function that takes t (0-1) and returns eased value
 */
export function getKeyframeEasingFunction(keyframe: Keyframe): EasingFunction {
  const { easing, bezierPoints } = keyframe;

  // For cubic_bezier with custom control points, create a custom easing function
  if (easing === 'cubic_bezier' && bezierPoints && bezierPoints.length === 4) {
    // Validate control points
    const [x1, y1, x2, y2] = bezierPoints;
    if (
      Number.isFinite(x1) && Number.isFinite(y1) &&
      Number.isFinite(x2) && Number.isFinite(y2) &&
      x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1
    ) {
      return (t: number) => evaluateCubicBezier(t, bezierPoints as BezierPoints);
    }
  }

  // Use standard easing function
  return easingFunctions[easing] ?? easingFunctions.linear;
}

// =============================================================================
// Value Interpolation
// =============================================================================

/**
 * Interpolate between two parameter values.
 *
 * Security: All numeric outputs are validated to prevent NaN/Infinity propagation.
 * Type mismatches between from/to are handled gracefully by returning the from value.
 *
 * @param from - Starting value
 * @param to - Ending value
 * @param t - Interpolation factor (0-1, can be eased)
 * @returns Interpolated value
 */
export function interpolateValue(
  from: ParamValue,
  to: ParamValue,
  t: number
): InterpolatedValue {
  // Validate input t and clamp to [0, 1]
  const clampedT = Math.max(0, Math.min(1, safeNumber(t, 0)));

  // Critical: Validate that both values are valid ParamValue objects
  // This prevents crashes when keyframes have null/undefined values
  if (!isValidParamValue(from)) {
    if (isValidParamValue(to)) {
      // from is invalid, to is valid - use to's value
      return extractValue(to as ParamValue);
    }
    // Both invalid - return safe default
    return 0;
  }

  if (!isValidParamValue(to)) {
    // to is invalid, from is valid - use from's value
    return extractValue(from);
  }

  // Type mismatch guard: if from and to types differ, return from value
  if (from.type !== to.type) {
    return from.value as InterpolatedValue;
  }

  switch (from.type) {
    case 'float': {
      const fromVal = safeNumericValue(from, 0);
      const toVal = safeNumericValue(to, fromVal);
      const result = fromVal + (toVal - fromVal) * clampedT;
      return safeNumber(result, fromVal);
    }

    case 'int': {
      const fromVal = safeNumericValue(from, 0);
      const toVal = safeNumericValue(to, fromVal);
      const interpolated = fromVal + (toVal - fromVal) * clampedT;
      return Math.round(safeNumber(interpolated, fromVal));
    }

    case 'bool': {
      // Boolean: switch at midpoint; validate both are actually boolean
      const fromBool = typeof from.value === 'boolean' ? from.value : false;
      const toBool = typeof to.value === 'boolean' ? to.value : fromBool;
      return clampedT < 0.5 ? fromBool : toBool;
    }

    case 'string': {
      // String: switch at midpoint (no interpolation possible); validate types
      const fromStr = typeof from.value === 'string' ? from.value : '';
      const toStr = typeof to.value === 'string' ? to.value : fromStr;
      return clampedT < 0.5 ? fromStr : toStr;
    }

    case 'color': {
      // Interpolate each RGBA component with strict validation
      const fromColor = safeColorValue(from);
      const toColor = safeColorValue(to);

      // Fallback to default color if validation fails
      if (!fromColor) {
        return [0, 0, 0, 255];
      }
      if (!toColor) {
        return fromColor;
      }

      return [
        Math.round(Math.max(0, Math.min(255, fromColor[0] + (toColor[0] - fromColor[0]) * clampedT))),
        Math.round(Math.max(0, Math.min(255, fromColor[1] + (toColor[1] - fromColor[1]) * clampedT))),
        Math.round(Math.max(0, Math.min(255, fromColor[2] + (toColor[2] - fromColor[2]) * clampedT))),
        Math.round(Math.max(0, Math.min(255, fromColor[3] + (toColor[3] - fromColor[3]) * clampedT))),
      ];
    }

    case 'point': {
      // Interpolate x and y with strict validation
      const fromPoint = safeTupleValue(from);
      const toPoint = safeTupleValue(to);

      // Fallback to origin if validation fails
      if (!fromPoint) {
        return [0, 0];
      }
      if (!toPoint) {
        return fromPoint;
      }

      return [
        fromPoint[0] + (toPoint[0] - fromPoint[0]) * clampedT,
        fromPoint[1] + (toPoint[1] - fromPoint[1]) * clampedT,
      ];
    }

    case 'range': {
      // Interpolate min and max with strict validation
      const fromRange = safeTupleValue(from);
      const toRange = safeTupleValue(to);

      // Fallback to [0, 1] if validation fails
      if (!fromRange) {
        return [0, 1];
      }
      if (!toRange) {
        return fromRange;
      }

      return [
        fromRange[0] + (toRange[0] - fromRange[0]) * clampedT,
        fromRange[1] + (toRange[1] - fromRange[1]) * clampedT,
      ];
    }

    default: {
      // Unknown type - attempt safe extraction with fallback
      // Cast to unknown first to bypass TypeScript's exhaustiveness check
      const unknownFrom = from as unknown as { value?: unknown };
      if (unknownFrom && typeof unknownFrom.value !== 'undefined') {
        return unknownFrom.value as InterpolatedValue;
      }
      return 0;
    }
  }
}

// =============================================================================
// Keyframe Value Lookup
// =============================================================================

/**
 * Sort keyframes by time offset (ascending).
 */
function sortKeyframes(keyframes: Keyframe[]): Keyframe[] {
  return [...keyframes].sort((a, b) => a.timeOffset - b.timeOffset);
}

/**
 * Get the interpolated value at a specific time from a keyframe array.
 *
 * Security: Validates time input and handles edge cases like zero-duration segments
 * to prevent division by zero or NaN propagation.
 *
 * @param keyframes - Array of keyframes (will be sorted internally)
 * @param time - Time in seconds to get value at
 * @param options - Interpolation options
 * @returns Interpolated value or undefined if no keyframes
 */
export function getValueAtTime(
  keyframes: Keyframe[],
  time: number,
  options: InterpolationOptions = {}
): InterpolatedValue | undefined {
  // Validate keyframes array
  if (!Array.isArray(keyframes) || keyframes.length === 0) {
    return options.defaultValue;
  }

  // Validate and sanitize time input
  // For Infinity, use MAX_SAFE_INTEGER to get the last keyframe
  // For -Infinity, use MIN_SAFE_INTEGER to get the first keyframe
  let safeTime: number;
  if (time === Infinity) {
    safeTime = Number.MAX_SAFE_INTEGER;
  } else if (time === -Infinity) {
    safeTime = Number.MIN_SAFE_INTEGER;
  } else {
    safeTime = safeNumber(time, 0);
  }

  // Sort keyframes by time
  const sorted = sortKeyframes(keyframes);

  // Handle single keyframe
  if (sorted.length === 1) {
    return extractValue(sorted[0].value);
  }

  // Before first keyframe
  const firstTime = safeNumber(sorted[0].timeOffset, 0);
  if (safeTime <= firstTime) {
    return extractValue(sorted[0].value);
  }

  // After last keyframe
  const lastTime = safeNumber(sorted[sorted.length - 1].timeOffset, 0);
  if (safeTime >= lastTime) {
    return extractValue(sorted[sorted.length - 1].value);
  }

  // Find the two keyframes we're between using binary search for better performance
  let fromIndex = 0;
  let low = 0;
  let high = sorted.length - 2;

  // Binary search for the segment containing safeTime
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const midTime = safeNumber(sorted[mid].timeOffset, 0);
    const nextTime = safeNumber(sorted[mid + 1].timeOffset, 0);

    if (safeTime >= midTime && safeTime < nextTime) {
      fromIndex = mid;
      break;
    } else if (safeTime < midTime) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  // Critical bounds check: ensure fromIndex and fromIndex+1 are valid indices
  // This guards against edge cases where binary search may not find exact match
  if (fromIndex < 0) {
    fromIndex = 0;
  }
  if (fromIndex >= sorted.length - 1) {
    // At or past last keyframe - return last keyframe value
    return extractValue(sorted[sorted.length - 1].value);
  }

  const fromKf = sorted[fromIndex];
  const toKf = sorted[fromIndex + 1];

  // Defensive: verify both keyframes exist (should always be true after bounds check)
  if (!fromKf || !toKf) {
    return extractValue(sorted[0].value);
  }

  const fromTime = safeNumber(fromKf.timeOffset, 0);
  const toTime = safeNumber(toKf.timeOffset, 0);

  // Exact match on keyframe time (with epsilon tolerance for floating point)
  const EPSILON = 1e-9;
  if (Math.abs(safeTime - fromTime) < EPSILON) {
    return extractValue(fromKf.value);
  }
  if (Math.abs(safeTime - toTime) < EPSILON) {
    return extractValue(toKf.value);
  }

  // Calculate normalized time within this segment
  const segmentDuration = toTime - fromTime;

  // Guard against zero-duration segments (division by zero)
  if (segmentDuration <= EPSILON) {
    return extractValue(fromKf.value);
  }

  const normalizedTime = (safeTime - fromTime) / segmentDuration;

  // Apply easing function (with support for custom Bezier control points)
  const easingFn = getKeyframeEasingFunction(fromKf);
  const easedTime = safeNumber(easingFn(normalizedTime), normalizedTime);

  // Interpolate value
  return interpolateValue(fromKf.value, toKf.value, easedTime);
}

/**
 * Extract the raw value from a ParamValue with validation.
 * Returns a safe default if the value is malformed.
 */
function extractValue(paramValue: ParamValue): InterpolatedValue {
  if (!isValidParamValue(paramValue)) {
    return 0;
  }

  const { type, value } = paramValue;

  // Type-specific validation and extraction
  switch (type) {
    case 'float':
    case 'int':
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    case 'bool':
      return typeof value === 'boolean' ? value : false;
    case 'string':
      return typeof value === 'string' ? value : '';
    case 'color': {
      const color = safeColorValue(paramValue);
      return color ?? [0, 0, 0, 255];
    }
    case 'point':
    case 'range': {
      const tuple = safeTupleValue(paramValue);
      return tuple ?? [0, 0];
    }
    default:
      // Attempt direct return for unknown types with basic validation
      if (value !== null && value !== undefined) {
        return value as InterpolatedValue;
      }
      return 0;
  }
}

// =============================================================================
// Additional Utilities
// =============================================================================

/**
 * Find all keyframes within a time range.
 *
 * @param keyframes - Array of keyframes
 * @param startTime - Range start (inclusive)
 * @param endTime - Range end (inclusive)
 * @returns Keyframes within the range
 */
export function getKeyframesInRange(
  keyframes: Keyframe[],
  startTime: number,
  endTime: number
): Keyframe[] {
  return keyframes.filter(
    (kf) => kf.timeOffset >= startTime && kf.timeOffset <= endTime
  );
}

/**
 * Check if a keyframe exists at a specific time.
 *
 * @param keyframes - Array of keyframes
 * @param time - Time to check
 * @param tolerance - Time tolerance for matching (default 0.001s = 1ms)
 * @returns True if a keyframe exists at that time
 */
export function hasKeyframeAtTime(
  keyframes: Keyframe[],
  time: number,
  tolerance: number = 0.001
): boolean {
  return keyframes.some(
    (kf) => Math.abs(kf.timeOffset - time) <= tolerance
  );
}

/**
 * Get the keyframe at a specific time.
 *
 * @param keyframes - Array of keyframes
 * @param time - Time to find
 * @param tolerance - Time tolerance for matching (default 0.001s = 1ms)
 * @returns Keyframe at that time or undefined
 */
export function getKeyframeAtTime(
  keyframes: Keyframe[],
  time: number,
  tolerance: number = 0.001
): Keyframe | undefined {
  return keyframes.find(
    (kf) => Math.abs(kf.timeOffset - time) <= tolerance
  );
}

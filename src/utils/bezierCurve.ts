/**
 * Bezier Curve Utilities
 *
 * Provides cubic Bezier curve evaluation for keyframe easing.
 * Implements CSS cubic-bezier() timing function specification.
 *
 * A cubic Bezier curve is defined by four control points:
 * - P0 (0, 0) - Start point (implicit)
 * - P1 (x1, y1) - First control point
 * - P2 (x2, y2) - Second control point
 * - P3 (1, 1) - End point (implicit)
 *
 * The x-axis represents input time (0-1), y-axis represents output progress (0-1).
 * Note: y values can go outside 0-1 for overshoot/anticipation effects.
 */

// =============================================================================
// Types
// =============================================================================

/** Bezier control points: [x1, y1, x2, y2] */
export type BezierPoints = [number, number, number, number];

/** Easing function signature */
export type EasingFn = (t: number) => number;

// =============================================================================
// Validation
// =============================================================================

/**
 * Validates that input is a valid BezierPoints array.
 * - Must be an array of exactly 4 numbers
 * - All values must be finite numbers
 * - x1 and x2 must be in range [0, 1]
 * - y1 and y2 can be any finite number (allows overshoot)
 */
export function isValidBezierPoints(input: unknown): input is BezierPoints {
  if (!Array.isArray(input) || input.length !== 4) {
    return false;
  }

  // Check all values are finite numbers
  for (let i = 0; i < 4; i++) {
    if (typeof input[i] !== 'number' || !Number.isFinite(input[i])) {
      return false;
    }
  }

  const [x1, , x2] = input as number[];

  // X values must be in [0, 1] range for valid timing function
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    return false;
  }

  return true;
}

/**
 * Clamps bezier control points to valid ranges.
 * - x1 and x2 are clamped to [0, 1]
 * - y1 and y2 are left unchanged (allows overshoot)
 */
export function clampBezierPoints(points: BezierPoints): BezierPoints {
  const [x1, y1, x2, y2] = points;
  return [
    Math.max(0, Math.min(1, x1)),
    y1,
    Math.max(0, Math.min(1, x2)),
    y2,
  ];
}

// =============================================================================
// Bezier Math
// =============================================================================

/**
 * Calculate the x or y coordinate of a cubic Bezier curve at parameter t.
 *
 * The curve is defined by control points:
 * - P0 = 0 (implicit start)
 * - P1 = p1 (first control point)
 * - P2 = p2 (second control point)
 * - P3 = 1 (implicit end)
 *
 * B(t) = (1-t)³*P0 + 3*(1-t)²*t*P1 + 3*(1-t)*t²*P2 + t³*P3
 *
 * Since P0=0 and P3=1:
 * B(t) = 3*(1-t)²*t*P1 + 3*(1-t)*t²*P2 + t³
 */
function bezierCoordinate(t: number, p1: number, p2: number): number {
  const oneMinusT = 1 - t;
  const oneMinusT2 = oneMinusT * oneMinusT;
  const t2 = t * t;

  return (
    3 * oneMinusT2 * t * p1 +
    3 * oneMinusT * t2 * p2 +
    t2 * t
  );
}

/**
 * Calculate the derivative of the Bezier curve at parameter t.
 * Used for Newton-Raphson iteration to solve for t given x.
 *
 * B'(t) = 3*(1-t)²*P1 + 6*(1-t)*t*(P2-P1) + 3*t²*(1-P2)
 *
 * Simplified for P0=0, P3=1:
 * B'(t) = 3*(1-t)²*P1 + 6*(1-t)*t*(P2-P1) + 3*t²*(1-P2)
 */
function bezierDerivative(t: number, p1: number, p2: number): number {
  const oneMinusT = 1 - t;
  return (
    3 * oneMinusT * oneMinusT * p1 +
    6 * oneMinusT * t * (p2 - p1) +
    3 * t * t * (1 - p2)
  );
}

/**
 * Solve for parameter t given x coordinate using Newton-Raphson method.
 * This is needed because we know x (time) and need to find t to calculate y (progress).
 *
 * For a cubic Bezier timing function:
 * - Input x is the normalized time (0-1)
 * - We need to find t such that bezierX(t) = x
 * - Then we can calculate y = bezierY(t)
 */
function solveBezierT(x: number, x1: number, x2: number): number {
  // Handle edge cases
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Initial guess: t = x is often close for smooth curves
  let t = x;

  // Newton-Raphson iteration
  // Max 8 iterations is typically sufficient for convergence
  const epsilon = 1e-7;
  for (let i = 0; i < 8; i++) {
    const currentX = bezierCoordinate(t, x1, x2);
    const error = currentX - x;

    if (Math.abs(error) < epsilon) {
      return t;
    }

    const derivative = bezierDerivative(t, x1, x2);

    // Avoid division by zero
    if (Math.abs(derivative) < epsilon) {
      break;
    }

    t -= error / derivative;

    // Clamp t to [0, 1]
    t = Math.max(0, Math.min(1, t));
  }

  // If Newton-Raphson didn't converge, fall back to binary search
  let low = 0;
  let high = 1;
  t = x;

  while (high - low > epsilon) {
    const currentX = bezierCoordinate(t, x1, x2);

    if (Math.abs(currentX - x) < epsilon) {
      return t;
    }

    if (currentX < x) {
      low = t;
    } else {
      high = t;
    }

    t = (low + high) / 2;
  }

  return t;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Evaluate a cubic Bezier curve at input time x.
 *
 * @param x - Input time value (0-1)
 * @param points - Control points [x1, y1, x2, y2]
 * @returns Output progress value (typically 0-1, but can overshoot)
 */
export function evaluateCubicBezier(x: number, points: BezierPoints): number {
  const [x1, y1, x2, y2] = points;

  // Handle boundary conditions
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Special case: linear curve
  if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) {
    return x;
  }

  // Find parameter t for input x
  const t = solveBezierT(x, x1, x2);

  // Calculate y at parameter t
  return bezierCoordinate(t, y1, y2);
}

/**
 * Create a memoized easing function from Bezier control points.
 * Useful for repeated evaluations with the same curve.
 *
 * @param points - Control points [x1, y1, x2, y2]
 * @returns Easing function that takes t (0-1) and returns progress (0-1)
 */
export function createBezierEasing(points: BezierPoints): EasingFn {
  // Pre-compute lookup table for better performance
  const sampleCount = 100;
  const samples: number[] = new Array(sampleCount + 1);

  for (let i = 0; i <= sampleCount; i++) {
    const x = i / sampleCount;
    samples[i] = evaluateCubicBezier(x, points);
  }

  // Cache for exact lookups
  const cache = new Map<number, number>();

  return (x: number): number => {
    // Boundary conditions
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    // Check cache first
    const cached = cache.get(x);
    if (cached !== undefined) {
      return cached;
    }

    // Linear interpolation from lookup table for speed
    const scaledX = x * sampleCount;
    const index = Math.floor(scaledX);
    const fraction = scaledX - index;

    let result: number;
    if (index >= sampleCount) {
      result = samples[sampleCount];
    } else {
      result = samples[index] + fraction * (samples[index + 1] - samples[index]);
    }

    // Cache the result
    cache.set(x, result);

    return result;
  };
}

// =============================================================================
// Presets
// =============================================================================

/**
 * Standard Bezier curve presets.
 * Includes CSS standard curves and common animation curves.
 */
export const BEZIER_PRESETS: Record<string, BezierPoints> = {
  // CSS standard curves
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1.0],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],

  // Quadratic curves
  easeInQuad: [0.55, 0.085, 0.68, 0.53],
  easeOutQuad: [0.25, 0.46, 0.45, 0.94],
  easeInOutQuad: [0.455, 0.03, 0.515, 0.955],

  // Cubic curves
  easeInCubic: [0.55, 0.055, 0.675, 0.19],
  easeOutCubic: [0.215, 0.61, 0.355, 1],
  easeInOutCubic: [0.645, 0.045, 0.355, 1],

  // Quart curves
  easeInQuart: [0.895, 0.03, 0.685, 0.22],
  easeOutQuart: [0.165, 0.84, 0.44, 1],
  easeInOutQuart: [0.77, 0, 0.175, 1],

  // Quint curves
  easeInQuint: [0.755, 0.05, 0.855, 0.06],
  easeOutQuint: [0.23, 1, 0.32, 1],
  easeInOutQuint: [0.86, 0, 0.07, 1],

  // Back curves (overshoot)
  easeInBack: [0.6, -0.28, 0.735, 0.045],
  easeOutBack: [0.175, 0.885, 0.32, 1.275],
  easeInOutBack: [0.68, -0.55, 0.265, 1.55],
};

/**
 * Interpolation System
 *
 * Production-grade interpolation utilities for animation and value mapping.
 * Inspired by Remotion's interpolate.ts with adaptations for OpenReelio.
 *
 * Features:
 * - Multi-point interpolation with arbitrary ranges
 * - 4 extrapolation modes for out-of-range values
 * - Custom easing function support
 * - Physics-based spring animation
 * - Overshoot clamping option
 *
 * @module utils/interpolation
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Extrapolation behavior when input is outside the input range.
 *
 * - 'extend': Continue the slope beyond the boundary (default)
 * - 'clamp': Hold at the boundary value
 * - 'identity': Return the input value unchanged
 * - 'wrap': Wrap around to the beginning of the range
 */
export type ExtrapolationMode = 'extend' | 'clamp' | 'identity' | 'wrap';

/**
 * Options for the interpolate function.
 */
export interface InterpolateOptions {
  /**
   * Easing function to apply to the interpolation.
   * Takes a value between 0-1 and returns a transformed value.
   * Default: linear (identity function)
   */
  easing?: (t: number) => number;

  /**
   * How to handle values below the input range.
   * Default: 'extend'
   */
  extrapolateLeft?: ExtrapolationMode;

  /**
   * How to handle values above the input range.
   * Default: 'extend'
   */
  extrapolateRight?: ExtrapolationMode;
}

/**
 * Configuration for spring animation physics.
 */
export interface SpringConfig {
  /**
   * Damping coefficient - higher values reduce oscillation.
   * Default: 10
   */
  damping?: number;

  /**
   * Mass of the spring - higher values make animation slower.
   * Default: 1
   */
  mass?: number;

  /**
   * Stiffness of the spring - higher values make animation faster.
   * Default: 100
   */
  stiffness?: number;

  /**
   * Whether to clamp values to prevent overshoot.
   * Default: false
   */
  overshootClamping?: boolean;
}

/**
 * Options for spring animation.
 */
export interface SpringOptions {
  /** Current frame number */
  frame: number;
  /** Frames per second */
  fps: number;
  /** Spring physics configuration */
  config?: SpringConfig;
  /** Starting value (default: 0) */
  from?: number;
  /** Target value (default: 1) */
  to?: number;
}

// =============================================================================
// Interpolation
// =============================================================================

/**
 * Interpolates a value between ranges with optional easing and extrapolation.
 *
 * @param input - The input value to interpolate
 * @param inputRange - Array of input values (must be sorted ascending)
 * @param outputRange - Array of corresponding output values
 * @param options - Interpolation options
 * @returns The interpolated output value
 *
 * @example
 * ```typescript
 * // Simple linear interpolation
 * interpolate(0.5, [0, 1], [0, 100]) // => 50
 *
 * // Multi-point interpolation
 * interpolate(1.5, [0, 1, 2], [0, 50, 100]) // => 75
 *
 * // With easing
 * interpolate(0.5, [0, 1], [0, 100], { easing: t => t * t }) // => 25
 *
 * // With clamping
 * interpolate(2, [0, 1], [0, 100], { extrapolateRight: 'clamp' }) // => 100
 * ```
 */
export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options: InterpolateOptions = {}
): number {
  const {
    easing = (t) => t,
    extrapolateLeft = 'extend',
    extrapolateRight = 'extend',
  } = options;

  // Validate ranges
  if (inputRange.length !== outputRange.length) {
    throw new Error('inputRange and outputRange must have the same length');
  }

  if (inputRange.length < 2) {
    throw new Error('inputRange and outputRange must have at least 2 points');
  }

  // Handle extrapolation below range
  if (input < inputRange[0]) {
    return applyExtrapolation(
      input,
      inputRange[0],
      outputRange[0],
      inputRange[0],
      inputRange[1],
      outputRange[0],
      outputRange[1],
      extrapolateLeft,
      easing
    );
  }

  // Handle extrapolation above range
  const lastIdx = inputRange.length - 1;
  if (input > inputRange[lastIdx]) {
    return applyExtrapolation(
      input,
      inputRange[lastIdx],
      outputRange[lastIdx],
      inputRange[lastIdx - 1],
      inputRange[lastIdx],
      outputRange[lastIdx - 1],
      outputRange[lastIdx],
      extrapolateRight,
      easing
    );
  }

  // Find the correct segment
  let segmentIndex = 0;
  for (let i = 1; i < inputRange.length; i++) {
    if (input <= inputRange[i]) {
      segmentIndex = i - 1;
      break;
    }
  }

  const inputMin = inputRange[segmentIndex];
  const inputMax = inputRange[segmentIndex + 1];
  const outputMin = outputRange[segmentIndex];
  const outputMax = outputRange[segmentIndex + 1];

  // Handle zero-width segment
  if (inputMax === inputMin) {
    return outputMin;
  }

  // Calculate interpolation factor
  const t = (input - inputMin) / (inputMax - inputMin);
  const easedT = easing(t);

  // Linear interpolation with easing
  return outputMin + (outputMax - outputMin) * easedT;
}

/**
 * Applies extrapolation mode for out-of-range values.
 */
function applyExtrapolation(
  input: number,
  boundaryInput: number,
  boundaryOutput: number,
  inputMin: number,
  inputMax: number,
  outputMin: number,
  outputMax: number,
  mode: ExtrapolationMode,
  easing: (t: number) => number
): number {
  switch (mode) {
    case 'clamp':
      return boundaryOutput;

    case 'identity':
      return input;

    case 'wrap': {
      const inputSpan = inputMax - inputMin;
      if (inputSpan === 0) return outputMin;

      // Wrap the input to within the range
      let wrapped = ((input - inputMin) % inputSpan);
      if (wrapped < 0) wrapped += inputSpan;
      wrapped += inputMin;

      // Calculate interpolation factor for wrapped value
      const t = (wrapped - inputMin) / inputSpan;
      const easedT = easing(t);
      return outputMin + (outputMax - outputMin) * easedT;
    }

    case 'extend':
    default: {
      // Continue the slope beyond the boundary
      const inputSpan = inputMax - inputMin;
      if (inputSpan === 0) return boundaryOutput;

      const slope = (outputMax - outputMin) / inputSpan;
      return boundaryOutput + slope * (input - boundaryInput);
    }
  }
}

// =============================================================================
// Spring Animation
// =============================================================================

/**
 * Calculates spring animation value at a given frame.
 *
 * Uses physics-based spring differential equation to produce natural motion
 * that accelerates quickly and decelerates smoothly.
 *
 * @param options - Spring animation options
 * @returns The animated value at the specified frame
 *
 * @example
 * ```typescript
 * // Basic spring from 0 to 100
 * spring({ frame: 15, fps: 30, from: 0, to: 100 })
 *
 * // Custom spring configuration
 * spring({
 *   frame: 15,
 *   fps: 30,
 *   from: 0,
 *   to: 100,
 *   config: { damping: 15, stiffness: 150 }
 * })
 *
 * // With overshoot clamping
 * spring({
 *   frame: 15,
 *   fps: 30,
 *   from: 0,
 *   to: 100,
 *   config: { overshootClamping: true }
 * })
 * ```
 */
export function spring(options: SpringOptions): number {
  const { frame, fps, config = {}, from = 0, to = 1 } = options;

  const {
    damping = 10,
    mass = 1,
    stiffness = 100,
    overshootClamping = false,
  } = config;

  // Validate parameters to prevent division by zero and NaN
  if (mass <= 0) {
    throw new Error('Spring mass must be positive');
  }
  if (stiffness < 0) {
    throw new Error('Spring stiffness must be non-negative');
  }
  if (damping < 0) {
    throw new Error('Spring damping must be non-negative');
  }
  if (fps <= 0) {
    throw new Error('FPS must be positive');
  }

  // Handle edge case: zero stiffness means no spring force
  if (stiffness === 0) {
    // Without stiffness, the spring cannot move toward target
    return from;
  }

  // Convert frame to time in seconds
  const time = frame / fps;

  // Calculate spring parameters
  const omega0 = Math.sqrt(stiffness / mass);
  const stiffnessMassProduct = stiffness * mass;
  const zeta = stiffnessMassProduct > 0
    ? damping / (2 * Math.sqrt(stiffnessMassProduct))
    : 0;

  let displacement: number;

  if (zeta < 1) {
    // Underdamped - oscillates
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    displacement = Math.exp(-zeta * omega0 * time) * Math.cos(omegaD * time);
  } else if (zeta === 1) {
    // Critically damped - fastest non-oscillating response
    displacement = (1 + omega0 * time) * Math.exp(-omega0 * time);
  } else {
    // Overdamped - slow, no oscillation
    const s1 = -omega0 * (zeta - Math.sqrt(zeta * zeta - 1));
    const s2 = -omega0 * (zeta + Math.sqrt(zeta * zeta - 1));
    displacement =
      (s2 * Math.exp(s1 * time) - s1 * Math.exp(s2 * time)) / (s2 - s1);
  }

  // Calculate result
  let result = from + (to - from) * (1 - displacement);

  // Apply overshoot clamping if enabled
  if (overshootClamping) {
    const min = Math.min(from, to);
    const max = Math.max(from, to);
    result = Math.min(Math.max(result, min), max);
  }

  return result;
}

// =============================================================================
// Common Easing Functions
// =============================================================================

/**
 * Collection of common easing functions.
 */
export const Easing = {
  /** Linear (no easing) */
  linear: (t: number) => t,

  /** Quadratic ease-in */
  easeIn: (t: number) => t * t,

  /** Quadratic ease-out */
  easeOut: (t: number) => 1 - (1 - t) * (1 - t),

  /** Quadratic ease-in-out */
  easeInOut: (t: number) =>
    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,

  /** Cubic ease-in */
  cubicIn: (t: number) => t * t * t,

  /** Cubic ease-out */
  cubicOut: (t: number) => 1 - Math.pow(1 - t, 3),

  /** Cubic ease-in-out */
  cubicInOut: (t: number) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,

  /** Exponential ease-in */
  expIn: (t: number) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),

  /** Exponential ease-out */
  expOut: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),

  /** Sine ease-in */
  sineIn: (t: number) => 1 - Math.cos((t * Math.PI) / 2),

  /** Sine ease-out */
  sineOut: (t: number) => Math.sin((t * Math.PI) / 2),

  /** Sine ease-in-out */
  sineInOut: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,

  /** Elastic ease-out (bouncy) */
  elasticOut: (t: number) => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0
      ? 0
      : t === 1
        ? 1
        : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },

  /** Back ease-out (overshoot) */
  backOut: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },

  /** Bounce ease-out */
  bounceOut: (t: number) => {
    const n1 = 7.5625;
    const d1 = 2.75;

    if (t < 1 / d1) {
      return n1 * t * t;
    } else if (t < 2 / d1) {
      return n1 * (t -= 1.5 / d1) * t + 0.75;
    } else if (t < 2.5 / d1) {
      return n1 * (t -= 2.25 / d1) * t + 0.9375;
    } else {
      return n1 * (t -= 2.625 / d1) * t + 0.984375;
    }
  },

  /**
   * Creates a bezier easing function.
   * Note: This is a simplified approximation.
   */
  bezier: (x1: number, y1: number, x2: number, y2: number) => {
    return (t: number) => {
      // Simple approximation using cubic interpolation
      const cx = 3 * x1;
      const bx = 3 * (x2 - x1) - cx;
      const ax = 1 - cx - bx;

      const cy = 3 * y1;
      const by = 3 * (y2 - y1) - cy;
      const ay = 1 - cy - by;

      // Find t for x
      let x = t;
      for (let i = 0; i < 8; i++) {
        const currentX = ((ax * x + bx) * x + cx) * x;
        const currentSlope = (3 * ax * x + 2 * bx) * x + cx;
        if (currentSlope === 0) break;
        x = x - (currentX - t) / currentSlope;
      }

      // Calculate y for the found x
      return ((ay * x + by) * x + cy) * x;
    };
  },
} as const;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Creates a sequence of values interpolated over frames.
 * Useful for pre-computing animation values.
 *
 * @param startFrame - Starting frame number
 * @param endFrame - Ending frame number
 * @param fn - Function that takes frame number and returns value
 * @returns Array of interpolated values
 */
export function sequence(
  startFrame: number,
  endFrame: number,
  fn: (frame: number) => number
): number[] {
  const result: number[] = [];
  for (let frame = startFrame; frame <= endFrame; frame++) {
    result.push(fn(frame));
  }
  return result;
}

/**
 * Converts a delay in seconds to frames.
 *
 * @param seconds - Delay in seconds
 * @param fps - Frames per second
 * @returns Delay in frames
 */
export function delayToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/**
 * Creates a delayed spring animation.
 *
 * @param delayFrames - Number of frames to delay
 * @param options - Spring options
 * @returns Spring value (0 during delay, then animating)
 */
export function delayedSpring(
  delayFrames: number,
  options: SpringOptions
): number {
  if (options.frame < delayFrames) {
    return options.from ?? 0;
  }

  return spring({
    ...options,
    frame: options.frame - delayFrames,
  });
}

/**
 * Color Wheel Utilities
 *
 * Mathematics and conversions for color wheel controls.
 * Used in Lift/Gamma/Gain color correction system.
 *
 * Color Wheel Coordinate System:
 * - Center (0, 0) = neutral (no color shift)
 * - X-axis: Red (+) to Cyan (-)
 * - Y-axis: Green (-) to Magenta (+) [screen coords, Y down]
 * - Radius (0-1): Saturation/intensity of color shift
 *
 * @module utils/colorWheel
 */

// =============================================================================
// Types
// =============================================================================

/**
 * RGB color offset values (-1 to 1 range).
 */
export interface ColorOffset {
  r: number;
  g: number;
  b: number;
}

/**
 * Wheel position in 2D space with luminance.
 */
export interface WheelPosition {
  /** X position (-1 to 1), positive = red direction */
  x: number;
  /** Y position (-1 to 1), negative = green direction (screen coords) */
  y: number;
  /** Luminance/intensity (0 to 1) */
  luminance: number;
}

/**
 * Complete Lift/Gamma/Gain color correction settings.
 */
export interface LiftGammaGain {
  /** Lift: affects shadows (dark values) */
  lift: ColorOffset;
  /** Gamma: affects midtones */
  gamma: ColorOffset;
  /** Gain: affects highlights (bright values) */
  gain: ColorOffset;
}

/**
 * RGB color in 0-1 range.
 */
export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Cartesian coordinate.
 */
export interface CartesianPoint {
  x: number;
  y: number;
}

/**
 * Polar coordinate.
 */
export interface PolarPoint {
  radius: number;
  angle: number;
}

// =============================================================================
// Coordinate Conversions
// =============================================================================

/**
 * Converts polar coordinates to cartesian.
 *
 * @param radius - Distance from origin (0-1)
 * @param angle - Angle in radians (0 = right, increases counter-clockwise)
 * @returns Cartesian point { x, y }
 */
export function polarToCartesian(radius: number, angle: number): CartesianPoint {
  return {
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
  };
}

/**
 * Converts cartesian coordinates to polar.
 *
 * @param x - X coordinate
 * @param y - Y coordinate
 * @returns Polar point { radius, angle }
 */
export function cartesianToPolar(x: number, y: number): PolarPoint {
  const radius = Math.sqrt(x * x + y * y);
  const angle = radius === 0 ? 0 : Math.atan2(y, x);
  return { radius, angle };
}

/**
 * Clamps a point to be within a circle of given radius.
 *
 * @param x - X coordinate
 * @param y - Y coordinate
 * @param maxRadius - Maximum allowed radius
 * @returns Clamped point
 */
export function clampToCircle(
  x: number,
  y: number,
  maxRadius: number
): CartesianPoint {
  const polar = cartesianToPolar(x, y);

  if (polar.radius <= maxRadius) {
    return { x, y };
  }

  return polarToCartesian(maxRadius, polar.angle);
}

// =============================================================================
// Color Offset Conversions
// =============================================================================

/**
 * Converts cartesian wheel position to RGB color offset.
 *
 * Uses a color wheel model matching DaVinci Resolve:
 * - Right (1, 0) = Red
 * - Top (0, -1) = Green (screen Y coords)
 * - Left (-1, 0) = Cyan
 * - Bottom-left = Blue
 * - Bottom-right = Yellow
 *
 * @param x - X position (-1 to 1)
 * @param y - Y position (-1 to 1)
 * @returns RGB color offset
 */
export function cartesianToColorOffset(x: number, y: number): ColorOffset {
  // Calculate polar coordinates
  const radius = Math.sqrt(x * x + y * y);
  if (radius === 0) {
    return { r: 0, g: 0, b: 0 };
  }

  // Limit radius to 1
  const clampedRadius = Math.min(radius, 1);

  // Get angle in radians (0 = right, increasing counter-clockwise)
  // Invert Y for screen coordinates
  const angle = Math.atan2(-y, x);

  // Convert to hue (0-360)
  // Red at 0°, Green at 120°, Blue at 240°
  let hue = (angle * 180) / Math.PI;
  if (hue < 0) hue += 360;

  // Convert hue to RGB using HSL-like conversion with S=1, L=0.5
  // This gives us a unit vector in RGB color space
  const h = hue / 60; // 0-6 range
  const sector = Math.floor(h);
  const f = h - sector;

  let r = 0, g = 0, b = 0;

  switch (sector % 6) {
    case 0: r = 1; g = f; b = 0; break;
    case 1: r = 1 - f; g = 1; b = 0; break;
    case 2: r = 0; g = 1; b = f; break;
    case 3: r = 0; g = 1 - f; b = 1; break;
    case 4: r = f; g = 0; b = 1; break;
    case 5: r = 1; g = 0; b = 1 - f; break;
  }

  // Normalize to offset form (center at gray, push toward color)
  // The offset represents deviation from gray
  const avg = (r + g + b) / 3;
  return {
    r: (r - avg) * clampedRadius,
    g: (g - avg) * clampedRadius,
    b: (b - avg) * clampedRadius,
  };
}

/**
 * Converts RGB color offset back to cartesian wheel position.
 *
 * @param offset - RGB color offset
 * @returns Cartesian position
 */
export function colorOffsetToCartesian(offset: ColorOffset): CartesianPoint {
  const { r, g, b } = offset;

  // Handle neutral (no offset)
  const magnitude = Math.sqrt(r * r + g * g + b * b);
  if (magnitude < 0.0001) {
    return { x: 0, y: 0 };
  }

  // Convert RGB offset to hue using standard RGB to HSL conversion
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (delta < 0.0001) {
    return { x: 0, y: 0 };
  }

  let hue = 0;
  if (max === r) {
    hue = 60 * (((g - b) / delta) % 6);
  } else if (max === g) {
    hue = 60 * ((b - r) / delta + 2);
  } else {
    hue = 60 * ((r - g) / delta + 4);
  }

  if (hue < 0) hue += 360;

  // Convert hue back to angle (in radians)
  const angle = (hue * Math.PI) / 180;

  // Calculate radius from offset magnitude
  // The maximum possible offset magnitude is sqrt(2/3) for a pure color
  const maxMagnitude = Math.sqrt(2 / 3);
  const radius = Math.min(magnitude / maxMagnitude, 1);

  // Convert back to cartesian (remember Y is inverted for screen)
  return {
    x: radius * Math.cos(angle),
    y: -radius * Math.sin(angle),
  };
}

// =============================================================================
// Wheel Position to RGB
// =============================================================================

/**
 * Converts a wheel position to an RGB color for display.
 *
 * @param position - Wheel position with x, y, and luminance
 * @returns RGB color (0-1 range)
 */
export function wheelPositionToRGB(position: WheelPosition): RGBColor {
  const { x, y, luminance } = position;

  // Get color offset from position
  const offset = cartesianToColorOffset(x, y);

  // Combine with luminance
  // The offset is added directly to the gray value
  const r = clamp01(luminance + offset.r);
  const g = clamp01(luminance + offset.g);
  const b = clamp01(luminance + offset.b);

  return { r, g, b };
}

/**
 * Converts an RGB color back to wheel position.
 *
 * @param color - RGB color (0-1 range)
 * @returns Wheel position
 */
export function rgbToWheelPosition(color: RGBColor): WheelPosition {
  const { r, g, b } = color;

  // Calculate luminance (simple average)
  const luminance = (r + g + b) / 3;

  // Handle pure gray
  if (Math.abs(r - g) < 0.001 && Math.abs(g - b) < 0.001) {
    return { x: 0, y: 0, luminance };
  }

  // Calculate color offset from gray
  const offset: ColorOffset = {
    r: r - luminance,
    g: g - luminance,
    b: b - luminance,
  };

  const pos = colorOffsetToCartesian(offset);

  return {
    x: pos.x,
    y: pos.y,
    luminance,
  };
}

// =============================================================================
// Lift/Gamma/Gain Application
// =============================================================================

/**
 * Applies Lift/Gamma/Gain color correction to an RGB value.
 *
 * The formula follows industry-standard color grading:
 * - Lift: Adds to shadows, minimal effect on highlights
 * - Gamma: Power curve adjustment, affects midtones most
 * - Gain: Multiplies highlights, minimal effect on shadows
 *
 * Combined formula per channel:
 * output = gain * (input + lift * (1 - input)) ^ (1 / (1 + gamma))
 *
 * @param r - Red input (0-1)
 * @param g - Green input (0-1)
 * @param b - Blue input (0-1)
 * @param lgg - Lift/Gamma/Gain settings
 * @returns Corrected RGB color
 */
export function applyLiftGammaGain(
  r: number,
  g: number,
  b: number,
  lgg: LiftGammaGain
): RGBColor {
  return {
    r: applyLGGChannel(r, lgg.lift.r, lgg.gamma.r, lgg.gain.r),
    g: applyLGGChannel(g, lgg.lift.g, lgg.gamma.g, lgg.gain.g),
    b: applyLGGChannel(b, lgg.lift.b, lgg.gamma.b, lgg.gain.b),
  };
}

/**
 * Applies LGG to a single channel.
 */
function applyLGGChannel(
  value: number,
  lift: number,
  gamma: number,
  gain: number
): number {
  // Apply lift (adds to shadows)
  // Lift affects dark values more: lift * (1 - value)
  let result = value + lift * (1 - value);

  // Apply gamma (power curve for midtones)
  // Gamma > 0 brightens midtones, gamma < 0 darkens
  if (result > 0) {
    const gammaFactor = 1 / (1 + gamma);
    result = Math.pow(result, gammaFactor);
  }

  // Apply gain (multiplies highlights)
  // Gain affects bright values more
  result = result * (1 + gain);

  // Clamp to valid range
  return clamp01(result);
}

// =============================================================================
// FFmpeg Color Matrix
// =============================================================================

/**
 * Creates a 3x4 color matrix for FFmpeg colorchannelmixer filter.
 *
 * The matrix format is:
 * [[rr, rg, rb, ra],  // How to calculate output R
 *  [gr, gg, gb, ga],  // How to calculate output G
 *  [br, bg, bb, ba]]  // How to calculate output B
 *
 * Where output_r = rr*input_r + rg*input_g + rb*input_b + ra
 *
 * Note: This is a linearized approximation of LGG.
 * For accurate results, use the applyLiftGammaGain function.
 *
 * @param lgg - Lift/Gamma/Gain settings
 * @returns 3x4 color matrix
 */
export function createLiftGammaGainMatrix(
  lgg: LiftGammaGain
): number[][] {
  const { lift, gamma, gain } = lgg;

  // Simplified linear approximation
  // True LGG is non-linear, but this gives a usable matrix for FFmpeg

  // For each channel, calculate:
  // - Diagonal (self-influence): 1 + gain
  // - Offset: lift
  // - Gamma effect is approximated through gain adjustment

  // R row: how input RGB affects output R
  const rr = 1 + gain.r + gamma.r * 0.5;
  const rg = 0;
  const rb = 0;
  const ra = lift.r * (1 - gain.r * 0.5);

  // G row: how input RGB affects output G
  const gr = 0;
  const gg = 1 + gain.g + gamma.g * 0.5;
  const gb = 0;
  const ga = lift.g * (1 - gain.g * 0.5);

  // B row: how input RGB affects output B
  const br = 0;
  const bg = 0;
  const bb = 1 + gain.b + gamma.b * 0.5;
  const ba = lift.b * (1 - gain.b * 0.5);

  return [
    [rr, rg, rb, ra],
    [gr, gg, gb, ga],
    [br, bg, bb, ba],
  ];
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Clamps a value to 0-1 range.
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Creates neutral (identity) Lift/Gamma/Gain settings.
 */
export function createNeutralLGG(): LiftGammaGain {
  return {
    lift: { r: 0, g: 0, b: 0 },
    gamma: { r: 0, g: 0, b: 0 },
    gain: { r: 0, g: 0, b: 0 },
  };
}

/**
 * Checks if LGG settings are neutral (no effect).
 */
export function isNeutralLGG(lgg: LiftGammaGain): boolean {
  const isZero = (o: ColorOffset) =>
    o.r === 0 && o.g === 0 && o.b === 0;

  return isZero(lgg.lift) && isZero(lgg.gamma) && isZero(lgg.gain);
}

/**
 * Formats LGG settings for FFmpeg filter string.
 *
 * @param lgg - Lift/Gamma/Gain settings
 * @returns FFmpeg colorbalance filter string
 */
export function lggToFFmpegFilter(lgg: LiftGammaGain): string {
  const { lift, gamma, gain } = lgg;

  // Use colorbalance filter which has rs, gs, bs (shadows),
  // rm, gm, bm (midtones), rh, gh, bh (highlights)
  const parts: string[] = [];

  // Shadows (lift)
  if (lift.r !== 0) parts.push(`rs=${lift.r.toFixed(3)}`);
  if (lift.g !== 0) parts.push(`gs=${lift.g.toFixed(3)}`);
  if (lift.b !== 0) parts.push(`bs=${lift.b.toFixed(3)}`);

  // Midtones (gamma)
  if (gamma.r !== 0) parts.push(`rm=${gamma.r.toFixed(3)}`);
  if (gamma.g !== 0) parts.push(`gm=${gamma.g.toFixed(3)}`);
  if (gamma.b !== 0) parts.push(`bm=${gamma.b.toFixed(3)}`);

  // Highlights (gain)
  if (gain.r !== 0) parts.push(`rh=${gain.r.toFixed(3)}`);
  if (gain.g !== 0) parts.push(`gh=${gain.g.toFixed(3)}`);
  if (gain.b !== 0) parts.push(`bh=${gain.b.toFixed(3)}`);

  if (parts.length === 0) {
    return '';
  }

  return `colorbalance=${parts.join(':')}`;
}

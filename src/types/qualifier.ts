/**
 * HSL Qualifier Types
 *
 * Types for selective color correction using HSL-based pixel selection.
 */

/** Qualifier parameter names for type safety */
export type QualifierParamName =
  | 'hue_center'
  | 'hue_width'
  | 'sat_min'
  | 'sat_max'
  | 'lum_min'
  | 'lum_max'
  | 'softness'
  | 'hue_shift'
  | 'sat_adjust'
  | 'lum_adjust'
  | 'invert';

/** Qualifier parameter values */
export interface QualifierValues {
  /** Center hue in degrees (0-360) */
  hue_center: number;
  /** Hue range width in degrees (1-180) */
  hue_width: number;
  /** Minimum saturation (0.0-1.0) */
  sat_min: number;
  /** Maximum saturation (0.0-1.0) */
  sat_max: number;
  /** Minimum luminance (0.0-1.0) */
  lum_min: number;
  /** Maximum luminance (0.0-1.0) */
  lum_max: number;
  /** Edge softness (0.0-1.0) */
  softness: number;
  /** Hue rotation adjustment (-180 to 180) */
  hue_shift: number;
  /** Saturation adjustment (-1.0 to 1.0) */
  sat_adjust: number;
  /** Luminance adjustment (-1.0 to 1.0) */
  lum_adjust: number;
  /** Invert selection */
  invert: boolean;
}

/** Preset qualifier names */
export type QualifierPreset = 'skin_tones' | 'sky_blue' | 'foliage' | 'custom';

/** Default qualifier values */
export const DEFAULT_QUALIFIER_VALUES: QualifierValues = {
  hue_center: 120, // Green
  hue_width: 30,
  sat_min: 0.2,
  sat_max: 1.0,
  lum_min: 0.0,
  lum_max: 1.0,
  softness: 0.1,
  hue_shift: 0.0,
  sat_adjust: 0.0,
  lum_adjust: 0.0,
  invert: false,
};

/** Preset qualifier configurations */
export const QUALIFIER_PRESETS: Record<
  Exclude<QualifierPreset, 'custom'>,
  QualifierValues
> = {
  skin_tones: {
    hue_center: 20,
    hue_width: 40,
    sat_min: 0.15,
    sat_max: 0.7,
    lum_min: 0.2,
    lum_max: 0.85,
    softness: 0.15,
    hue_shift: 0,
    sat_adjust: 0,
    lum_adjust: 0,
    invert: false,
  },
  sky_blue: {
    hue_center: 210,
    hue_width: 60,
    sat_min: 0.2,
    sat_max: 1.0,
    lum_min: 0.3,
    lum_max: 0.9,
    softness: 0.1,
    hue_shift: 0,
    sat_adjust: 0,
    lum_adjust: 0,
    invert: false,
  },
  foliage: {
    hue_center: 100,
    hue_width: 80,
    sat_min: 0.15,
    sat_max: 1.0,
    lum_min: 0.1,
    lum_max: 0.85,
    softness: 0.1,
    hue_shift: 0,
    sat_adjust: 0,
    lum_adjust: 0,
    invert: false,
  },
};

/** Parameter constraints for validation */
export const QUALIFIER_CONSTRAINTS = {
  hue_center: { min: 0, max: 360, step: 1 },
  hue_width: { min: 1, max: 180, step: 1 },
  sat_min: { min: 0, max: 1, step: 0.01 },
  sat_max: { min: 0, max: 1, step: 0.01 },
  lum_min: { min: 0, max: 1, step: 0.01 },
  lum_max: { min: 0, max: 1, step: 0.01 },
  softness: { min: 0, max: 1, step: 0.01 },
  hue_shift: { min: -180, max: 180, step: 1 },
  sat_adjust: { min: -1, max: 1, step: 0.01 },
  lum_adjust: { min: -1, max: 1, step: 0.01 },
  invert: { min: 0, max: 1, step: 1 }, // Boolean as 0/1
} as const;

/**
 * Safely converts a value to number, returning defaultValue if invalid.
 */
function safeNumber(value: unknown, defaultValue: number): number {
  if (value === null || value === undefined) return defaultValue;
  const num = Number(value);
  return Number.isNaN(num) ? defaultValue : num;
}

/** Convert effect params to QualifierValues with safe type coercion */
export function paramsToQualifierValues(
  params: Record<string, unknown>
): QualifierValues {
  return {
    hue_center: safeNumber(params.hue_center, DEFAULT_QUALIFIER_VALUES.hue_center),
    hue_width: safeNumber(params.hue_width, DEFAULT_QUALIFIER_VALUES.hue_width),
    sat_min: safeNumber(params.sat_min, DEFAULT_QUALIFIER_VALUES.sat_min),
    sat_max: safeNumber(params.sat_max, DEFAULT_QUALIFIER_VALUES.sat_max),
    lum_min: safeNumber(params.lum_min, DEFAULT_QUALIFIER_VALUES.lum_min),
    lum_max: safeNumber(params.lum_max, DEFAULT_QUALIFIER_VALUES.lum_max),
    softness: safeNumber(params.softness, DEFAULT_QUALIFIER_VALUES.softness),
    hue_shift: safeNumber(params.hue_shift, DEFAULT_QUALIFIER_VALUES.hue_shift),
    sat_adjust: safeNumber(params.sat_adjust, DEFAULT_QUALIFIER_VALUES.sat_adjust),
    lum_adjust: safeNumber(params.lum_adjust, DEFAULT_QUALIFIER_VALUES.lum_adjust),
    invert: Boolean(params.invert ?? DEFAULT_QUALIFIER_VALUES.invert),
  };
}

/** Check if effect type is HSL Qualifier */
export function isHSLQualifierEffect(
  effectType: string | { custom: string }
): boolean {
  return effectType === 'hsl_qualifier';
}

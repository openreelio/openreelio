/**
 * Effect Parameter Definitions
 *
 * Centralized parameter definitions for all effect types.
 * Used by EffectInspector and ParameterEditor to render appropriate controls.
 */

import type { ParamDef, EffectType } from '@/types';

// =============================================================================
// Audio Effect Parameter Definitions
// =============================================================================

export const AUDIO_EFFECT_PARAM_DEFS: Record<string, ParamDef[]> = {
  volume: [
    {
      name: 'level',
      label: 'Level',
      default: { type: 'float', value: 1.0 },
      min: 0,
      max: 2,
      step: 0.01,
    },
  ],

  gain: [
    {
      name: 'gain',
      label: 'Gain (dB)',
      default: { type: 'float', value: 0 },
      min: -24,
      max: 24,
      step: 0.5,
    },
  ],

  eq_band: [
    {
      name: 'frequency',
      label: 'Frequency (Hz)',
      default: { type: 'float', value: 1000 },
      min: 20,
      max: 20000,
      step: 10,
    },
    {
      name: 'width',
      label: 'Width (Q)',
      default: { type: 'float', value: 1.0 },
      min: 0.1,
      max: 10,
      step: 0.1,
    },
    {
      name: 'gain',
      label: 'Gain (dB)',
      default: { type: 'float', value: 0 },
      min: -24,
      max: 24,
      step: 0.5,
    },
  ],

  compressor: [
    {
      name: 'threshold',
      label: 'Threshold',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'ratio',
      label: 'Ratio',
      default: { type: 'float', value: 4.0 },
      min: 1,
      max: 20,
      step: 0.5,
    },
    {
      name: 'attack',
      label: 'Attack (ms)',
      default: { type: 'float', value: 5 },
      min: 0.1,
      max: 100,
      step: 0.1,
    },
    {
      name: 'release',
      label: 'Release (ms)',
      default: { type: 'float', value: 50 },
      min: 1,
      max: 1000,
      step: 1,
    },
  ],

  limiter: [
    {
      name: 'limit',
      label: 'Limit',
      default: { type: 'float', value: 1.0 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'attack',
      label: 'Attack (ms)',
      default: { type: 'float', value: 5 },
      min: 0.1,
      max: 100,
      step: 0.1,
    },
    {
      name: 'release',
      label: 'Release (ms)',
      default: { type: 'float', value: 50 },
      min: 1,
      max: 1000,
      step: 1,
    },
  ],

  reverb: [
    {
      name: 'delay',
      label: 'Delay (ms)',
      default: { type: 'float', value: 500 },
      min: 10,
      max: 2000,
      step: 10,
    },
    {
      name: 'decay',
      label: 'Decay',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  delay: [
    {
      name: 'delay',
      label: 'Delay (ms)',
      default: { type: 'float', value: 500 },
      min: 1,
      max: 5000,
      step: 10,
    },
  ],

  noise_reduction: [
    {
      name: 'strength',
      label: 'Strength',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  loudness_normalize: [
    {
      name: 'target_lufs',
      label: 'Target Loudness (LUFS)',
      default: { type: 'float', value: -14 },
      min: -50,
      max: 0,
      step: 0.5,
    },
    {
      name: 'true_peak',
      label: 'True Peak (dBTP)',
      default: { type: 'float', value: -1 },
      min: -10,
      max: 0,
      step: 0.1,
    },
  ],
};

// =============================================================================
// Video Effect Parameter Definitions
// =============================================================================

export const VIDEO_EFFECT_PARAM_DEFS: Record<string, ParamDef[]> = {
  brightness: [
    {
      name: 'value',
      label: 'Brightness',
      default: { type: 'float', value: 0 },
      min: -1,
      max: 1,
      step: 0.01,
    },
  ],

  contrast: [
    {
      name: 'value',
      label: 'Contrast',
      default: { type: 'float', value: 1 },
      min: 0,
      max: 2,
      step: 0.01,
    },
  ],

  saturation: [
    {
      name: 'value',
      label: 'Saturation',
      default: { type: 'float', value: 1 },
      min: 0,
      max: 3,
      step: 0.01,
    },
  ],

  hue: [
    {
      name: 'value',
      label: 'Hue Shift',
      default: { type: 'float', value: 0 },
      min: -180,
      max: 180,
      step: 1,
    },
  ],

  gamma: [
    {
      name: 'value',
      label: 'Gamma',
      default: { type: 'float', value: 1 },
      min: 0.1,
      max: 10,
      step: 0.1,
    },
  ],

  gaussian_blur: [
    {
      name: 'radius',
      label: 'Radius',
      default: { type: 'int', value: 5 },
      min: 0,
      max: 100,
      step: 1,
    },
    {
      name: 'sigma',
      label: 'Sigma',
      default: { type: 'float', value: 1.0 },
      min: 0,
      max: 10,
      step: 0.1,
    },
  ],

  box_blur: [
    {
      name: 'radius',
      label: 'Radius',
      default: { type: 'int', value: 5 },
      min: 0,
      max: 100,
      step: 1,
    },
  ],

  motion_blur: [
    {
      name: 'angle',
      label: 'Angle',
      default: { type: 'float', value: 0 },
      min: -180,
      max: 180,
      step: 1,
    },
    {
      name: 'distance',
      label: 'Distance',
      default: { type: 'int', value: 10 },
      min: 0,
      max: 100,
      step: 1,
    },
  ],

  sharpen: [
    {
      name: 'amount',
      label: 'Amount',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 2,
      step: 0.01,
    },
  ],

  vignette: [
    {
      name: 'intensity',
      label: 'Intensity',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'radius',
      label: 'Radius',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  crop: [
    {
      name: 'x',
      label: 'X Offset',
      default: { type: 'int', value: 0 },
      min: 0,
      max: 10000,
      step: 1,
    },
    {
      name: 'y',
      label: 'Y Offset',
      default: { type: 'int', value: 0 },
      min: 0,
      max: 10000,
      step: 1,
    },
    {
      name: 'width',
      label: 'Width',
      default: { type: 'int', value: 1920 },
      min: 1,
      max: 10000,
      step: 1,
    },
    {
      name: 'height',
      label: 'Height',
      default: { type: 'int', value: 1080 },
      min: 1,
      max: 10000,
      step: 1,
    },
  ],

  rotate: [
    {
      name: 'angle',
      label: 'Angle',
      default: { type: 'float', value: 0 },
      min: -360,
      max: 360,
      step: 1,
    },
  ],

  flip: [
    {
      name: 'horizontal',
      label: 'Horizontal',
      default: { type: 'bool', value: false },
    },
    {
      name: 'vertical',
      label: 'Vertical',
      default: { type: 'bool', value: false },
    },
  ],

  mirror: [
    {
      name: 'horizontal',
      label: 'Horizontal',
      default: { type: 'bool', value: true },
    },
  ],

  pixelate: [
    {
      name: 'size',
      label: 'Pixel Size',
      default: { type: 'int', value: 10 },
      min: 1,
      max: 100,
      step: 1,
    },
  ],

  posterize: [
    {
      name: 'levels',
      label: 'Levels',
      default: { type: 'int', value: 4 },
      min: 2,
      max: 32,
      step: 1,
    },
  ],

  noise: [
    {
      name: 'amount',
      label: 'Amount',
      default: { type: 'float', value: 0.1 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  film_grain: [
    {
      name: 'intensity',
      label: 'Intensity',
      default: { type: 'float', value: 0.3 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  glow: [
    {
      name: 'intensity',
      label: 'Intensity',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'radius',
      label: 'Radius',
      default: { type: 'int', value: 10 },
      min: 1,
      max: 100,
      step: 1,
    },
  ],

  chromatic_aberration: [
    {
      name: 'offset',
      label: 'Offset',
      default: { type: 'float', value: 5 },
      min: 0,
      max: 50,
      step: 1,
    },
  ],

  color_balance: [
    {
      name: 'red',
      label: 'Red',
      default: { type: 'float', value: 0 },
      min: -1,
      max: 1,
      step: 0.01,
    },
    {
      name: 'green',
      label: 'Green',
      default: { type: 'float', value: 0 },
      min: -1,
      max: 1,
      step: 0.01,
    },
    {
      name: 'blue',
      label: 'Blue',
      default: { type: 'float', value: 0 },
      min: -1,
      max: 1,
      step: 0.01,
    },
  ],

  levels: [
    {
      name: 'black_point',
      label: 'Black Point',
      default: { type: 'int', value: 0 },
      min: 0,
      max: 255,
      step: 1,
    },
    {
      name: 'white_point',
      label: 'White Point',
      default: { type: 'int', value: 255 },
      min: 0,
      max: 255,
      step: 1,
    },
    {
      name: 'gamma',
      label: 'Gamma',
      default: { type: 'float', value: 1 },
      min: 0.1,
      max: 10,
      step: 0.1,
    },
  ],

  lut: [
    {
      name: 'file',
      label: 'LUT File',
      default: { type: 'string', value: '' },
      inputType: 'file',
      fileExtensions: ['cube', '3dl', 'lut'],
    },
    {
      name: 'interp',
      label: 'Interpolation',
      default: { type: 'string', value: 'tetrahedral' },
      inputType: 'select',
      options: ['nearest', 'trilinear', 'tetrahedral'],
    },
    {
      name: 'intensity',
      label: 'Intensity',
      default: { type: 'float', value: 1 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  unsharp_mask: [
    {
      name: 'amount',
      label: 'Amount',
      default: { type: 'float', value: 1.0 },
      min: 0,
      max: 5,
      step: 0.1,
    },
    {
      name: 'radius',
      label: 'Radius',
      default: { type: 'float', value: 1.0 },
      min: 0.1,
      max: 10,
      step: 0.1,
    },
    {
      name: 'threshold',
      label: 'Threshold',
      default: { type: 'int', value: 0 },
      min: 0,
      max: 255,
      step: 1,
    },
  ],

  radial_blur: [
    {
      name: 'intensity',
      label: 'Intensity',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  text_overlay: [
    {
      name: 'text',
      label: 'Text',
      default: { type: 'string', value: '' },
    },
    {
      name: 'x',
      label: 'X Position',
      default: { type: 'int', value: 0 },
      min: 0,
      max: 10000,
      step: 1,
    },
    {
      name: 'y',
      label: 'Y Position',
      default: { type: 'int', value: 0 },
      min: 0,
      max: 10000,
      step: 1,
    },
    {
      name: 'font_size',
      label: 'Font Size',
      default: { type: 'int', value: 48 },
      min: 8,
      max: 500,
      step: 1,
    },
  ],

  subtitle: [
    {
      name: 'text',
      label: 'Text',
      default: { type: 'string', value: '' },
    },
  ],

  background_removal: [
    {
      name: 'threshold',
      label: 'Threshold',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  face_blur: [
    {
      name: 'intensity',
      label: 'Blur Intensity',
      default: { type: 'float', value: 0.8 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  auto_reframe: [
    {
      name: 'aspect_ratio',
      label: 'Target Aspect Ratio',
      default: { type: 'string', value: '9:16' },
      inputType: 'select',
      options: ['16:9', '9:16', '1:1', '4:3', '4:5'],
    },
    {
      name: 'speed',
      label: 'Tracking Speed',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  object_tracking: [
    {
      name: 'confidence',
      label: 'Detection Confidence',
      default: { type: 'float', value: 0.7 },
      min: 0.1,
      max: 1,
      step: 0.01,
    },
    {
      name: 'smooth',
      label: 'Smoothing',
      default: { type: 'float', value: 0.5 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  // ===========================================================================
  // Keying Effects
  // ===========================================================================

  chroma_key: [
    {
      name: 'key_color',
      label: 'Key Color',
      default: { type: 'string', value: '#00FF00' },
      inputType: 'color',
    },
    {
      name: 'similarity',
      label: 'Similarity',
      default: { type: 'float', value: 0.3 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'blend',
      label: 'Edge Blend',
      default: { type: 'float', value: 0.1 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'spill_suppression',
      label: 'Spill Suppression',
      default: { type: 'float', value: 0.0 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'edge_feather',
      label: 'Edge Feather',
      default: { type: 'float', value: 0.0 },
      min: 0,
      max: 10,
      step: 0.1,
    },
  ],

  luma_key: [
    {
      name: 'threshold',
      label: 'Threshold',
      default: { type: 'float', value: 0.1 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'tolerance',
      label: 'Tolerance',
      default: { type: 'float', value: 0.1 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  // ===========================================================================
  // Color Grading Effects
  // ===========================================================================

  color_wheels: [
    {
      name: 'lift_r',
      label: 'Lift Red',
      default: { type: 'float', value: 0 },
      min: -1,
      max: 1,
      step: 0.01,
    },
    {
      name: 'lift_g',
      label: 'Lift Green',
      default: { type: 'float', value: 0 },
      min: -1,
      max: 1,
      step: 0.01,
    },
    {
      name: 'lift_b',
      label: 'Lift Blue',
      default: { type: 'float', value: 0 },
      min: -1,
      max: 1,
      step: 0.01,
    },
    {
      name: 'gamma_r',
      label: 'Gamma Red',
      default: { type: 'float', value: 0 },
      min: -1,
      max: 1,
      step: 0.01,
    },
    {
      name: 'gamma_g',
      label: 'Gamma Green',
      default: { type: 'float', value: 0 },
      min: -1,
      max: 1,
      step: 0.01,
    },
    {
      name: 'gamma_b',
      label: 'Gamma Blue',
      default: { type: 'float', value: 0 },
      min: -1,
      max: 1,
      step: 0.01,
    },
    {
      name: 'gain_r',
      label: 'Gain Red',
      default: { type: 'float', value: 1 },
      min: 0,
      max: 2,
      step: 0.01,
    },
    {
      name: 'gain_g',
      label: 'Gain Green',
      default: { type: 'float', value: 1 },
      min: 0,
      max: 2,
      step: 0.01,
    },
    {
      name: 'gain_b',
      label: 'Gain Blue',
      default: { type: 'float', value: 1 },
      min: 0,
      max: 2,
      step: 0.01,
    },
  ],

  hsl_qualifier: [
    {
      name: 'hue_center',
      label: 'Hue Center',
      default: { type: 'float', value: 120 },
      min: 0,
      max: 360,
      step: 1,
    },
    {
      name: 'hue_width',
      label: 'Hue Width',
      default: { type: 'float', value: 30 },
      min: 0,
      max: 180,
      step: 1,
    },
    {
      name: 'hue_softness',
      label: 'Hue Softness',
      default: { type: 'float', value: 10 },
      min: 0,
      max: 90,
      step: 1,
    },
    {
      name: 'sat_low',
      label: 'Saturation Low',
      default: { type: 'float', value: 0 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'sat_high',
      label: 'Saturation High',
      default: { type: 'float', value: 1 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'lum_low',
      label: 'Luminance Low',
      default: { type: 'float', value: 0 },
      min: 0,
      max: 1,
      step: 0.01,
    },
    {
      name: 'lum_high',
      label: 'Luminance High',
      default: { type: 'float', value: 1 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],

  curves: [
    {
      name: 'master',
      label: 'Master Curve',
      default: { type: 'string', value: '0/0 1/1' },
    },
    {
      name: 'red',
      label: 'Red Curve',
      default: { type: 'string', value: '0/0 1/1' },
    },
    {
      name: 'green',
      label: 'Green Curve',
      default: { type: 'string', value: '0/0 1/1' },
    },
    {
      name: 'blue',
      label: 'Blue Curve',
      default: { type: 'string', value: '0/0 1/1' },
    },
  ],

  blend_mode: [
    {
      name: 'mode',
      label: 'Blend Mode',
      default: { type: 'string', value: 'normal' },
      inputType: 'select',
      options: [
        'normal',
        'multiply',
        'screen',
        'overlay',
        'darken',
        'lighten',
        'color_dodge',
        'color_burn',
        'hard_light',
        'soft_light',
        'difference',
        'exclusion',
      ],
    },
  ],

  opacity: [
    {
      name: 'value',
      label: 'Opacity',
      default: { type: 'float', value: 1.0 },
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],
};

// =============================================================================
// Transition Effect Parameter Definitions
// =============================================================================

export const TRANSITION_EFFECT_PARAM_DEFS: Record<string, ParamDef[]> = {
  cross_dissolve: [
    {
      name: 'duration',
      label: 'Duration (s)',
      default: { type: 'float', value: 1.0 },
      min: 0.1,
      max: 10,
      step: 0.1,
    },
  ],

  fade: [
    {
      name: 'duration',
      label: 'Duration (s)',
      default: { type: 'float', value: 1.0 },
      min: 0.1,
      max: 10,
      step: 0.1,
    },
    {
      name: 'fade_in',
      label: 'Fade In',
      default: { type: 'bool', value: true },
    },
  ],

  wipe: [
    {
      name: 'duration',
      label: 'Duration (s)',
      default: { type: 'float', value: 1.0 },
      min: 0.1,
      max: 10,
      step: 0.1,
    },
    {
      name: 'direction',
      label: 'Direction',
      default: { type: 'string', value: 'left' },
      inputType: 'select',
      options: ['left', 'right', 'up', 'down'],
    },
  ],

  slide: [
    {
      name: 'duration',
      label: 'Duration (s)',
      default: { type: 'float', value: 1.0 },
      min: 0.1,
      max: 10,
      step: 0.1,
    },
    {
      name: 'direction',
      label: 'Direction',
      default: { type: 'string', value: 'left' },
      inputType: 'select',
      options: ['left', 'right', 'up', 'down'],
    },
  ],

  zoom: [
    {
      name: 'duration',
      label: 'Duration (s)',
      default: { type: 'float', value: 1.0 },
      min: 0.1,
      max: 10,
      step: 0.1,
    },
    {
      name: 'zoom_type',
      label: 'Zoom Type',
      default: { type: 'string', value: 'in' },
      inputType: 'select',
      options: ['in', 'out'],
    },
  ],
};

// =============================================================================
// Lookup Function
// =============================================================================

/**
 * Combined lookup table for all effect types.
 * This provides a single source of truth and enables faster lookups.
 */
const ALL_EFFECT_PARAM_DEFS: Record<string, ParamDef[]> = {
  ...AUDIO_EFFECT_PARAM_DEFS,
  ...VIDEO_EFFECT_PARAM_DEFS,
  ...TRANSITION_EFFECT_PARAM_DEFS,
};

/**
 * Type guard for validating EffectType is a valid string key.
 */
function isValidEffectTypeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates that a ParamDef array is properly structured.
 * Returns a defensive copy to prevent external mutation.
 */
function safeParamDefs(defs: ParamDef[] | undefined): ParamDef[] {
  if (!Array.isArray(defs)) {
    return [];
  }
  // Return a shallow copy to prevent external mutation of the definitions
  return [...defs];
}

/**
 * Get parameter definitions for an effect type.
 * Returns an empty array for unknown types, enabling safe iteration.
 *
 * @param effectType - The effect type (string or custom object)
 * @returns Array of ParamDef for the effect, or empty array if not found
 */
export function getEffectParamDefs(effectType: EffectType): ParamDef[] {
  // Handle null/undefined defensively
  if (effectType === null || effectType === undefined) {
    return [];
  }

  // Handle custom effect types - plugin-defined effects have their own definitions
  if (typeof effectType === 'object' && effectType !== null && 'custom' in effectType) {
    return [];
  }

  // Validate effectType is a valid string
  if (!isValidEffectTypeString(effectType)) {
    return [];
  }

  // Single lookup in combined table
  const defs = ALL_EFFECT_PARAM_DEFS[effectType];
  return safeParamDefs(defs);
}

/**
 * Check if an effect type has parameter definitions.
 *
 * @param effectType - The effect type to check
 * @returns True if the effect type has known parameter definitions
 */
export function hasEffectParamDefs(effectType: EffectType): boolean {
  if (typeof effectType !== 'string' || effectType.length === 0) {
    return false;
  }
  return effectType in ALL_EFFECT_PARAM_DEFS;
}

/**
 * Get all known effect types that have parameter definitions.
 * Useful for validation or UI enumerations.
 *
 * @returns Array of all effect type strings with known definitions
 */
export function getAllKnownEffectTypes(): string[] {
  return Object.keys(ALL_EFFECT_PARAM_DEFS);
}

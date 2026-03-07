/**
 * Blend Modes Utility
 *
 * Provides definitions, labels, and utilities for video blend modes.
 * Used for compositing layers/tracks in the timeline.
 *
 * @module utils/blendModes
 */

import type { BlendMode } from '@/types';

// =============================================================================
// Types
// =============================================================================

/**
 * Categories for grouping blend modes in the UI
 */
export type BlendModeCategory = 'basic' | 'darken' | 'lighten' | 'contrast' | 'component';

/**
 * Complete definition for a blend mode
 */
export interface BlendModeDefinition {
  /** Display label */
  label: string;
  /** Human-readable description of the effect */
  description: string;
  /** Category for UI grouping */
  category: BlendModeCategory;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default blend mode for new tracks
 */
export const DEFAULT_BLEND_MODE: BlendMode = 'normal';

/**
 * All available blend modes as an array
 */
export const ALL_BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'add',
  'subtract',
  'darken',
  'lighten',
  'colorBurn',
  'colorDodge',
  'linearBurn',
  'linearDodge',
  'softLight',
  'hardLight',
  'vividLight',
  'linearLight',
  'pinLight',
  'difference',
  'exclusion',
] as const;

/**
 * Definitions for all blend modes
 */
export const BLEND_MODE_DEFINITIONS: Record<BlendMode, BlendModeDefinition> = {
  normal: {
    label: 'Normal',
    description: 'Standard compositing - top layer fully covers layers below based on opacity.',
    category: 'basic',
  },
  multiply: {
    label: 'Multiply',
    description: 'Darkens the image by multiplying colors. Good for shadows and darkening effects.',
    category: 'darken',
  },
  screen: {
    label: 'Screen',
    description:
      'Lightens the image by inverting, multiplying, and inverting again. Good for highlights.',
    category: 'lighten',
  },
  overlay: {
    label: 'Overlay',
    description:
      'Combines multiply and screen modes. Darkens dark areas, lightens light areas. Increases contrast.',
    category: 'contrast',
  },
  add: {
    label: 'Add',
    description:
      'Adds color values together. Creates bright, glowing effects. Good for light effects.',
    category: 'lighten',
  },
  subtract: {
    label: 'Subtract',
    description: 'Subtracts color values. Darkens and creates high-contrast effects.',
    category: 'darken',
  },
  darken: {
    label: 'Darken',
    description: 'Keeps the darker pixel from each layer. Removes light areas.',
    category: 'darken',
  },
  lighten: {
    label: 'Lighten',
    description: 'Keeps the lighter pixel from each layer. Removes dark areas.',
    category: 'lighten',
  },
  colorBurn: {
    label: 'Color Burn',
    description: 'Intensifies dark areas by increasing contrast. Rich, saturated shadows.',
    category: 'darken',
  },
  colorDodge: {
    label: 'Color Dodge',
    description: 'Intensifies light areas by decreasing contrast. Bright, blown-out highlights.',
    category: 'lighten',
  },
  linearBurn: {
    label: 'Linear Burn',
    description: 'Darkens by decreasing brightness linearly. More extreme than Multiply.',
    category: 'darken',
  },
  linearDodge: {
    label: 'Linear Dodge',
    description: 'Lightens by increasing brightness linearly. Same as Add.',
    category: 'lighten',
  },
  softLight: {
    label: 'Soft Light',
    description:
      'Gently darkens or lightens based on blend color. Like shining a diffused light on the image.',
    category: 'contrast',
  },
  hardLight: {
    label: 'Hard Light',
    description:
      'Strongly darkens or lightens based on blend color. Like shining a harsh spotlight.',
    category: 'contrast',
  },
  vividLight: {
    label: 'Vivid Light',
    description: 'Burns or dodges colors by increasing or decreasing contrast.',
    category: 'contrast',
  },
  linearLight: {
    label: 'Linear Light',
    description: 'Burns or dodges colors by decreasing or increasing brightness.',
    category: 'contrast',
  },
  pinLight: {
    label: 'Pin Light',
    description:
      'Replaces colors depending on brightness. Useful for creating special artistic effects.',
    category: 'contrast',
  },
  difference: {
    label: 'Difference',
    description: 'Shows the absolute difference between layers. Identical areas become black.',
    category: 'component',
  },
  exclusion: {
    label: 'Exclusion',
    description: 'Similar to Difference but with lower contrast. Produces a softer effect.',
    category: 'component',
  },
};

/**
 * Human-readable category labels
 */
export const BLEND_MODE_CATEGORY_LABELS: Record<BlendModeCategory, string> = {
  basic: 'Basic',
  darken: 'Darken',
  lighten: 'Lighten',
  contrast: 'Contrast',
  component: 'Component',
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the display label for a blend mode
 */
export function getBlendModeLabel(mode: BlendMode): string {
  return BLEND_MODE_DEFINITIONS[mode]?.label ?? mode;
}

/**
 * Get the description for a blend mode
 */
export function getBlendModeDescription(mode: BlendMode): string {
  return BLEND_MODE_DEFINITIONS[mode]?.description ?? '';
}

/**
 * Get the category for a blend mode
 */
export function getBlendModeCategory(mode: BlendMode): BlendModeCategory {
  return BLEND_MODE_DEFINITIONS[mode]?.category ?? 'basic';
}

/**
 * Get all blend modes in a specific category
 */
export function getBlendModesByCategory(category: BlendModeCategory): BlendMode[] {
  return ALL_BLEND_MODES.filter((mode) => BLEND_MODE_DEFINITIONS[mode].category === category);
}

/**
 * Resolve the effective clip blend mode while preserving track-level fallback.
 */
export function getEffectiveBlendMode(
  clipMode: BlendMode | undefined,
  trackMode: BlendMode | undefined,
): BlendMode {
  if (clipMode && clipMode !== DEFAULT_BLEND_MODE) {
    return clipMode;
  }

  return trackMode ?? DEFAULT_BLEND_MODE;
}

/**
 * Check if a value is a valid blend mode
 */
export function isValidBlendMode(value: unknown): value is BlendMode {
  if (typeof value !== 'string') return false;
  return ALL_BLEND_MODES.includes(value as BlendMode);
}

/**
 * Get all categories that have at least one blend mode
 */
export function getUsedCategories(): BlendModeCategory[] {
  const categories = new Set<BlendModeCategory>();
  for (const mode of ALL_BLEND_MODES) {
    categories.add(BLEND_MODE_DEFINITIONS[mode].category);
  }
  return Array.from(categories);
}

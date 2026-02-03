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
export type BlendModeCategory =
  | 'basic'
  | 'darken'
  | 'lighten'
  | 'contrast'
  | 'component';

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
] as const;

/**
 * Definitions for all blend modes
 */
export const BLEND_MODE_DEFINITIONS: Record<BlendMode, BlendModeDefinition> = {
  normal: {
    label: 'Normal',
    description:
      'Standard compositing - top layer fully covers layers below based on opacity.',
    category: 'basic',
  },
  multiply: {
    label: 'Multiply',
    description:
      'Darkens the image by multiplying colors. Good for shadows and darkening effects.',
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
export function getBlendModesByCategory(
  category: BlendModeCategory
): BlendMode[] {
  return ALL_BLEND_MODES.filter(
    (mode) => BLEND_MODE_DEFINITIONS[mode].category === category
  );
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

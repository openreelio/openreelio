/**
 * EffectType & EffectCategory Integration Tests
 *
 * Validates that the TypeScript EffectType type definition, getEffectCategory(),
 * and EFFECT_CATEGORY_LABELS are all aligned. Also validates alignment with
 * the Zod schema in commandSchemas.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  getEffectCategory,
  isAudioEffect,
  EFFECT_CATEGORY_LABELS,
  type EffectType,
  type EffectCategory,
} from './index';
import { EffectType as ZodEffectType } from '@/schemas/commandSchemas';
import { getEffectParamDefs, hasEffectParamDefs } from '@/utils/effectParamDefs';

// All string-literal effect types (excludes { custom: string })
const ALL_STRING_EFFECT_TYPES: EffectType[] = [
  // Color
  'brightness', 'contrast', 'saturation', 'hue', 'color_balance',
  'color_wheels', 'gamma', 'levels', 'curves', 'lut',
  // Transform
  'crop', 'flip', 'mirror', 'rotate',
  // Blur/Sharpen
  'gaussian_blur', 'box_blur', 'motion_blur', 'radial_blur', 'sharpen', 'unsharp_mask',
  // Stylize
  'vignette', 'glow', 'film_grain', 'chromatic_aberration', 'noise', 'pixelate', 'posterize',
  // Transitions
  'cross_dissolve', 'fade', 'wipe', 'slide', 'zoom',
  // Audio
  'volume', 'gain', 'eq_band', 'compressor', 'limiter', 'noise_reduction', 'reverb', 'delay',
  // Text
  'text_overlay', 'subtitle',
  // AI
  'background_removal', 'auto_reframe', 'face_blur', 'object_tracking',
  // Keying
  'chroma_key', 'luma_key', 'hsl_qualifier',
  // Compositing
  'blend_mode', 'opacity',
  // Audio normalization
  'loudness_normalize',
];

describe('EffectType system integration', () => {
  describe('getEffectCategory', () => {
    it('should return a valid category for every string effect type', () => {
      const validCategories: EffectCategory[] = [
        'color', 'advanced_color', 'transform', 'blur_sharpen',
        'stylize', 'transition', 'audio', 'text', 'ai', 'keying',
        'compositing', 'custom',
      ];

      for (const effectType of ALL_STRING_EFFECT_TYPES) {
        const category = getEffectCategory(effectType);
        expect(
          validCategories.includes(category),
          `getEffectCategory('${effectType}') returned '${category}' which is not a valid category`,
        ).toBe(true);
      }
    });

    it('should not return custom for any known effect type', () => {
      for (const effectType of ALL_STRING_EFFECT_TYPES) {
        const category = getEffectCategory(effectType);
        expect(
          category,
          `getEffectCategory('${effectType}') returned 'custom' - likely missing from switch statement`,
        ).not.toBe('custom');
      }
    });

    it('should return custom for { custom: string } effect type', () => {
      expect(getEffectCategory({ custom: 'my_plugin_effect' })).toBe('custom');
    });

    it('should categorize compositing effects correctly', () => {
      expect(getEffectCategory('blend_mode')).toBe('compositing');
      expect(getEffectCategory('opacity')).toBe('compositing');
    });

    it('should categorize loudness_normalize as audio', () => {
      expect(getEffectCategory('loudness_normalize')).toBe('audio');
    });
  });

  describe('isAudioEffect', () => {
    it('should return true for audio effects', () => {
      const audioEffects: EffectType[] = [
        'volume', 'gain', 'eq_band', 'compressor', 'limiter',
        'noise_reduction', 'reverb', 'delay', 'loudness_normalize',
      ];
      for (const effectType of audioEffects) {
        expect(isAudioEffect(effectType), `${effectType} should be audio`).toBe(true);
      }
    });

    it('should return false for video effects', () => {
      const videoEffects: EffectType[] = ['brightness', 'gaussian_blur', 'chroma_key'];
      for (const effectType of videoEffects) {
        expect(isAudioEffect(effectType), `${effectType} should not be audio`).toBe(false);
      }
    });
  });

  describe('EFFECT_CATEGORY_LABELS', () => {
    it('should have a label for every category including compositing', () => {
      const categories: EffectCategory[] = [
        'color', 'advanced_color', 'transform', 'blur_sharpen',
        'stylize', 'transition', 'audio', 'text', 'ai', 'keying',
        'compositing', 'custom',
      ];

      for (const cat of categories) {
        expect(
          EFFECT_CATEGORY_LABELS[cat],
          `Missing label for category '${cat}'`,
        ).toBeDefined();
        expect(typeof EFFECT_CATEGORY_LABELS[cat]).toBe('string');
      }
    });

    it('should have Compositing label', () => {
      expect(EFFECT_CATEGORY_LABELS.compositing).toBe('Compositing');
    });
  });

  describe('Zod schema alignment', () => {
    it('should have all TypeScript string effect types in Zod enum', () => {
      for (const effectType of ALL_STRING_EFFECT_TYPES) {
        const result = ZodEffectType.safeParse(effectType);
        expect(
          result.success,
          `Zod EffectType missing '${effectType}'`,
        ).toBe(true);
      }
    });

    it('should have exactly as many Zod values as TypeScript string types', () => {
      expect(ZodEffectType.options).toHaveLength(ALL_STRING_EFFECT_TYPES.length);
    });
  });

  describe('effectParamDefs alignment', () => {
    it('should have param definitions for every string effect type', () => {
      const missing: string[] = [];
      for (const effectType of ALL_STRING_EFFECT_TYPES) {
        if (typeof effectType === 'string' && !hasEffectParamDefs(effectType)) {
          missing.push(effectType);
        }
      }
      expect(
        missing,
        `Missing param defs for: ${missing.join(', ')}`,
      ).toEqual([]);
    });

    it('should return non-empty param defs for known effect types', () => {
      for (const effectType of ALL_STRING_EFFECT_TYPES) {
        if (typeof effectType === 'string') {
          const defs = getEffectParamDefs(effectType);
          expect(
            defs.length,
            `effectParamDefs for '${effectType}' is empty`,
          ).toBeGreaterThan(0);
        }
      }
    });
  });
});

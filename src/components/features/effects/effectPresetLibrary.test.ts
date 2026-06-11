import { describe, expect, it } from 'vitest';
import { getEffectCategory, type EffectType } from '@/types';
import {
  BUILT_IN_VISUAL_EFFECT_PRESETS,
  VISUAL_EFFECT_PRESET_CATEGORY_LABELS,
  filterSavedEffectPresets,
  filterVisualEffectPresets,
  getEffectPresetTypeKey,
  getEffectPresetTypeLabel,
  type VisualEffectPresetCategory,
} from './effectPresetLibrary';

const EXPORT_BACKED_VISUAL_EFFECTS = new Set<EffectType>([
  'brightness',
  'contrast',
  'saturation',
  'temperature_tint',
  'gaussian_blur',
  'sharpen',
  'vignette',
  'film_grain',
  'pixelate',
]);

describe('effectPresetLibrary', () => {
  it('should provide presets for every required visual workflow category', () => {
    const categories = new Set<VisualEffectPresetCategory>(
      BUILT_IN_VISUAL_EFFECT_PRESETS.map((preset) => preset.category),
    );

    expect(categories).toEqual(
      new Set<VisualEffectPresetCategory>(['clean-up', 'look', 'motion', 'privacy', 'social']),
    );
  });

  it('should expand every preset into ordinary editable visual effects', () => {
    for (const preset of BUILT_IN_VISUAL_EFFECT_PRESETS) {
      expect(preset.effects.length, `${preset.id} should contain effects`).toBeGreaterThan(0);

      for (const effect of preset.effects) {
        expect(getEffectCategory(effect.effectType), `${preset.id}:${effect.effectType}`).not.toBe(
          'audio',
        );
        expect(
          EXPORT_BACKED_VISUAL_EFFECTS.has(effect.effectType),
          `${preset.id}:${effect.effectType} should have export-backed behavior`,
        ).toBe(true);
      }
    }
  });

  it('should define editable default masks for privacy region presets', () => {
    const privacyPresets = BUILT_IN_VISUAL_EFFECT_PRESETS.filter(
      (preset) => preset.category === 'privacy',
    );

    for (const preset of privacyPresets) {
      expect(preset.effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            defaultMask: expect.objectContaining({
              feather: expect.any(Number),
              shape: expect.objectContaining({ type: expect.stringMatching(/rectangle|ellipse/) }),
            }),
          }),
        ]),
      );
    }
  });

  it('should filter presets by name, category label, description, and effect type', () => {
    expect(filterVisualEffectPresets(BUILT_IN_VISUAL_EFFECT_PRESETS, 'privacy').map((p) => p.id))
      .toEqual(['privacy-heavy-mosaic', 'privacy-soft-blur']);

    expect(filterVisualEffectPresets(BUILT_IN_VISUAL_EFFECT_PRESETS, 'temperature_tint')).toEqual([
      expect.objectContaining({ id: 'look-warm-documentary' }),
    ]);

    expect(VISUAL_EFFECT_PRESET_CATEGORY_LABELS.social).toBe('Social');
  });

  it('should filter saved presets by metadata and readable effect type', () => {
    const savedPresets = [
      {
        id: 'saved-1',
        name: 'Client Blur',
        description: 'Animated privacy pass',
        effectType: 'gaussian_blur' as const,
        category: 'blur_sharpen' as const,
        createdAt: '2026-06-08T00:00:00Z',
        updatedAt: '2026-06-08T00:00:00Z',
      },
      {
        id: 'saved-2',
        name: 'Podcast Volume',
        effectType: 'volume' as const,
        category: 'audio' as const,
        createdAt: '2026-06-08T00:00:00Z',
        updatedAt: '2026-06-08T00:00:00Z',
      },
    ];

    expect(filterSavedEffectPresets(savedPresets, 'gaussian').map((preset) => preset.id)).toEqual([
      'saved-1',
    ]);
    expect(filterSavedEffectPresets(savedPresets, 'audio').map((preset) => preset.id)).toEqual([
      'saved-2',
    ]);
    expect(getEffectPresetTypeLabel({ custom: 'third_party_fx' })).toBe('third_party_fx');
    expect(getEffectPresetTypeKey('gaussian_blur')).toBe('gaussian_blur');
  });
});

import type { EffectPresetSummary, EffectType, MaskShape, SimpleParamValue } from '@/types';
import { EFFECT_CATEGORY_LABELS, EFFECT_TYPE_LABELS } from '@/types';

export type VisualEffectPresetCategory = 'clean-up' | 'look' | 'motion' | 'privacy' | 'social';

export interface VisualEffectPresetStep {
  effectType: Extract<EffectType, string>;
  params: Record<string, SimpleParamValue>;
  defaultMask?: {
    shape: MaskShape;
    name?: string;
    feather?: number;
    inverted?: boolean;
  };
}

export interface VisualEffectPreset {
  id: string;
  name: string;
  category: VisualEffectPresetCategory;
  description: string;
  effects: VisualEffectPresetStep[];
}

export const VISUAL_EFFECT_PRESET_CATEGORY_LABELS: Record<VisualEffectPresetCategory, string> = {
  'clean-up': 'Clean-Up',
  look: 'Look',
  motion: 'Motion Feel',
  privacy: 'Privacy',
  social: 'Social',
};

export const BUILT_IN_VISUAL_EFFECT_PRESETS: VisualEffectPreset[] = [
  {
    id: 'cleanup-soften-noise',
    name: 'Soften Noise',
    category: 'clean-up',
    description: 'Reduce harsh detail with light blur and gentle contrast.',
    effects: [
      { effectType: 'gaussian_blur', params: { radius: 1.4 } },
      { effectType: 'contrast', params: { value: 0.96 } },
    ],
  },
  {
    id: 'cleanup-crisp-detail',
    name: 'Crisp Detail',
    category: 'clean-up',
    description: 'Sharpen soft footage without changing color strongly.',
    effects: [
      { effectType: 'sharpen', params: { amount: 0.85 } },
      { effectType: 'contrast', params: { value: 1.05 } },
    ],
  },
  {
    id: 'look-warm-documentary',
    name: 'Warm Documentary',
    category: 'look',
    description: 'Warm color, restrained contrast, and mild vignette.',
    effects: [
      { effectType: 'temperature_tint', params: { temperature: 14, tint: 3 } },
      { effectType: 'contrast', params: { value: 1.08 } },
      { effectType: 'vignette', params: { intensity: 0.24, radius: 0.82 } },
    ],
  },
  {
    id: 'look-social-pop',
    name: 'Social Pop',
    category: 'look',
    description: 'Higher saturation and contrast for feed-ready clips.',
    effects: [
      { effectType: 'saturation', params: { value: 1.22 } },
      { effectType: 'contrast', params: { value: 1.12 } },
      { effectType: 'brightness', params: { value: 0.03 } },
    ],
  },
  {
    id: 'motion-dream-trail',
    name: 'Dream Softness',
    category: 'motion',
    description: 'Soft movement with mild blur, grain, and lower contrast.',
    effects: [
      { effectType: 'gaussian_blur', params: { radius: 2.6 } },
      { effectType: 'contrast', params: { value: 0.94 } },
      { effectType: 'film_grain', params: { amount: 6 } },
    ],
  },
  {
    id: 'motion-action-crisp',
    name: 'Action Crisp',
    category: 'motion',
    description: 'Sharper motion with punchier contrast.',
    effects: [
      { effectType: 'sharpen', params: { amount: 1.05 } },
      { effectType: 'contrast', params: { value: 1.16 } },
    ],
  },
  {
    id: 'privacy-heavy-mosaic',
    name: 'Heavy Mosaic',
    category: 'privacy',
    description: 'Strong pixelation with an editable center privacy mask.',
    effects: [
      {
        effectType: 'pixelate',
        params: { size: 28 },
        defaultMask: {
          name: 'Privacy Mosaic Region',
          feather: 0.04,
          shape: {
            type: 'rectangle',
            x: 0.5,
            y: 0.42,
            width: 0.34,
            height: 0.26,
            cornerRadius: 0.08,
            rotation: 0,
          },
        },
      },
    ],
  },
  {
    id: 'privacy-soft-blur',
    name: 'Soft Privacy Blur',
    category: 'privacy',
    description: 'Large blur with an editable ellipse privacy mask.',
    effects: [
      {
        effectType: 'gaussian_blur',
        params: { radius: 24 },
        defaultMask: {
          name: 'Privacy Blur Region',
          feather: 0.14,
          shape: {
            type: 'ellipse',
            x: 0.5,
            y: 0.42,
            radiusX: 0.18,
            radiusY: 0.16,
            rotation: 0,
          },
        },
      },
    ],
  },
  {
    id: 'social-vertical-polish',
    name: 'Vertical Polish',
    category: 'social',
    description: 'Bright, saturated, lightly vignetted social delivery look.',
    effects: [
      { effectType: 'brightness', params: { value: 0.05 } },
      { effectType: 'saturation', params: { value: 1.18 } },
      { effectType: 'vignette', params: { intensity: 0.18, radius: 0.9 } },
    ],
  },
  {
    id: 'social-retro-feed',
    name: 'Retro Feed',
    category: 'social',
    description: 'Muted contrast with grain for short-form texture.',
    effects: [
      { effectType: 'contrast', params: { value: 0.92 } },
      { effectType: 'film_grain', params: { amount: 12 } },
      { effectType: 'vignette', params: { intensity: 0.22, radius: 0.86 } },
    ],
  },
];

export function filterVisualEffectPresets(
  presets: readonly VisualEffectPreset[],
  query: string,
): VisualEffectPreset[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...presets];
  }

  return presets.filter((preset) => {
    const categoryLabel = VISUAL_EFFECT_PRESET_CATEGORY_LABELS[preset.category];
    const effectTypes = preset.effects.map((effect) => effect.effectType).join(' ');
    return `${preset.name} ${preset.description} ${categoryLabel} ${effectTypes}`
      .toLowerCase()
      .includes(normalized);
  });
}

export function getEffectPresetTypeLabel(effectType: EffectType): string {
  if (typeof effectType === 'object' && 'custom' in effectType) {
    return effectType.custom;
  }

  return EFFECT_TYPE_LABELS[effectType] ?? effectType;
}

export function getEffectPresetTypeKey(effectType: EffectType): string {
  return typeof effectType === 'object' && 'custom' in effectType ? effectType.custom : effectType;
}

export function filterSavedEffectPresets(
  presets: readonly EffectPresetSummary[],
  query: string,
): EffectPresetSummary[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...presets];
  }

  return presets.filter((preset) => {
    const categoryLabel = EFFECT_CATEGORY_LABELS[preset.category] ?? preset.category;
    const effectLabel = getEffectPresetTypeLabel(preset.effectType);
    const effectKey = getEffectPresetTypeKey(preset.effectType);
    return `${preset.name} ${preset.description ?? ''} ${categoryLabel} ${effectLabel} ${effectKey}`
      .toLowerCase()
      .includes(normalized);
  });
}

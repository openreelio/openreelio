/**
 * Effect category data definitions for EffectsBrowser.
 *
 * Extracted to keep EffectsBrowser.tsx under the 200-line component limit.
 */

import type { ReactNode } from 'react';
import {
  Wand2,
  Sparkles,
  Palette,
  Volume2,
  Zap,
  Layers,
  Focus,
  Type,
  Bot,
  Scissors,
} from 'lucide-react';
import type { EffectCategory } from '@/types';
import { EFFECT_TYPE_LABELS } from '@/types';
import type { EffectEntry } from '@/hooks/useEffectSearch';

// =============================================================================
// Types
// =============================================================================

export interface CategoryWithIcon {
  id: EffectCategory;
  icon: ReactNode;
  effects: EffectEntry[];
}

// =============================================================================
// Icons
// =============================================================================

export const CATEGORY_ICONS: Record<EffectCategory, ReactNode> = {
  color: <Palette className="w-4 h-4" />,
  advanced_color: <Palette className="w-4 h-4" />,
  transform: <Zap className="w-4 h-4" />,
  blur_sharpen: <Focus className="w-4 h-4" />,
  stylize: <Sparkles className="w-4 h-4" />,
  transition: <Layers className="w-4 h-4" />,
  audio: <Volume2 className="w-4 h-4" />,
  text: <Type className="w-4 h-4" />,
  ai: <Bot className="w-4 h-4" />,
  keying: <Scissors className="w-4 h-4" />,
  compositing: <Layers className="w-4 h-4" />,
  custom: <Wand2 className="w-4 h-4" />,
};

// =============================================================================
// Effect Definitions by Category
// =============================================================================

/**
 * Effect definitions organized by category.
 * Uses EFFECT_TYPE_LABELS for display names.
 */
export const EFFECT_CATEGORIES: CategoryWithIcon[] = [
  {
    id: 'color',
    icon: CATEGORY_ICONS.color,
    effects: [
      { type: 'brightness', label: EFFECT_TYPE_LABELS.brightness ?? 'Brightness' },
      { type: 'contrast', label: EFFECT_TYPE_LABELS.contrast ?? 'Contrast' },
      { type: 'saturation', label: EFFECT_TYPE_LABELS.saturation ?? 'Saturation' },
      { type: 'hue', label: EFFECT_TYPE_LABELS.hue ?? 'Hue' },
      { type: 'color_balance', label: EFFECT_TYPE_LABELS.color_balance ?? 'Color Balance' },
      { type: 'color_wheels', label: EFFECT_TYPE_LABELS.color_wheels ?? 'Color Wheels' },
      { type: 'gamma', label: EFFECT_TYPE_LABELS.gamma ?? 'Gamma' },
      { type: 'levels', label: EFFECT_TYPE_LABELS.levels ?? 'Levels' },
      { type: 'curves', label: EFFECT_TYPE_LABELS.curves ?? 'Curves' },
      { type: 'lut', label: EFFECT_TYPE_LABELS.lut ?? 'LUT' },
    ],
  },
  {
    id: 'transform',
    icon: CATEGORY_ICONS.transform,
    effects: [
      { type: 'crop', label: EFFECT_TYPE_LABELS.crop ?? 'Crop' },
      { type: 'flip', label: EFFECT_TYPE_LABELS.flip ?? 'Flip' },
      { type: 'mirror', label: EFFECT_TYPE_LABELS.mirror ?? 'Mirror' },
      { type: 'rotate', label: EFFECT_TYPE_LABELS.rotate ?? 'Rotate' },
      { type: 'stabilize', label: EFFECT_TYPE_LABELS.stabilize ?? 'Stabilize' },
    ],
  },
  {
    id: 'blur_sharpen',
    icon: CATEGORY_ICONS.blur_sharpen,
    effects: [
      { type: 'gaussian_blur', label: EFFECT_TYPE_LABELS.gaussian_blur ?? 'Gaussian Blur' },
      { type: 'box_blur', label: EFFECT_TYPE_LABELS.box_blur ?? 'Box Blur' },
      { type: 'motion_blur', label: EFFECT_TYPE_LABELS.motion_blur ?? 'Motion Blur' },
      { type: 'radial_blur', label: EFFECT_TYPE_LABELS.radial_blur ?? 'Radial Blur' },
      { type: 'sharpen', label: EFFECT_TYPE_LABELS.sharpen ?? 'Sharpen' },
      { type: 'unsharp_mask', label: EFFECT_TYPE_LABELS.unsharp_mask ?? 'Unsharp Mask' },
    ],
  },
  {
    id: 'stylize',
    icon: CATEGORY_ICONS.stylize,
    effects: [
      { type: 'vignette', label: EFFECT_TYPE_LABELS.vignette ?? 'Vignette' },
      { type: 'glow', label: EFFECT_TYPE_LABELS.glow ?? 'Glow' },
      { type: 'film_grain', label: EFFECT_TYPE_LABELS.film_grain ?? 'Film Grain' },
      {
        type: 'chromatic_aberration',
        label: EFFECT_TYPE_LABELS.chromatic_aberration ?? 'Chromatic Aberration',
      },
      { type: 'noise', label: EFFECT_TYPE_LABELS.noise ?? 'Noise' },
      { type: 'pixelate', label: EFFECT_TYPE_LABELS.pixelate ?? 'Pixelate' },
      { type: 'posterize', label: EFFECT_TYPE_LABELS.posterize ?? 'Posterize' },
    ],
  },
  {
    id: 'transition',
    icon: CATEGORY_ICONS.transition,
    effects: [
      { type: 'cross_dissolve', label: EFFECT_TYPE_LABELS.cross_dissolve ?? 'Cross Dissolve' },
      { type: 'fade', label: EFFECT_TYPE_LABELS.fade ?? 'Fade' },
      { type: 'wipe', label: EFFECT_TYPE_LABELS.wipe ?? 'Wipe' },
      { type: 'slide', label: EFFECT_TYPE_LABELS.slide ?? 'Slide' },
      { type: 'zoom', label: EFFECT_TYPE_LABELS.zoom ?? 'Zoom' },
    ],
  },
  {
    id: 'audio',
    icon: CATEGORY_ICONS.audio,
    effects: [
      { type: 'volume', label: EFFECT_TYPE_LABELS.volume ?? 'Volume' },
      { type: 'gain', label: EFFECT_TYPE_LABELS.gain ?? 'Gain' },
      { type: 'eq_band', label: EFFECT_TYPE_LABELS.eq_band ?? 'EQ Band' },
      { type: 'compressor', label: EFFECT_TYPE_LABELS.compressor ?? 'Compressor' },
      { type: 'limiter', label: EFFECT_TYPE_LABELS.limiter ?? 'Limiter' },
      { type: 'noise_reduction', label: EFFECT_TYPE_LABELS.noise_reduction ?? 'Noise Reduction' },
      { type: 'reverb', label: EFFECT_TYPE_LABELS.reverb ?? 'Reverb' },
      { type: 'delay', label: EFFECT_TYPE_LABELS.delay ?? 'Delay' },
    ],
  },
  {
    id: 'text',
    icon: CATEGORY_ICONS.text,
    effects: [
      { type: 'text_overlay', label: EFFECT_TYPE_LABELS.text_overlay ?? 'Text Overlay' },
      { type: 'subtitle', label: EFFECT_TYPE_LABELS.subtitle ?? 'Subtitle' },
    ],
  },
  {
    id: 'ai',
    icon: CATEGORY_ICONS.ai,
    effects: [
      {
        type: 'background_removal',
        label: EFFECT_TYPE_LABELS.background_removal ?? 'Background Removal',
      },
      { type: 'auto_reframe', label: EFFECT_TYPE_LABELS.auto_reframe ?? 'Auto Reframe' },
      { type: 'face_blur', label: EFFECT_TYPE_LABELS.face_blur ?? 'Face Blur' },
      { type: 'object_tracking', label: EFFECT_TYPE_LABELS.object_tracking ?? 'Object Tracking' },
    ],
  },
  {
    id: 'keying',
    icon: CATEGORY_ICONS.keying,
    effects: [
      { type: 'chroma_key', label: EFFECT_TYPE_LABELS.chroma_key ?? 'Chroma Key' },
      { type: 'luma_key', label: EFFECT_TYPE_LABELS.luma_key ?? 'Luma Key' },
    ],
  },
];

/** Total effect count (constant, computed once) */
export const TOTAL_EFFECT_COUNT = EFFECT_CATEGORIES.reduce(
  (acc, cat) => acc + cat.effects.length,
  0,
);

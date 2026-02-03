/**
 * EffectsBrowser Component
 *
 * Browser panel for discovering and applying effects to clips.
 * Displays available effects organized by category with search functionality.
 */

import { memo, useState, useMemo, type ReactNode } from 'react';
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
  Search,
} from 'lucide-react';
import type { EffectCategory, EffectType } from '@/types';
import { EFFECT_CATEGORY_LABELS, EFFECT_TYPE_LABELS } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface EffectsBrowserProps {
  /** Additional CSS classes */
  className?: string;
  /** Callback when an effect is selected */
  onEffectSelect?: (effectType: string) => void;
}

interface EffectEntry {
  type: EffectType;
  label: string;
}

interface CategoryDefinition {
  id: EffectCategory;
  icon: ReactNode;
  effects: EffectEntry[];
}

// =============================================================================
// Effect Definitions by Category
// =============================================================================

const CATEGORY_ICONS: Record<EffectCategory, ReactNode> = {
  color: <Palette className="w-4 h-4" />,
  advanced_color: <Palette className="w-4 h-4" />,
  transform: <Zap className="w-4 h-4" />,
  blur_sharpen: <Focus className="w-4 h-4" />,
  stylize: <Sparkles className="w-4 h-4" />,
  transition: <Layers className="w-4 h-4" />,
  audio: <Volume2 className="w-4 h-4" />,
  text: <Type className="w-4 h-4" />,
  ai: <Bot className="w-4 h-4" />,
  custom: <Wand2 className="w-4 h-4" />,
};

/**
 * Effect definitions organized by category
 * Uses EFFECT_TYPE_LABELS for display names
 */
const EFFECT_CATEGORIES: CategoryDefinition[] = [
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
];

// Total effect count (constant, computed once)
const TOTAL_EFFECT_COUNT = EFFECT_CATEGORIES.reduce((acc, cat) => acc + cat.effects.length, 0);

// =============================================================================
// Component
// =============================================================================

export const EffectsBrowser = memo(function EffectsBrowser({
  className = '',
  onEffectSelect,
}: EffectsBrowserProps) {
  const [searchQuery, setSearchQuery] = useState('');

  // Filter effects based on search query
  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) {
      return EFFECT_CATEGORIES;
    }

    const query = searchQuery.toLowerCase();
    return EFFECT_CATEGORIES.map((category) => ({
      ...category,
      effects: category.effects.filter((effect) => effect.label.toLowerCase().includes(query)),
    })).filter((category) => category.effects.length > 0);
  }, [searchQuery]);

  // Check if any effects match the search
  const hasResults = filteredCategories.some((cat) => cat.effects.length > 0);

  return (
    <div className={`h-full overflow-auto ${className}`} data-testid="effects-browser">
      {/* Header */}
      <div className="p-3 border-b border-editor-border">
        <div className="flex items-center gap-2 text-editor-text">
          <Wand2 className="w-4 h-4 text-primary-500" />
          <span className="text-sm font-medium">Effects</span>
        </div>
        <p className="text-xs text-editor-text-muted mt-1">
          Drag effects to clips or double-click to apply
        </p>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-editor-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-editor-text-muted" />
          <input
            type="text"
            placeholder="Search effects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-editor-input border border-editor-border rounded pl-8 pr-2 py-1.5 text-sm text-editor-text placeholder:text-editor-text-muted focus:border-primary-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Effect Categories */}
      <div className="p-2 space-y-4">
        {!hasResults ? (
          <div className="flex flex-col items-center justify-center py-8 text-editor-text-muted">
            <Search className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-sm">No effects found</p>
            <p className="text-xs mt-1">Try a different search term</p>
          </div>
        ) : (
          filteredCategories.map((category) => (
            <div key={category.id}>
              <div className="flex items-center gap-2 px-2 py-1.5 text-editor-text-muted">
                {category.icon}
                <span className="text-xs font-medium uppercase tracking-wider">
                  {EFFECT_CATEGORY_LABELS[category.id]}
                </span>
              </div>
              <div className="space-y-0.5">
                {category.effects.map((effect) => (
                  <button
                    key={typeof effect.type === 'string' ? effect.type : effect.type.custom}
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-sm rounded transition-colors text-editor-text hover:bg-editor-hover"
                    onClick={() =>
                      onEffectSelect?.(
                        typeof effect.type === 'string' ? effect.type : effect.type.custom
                      )
                    }
                  >
                    {effect.label}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-editor-border mt-4">
        <p className="text-xs text-editor-text-muted text-center italic">
          {TOTAL_EFFECT_COUNT} effects available
        </p>
      </div>
    </div>
  );
});

/**
 * EffectsBrowser Component
 *
 * Browser panel for discovering and applying effects to clips.
 * Currently a placeholder for future implementation.
 */

import { memo } from 'react';
import { Wand2, Sparkles, Palette, Volume2, Zap } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface EffectsBrowserProps {
  /** Additional CSS classes */
  className?: string;
  /** Callback when an effect is selected */
  onEffectSelect?: (effectId: string) => void;
}

// =============================================================================
// Placeholder Effect Categories
// =============================================================================

const EFFECT_CATEGORIES = [
  {
    id: 'color',
    name: 'Color & Grading',
    icon: <Palette className="w-4 h-4" />,
    effects: [
      { id: 'brightness', name: 'Brightness/Contrast' },
      { id: 'saturation', name: 'Saturation' },
      { id: 'hue', name: 'Hue Shift' },
      { id: 'lut', name: 'LUT (Coming Soon)' },
    ],
  },
  {
    id: 'transform',
    name: 'Transform',
    icon: <Zap className="w-4 h-4" />,
    effects: [
      { id: 'crop', name: 'Crop' },
      { id: 'rotate', name: 'Rotate' },
      { id: 'scale', name: 'Scale' },
      { id: 'flip', name: 'Flip' },
    ],
  },
  {
    id: 'audio',
    name: 'Audio',
    icon: <Volume2 className="w-4 h-4" />,
    effects: [
      { id: 'volume', name: 'Volume' },
      { id: 'fade', name: 'Fade In/Out' },
      { id: 'eq', name: 'Equalizer (Coming Soon)' },
      { id: 'noise', name: 'Noise Reduction (Coming Soon)' },
    ],
  },
  {
    id: 'stylize',
    name: 'Stylize',
    icon: <Sparkles className="w-4 h-4" />,
    effects: [
      { id: 'blur', name: 'Blur' },
      { id: 'sharpen', name: 'Sharpen' },
      { id: 'vignette', name: 'Vignette' },
      { id: 'glow', name: 'Glow (Coming Soon)' },
    ],
  },
];

// =============================================================================
// Component
// =============================================================================

export const EffectsBrowser = memo(function EffectsBrowser({
  className = '',
  onEffectSelect,
}: EffectsBrowserProps) {
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

      {/* Search (placeholder) */}
      <div className="p-2 border-b border-editor-border">
        <input
          type="text"
          placeholder="Search effects..."
          className="w-full bg-editor-input border border-editor-border rounded px-2 py-1.5 text-sm text-editor-text placeholder:text-editor-text-muted focus:border-primary-500 focus:outline-none"
          disabled
        />
      </div>

      {/* Effect Categories */}
      <div className="p-2 space-y-4">
        {EFFECT_CATEGORIES.map((category) => (
          <div key={category.id}>
            <div className="flex items-center gap-2 px-2 py-1.5 text-editor-text-muted">
              {category.icon}
              <span className="text-xs font-medium uppercase tracking-wider">{category.name}</span>
            </div>
            <div className="space-y-0.5">
              {category.effects.map((effect) => {
                const isComingSoon = effect.name.includes('Coming Soon');
                return (
                  <button
                    key={effect.id}
                    type="button"
                    className={`w-full text-left px-3 py-1.5 text-sm rounded transition-colors ${
                      isComingSoon
                        ? 'text-editor-text-muted opacity-50 cursor-not-allowed'
                        : 'text-editor-text hover:bg-editor-hover'
                    }`}
                    onClick={() => !isComingSoon && onEffectSelect?.(effect.id)}
                    disabled={isComingSoon}
                  >
                    {effect.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-editor-border mt-4">
        <p className="text-xs text-editor-text-muted text-center italic">
          More effects coming in v0.3.0
        </p>
      </div>
    </div>
  );
});

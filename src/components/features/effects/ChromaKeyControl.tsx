/**
 * ChromaKeyControl Component
 *
 * A specialized control for chroma key (green screen) effect parameters.
 * Features:
 * - Color presets (green, blue)
 * - Custom color picker
 * - Similarity and blend sliders
 * - Reset to defaults
 *
 * @module components/features/effects/ChromaKeyControl
 */

import React, { useCallback } from 'react';
import { RotateCcw } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface ChromaKeyControlProps {
  /** Current key color (hex format) */
  keyColor: string;
  /** Similarity value (0-1) */
  similarity: number;
  /** Blend/edge feather value (0-1) */
  blend: number;
  /** Called when key color changes */
  onKeyColorChange: (color: string) => void;
  /** Called when similarity changes */
  onSimilarityChange: (value: number) => void;
  /** Called when blend changes */
  onBlendChange: (value: number) => void;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const PRESETS = [
  { name: 'Green', color: '#00FF00', label: 'green' },
  { name: 'Blue', color: '#0000FF', label: 'blue' },
  { name: 'Magenta', color: '#FF00FF', label: 'magenta' },
] as const;

const DEFAULTS = {
  keyColor: '#00FF00',
  similarity: 0.3,
  blend: 0.1,
};

// =============================================================================
// Component
// =============================================================================

export function ChromaKeyControl({
  keyColor,
  similarity,
  blend,
  onKeyColorChange,
  onSimilarityChange,
  onBlendChange,
  disabled = false,
  className = '',
}: ChromaKeyControlProps) {
  // Check if current color matches a preset
  const isPresetActive = useCallback(
    (presetColor: string) => {
      return keyColor.toUpperCase() === presetColor.toUpperCase();
    },
    [keyColor]
  );

  // Handle preset click
  const handlePresetClick = useCallback(
    (color: string) => {
      if (disabled) return;
      onKeyColorChange(color);
    },
    [disabled, onKeyColorChange]
  );

  // Handle color input change
  const handleColorInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onKeyColorChange(e.target.value.toUpperCase());
    },
    [onKeyColorChange]
  );

  // Handle similarity change
  const handleSimilarityChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onSimilarityChange(parseFloat(e.target.value));
    },
    [onSimilarityChange]
  );

  // Handle blend change
  const handleBlendChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onBlendChange(parseFloat(e.target.value));
    },
    [onBlendChange]
  );

  // Handle reset
  const handleReset = useCallback(() => {
    if (disabled) return;
    onKeyColorChange(DEFAULTS.keyColor);
    onSimilarityChange(DEFAULTS.similarity);
    onBlendChange(DEFAULTS.blend);
  }, [disabled, onKeyColorChange, onSimilarityChange, onBlendChange]);

  return (
    <div
      data-testid="chroma-key-control"
      className={`flex flex-col gap-4 p-3 bg-zinc-800 rounded-lg ${disabled ? 'opacity-50 pointer-events-none' : ''} ${className}`}
    >
      {/* Header with reset button */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">Chroma Key</h3>
        <button
          type="button"
          onClick={handleReset}
          className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
          aria-label="Reset chroma key"
          disabled={disabled}
        >
          <RotateCcw size={14} />
        </button>
      </div>

      {/* Key Color Section */}
      <div className="space-y-2">
        <label className="text-xs text-zinc-400">Key Color</label>
        <div className="flex items-center gap-2">
          {/* Color swatch with hidden input */}
          <div className="relative">
            <div
              data-testid="color-swatch"
              className="w-8 h-8 rounded border border-zinc-600 cursor-pointer"
              style={{ backgroundColor: keyColor }}
            />
            <input
              data-testid="color-input"
              type="color"
              value={keyColor}
              onChange={handleColorInputChange}
              className="absolute inset-0 opacity-0 cursor-pointer"
              disabled={disabled}
            />
          </div>

          {/* Preset buttons */}
          <div className="flex gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => handlePresetClick(preset.color)}
                className={`
                  px-2 py-1 text-xs rounded
                  ${isPresetActive(preset.color)
                    ? 'ring-2 ring-yellow-400 bg-zinc-700'
                    : 'bg-zinc-700 hover:bg-zinc-600'}
                  text-zinc-200 transition-all
                `}
                aria-label={preset.name}
                disabled={disabled}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Similarity Slider */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label htmlFor="similarity-slider" className="text-xs text-zinc-400">
            Similarity
          </label>
          <span className="text-xs text-zinc-500">
            {Math.round(similarity * 100)}%
          </span>
        </div>
        <input
          id="similarity-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={similarity}
          onChange={handleSimilarityChange}
          className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-green-500"
          aria-label="Similarity"
          disabled={disabled}
        />
        <p className="text-xs text-zinc-500">
          Higher values select more similar colors
        </p>
      </div>

      {/* Blend Slider */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label htmlFor="blend-slider" className="text-xs text-zinc-400">
            Edge Blend
          </label>
          <span className="text-xs text-zinc-500">
            {Math.round(blend * 100)}%
          </span>
        </div>
        <input
          id="blend-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={blend}
          onChange={handleBlendChange}
          className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-green-500"
          aria-label="Blend"
          disabled={disabled}
        />
        <p className="text-xs text-zinc-500">
          Softens the edges of the key
        </p>
      </div>
    </div>
  );
}

export default ChromaKeyControl;

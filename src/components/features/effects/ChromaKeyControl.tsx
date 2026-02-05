/**
 * ChromaKeyControl Component
 *
 * Enhanced control for chroma key (green screen) effect parameters.
 * Features:
 * - Color presets (green, blue, magenta)
 * - Custom color picker
 * - Eyedropper/sample from preview
 * - Similarity, softness, spill suppression, edge feather sliders
 * - Reset to defaults
 *
 * @module components/features/effects/ChromaKeyControl
 */

import { useCallback } from 'react';
import { RotateCcw, Pipette, X } from 'lucide-react';
import { useChromaKey, type ChromaKeyParams, type ChromaKeyPreset } from '@/hooks/useChromaKey';

// =============================================================================
// Types
// =============================================================================

export interface ChromaKeyControlProps {
  /** Initial parameters */
  initialParams?: Partial<ChromaKeyParams>;
  /** Called when parameters change */
  onChange?: (params: ChromaKeyParams) => void;
  /** Called when user wants to sample color from preview */
  onSampleFromPreview?: () => void;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const PRESETS: Array<{ id: ChromaKeyPreset; name: string; color: string }> = [
  { id: 'green', name: 'Green', color: '#00FF00' },
  { id: 'blue', name: 'Blue', color: '#0000FF' },
  { id: 'magenta', name: 'Magenta', color: '#FF00FF' },
];

// =============================================================================
// Slider Component
// =============================================================================

interface SliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
  description?: string;
  disabled?: boolean;
}

function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit = '%',
  description,
  disabled = false,
}: SliderProps): JSX.Element {
  const displayValue = unit === '%' ? Math.round(value * 100) : value.toFixed(1);
  const sliderId = `slider-${label.toLowerCase().replace(/\s+/g, '-')}`;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label htmlFor={sliderId} className="text-xs text-zinc-400">{label}</label>
        <span className="text-xs text-zinc-500">
          {displayValue}
          {unit}
        </span>
      </div>
      <input
        id={sliderId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        aria-label={label}
        className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
      />
      {description && <p className="text-xs text-zinc-500">{description}</p>}
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export function ChromaKeyControl({
  initialParams,
  onChange,
  onSampleFromPreview,
  disabled = false,
  className = '',
}: ChromaKeyControlProps): JSX.Element {
  const {
    params,
    updateParam,
    reset,
    applyPreset,
    isSampling,
    startSampling,
    cancelSampling,
  } = useChromaKey({ initialParams, onChange });

  // Handle preset click
  const handlePresetClick = useCallback(
    (preset: ChromaKeyPreset) => {
      if (disabled) return;
      applyPreset(preset);
    },
    [disabled, applyPreset]
  );

  // Handle color input change
  const handleColorInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateParam('keyColor', e.target.value.toUpperCase());
    },
    [updateParam]
  );

  // Handle eyedropper click
  const handleEyedropperClick = useCallback(() => {
    if (disabled) return;
    if (isSampling) {
      cancelSampling();
    } else {
      startSampling();
      onSampleFromPreview?.();
    }
  }, [disabled, isSampling, startSampling, cancelSampling, onSampleFromPreview]);

  // Handle reset
  const handleReset = useCallback(() => {
    if (disabled) return;
    reset();
  }, [disabled, reset]);

  // Check if preset is active
  const isPresetActive = useCallback(
    (presetColor: string) => params.keyColor.toUpperCase() === presetColor.toUpperCase(),
    [params.keyColor]
  );

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
              style={{ backgroundColor: params.keyColor }}
            />
            <input
              data-testid="color-input"
              type="color"
              value={params.keyColor}
              onChange={handleColorInputChange}
              className="absolute inset-0 opacity-0 cursor-pointer"
              disabled={disabled}
            />
          </div>

          {/* Eyedropper button */}
          <button
            type="button"
            onClick={handleEyedropperClick}
            className={`
              p-2 rounded border transition-all
              ${isSampling
                ? 'bg-yellow-600 border-yellow-500 text-white'
                : 'bg-zinc-700 border-zinc-600 text-zinc-300 hover:bg-zinc-600'}
            `}
            aria-label={isSampling ? 'Cancel sampling' : 'Sample from preview'}
            title={isSampling ? 'Click to cancel' : 'Sample color from preview'}
            disabled={disabled}
          >
            {isSampling ? <X size={14} /> : <Pipette size={14} />}
          </button>

          {/* Preset buttons */}
          <div className="flex gap-1 flex-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handlePresetClick(preset.id)}
                className={`
                  flex-1 px-2 py-1 text-xs rounded transition-all
                  ${isPresetActive(preset.color)
                    ? 'ring-2 ring-yellow-400 bg-zinc-700'
                    : 'bg-zinc-700 hover:bg-zinc-600'}
                  text-zinc-200
                `}
                aria-label={preset.name}
                disabled={disabled}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full mr-1"
                  style={{ backgroundColor: preset.color }}
                />
                {preset.name}
              </button>
            ))}
          </div>
        </div>

        {/* Sampling mode indicator */}
        {isSampling && (
          <p className="text-xs text-yellow-400 animate-pulse">
            Click on the preview to sample a color...
          </p>
        )}
      </div>

      {/* Similarity Slider */}
      <Slider
        label="Similarity"
        value={params.similarity}
        onChange={(v) => updateParam('similarity', v)}
        min={0}
        max={1}
        step={0.01}
        description="How closely colors must match the key color"
        disabled={disabled}
      />

      {/* Softness Slider */}
      <Slider
        label="Softness"
        value={params.softness}
        onChange={(v) => updateParam('softness', v)}
        min={0}
        max={1}
        step={0.01}
        description="Softens the edges of the key"
        disabled={disabled}
      />

      {/* Spill Suppression Slider */}
      <Slider
        label="Spill Suppression"
        value={params.spillSuppression}
        onChange={(v) => updateParam('spillSuppression', v)}
        min={0}
        max={1}
        step={0.01}
        description="Reduces color spill on edges"
        disabled={disabled}
      />

      {/* Edge Feather Slider */}
      <Slider
        label="Edge Feather"
        value={params.edgeFeather}
        onChange={(v) => updateParam('edgeFeather', v)}
        min={0}
        max={10}
        step={0.1}
        unit="px"
        description="Blurs the edges of the key mask"
        disabled={disabled}
      />
    </div>
  );
}

export default ChromaKeyControl;

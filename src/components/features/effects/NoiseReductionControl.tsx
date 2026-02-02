/**
 * NoiseReductionControl Component
 *
 * A control panel for audio noise reduction settings.
 * Features:
 * - Enable/disable toggle
 * - Algorithm selection
 * - Strength slider
 * - Preset buttons (Light, Medium, Heavy)
 *
 * @module components/features/effects/NoiseReductionControl
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Volume2, ChevronDown } from 'lucide-react';
import type { NoiseReductionSettings, NoiseReductionAlgorithm } from '@/utils/noiseReduction';
import {
  NOISE_REDUCTION_ALGORITHMS,
  NOISE_REDUCTION_PRESETS,
  getNoiseReductionAlgorithmLabel,
  ALL_NOISE_REDUCTION_ALGORITHMS,
  type NoiseReductionPresetLevel,
} from '@/utils/noiseReduction';

// =============================================================================
// Types
// =============================================================================

export interface NoiseReductionControlProps {
  /** Current noise reduction settings */
  settings: NoiseReductionSettings;
  /** Called when settings change */
  onChange: (settings: NoiseReductionSettings) => void;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function NoiseReductionControl({
  settings,
  onChange,
  disabled = false,
  className = '',
}: NoiseReductionControlProps) {
  const [isAlgorithmOpen, setIsAlgorithmOpen] = useState(false);
  const algorithmRef = useRef<HTMLDivElement>(null);

  // Close algorithm dropdown when clicking outside
  useEffect(() => {
    if (!isAlgorithmOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        algorithmRef.current &&
        !algorithmRef.current.contains(event.target as Node)
      ) {
        setIsAlgorithmOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isAlgorithmOpen]);

  // Handle toggle
  const handleToggle = useCallback(() => {
    onChange({ ...settings, enabled: !settings.enabled });
  }, [settings, onChange]);

  // Handle algorithm change
  const handleAlgorithmChange = useCallback(
    (algorithm: NoiseReductionAlgorithm) => {
      onChange({ ...settings, algorithm });
      setIsAlgorithmOpen(false);
    },
    [settings, onChange]
  );

  // Handle strength change
  const handleStrengthChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange({ ...settings, strength: parseFloat(e.target.value) });
    },
    [settings, onChange]
  );

  // Handle preset click
  const handlePresetClick = useCallback(
    (level: NoiseReductionPresetLevel) => {
      const preset = NOISE_REDUCTION_PRESETS[level];
      onChange({
        ...settings,
        algorithm: preset.algorithm,
        strength: preset.strength,
      });
    },
    [settings, onChange]
  );

  // Check if current settings match a preset
  const isPresetActive = useCallback(
    (level: NoiseReductionPresetLevel): boolean => {
      const preset = NOISE_REDUCTION_PRESETS[level];
      return (
        settings.algorithm === preset.algorithm &&
        Math.abs(settings.strength - preset.strength) < 0.01
      );
    },
    [settings]
  );

  const isControlsDisabled = disabled || !settings.enabled;

  return (
    <div
      data-testid="noise-reduction-control"
      className={`flex flex-col gap-4 p-3 bg-zinc-800 rounded-lg ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      {/* Header with toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Volume2 size={16} className="text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">Noise Reduction</h3>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          aria-label="Enable noise reduction"
          onClick={handleToggle}
          disabled={disabled}
          className={`
            relative w-10 h-5 rounded-full transition-colors
            ${settings.enabled ? 'bg-green-600' : 'bg-zinc-600'}
            ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
          `}
        >
          <span
            className={`
              absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white
              transition-transform
              ${settings.enabled ? 'translate-x-5' : 'translate-x-0'}
            `}
          />
        </button>
      </div>

      {/* Algorithm selector */}
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">Algorithm</label>
        <div ref={algorithmRef} className="relative">
          <button
            type="button"
            data-testid="algorithm-selector"
            onClick={() => !isControlsDisabled && setIsAlgorithmOpen(!isAlgorithmOpen)}
            disabled={isControlsDisabled}
            className={`
              flex items-center justify-between gap-2 w-full
              px-3 py-1.5 text-sm
              bg-zinc-700 border border-zinc-600 rounded
              text-zinc-200
              ${isControlsDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-zinc-600'}
              transition-colors
            `}
          >
            <span>{getNoiseReductionAlgorithmLabel(settings.algorithm)}</span>
            <ChevronDown
              size={14}
              className={`transition-transform ${isAlgorithmOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {isAlgorithmOpen && (
            <div
              role="listbox"
              className="absolute z-50 mt-1 w-full bg-zinc-800 border border-zinc-600 rounded shadow-lg py-1"
            >
              {ALL_NOISE_REDUCTION_ALGORITHMS.map((algo) => (
                <div
                  key={algo}
                  role="option"
                  aria-selected={settings.algorithm === algo}
                  onClick={() => handleAlgorithmChange(algo)}
                  className={`
                    px-3 py-1.5 text-sm cursor-pointer
                    ${settings.algorithm === algo
                      ? 'bg-blue-600 text-white'
                      : 'text-zinc-200 hover:bg-zinc-700'}
                    transition-colors
                  `}
                >
                  {getNoiseReductionAlgorithmLabel(algo)}
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          {NOISE_REDUCTION_ALGORITHMS[settings.algorithm]?.description.slice(0, 80)}...
        </p>
      </div>

      {/* Strength slider */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label htmlFor="nr-strength-slider" className="text-xs text-zinc-400">
            Strength
          </label>
          <span className="text-xs text-zinc-500">
            {Math.round(settings.strength * 100)}%
          </span>
        </div>
        <input
          id="nr-strength-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={settings.strength}
          onChange={handleStrengthChange}
          disabled={isControlsDisabled}
          aria-label="Strength"
          className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <p className="text-xs text-zinc-500">
          Higher values remove more noise but may affect audio quality
        </p>
      </div>

      {/* Preset buttons */}
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">Presets</label>
        <div className="flex gap-2">
          {(['light', 'medium', 'heavy'] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => handlePresetClick(level)}
              disabled={isControlsDisabled}
              aria-label={level.charAt(0).toUpperCase() + level.slice(1)}
              className={`
                flex-1 px-3 py-1.5 text-xs rounded
                ${isPresetActive(level)
                  ? 'ring-2 ring-green-400 bg-zinc-700'
                  : 'bg-zinc-700 hover:bg-zinc-600'}
                text-zinc-200 transition-all
                disabled:opacity-50 disabled:cursor-not-allowed
              `}
            >
              {level.charAt(0).toUpperCase() + level.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default NoiseReductionControl;

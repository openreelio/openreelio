/**
 * TemperatureTintPanel Component
 *
 * White balance controls with gradient-backed sliders:
 * - Temperature: blue (cool) to orange (warm)
 * - Tint: green to magenta
 *
 * Values range from -100 to +100, with 0 as neutral.
 */

import { memo, useCallback } from 'react';
import { RotateCcw } from 'lucide-react';
import type { SimpleParamValue } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface TemperatureTintPanelProps {
  /** Current effect parameters (temperature, tint) */
  params: Record<string, SimpleParamValue>;
  /** Callback when a parameter changes */
  onChange: (paramName: string, value: SimpleParamValue) => void;
  /** Whether the panel is read-only */
  readOnly?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const TEMP_MIN = -100;
const TEMP_MAX = 100;
const TINT_MIN = -100;
const TINT_MAX = 100;

/** CSS gradient for temperature slider: cool blue to warm orange */
const TEMP_GRADIENT =
  'linear-gradient(to right, #4a90d9, #6b7b8d 50%, #e8a040)';

/** CSS gradient for tint slider: green to magenta */
const TINT_GRADIENT =
  'linear-gradient(to right, #40b060, #7b7b7b 50%, #c050a0)';

// =============================================================================
// Sub-Components
// =============================================================================

interface GradientSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  gradient: string;
  leftLabel: string;
  rightLabel: string;
  onChange: (value: number) => void;
  onReset: () => void;
  readOnly: boolean;
  testId: string;
}

const GradientSlider = memo(function GradientSlider({
  label,
  value,
  min,
  max,
  gradient,
  leftLabel,
  rightLabel,
  onChange,
  onReset,
  readOnly,
  testId,
}: GradientSliderProps) {
  return (
    <div className="space-y-1.5" data-testid={testId}>
      {/* Label row */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-editor-text">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-xs tabular-nums text-editor-text-muted w-10 text-right">
            {value > 0 ? `+${value.toFixed(0)}` : value.toFixed(0)}
          </span>
          <button
            type="button"
            onClick={onReset}
            disabled={readOnly || value === 0}
            aria-label={`Reset ${label.toLowerCase()}`}
            className="p-0.5 text-editor-text-muted hover:text-editor-text rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Gradient track + range input */}
      <div className="relative h-5">
        <div
          className="absolute inset-0 rounded-sm"
          style={{ background: gradient, opacity: 0.7 }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={readOnly}
          aria-label={label}
          className="absolute inset-0 w-full h-full appearance-none bg-transparent cursor-pointer disabled:cursor-not-allowed
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-5
            [&::-webkit-slider-thumb]:rounded-sm [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border
            [&::-webkit-slider-thumb]:border-gray-400 [&::-webkit-slider-thumb]:shadow-sm
            [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-sm
            [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-gray-400
            [&::-moz-range-thumb]:shadow-sm [&::-moz-range-track]:bg-transparent"
        />
      </div>

      {/* Axis labels */}
      <div className="flex justify-between">
        <span className="text-[10px] text-editor-text-muted">{leftLabel}</span>
        <span className="text-[10px] text-editor-text-muted">{rightLabel}</span>
      </div>
    </div>
  );
});

// =============================================================================
// Main Component
// =============================================================================

export const TemperatureTintPanel = memo(function TemperatureTintPanel({
  params,
  onChange,
  readOnly = false,
}: TemperatureTintPanelProps) {
  const temperature =
    typeof params.temperature === 'number' ? params.temperature : 0;
  const tint = typeof params.tint === 'number' ? params.tint : 0;

  const handleTemperatureChange = useCallback(
    (value: number) => onChange('temperature', value),
    [onChange]
  );

  const handleTintChange = useCallback(
    (value: number) => onChange('tint', value),
    [onChange]
  );

  const resetTemperature = useCallback(
    () => onChange('temperature', 0),
    [onChange]
  );

  const resetTint = useCallback(() => onChange('tint', 0), [onChange]);

  return (
    <div className="space-y-4" data-testid="temperature-tint-panel">
      <GradientSlider
        label="Temperature"
        value={temperature}
        min={TEMP_MIN}
        max={TEMP_MAX}
        gradient={TEMP_GRADIENT}
        leftLabel="Cool"
        rightLabel="Warm"
        onChange={handleTemperatureChange}
        onReset={resetTemperature}
        readOnly={readOnly}
        testId="temperature-slider"
      />

      <GradientSlider
        label="Tint"
        value={tint}
        min={TINT_MIN}
        max={TINT_MAX}
        gradient={TINT_GRADIENT}
        leftLabel="Green"
        rightLabel="Magenta"
        onChange={handleTintChange}
        onReset={resetTint}
        readOnly={readOnly}
        testId="tint-slider"
      />
    </div>
  );
});

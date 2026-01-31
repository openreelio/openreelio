/**
 * ColorWheelsPanel Component
 *
 * Visual 3-way color corrector panel for Lift/Gamma/Gain adjustments.
 * Provides intuitive RGB sliders organized by tonal range:
 * - Lift: Affects shadows (dark regions)
 * - Gamma: Affects midtones (mid-luminance)
 * - Gain: Affects highlights (bright regions)
 *
 * Each adjustment ranges from -1.0 to 1.0 where:
 * - Negative values reduce the color channel
 * - Positive values increase the color channel
 * - 0.0 is neutral (no change)
 */

import { memo, useCallback } from 'react';
import { RotateCcw, CircleDot } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

/** Color wheel parameter names */
export type ColorWheelsParamName =
  | 'lift_r'
  | 'lift_g'
  | 'lift_b'
  | 'gamma_r'
  | 'gamma_g'
  | 'gamma_b'
  | 'gain_r'
  | 'gain_g'
  | 'gain_b';

/** Values for all color wheel parameters */
export interface ColorWheelsValues {
  lift_r: number;
  lift_g: number;
  lift_b: number;
  gamma_r: number;
  gamma_g: number;
  gamma_b: number;
  gain_r: number;
  gain_g: number;
  gain_b: number;
}

/** Component props */
export interface ColorWheelsPanelProps {
  /** Current parameter values */
  values: ColorWheelsValues;
  /** Callback when a parameter changes */
  onChange: (paramName: ColorWheelsParamName, value: number) => void;
  /** Callback when reset button is clicked */
  onReset?: () => void;
  /** Whether the panel is read-only */
  readOnly?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const MIN_VALUE = -1;
const MAX_VALUE = 1;
const STEP = 0.01;

/** Section definitions */
const SECTIONS = [
  {
    name: 'Lift',
    description: 'Shadows',
    prefix: 'lift' as const,
    color: 'from-slate-700 to-slate-600',
  },
  {
    name: 'Gamma',
    description: 'Midtones',
    prefix: 'gamma' as const,
    color: 'from-slate-600 to-slate-500',
  },
  {
    name: 'Gain',
    description: 'Highlights',
    prefix: 'gain' as const,
    color: 'from-slate-500 to-slate-400',
  },
] as const;

/** RGB channel definitions */
const CHANNELS = [
  { name: 'R', suffix: 'r' as const, color: 'bg-red-500', hoverColor: 'hover:bg-red-400' },
  { name: 'G', suffix: 'g' as const, color: 'bg-green-500', hoverColor: 'hover:bg-green-400' },
  { name: 'B', suffix: 'b' as const, color: 'bg-blue-500', hoverColor: 'hover:bg-blue-400' },
] as const;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Converts RGB adjustments to a preview color.
 * Maps -1 to 1 range to visible color differences.
 */
function getPreviewColor(r: number, g: number, b: number): string {
  // Convert -1 to 1 to 0 to 255 range (centered at 128)
  const red = Math.round(128 + r * 64);
  const green = Math.round(128 + g * 64);
  const blue = Math.round(128 + b * 64);
  return `rgb(${red}, ${green}, ${blue})`;
}

/**
 * Formats a value for display.
 */
function formatValue(value: number): string {
  return value.toFixed(2);
}

// =============================================================================
// Sub-components
// =============================================================================

interface ColorSliderProps {
  paramName: ColorWheelsParamName;
  channelName: string;
  value: number;
  onChange: (value: number) => void;
  readOnly: boolean;
  color: string;
}

const ColorSlider = memo(function ColorSlider({
  paramName,
  channelName,
  value,
  onChange,
  readOnly,
  color,
}: ColorSliderProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(parseFloat(e.target.value));
    },
    [onChange]
  );

  // Get section name from paramName (e.g., "lift_r" -> "Lift")
  const sectionName = paramName.split('_')[0].charAt(0).toUpperCase() + paramName.split('_')[0].slice(1);
  // Get full color name (R -> Red, G -> Green, B -> Blue)
  const colorNames: Record<string, string> = { R: 'Red', G: 'Green', B: 'Blue' };
  const fullColorName = colorNames[channelName] ?? channelName;

  return (
    <div className="flex items-center gap-2">
      <span
        className={`w-5 h-5 rounded-full ${color} flex items-center justify-center text-[10px] font-bold text-white`}
      >
        {channelName}
      </span>
      <input
        type="range"
        aria-label={`${sectionName} ${fullColorName}`}
        data-testid={`slider-${paramName}`}
        min={MIN_VALUE}
        max={MAX_VALUE}
        step={STEP}
        value={value}
        onChange={handleChange}
        disabled={readOnly}
        className="flex-1 h-1.5 bg-editor-border rounded-lg appearance-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:w-3
          [&::-webkit-slider-thumb]:h-3
          [&::-webkit-slider-thumb]:rounded-full
          [&::-webkit-slider-thumb]:bg-editor-text
          [&::-webkit-slider-thumb]:cursor-pointer
          [&::-webkit-slider-thumb]:transition-transform
          [&::-webkit-slider-thumb]:hover:scale-110
          [&::-moz-range-thumb]:w-3
          [&::-moz-range-thumb]:h-3
          [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:bg-editor-text
          [&::-moz-range-thumb]:border-0
          [&::-moz-range-thumb]:cursor-pointer"
      />
      <span
        data-testid={`value-${paramName}`}
        className="w-12 text-right text-xs text-editor-text-muted font-mono"
      >
        {formatValue(value)}
      </span>
    </div>
  );
});

interface ColorWheelSectionProps {
  name: string;
  description: string;
  prefix: 'lift' | 'gamma' | 'gain';
  values: ColorWheelsValues;
  onChange: (paramName: ColorWheelsParamName, value: number) => void;
  readOnly: boolean;
}

const ColorWheelSection = memo(function ColorWheelSection({
  name,
  description,
  prefix,
  values,
  onChange,
  readOnly,
}: ColorWheelSectionProps) {
  const rValue = values[`${prefix}_r`];
  const gValue = values[`${prefix}_g`];
  const bValue = values[`${prefix}_b`];

  const previewColor = getPreviewColor(rValue, gValue, bValue);

  return (
    <div className="space-y-2">
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-editor-text">{name}</h4>
          <p className="text-xs text-editor-text-muted">{description}</p>
        </div>
        {/* Color Preview */}
        <div
          data-testid={`color-preview-${prefix}`}
          className="w-8 h-8 rounded-full border border-editor-border shadow-inner"
          style={{ backgroundColor: previewColor }}
        />
      </div>

      {/* RGB Sliders */}
      <div className="space-y-1.5">
        {CHANNELS.map((channel) => {
          const paramName = `${prefix}_${channel.suffix}` as ColorWheelsParamName;
          return (
            <ColorSlider
              key={paramName}
              paramName={paramName}
              channelName={channel.name}
              value={values[paramName]}
              onChange={(value) => onChange(paramName, value)}
              readOnly={readOnly}
              color={channel.color}
            />
          );
        })}
      </div>
    </div>
  );
});

// =============================================================================
// Main Component
// =============================================================================

export const ColorWheelsPanel = memo(function ColorWheelsPanel({
  values,
  onChange,
  onReset,
  readOnly = false,
  className = '',
}: ColorWheelsPanelProps) {
  return (
    <div
      data-testid="color-wheels-panel"
      className={`flex flex-col gap-4 p-3 bg-editor-sidebar rounded-lg ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CircleDot className="w-4 h-4 text-purple-400" />
          <h3 className="text-sm font-semibold text-editor-text">Color Wheels</h3>
        </div>
        {onReset && !readOnly && (
          <button
            type="button"
            onClick={onReset}
            aria-label="Reset color wheels"
            className="flex items-center gap-1 px-2 py-1 text-xs text-editor-text-muted hover:text-editor-text rounded transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
        )}
      </div>

      {/* Color Wheel Sections */}
      <div className="space-y-4">
        {SECTIONS.map((section) => (
          <ColorWheelSection
            key={section.prefix}
            name={section.name}
            description={section.description}
            prefix={section.prefix}
            values={values}
            onChange={onChange}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  );
});

export default ColorWheelsPanel;

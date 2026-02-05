/**
 * QualifierPanel Component
 *
 * HSL-based selective color correction panel.
 * Provides controls for hue, saturation, and luminance selection
 * with adjustment sliders and preset buttons.
 *
 * @module components/features/qualifier/QualifierPanel
 */

import React, { useCallback } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, Eye, EyeOff } from 'lucide-react';
import {
  type QualifierValues,
  DEFAULT_QUALIFIER_VALUES,
  QUALIFIER_PRESETS,
  QUALIFIER_CONSTRAINTS,
} from '@/types/qualifier';

// =============================================================================
// Types
// =============================================================================

export interface QualifierPanelProps {
  /** Current qualifier values */
  values: QualifierValues;
  /** Called when any value changes */
  onChange: (values: QualifierValues) => void;
  /** Whether panel is collapsed */
  collapsed?: boolean;
  /** Called when collapsed state changes */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Whether to show preview toggle button */
  showPreviewToggle?: boolean;
  /** Whether mask preview is enabled */
  previewEnabled?: boolean;
  /** Called when preview mode changes */
  onPreviewChange?: (enabled: boolean) => void;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const HUE_COLORS = [
  { hue: 0, color: '#FF0000' },
  { hue: 60, color: '#FFFF00' },
  { hue: 120, color: '#00FF00' },
  { hue: 180, color: '#00FFFF' },
  { hue: 240, color: '#0000FF' },
  { hue: 300, color: '#FF00FF' },
  { hue: 360, color: '#FF0000' },
];

// =============================================================================
// Helper Components
// =============================================================================

interface SliderInputProps {
  label: string;
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  unit?: string;
}

function SliderInput({
  label,
  id,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  unit = '',
}: SliderInputProps) {
  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(parseFloat(e.target.value));
    },
    [onChange]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val)) {
        onChange(Math.min(max, Math.max(min, val)));
      }
    },
    [onChange, min, max]
  );

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-zinc-400 w-20 shrink-0">
        {label}
      </label>
      <input
        type="range"
        id={id}
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={handleSliderChange}
        disabled={disabled}
        className="flex-1 h-1.5 bg-zinc-700 rounded-full appearance-none cursor-pointer
                   [&::-webkit-slider-thumb]:appearance-none
                   [&::-webkit-slider-thumb]:w-3
                   [&::-webkit-slider-thumb]:h-3
                   [&::-webkit-slider-thumb]:bg-white
                   [&::-webkit-slider-thumb]:rounded-full
                   [&::-webkit-slider-thumb]:cursor-pointer
                   disabled:opacity-50 disabled:cursor-not-allowed"
      />
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={handleInputChange}
        onBlur={handleInputChange}
        disabled={disabled}
        className="w-16 px-1.5 py-0.5 text-xs bg-zinc-800 border border-zinc-600
                   rounded text-right text-zinc-200
                   disabled:opacity-50 disabled:cursor-not-allowed"
      />
      {unit && <span className="text-xs text-zinc-500 w-4">{unit}</span>}
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export function QualifierPanel({
  values,
  onChange,
  collapsed = false,
  onCollapsedChange,
  disabled = false,
  showPreviewToggle = false,
  previewEnabled = false,
  onPreviewChange,
  className = '',
}: QualifierPanelProps) {
  // Handle individual value changes with range validation
  const updateValue = useCallback(
    <K extends keyof QualifierValues>(key: K, value: QualifierValues[K]) => {
      const newValues = { ...values, [key]: value };

      // Validate range constraints: min must not exceed max
      if (key === 'sat_min' && typeof value === 'number' && value > values.sat_max) {
        newValues.sat_min = values.sat_max;
      } else if (key === 'sat_max' && typeof value === 'number' && value < values.sat_min) {
        newValues.sat_max = values.sat_min;
      } else if (key === 'lum_min' && typeof value === 'number' && value > values.lum_max) {
        newValues.lum_min = values.lum_max;
      } else if (key === 'lum_max' && typeof value === 'number' && value < values.lum_min) {
        newValues.lum_max = values.lum_min;
      }

      onChange(newValues);
    },
    [values, onChange]
  );

  // Handle preset selection
  const applyPreset = useCallback(
    (preset: keyof typeof QUALIFIER_PRESETS) => {
      onChange(QUALIFIER_PRESETS[preset]);
    },
    [onChange]
  );

  // Handle reset
  const handleReset = useCallback(() => {
    onChange(DEFAULT_QUALIFIER_VALUES);
  }, [onChange]);

  // Toggle collapsed state
  const toggleCollapsed = useCallback(() => {
    onCollapsedChange?.(!collapsed);
  }, [collapsed, onCollapsedChange]);

  // Toggle preview mode
  const togglePreview = useCallback(() => {
    onPreviewChange?.(!previewEnabled);
  }, [previewEnabled, onPreviewChange]);

  // Generate hue gradient for visual feedback
  const hueGradient = HUE_COLORS.map(
    ({ hue, color }) => `${color} ${(hue / 360) * 100}%`
  ).join(', ');

  return (
    <div
      data-testid="qualifier-panel"
      className={`bg-zinc-900 rounded-lg border border-zinc-700 ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-zinc-700">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-center gap-2 text-sm font-medium text-zinc-200 hover:text-white transition-colors"
          aria-label="HSL Qualifier"
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          HSL Qualifier
        </button>

        <div className="flex items-center gap-2">
          {/* Preview toggle */}
          {showPreviewToggle && (
            <button
              type="button"
              onClick={togglePreview}
              className={`p-1.5 rounded transition-colors ${
                previewEnabled
                  ? 'bg-blue-600 text-white'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
              }`}
              aria-label="Show Mask"
              disabled={disabled}
            >
              {previewEnabled ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
          )}

          {/* Reset button */}
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
            aria-label="Reset"
            disabled={disabled}
          >
            <RotateCcw size={12} />
            Reset
          </button>
        </div>
      </div>

      {/* Content (collapsible) */}
      {!collapsed && (
        <div className="p-4 space-y-4">
          {/* Preset Buttons */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => applyPreset('skin_tones')}
              disabled={disabled}
              className="flex-1 px-2 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700
                         border border-zinc-600 rounded text-zinc-200
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Skin Tones
            </button>
            <button
              type="button"
              onClick={() => applyPreset('sky_blue')}
              disabled={disabled}
              className="flex-1 px-2 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700
                         border border-zinc-600 rounded text-zinc-200
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Sky Blue
            </button>
            <button
              type="button"
              onClick={() => applyPreset('foliage')}
              disabled={disabled}
              className="flex-1 px-2 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700
                         border border-zinc-600 rounded text-zinc-200
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Foliage
            </button>
          </div>

          {/* Hue Section */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
              Hue Selection
            </h4>
            {/* Hue gradient bar */}
            <div
              className="h-2 rounded"
              style={{ background: `linear-gradient(to right, ${hueGradient})` }}
            />
            <SliderInput
              label="Hue Center"
              id="hue-center"
              value={values.hue_center}
              min={QUALIFIER_CONSTRAINTS.hue_center.min}
              max={QUALIFIER_CONSTRAINTS.hue_center.max}
              step={QUALIFIER_CONSTRAINTS.hue_center.step}
              onChange={(v) => updateValue('hue_center', v)}
              disabled={disabled}
              unit="°"
            />
            <SliderInput
              label="Hue Width"
              id="hue-width"
              value={values.hue_width}
              min={QUALIFIER_CONSTRAINTS.hue_width.min}
              max={QUALIFIER_CONSTRAINTS.hue_width.max}
              step={QUALIFIER_CONSTRAINTS.hue_width.step}
              onChange={(v) => updateValue('hue_width', v)}
              disabled={disabled}
              unit="°"
            />
          </div>

          {/* Saturation Section */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
              Saturation Range
            </h4>
            <SliderInput
              label="Sat Min"
              id="sat-min"
              value={values.sat_min}
              min={QUALIFIER_CONSTRAINTS.sat_min.min}
              max={QUALIFIER_CONSTRAINTS.sat_min.max}
              step={QUALIFIER_CONSTRAINTS.sat_min.step}
              onChange={(v) => updateValue('sat_min', v)}
              disabled={disabled}
            />
            <SliderInput
              label="Sat Max"
              id="sat-max"
              value={values.sat_max}
              min={QUALIFIER_CONSTRAINTS.sat_max.min}
              max={QUALIFIER_CONSTRAINTS.sat_max.max}
              step={QUALIFIER_CONSTRAINTS.sat_max.step}
              onChange={(v) => updateValue('sat_max', v)}
              disabled={disabled}
            />
          </div>

          {/* Luminance Section */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
              Luminance Range
            </h4>
            <SliderInput
              label="Lum Min"
              id="lum-min"
              value={values.lum_min}
              min={QUALIFIER_CONSTRAINTS.lum_min.min}
              max={QUALIFIER_CONSTRAINTS.lum_min.max}
              step={QUALIFIER_CONSTRAINTS.lum_min.step}
              onChange={(v) => updateValue('lum_min', v)}
              disabled={disabled}
            />
            <SliderInput
              label="Lum Max"
              id="lum-max"
              value={values.lum_max}
              min={QUALIFIER_CONSTRAINTS.lum_max.min}
              max={QUALIFIER_CONSTRAINTS.lum_max.max}
              step={QUALIFIER_CONSTRAINTS.lum_max.step}
              onChange={(v) => updateValue('lum_max', v)}
              disabled={disabled}
            />
          </div>

          {/* Softness & Invert */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
              Selection Options
            </h4>
            <SliderInput
              label="Softness"
              id="softness"
              value={values.softness}
              min={QUALIFIER_CONSTRAINTS.softness.min}
              max={QUALIFIER_CONSTRAINTS.softness.max}
              step={QUALIFIER_CONSTRAINTS.softness.step}
              onChange={(v) => updateValue('softness', v)}
              disabled={disabled}
            />
            <div className="flex items-center gap-2">
              <label
                htmlFor="invert-selection"
                className="text-xs text-zinc-400 w-20 shrink-0"
              >
                Invert Selection
              </label>
              <input
                type="checkbox"
                id="invert-selection"
                aria-label="Invert Selection"
                checked={values.invert}
                onChange={(e) => updateValue('invert', e.target.checked)}
                disabled={disabled}
                className="w-4 h-4 rounded border-zinc-600 bg-zinc-800
                           text-blue-600 focus:ring-blue-500 focus:ring-offset-zinc-900
                           disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
          </div>

          {/* Adjustment Section */}
          <div className="space-y-2 pt-2 border-t border-zinc-700">
            <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
              Color Adjustments
            </h4>
            <SliderInput
              label="Hue Shift"
              id="hue-shift"
              value={values.hue_shift}
              min={QUALIFIER_CONSTRAINTS.hue_shift.min}
              max={QUALIFIER_CONSTRAINTS.hue_shift.max}
              step={QUALIFIER_CONSTRAINTS.hue_shift.step}
              onChange={(v) => updateValue('hue_shift', v)}
              disabled={disabled}
              unit="°"
            />
            <SliderInput
              label="Saturation Adjust"
              id="sat-adjust"
              value={values.sat_adjust}
              min={QUALIFIER_CONSTRAINTS.sat_adjust.min}
              max={QUALIFIER_CONSTRAINTS.sat_adjust.max}
              step={QUALIFIER_CONSTRAINTS.sat_adjust.step}
              onChange={(v) => updateValue('sat_adjust', v)}
              disabled={disabled}
            />
            <SliderInput
              label="Luminance Adjust"
              id="lum-adjust"
              value={values.lum_adjust}
              min={QUALIFIER_CONSTRAINTS.lum_adjust.min}
              max={QUALIFIER_CONSTRAINTS.lum_adjust.max}
              step={QUALIFIER_CONSTRAINTS.lum_adjust.step}
              onChange={(v) => updateValue('lum_adjust', v)}
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default QualifierPanel;

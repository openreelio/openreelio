/**
 * ColorWheelsPanel Component
 *
 * Complete Lift/Gamma/Gain color grading panel.
 * Industry-standard primary color correction interface.
 *
 * Features:
 * - Three color wheels for shadows, midtones, highlights
 * - Luminance sliders for each wheel
 * - Reset individual or all wheels
 * - Preset support
 * - Collapsible panel
 *
 * @module components/features/colorGrading/ColorWheelsPanel
 */

import React, { useCallback } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { ColorWheelControl } from './ColorWheelControl';
import {
  type LiftGammaGain,
  type ColorOffset,
  createNeutralLGG,
} from '@/utils/colorWheel';

// =============================================================================
// Types
// =============================================================================

export interface WheelLuminance {
  lift: number;
  gamma: number;
  gain: number;
}

export interface ColorPreset {
  name: string;
  value: LiftGammaGain;
  luminance?: WheelLuminance;
}

export interface ColorWheelsPanelProps {
  /** Current Lift/Gamma/Gain values */
  value: LiftGammaGain;
  /** Current luminance values for each wheel */
  luminance: WheelLuminance;
  /** Called when any LGG value changes */
  onChange: (value: LiftGammaGain) => void;
  /** Called when any luminance value changes */
  onLuminanceChange: (luminance: WheelLuminance) => void;
  /** Layout direction */
  layout?: 'horizontal' | 'vertical';
  /** Whether panel is collapsed */
  collapsed?: boolean;
  /** Called when collapsed state changes */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Available presets */
  presets?: ColorPreset[];
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_LUMINANCE: WheelLuminance = {
  lift: 0,
  gamma: 0,
  gain: 0,
};

// =============================================================================
// Component
// =============================================================================

export function ColorWheelsPanel({
  value,
  luminance,
  onChange,
  onLuminanceChange,
  layout = 'horizontal',
  collapsed = false,
  onCollapsedChange,
  disabled = false,
  presets,
  className = '',
}: ColorWheelsPanelProps) {
  // Handle individual wheel changes
  const handleLiftChange = useCallback(
    (offset: ColorOffset) => {
      onChange({ ...value, lift: offset });
    },
    [value, onChange]
  );

  const handleGammaChange = useCallback(
    (offset: ColorOffset) => {
      onChange({ ...value, gamma: offset });
    },
    [value, onChange]
  );

  const handleGainChange = useCallback(
    (offset: ColorOffset) => {
      onChange({ ...value, gain: offset });
    },
    [value, onChange]
  );

  // Handle individual luminance changes
  const handleLiftLuminanceChange = useCallback(
    (val: number) => {
      onLuminanceChange({ ...luminance, lift: val });
    },
    [luminance, onLuminanceChange]
  );

  const handleGammaLuminanceChange = useCallback(
    (val: number) => {
      onLuminanceChange({ ...luminance, gamma: val });
    },
    [luminance, onLuminanceChange]
  );

  const handleGainLuminanceChange = useCallback(
    (val: number) => {
      onLuminanceChange({ ...luminance, gain: val });
    },
    [luminance, onLuminanceChange]
  );

  // Reset all wheels
  const handleResetAll = useCallback(() => {
    onChange(createNeutralLGG());
    onLuminanceChange(DEFAULT_LUMINANCE);
  }, [onChange, onLuminanceChange]);

  // Toggle collapsed state
  const handleToggleCollapsed = useCallback(() => {
    onCollapsedChange?.(!collapsed);
  }, [collapsed, onCollapsedChange]);

  // Apply preset
  const handlePresetChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const presetName = e.target.value;
      if (!presetName || !presets) return;

      const preset = presets.find((p) => p.name === presetName);
      if (preset) {
        onChange(preset.value);
        if (preset.luminance) {
          onLuminanceChange(preset.luminance);
        }
      }
    },
    [presets, onChange, onLuminanceChange]
  );

  return (
    <div
      data-testid="color-wheels-panel"
      data-collapsed={collapsed}
      className={`bg-zinc-900 rounded-lg border border-zinc-700 ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-zinc-700">
        <button
          type="button"
          onClick={handleToggleCollapsed}
          className="flex items-center gap-2 text-sm font-medium text-zinc-200 hover:text-white transition-colors"
          aria-label="Color Wheels"
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          Color Wheels
        </button>

        <div className="flex items-center gap-2">
          {/* Preset selector */}
          {presets && presets.length > 0 && (
            <select
              onChange={handlePresetChange}
              className="text-xs bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-zinc-300"
              aria-label="Preset"
              disabled={disabled}
              defaultValue=""
            >
              <option value="">Preset...</option>
              {presets.map((preset) => (
                <option key={preset.name} value={preset.name}>
                  {preset.name}
                </option>
              ))}
            </select>
          )}

          {/* Reset all button */}
          <button
            type="button"
            onClick={handleResetAll}
            className="flex items-center gap-1 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 rounded transition-colors"
            aria-label="Reset all"
            disabled={disabled}
          >
            <RotateCcw size={12} />
            Reset All
          </button>
        </div>
      </div>

      {/* Wheels container (collapsible) */}
      {!collapsed && (
        <div
          data-testid="wheels-container"
          className={`p-4 flex gap-6 justify-center ${
            layout === 'horizontal' ? 'flex-row' : 'flex-col items-center'
          }`}
        >
          {/* Lift (Shadows) */}
          <ColorWheelControl
            label="Lift"
            value={value.lift}
            luminance={luminance.lift}
            onChange={handleLiftChange}
            onLuminanceChange={handleLiftLuminanceChange}
            disabled={disabled}
          />

          {/* Gamma (Midtones) */}
          <ColorWheelControl
            label="Gamma"
            value={value.gamma}
            luminance={luminance.gamma}
            onChange={handleGammaChange}
            onLuminanceChange={handleGammaLuminanceChange}
            disabled={disabled}
          />

          {/* Gain (Highlights) */}
          <ColorWheelControl
            label="Gain"
            value={value.gain}
            luminance={luminance.gain}
            onChange={handleGainChange}
            onLuminanceChange={handleGainLuminanceChange}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

export default ColorWheelsPanel;

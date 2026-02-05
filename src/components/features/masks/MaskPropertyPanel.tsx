/**
 * MaskPropertyPanel Component
 *
 * Property editor for mask attributes (feather, opacity, expansion, etc.).
 *
 * @module components/features/masks/MaskPropertyPanel
 */

import React, { useCallback } from 'react';
import type { Mask, MaskBlendMode } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface MaskPropertyPanelProps {
  /** The mask to edit (null if none selected) */
  mask: Mask | null;
  /** Called when mask properties change */
  onChange: (mask: Mask) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const BLEND_MODES: { value: MaskBlendMode; label: string }[] = [
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'intersect', label: 'Intersect' },
  { value: 'difference', label: 'Difference' },
];

// =============================================================================
// Helper Components
// =============================================================================

interface SliderRowProps {
  label: string;
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

function SliderRow({
  label,
  id,
  value,
  min,
  max,
  step,
  onChange,
  disabled,
}: SliderRowProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(parseFloat(e.target.value));
    },
    [onChange]
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
        onChange={handleChange}
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
      <span className="text-xs text-zinc-500 w-10 text-right">
        {value.toFixed(2)}
      </span>
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export function MaskPropertyPanel({
  mask,
  onChange,
  disabled = false,
  className = '',
}: MaskPropertyPanelProps) {
  const isDisabled = disabled || Boolean(mask?.locked);

  // Update a single property
  const updateProperty = useCallback(
    <K extends keyof Mask>(key: K, value: Mask[K]) => {
      if (!mask) return;
      onChange({ ...mask, [key]: value });
    },
    [mask, onChange]
  );

  // Handle name change
  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateProperty('name', e.target.value);
    },
    [updateProperty]
  );

  // Handle blend mode change
  const handleBlendModeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateProperty('blendMode', e.target.value as MaskBlendMode);
    },
    [updateProperty]
  );

  // Handle invert toggle
  const handleInvertChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateProperty('inverted', e.target.checked);
    },
    [updateProperty]
  );

  // Early return if no mask selected
  if (!mask) {
    return null;
  }

  return (
    <div
      data-testid="mask-property-panel"
      className={`bg-zinc-900 rounded-lg border border-zinc-700 ${className}`}
    >
      {/* Header */}
      <div className="p-2 border-b border-zinc-700">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
          Mask Properties
        </span>
      </div>

      {/* Properties */}
      <div className="p-3 space-y-3">
        {/* Name */}
        <div className="flex items-center gap-2">
          <label htmlFor="mask-name" className="text-xs text-zinc-400 w-20 shrink-0">
            Name
          </label>
          <input
            type="text"
            id="mask-name"
            aria-label="Name"
            value={mask.name}
            onChange={handleNameChange}
            disabled={isDisabled}
            className="flex-1 px-2 py-1 text-xs bg-zinc-800 border border-zinc-600
                       rounded text-zinc-200
                       disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>

        {/* Feather */}
        <SliderRow
          label="Feather"
          id="mask-feather"
          value={mask.feather}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => updateProperty('feather', v)}
          disabled={isDisabled}
        />

        {/* Opacity */}
        <SliderRow
          label="Opacity"
          id="mask-opacity"
          value={mask.opacity}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => updateProperty('opacity', v)}
          disabled={isDisabled}
        />

        {/* Expansion */}
        <SliderRow
          label="Expansion"
          id="mask-expansion"
          value={mask.expansion}
          min={-1}
          max={1}
          step={0.01}
          onChange={(v) => updateProperty('expansion', v)}
          disabled={isDisabled}
        />

        {/* Blend Mode */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="mask-blend-mode"
            className="text-xs text-zinc-400 w-20 shrink-0"
          >
            Blend Mode
          </label>
          <select
            id="mask-blend-mode"
            aria-label="Blend Mode"
            value={mask.blendMode}
            onChange={handleBlendModeChange}
            disabled={isDisabled}
            className="flex-1 px-2 py-1 text-xs bg-zinc-800 border border-zinc-600
                       rounded text-zinc-200
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {BLEND_MODES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {/* Invert */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="mask-invert"
            className="text-xs text-zinc-400 w-20 shrink-0"
          >
            Invert
          </label>
          <input
            type="checkbox"
            id="mask-invert"
            aria-label="Invert"
            checked={mask.inverted}
            onChange={handleInvertChange}
            disabled={isDisabled}
            className="w-4 h-4 rounded border-zinc-600 bg-zinc-800
                       text-blue-600 focus:ring-blue-500 focus:ring-offset-zinc-900
                       disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>
      </div>
    </div>
  );
}

export default MaskPropertyPanel;

/**
 * HDRSettingsPanel Component
 *
 * Panel for configuring HDR (High Dynamic Range) export settings.
 * Includes color space, transfer function, and luminance configuration.
 *
 * @module components/features/hdr/HDRSettingsPanel
 */

import React, { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, Check, AlertTriangle } from 'lucide-react';
import { useHDRSettings, type HdrPreset } from '@/hooks/useHDRSettings';
import type { HdrMode } from '@/types/hdr';
import type { SequenceId } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface HDRSettingsPanelProps {
  /** The sequence to configure */
  sequenceId: SequenceId;
  /** Whether the panel is collapsed */
  collapsed?: boolean;
  /** Whether the panel can be collapsed */
  collapsible?: boolean;
  /** Called when collapsed state changes */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const HDR_MODE_OPTIONS: Array<{ value: HdrMode; label: string; description: string }> = [
  { value: 'sdr', label: 'SDR', description: 'Standard Dynamic Range (Rec.709)' },
  { value: 'hdr10', label: 'HDR10', description: 'HDR10 (PQ / ST.2084)' },
  { value: 'hlg', label: 'HLG', description: 'Hybrid Log-Gamma (Broadcast HDR)' },
];

const BIT_DEPTH_OPTIONS: Array<{ value: 8 | 10 | 12; label: string }> = [
  { value: 8, label: '8-bit' },
  { value: 10, label: '10-bit' },
  { value: 12, label: '12-bit' },
];

// =============================================================================
// Component
// =============================================================================

export function HDRSettingsPanel({
  sequenceId,
  collapsed: controlledCollapsed,
  collapsible = false,
  onCollapsedChange,
  disabled = false,
  className = '',
}: HDRSettingsPanelProps) {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [showSavedMessage, setShowSavedMessage] = useState(false);

  const isCollapsed = controlledCollapsed ?? internalCollapsed;

  // ---------------------------------------------------------------------------
  // Hook: HDR Settings
  // ---------------------------------------------------------------------------

  const {
    settings,
    isHdr,
    setHdrMode,
    setMaxCll,
    setMaxFall,
    setBitDepth,
    applyPreset,
    save,
    reset,
    validationWarning,
    isDirty,
    isSaving,
    error,
  } = useHDRSettings({ sequenceId });

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleToggleCollapsed = useCallback(() => {
    if (!collapsible) return;

    const newCollapsed = !isCollapsed;
    setInternalCollapsed(newCollapsed);
    onCollapsedChange?.(newCollapsed);
  }, [collapsible, isCollapsed, onCollapsedChange]);

  const handleModeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setHdrMode(e.target.value as HdrMode);
    },
    [setHdrMode]
  );

  const handleBitDepthChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setBitDepth(Number(e.target.value) as 8 | 10 | 12);
    },
    [setBitDepth]
  );

  const handleMaxCllChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setMaxCll(Number(e.target.value));
    },
    [setMaxCll]
  );

  const handleMaxFallChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setMaxFall(Number(e.target.value));
    },
    [setMaxFall]
  );

  const handleApplyPreset = useCallback(
    (preset: HdrPreset) => {
      applyPreset(preset);
    },
    [applyPreset]
  );

  const handleSave = useCallback(async () => {
    try {
      const success = await save();
      if (success) {
        setShowSavedMessage(true);
        setTimeout(() => setShowSavedMessage(false), 2000);
      }
    } catch (err) {
      // Error is already handled by the hook, but log for debugging
      console.error('HDRSettingsPanel: Save operation failed', err);
    }
  }, [save]);

  const handleReset = useCallback(() => {
    reset();
  }, [reset]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      data-testid="hdr-settings-panel"
      className={`bg-zinc-900 rounded-lg border border-zinc-700 ${className}`}
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between p-3 border-b border-zinc-700 ${
          collapsible ? 'cursor-pointer hover:bg-zinc-800/50' : ''
        }`}
        onClick={collapsible ? handleToggleCollapsed : undefined}
      >
        <div className="flex items-center gap-2">
          {collapsible && (
            <span className="text-zinc-400">
              {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            </span>
          )}
          <h3 className="text-sm font-medium text-zinc-200">HDR Settings</h3>
          {isHdr && (
            <span className="px-1.5 py-0.5 text-xs font-medium bg-orange-500 text-white rounded">
              HDR
            </span>
          )}
        </div>

        {showSavedMessage && (
          <span className="flex items-center gap-1 text-xs text-green-400">
            <Check size={14} />
            Saved
          </span>
        )}
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="p-4 space-y-4">
          {/* Error */}
          {error && (
            <div className="p-2 text-sm text-red-400 bg-red-900/30 rounded border border-red-700">
              {error}
            </div>
          )}

          {/* Preset Buttons */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleApplyPreset('sdr')}
              disabled={disabled}
              aria-label="SDR Preset"
              className="flex-1 px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700
                         border border-zinc-600 rounded text-zinc-200
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              SDR
            </button>
            <button
              type="button"
              onClick={() => handleApplyPreset('hdr10')}
              disabled={disabled}
              aria-label="HDR10 Preset"
              className="flex-1 px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700
                         border border-zinc-600 rounded text-zinc-200
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              HDR10
            </button>
            <button
              type="button"
              onClick={() => handleApplyPreset('hlg')}
              disabled={disabled}
              aria-label="HLG Preset"
              className="flex-1 px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700
                         border border-zinc-600 rounded text-zinc-200
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              HLG
            </button>
          </div>

          {/* HDR Mode */}
          <div className="space-y-1">
            <label htmlFor="hdr-mode" className="text-xs text-zinc-400">
              HDR Mode
            </label>
            <select
              id="hdr-mode"
              aria-label="HDR Mode"
              value={settings.hdrMode}
              onChange={handleModeChange}
              disabled={disabled}
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-600
                         rounded text-zinc-200 focus:border-blue-500 focus:outline-none
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {HDR_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} - {option.description}
                </option>
              ))}
            </select>
          </div>

          {/* Bit Depth */}
          <div className="space-y-1">
            <label htmlFor="bit-depth" className="text-xs text-zinc-400">
              Bit Depth
            </label>
            <select
              id="bit-depth"
              aria-label="Bit Depth"
              value={settings.bitDepth}
              onChange={handleBitDepthChange}
              disabled={disabled}
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-600
                         rounded text-zinc-200 focus:border-blue-500 focus:outline-none
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {BIT_DEPTH_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/* Validation Warning */}
          {validationWarning && (
            <div className="flex items-start gap-2 p-2 text-xs text-yellow-400 bg-yellow-900/30 rounded border border-yellow-700">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>{validationWarning}</span>
            </div>
          )}

          {/* HDR-specific settings */}
          {isHdr && (
            <div className="space-y-4 pt-4 border-t border-zinc-700">
              <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                Luminance Settings
              </h4>

              {/* Max CLL */}
              <div className="space-y-1">
                <div className="flex justify-between">
                  <label htmlFor="max-cll" className="text-xs text-zinc-400">
                    Max CLL (Content Light Level)
                  </label>
                  <span className="text-xs text-zinc-500">{settings.maxCll ?? 1000} nits</span>
                </div>
                <input
                  type="range"
                  id="max-cll"
                  aria-label="Max CLL"
                  value={settings.maxCll ?? 1000}
                  min={100}
                  max={10000}
                  step={100}
                  onChange={handleMaxCllChange}
                  disabled={disabled}
                  className="w-full h-1.5 bg-zinc-700 rounded-full appearance-none cursor-pointer
                             [&::-webkit-slider-thumb]:appearance-none
                             [&::-webkit-slider-thumb]:w-3
                             [&::-webkit-slider-thumb]:h-3
                             [&::-webkit-slider-thumb]:bg-orange-500
                             [&::-webkit-slider-thumb]:rounded-full
                             [&::-webkit-slider-thumb]:cursor-pointer
                             disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>

              {/* Max FALL */}
              <div className="space-y-1">
                <div className="flex justify-between">
                  <label htmlFor="max-fall" className="text-xs text-zinc-400">
                    Max FALL (Frame-Average Light Level)
                  </label>
                  <span className="text-xs text-zinc-500">{settings.maxFall ?? 400} nits</span>
                </div>
                <input
                  type="range"
                  id="max-fall"
                  aria-label="Max FALL"
                  value={settings.maxFall ?? 400}
                  min={100}
                  max={4000}
                  step={50}
                  onChange={handleMaxFallChange}
                  disabled={disabled}
                  className="w-full h-1.5 bg-zinc-700 rounded-full appearance-none cursor-pointer
                             [&::-webkit-slider-thumb]:appearance-none
                             [&::-webkit-slider-thumb]:w-3
                             [&::-webkit-slider-thumb]:h-3
                             [&::-webkit-slider-thumb]:bg-orange-500
                             [&::-webkit-slider-thumb]:rounded-full
                             [&::-webkit-slider-thumb]:cursor-pointer
                             disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>

              {/* Codec Info */}
              <div className="p-2 text-xs text-zinc-400 bg-zinc-800/50 rounded">
                <strong>Note:</strong> HDR export requires H.265 (HEVC) codec for proper metadata embedding.
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-2 pt-4 border-t border-zinc-700">
            <button
              type="button"
              onClick={handleReset}
              disabled={disabled || !isDirty}
              aria-label="Reset"
              className="flex items-center gap-1 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200
                         hover:bg-zinc-700 rounded transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCcw size={14} />
              Reset
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={handleSave}
              disabled={disabled || isSaving}
              aria-label="Apply"
              className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded
                         transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? 'Saving...' : 'Apply'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default HDRSettingsPanel;

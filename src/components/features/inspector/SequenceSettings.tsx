/**
 * SequenceSettings Component
 *
 * Allows changing sequence format settings (resolution, FPS).
 * Displayed in the Inspector panel when a sequence is active.
 */

import { useState, useCallback, useMemo, memo } from 'react';
import { Maximize, Film, Settings } from 'lucide-react';
import { useProjectStore } from '@/stores/projectStore';
import { useToastStore } from '@/hooks/useToast';
import type { SequenceFormat, Sequence, Ratio } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface SequenceSettingsProps {
  /** The active sequence */
  sequence: Sequence;
  /** Additional CSS classes */
  className?: string;
}

interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
  category: string;
}

// =============================================================================
// Constants
// =============================================================================

const RESOLUTION_PRESETS: ResolutionPreset[] = [
  // YouTube & Standard
  { label: '1080p (Full HD)', width: 1920, height: 1080, category: 'Standard' },
  { label: '4K (UHD)', width: 3840, height: 2160, category: 'Standard' },
  { label: '720p (HD)', width: 1280, height: 720, category: 'Standard' },
  // Vertical (Shorts, TikTok, Reels)
  { label: 'Shorts/TikTok (1080x1920)', width: 1080, height: 1920, category: 'Vertical' },
  { label: 'Shorts/TikTok (720x1280)', width: 720, height: 1280, category: 'Vertical' },
  // Square
  { label: 'Instagram Square', width: 1080, height: 1080, category: 'Square' },
  // Cinema
  { label: 'Cinema 2K', width: 2048, height: 1080, category: 'Cinema' },
  { label: 'Cinema 4K', width: 4096, height: 2160, category: 'Cinema' },
];

const FPS_PRESETS: { label: string; value: Ratio }[] = [
  { label: '24 fps (Film)', value: { num: 24, den: 1 } },
  { label: '25 fps (PAL)', value: { num: 25, den: 1 } },
  { label: '30 fps (NTSC)', value: { num: 30, den: 1 } },
  { label: '60 fps', value: { num: 60, den: 1 } },
  { label: '23.976 fps', value: { num: 24000, den: 1001 } },
  { label: '29.97 fps', value: { num: 30000, den: 1001 } },
  { label: '59.94 fps', value: { num: 60000, den: 1001 } },
];

// =============================================================================
// Component
// =============================================================================

export const SequenceSettings = memo(function SequenceSettings({
  sequence,
  className = '',
}: SequenceSettingsProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [customWidth, setCustomWidth] = useState(sequence.format.canvas.width.toString());
  const [customHeight, setCustomHeight] = useState(sequence.format.canvas.height.toString());
  const [lockAspectRatio, setLockAspectRatio] = useState(true);

  // Store actions
  const executeCommand = useProjectStore((state) => state.executeCommand);
  const addToast = useToastStore((state) => state.addToast);

  // Current format values
  const currentFormat = sequence.format;
  const currentWidth = currentFormat.canvas.width;
  const currentHeight = currentFormat.canvas.height;
  const currentFps = currentFormat.fps.num / currentFormat.fps.den;

  // Find matching preset
  const currentPreset = useMemo(() => {
    return RESOLUTION_PRESETS.find((p) => p.width === currentWidth && p.height === currentHeight);
  }, [currentWidth, currentHeight]);

  const currentFpsPreset = useMemo(() => {
    return FPS_PRESETS.find(
      (p) => p.value.num === currentFormat.fps.num && p.value.den === currentFormat.fps.den,
    );
  }, [currentFormat.fps]);

  // Aspect ratio for locked scaling
  const aspectRatio = useMemo(() => currentWidth / currentHeight, [currentWidth, currentHeight]);

  // Handle resolution preset change
  const handlePresetChange = useCallback(
    async (preset: ResolutionPreset) => {
      const newFormat: SequenceFormat = {
        ...currentFormat,
        canvas: { width: preset.width, height: preset.height },
      };

      // Update local state for custom inputs
      setCustomWidth(preset.width.toString());
      setCustomHeight(preset.height.toString());

      try {
        await executeCommand({
          type: 'SetSequenceFormat',
          payload: {
            sequenceId: sequence.id,
            format: newFormat,
          },
        });
        addToast({
          message: `Resolution changed to ${preset.width}x${preset.height}`,
          variant: 'success',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast({
          message: `Failed to change resolution: ${message}`,
          variant: 'error',
        });
      }
    },
    [currentFormat, sequence.id, executeCommand, addToast],
  );

  // Handle FPS change
  const handleFpsChange = useCallback(
    async (fps: Ratio) => {
      const newFormat: SequenceFormat = {
        ...currentFormat,
        fps,
      };

      try {
        await executeCommand({
          type: 'SetSequenceFormat',
          payload: {
            sequenceId: sequence.id,
            format: newFormat,
          },
        });
        const fpsValue = fps.num / fps.den;
        addToast({
          message: `Frame rate changed to ${fpsValue.toFixed(fpsValue % 1 === 0 ? 0 : 3)} fps`,
          variant: 'success',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast({
          message: `Failed to change frame rate: ${message}`,
          variant: 'error',
        });
      }
    },
    [currentFormat, sequence.id, executeCommand, addToast],
  );

  // Handle custom width change
  const handleWidthChange = useCallback(
    (value: string) => {
      setCustomWidth(value);
      if (lockAspectRatio) {
        const width = parseInt(value, 10);
        if (!isNaN(width) && width > 0) {
          const newHeight = Math.round(width / aspectRatio);
          setCustomHeight(newHeight.toString());
        }
      }
    },
    [lockAspectRatio, aspectRatio],
  );

  // Handle custom height change
  const handleHeightChange = useCallback(
    (value: string) => {
      setCustomHeight(value);
      if (lockAspectRatio) {
        const height = parseInt(value, 10);
        if (!isNaN(height) && height > 0) {
          const newWidth = Math.round(height * aspectRatio);
          setCustomWidth(newWidth.toString());
        }
      }
    },
    [lockAspectRatio, aspectRatio],
  );

  // Apply custom resolution
  const handleApplyCustom = useCallback(async () => {
    const width = parseInt(customWidth, 10);
    const height = parseInt(customHeight, 10);

    if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
      addToast({
        message: 'Please enter valid width and height values',
        variant: 'error',
      });
      return;
    }

    const newFormat: SequenceFormat = {
      ...currentFormat,
      canvas: { width, height },
    };

    try {
      await executeCommand({
        type: 'SetSequenceFormat',
        payload: {
          sequenceId: sequence.id,
          format: newFormat,
        },
      });
      setIsEditing(false);
      addToast({
        message: `Resolution changed to ${width}x${height}`,
        variant: 'success',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addToast({
        message: `Failed to change resolution: ${message}`,
        variant: 'error',
      });
    }
  }, [customWidth, customHeight, currentFormat, sequence.id, executeCommand, addToast]);

  // Group presets by category
  const groupedPresets = useMemo(() => {
    const groups: Record<string, ResolutionPreset[]> = {};
    for (const preset of RESOLUTION_PRESETS) {
      if (!groups[preset.category]) {
        groups[preset.category] = [];
      }
      groups[preset.category].push(preset);
    }
    return groups;
  }, []);

  return (
    <div className={`border-t border-editor-border ${className}`} data-testid="sequence-settings">
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-editor-hover transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <Settings className="w-4 h-4 text-primary-500" />
        <span className="text-sm font-semibold text-editor-text">Sequence Settings</span>
        <svg
          className={`w-4 h-4 ml-auto text-editor-text-muted transition-transform ${
            isExpanded ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Content */}
      {isExpanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* Current Settings Summary */}
          <div className="bg-editor-input bg-opacity-30 rounded p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-editor-text-muted flex items-center gap-1">
                <Maximize className="w-3 h-3" />
                Resolution
              </span>
              <span className="text-sm text-editor-text">
                {currentWidth} x {currentHeight}
                {currentPreset && (
                  <span className="text-editor-text-muted ml-1">({currentPreset.label})</span>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-editor-text-muted flex items-center gap-1">
                <Film className="w-3 h-3" />
                Frame Rate
              </span>
              <span className="text-sm text-editor-text">
                {currentFps.toFixed(currentFps % 1 === 0 ? 0 : 3)} fps
              </span>
            </div>
          </div>

          {/* Resolution Presets */}
          <div>
            <label className="text-xs font-medium text-editor-text-muted block mb-2">
              Resolution Preset
            </label>
            <select
              className="w-full bg-editor-input border border-editor-border rounded px-3 py-2 text-sm text-editor-text focus:border-primary-500 focus:ring-1 focus:ring-primary-500 focus:outline-none"
              value={currentPreset ? `${currentPreset.width}x${currentPreset.height}` : 'custom'}
              onChange={(e) => {
                if (e.target.value === 'custom') {
                  setIsEditing(true);
                  return;
                }
                const [w, h] = e.target.value.split('x').map(Number);
                const preset = RESOLUTION_PRESETS.find((p) => p.width === w && p.height === h);
                if (preset) {
                  handlePresetChange(preset);
                }
              }}
            >
              {Object.entries(groupedPresets).map(([category, presets]) => (
                <optgroup key={category} label={category}>
                  {presets.map((preset) => (
                    <option
                      key={`${preset.width}x${preset.height}`}
                      value={`${preset.width}x${preset.height}`}
                    >
                      {preset.label}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value="custom">Custom...</option>
            </select>
          </div>

          {/* Custom Resolution Editor */}
          {isEditing && (
            <div className="space-y-3 p-3 bg-editor-input bg-opacity-20 rounded border border-editor-border">
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <label className="text-xs text-editor-text-muted block mb-1">Width</label>
                  <input
                    type="number"
                    className="w-full bg-editor-input border border-editor-border rounded px-2 py-1.5 text-sm text-editor-text focus:border-primary-500 focus:outline-none"
                    value={customWidth}
                    onChange={(e) => handleWidthChange(e.target.value)}
                    min={1}
                    step={1}
                  />
                </div>
                <button
                  type="button"
                  className={`mt-5 p-1.5 rounded transition-colors ${
                    lockAspectRatio
                      ? 'bg-primary-500 text-white'
                      : 'bg-editor-hover text-editor-text-muted'
                  }`}
                  onClick={() => setLockAspectRatio(!lockAspectRatio)}
                  title={lockAspectRatio ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {lockAspectRatio ? (
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                      />
                    ) : (
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"
                      />
                    )}
                  </svg>
                </button>
                <div className="flex-1">
                  <label className="text-xs text-editor-text-muted block mb-1">Height</label>
                  <input
                    type="number"
                    className="w-full bg-editor-input border border-editor-border rounded px-2 py-1.5 text-sm text-editor-text focus:border-primary-500 focus:outline-none"
                    value={customHeight}
                    onChange={(e) => handleHeightChange(e.target.value)}
                    min={1}
                    step={1}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 px-3 py-1.5 text-sm bg-primary-500 text-white rounded hover:bg-primary-600 transition-colors"
                  onClick={handleApplyCustom}
                >
                  Apply
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm bg-editor-hover text-editor-text rounded hover:bg-editor-border transition-colors"
                  onClick={() => {
                    setIsEditing(false);
                    setCustomWidth(currentWidth.toString());
                    setCustomHeight(currentHeight.toString());
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* FPS Selector */}
          <div>
            <label className="text-xs font-medium text-editor-text-muted block mb-2">
              Frame Rate
            </label>
            <select
              className="w-full bg-editor-input border border-editor-border rounded px-3 py-2 text-sm text-editor-text focus:border-primary-500 focus:ring-1 focus:ring-primary-500 focus:outline-none"
              value={
                currentFpsPreset
                  ? `${currentFpsPreset.value.num}/${currentFpsPreset.value.den}`
                  : 'custom'
              }
              onChange={(e) => {
                const [num, den] = e.target.value.split('/').map(Number);
                handleFpsChange({ num, den });
              }}
            >
              {FPS_PRESETS.map((preset) => (
                <option
                  key={`${preset.value.num}/${preset.value.den}`}
                  value={`${preset.value.num}/${preset.value.den}`}
                >
                  {preset.label}
                </option>
              ))}
            </select>
          </div>

          {/* Info Note */}
          <p className="text-xs text-editor-text-muted italic">
            Changes to sequence settings will affect the preview and export output.
          </p>
        </div>
      )}
    </div>
  );
});

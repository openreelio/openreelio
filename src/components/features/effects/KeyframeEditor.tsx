/**
 * KeyframeEditor Component
 *
 * Editor for adding, editing, and deleting keyframes for effect parameters.
 * Displays a visual timeline with keyframe markers and easing controls.
 */

import { memo, useCallback, useMemo } from 'react';
import type { Keyframe, ParamDef, ParamValue } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface KeyframeEditorProps {
  /** Parameter definition */
  paramDef: ParamDef;
  /** Current keyframes for this parameter */
  keyframes: Keyframe[];
  /** Current playhead time in seconds */
  currentTime: number;
  /** Total duration in seconds (for positioning) */
  duration?: number;
  /** Current interpolated value at playhead */
  currentValue?: number;
  /** Index of selected keyframe */
  selectedIndex?: number;
  /** Callback when keyframes change */
  onChange: (keyframes: Keyframe[]) => void;
  /** Callback when a keyframe is selected */
  onSelect?: (index: number) => void;
  /** Read-only mode */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const EASING_OPTIONS: { value: Keyframe['easing']; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease_in', label: 'Ease In' },
  { value: 'ease_out', label: 'Ease Out' },
  { value: 'ease_in_out', label: 'Ease In-Out' },
  { value: 'step', label: 'Step' },
  { value: 'hold', label: 'Hold' },
  { value: 'cubic_bezier', label: 'Cubic Bezier' },
];

// Time tolerance for considering keyframes at "same" time (10ms)
const TIME_TOLERANCE = 0.01;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if there's a keyframe at the given time
 */
function hasKeyframeAtTime(keyframes: Keyframe[], time: number): boolean {
  return keyframes.some(
    (kf) => Math.abs(kf.timeOffset - time) < TIME_TOLERANCE
  );
}

/**
 * Insert a keyframe in sorted order by timeOffset.
 * Prevents duplicate keyframes within TIME_TOLERANCE by replacing existing ones.
 */
function insertKeyframeSorted(keyframes: Keyframe[], newKeyframe: Keyframe): Keyframe[] {
  // First, check for existing keyframe at the same time (within tolerance)
  const existingIndex = keyframes.findIndex(
    (kf) => Math.abs(kf.timeOffset - newKeyframe.timeOffset) < TIME_TOLERANCE
  );

  if (existingIndex !== -1) {
    // Replace existing keyframe at this time
    const result = [...keyframes];
    result[existingIndex] = newKeyframe;
    return result;
  }

  // No existing keyframe at this time - insert in sorted order
  const result = [...keyframes];
  const insertIndex = result.findIndex((kf) => kf.timeOffset > newKeyframe.timeOffset);

  if (insertIndex === -1) {
    result.push(newKeyframe);
  } else {
    result.splice(insertIndex, 0, newKeyframe);
  }

  return result;
}

// =============================================================================
// Component
// =============================================================================

export const KeyframeEditor = memo(function KeyframeEditor({
  paramDef,
  keyframes,
  currentTime,
  duration = 10,
  currentValue,
  selectedIndex,
  onChange,
  onSelect,
  readOnly = false,
  className,
}: KeyframeEditorProps) {
  // Check if we're at an existing keyframe time
  const atExistingKeyframe = useMemo(
    () => hasKeyframeAtTime(keyframes, currentTime),
    [keyframes, currentTime]
  );

  // Handle add/update keyframe with proper validation
  const handleAddKeyframe = useCallback(() => {
    // Use explicit undefined check to allow 0 as a valid value
    // currentValue ?? default would skip 0 (valid) since ?? only checks null/undefined
    let value: number;
    if (currentValue !== undefined && currentValue !== null && Number.isFinite(currentValue)) {
      value = currentValue;
    } else if (paramDef.default?.value !== undefined && typeof paramDef.default.value === 'number') {
      value = paramDef.default.value;
    } else {
      value = 0;
    }

    // Validate currentTime is a finite positive number
    const safeTimeOffset = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;

    const newKeyframe: Keyframe = {
      timeOffset: safeTimeOffset,
      value: { type: 'float', value } as ParamValue,
      easing: 'linear',
    };

    if (atExistingKeyframe) {
      // Update existing keyframe
      const updatedKeyframes = keyframes.map((kf) =>
        Math.abs(kf.timeOffset - currentTime) < TIME_TOLERANCE
          ? { ...kf, value: newKeyframe.value }
          : kf
      );
      onChange(updatedKeyframes);
    } else {
      // Add new keyframe in sorted order
      const newKeyframes = insertKeyframeSorted(keyframes, newKeyframe);
      onChange(newKeyframes);
    }
  }, [currentTime, currentValue, paramDef.default, keyframes, atExistingKeyframe, onChange]);

  // Handle delete keyframe
  const handleDeleteKeyframe = useCallback(
    (index: number) => {
      const newKeyframes = keyframes.filter((_, i) => i !== index);
      onChange(newKeyframes);
    },
    [keyframes, onChange]
  );

  // Handle keyframe selection
  const handleSelectKeyframe = useCallback(
    (index: number) => {
      onSelect?.(index);
    },
    [onSelect]
  );

  // Handle easing change
  const handleEasingChange = useCallback(
    (easing: Keyframe['easing']) => {
      if (selectedIndex === undefined || selectedIndex < 0 || selectedIndex >= keyframes.length) {
        return;
      }

      const updatedKeyframes = keyframes.map((kf, i) =>
        i === selectedIndex ? { ...kf, easing } : kf
      );
      onChange(updatedKeyframes);
    },
    [selectedIndex, keyframes, onChange]
  );

  // Calculate time indicator position
  const timeIndicatorLeft = useMemo(() => {
    if (duration <= 0) return '0%';
    const percentage = (currentTime / duration) * 100;
    return `${Math.min(100, Math.max(0, percentage))}%`;
  }, [currentTime, duration]);

  // Calculate keyframe marker position
  const getKeyframePosition = useCallback(
    (timeOffset: number): string => {
      if (duration <= 0) return '0%';
      const percentage = (timeOffset / duration) * 100;
      return `${Math.min(100, Math.max(0, percentage))}%`;
    },
    [duration]
  );

  return (
    <div
      data-testid="keyframe-editor"
      className={`flex flex-col gap-2 p-2 ${className || ''}`}
    >
      {/* Header with parameter label and add button */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{paramDef.label}</span>
        {!readOnly && (
          <button
            type="button"
            onClick={handleAddKeyframe}
            className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            {atExistingKeyframe ? 'Update Keyframe' : 'Add Keyframe'}
          </button>
        )}
      </div>

      {/* Timeline track with keyframes */}
      <div className="relative h-8 bg-gray-700 rounded">
        {/* Time indicator */}
        <div
          data-testid="time-indicator"
          className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
          style={{ left: timeIndicatorLeft }}
        />

        {/* Keyframe markers */}
        {keyframes.map((kf, index) => (
          <div
            key={`${kf.timeOffset}-${index}`}
            data-testid="keyframe-marker"
            className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full cursor-pointer bg-yellow-400 hover:bg-yellow-300 ${selectedIndex === index ? 'ring-2 ring-white' : ''}`}
            style={{ left: getKeyframePosition(kf.timeOffset) }}
            onClick={() => handleSelectKeyframe(index)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                handleSelectKeyframe(index);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={`Keyframe at ${kf.timeOffset}s`}
          />
        ))}

        {/* Empty state */}
        {keyframes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-xs">
            No keyframes
          </div>
        )}
      </div>

      {/* Keyframe list with delete buttons */}
      {keyframes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {keyframes.map((kf, index) => (
            <div
              key={`list-${kf.timeOffset}-${index}`}
              className="flex items-center gap-1 px-2 py-0.5 bg-gray-600 rounded text-xs"
            >
              <span>{kf.timeOffset.toFixed(2)}s</span>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleDeleteKeyframe(index)}
                  className="text-red-400 hover:text-red-300"
                  aria-label="Delete keyframe"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Easing selector for selected keyframe */}
      {selectedIndex !== undefined && selectedIndex >= 0 && selectedIndex < keyframes.length && (
        <div className="flex items-center gap-2">
          <label htmlFor="easing-select" className="text-xs text-gray-400">
            Easing:
          </label>
          <select
            id="easing-select"
            aria-label="Easing"
            value={keyframes[selectedIndex].easing}
            onChange={(e) => handleEasingChange(e.target.value as Keyframe['easing'])}
            disabled={readOnly}
            className="px-2 py-1 text-xs bg-gray-600 rounded disabled:opacity-50"
          >
            {EASING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
});

/**
 * MaskKeyframeEditor Component
 *
 * Visual timeline editor for mask shape keyframes.
 * Allows adding, removing, and navigating keyframes that animate a mask over time.
 *
 * @module components/features/masks/MaskKeyframeEditor
 */

import React, { useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Plus, Trash2, Link } from 'lucide-react';
import type { Mask, MaskKeyframe, Easing } from '@/types';
import { cloneMaskShape, resolveShapeAtTime } from '@/utils/maskInterpolation';

// =============================================================================
// Types
// =============================================================================

export interface MaskKeyframeEditorProps {
  /** The mask being edited */
  mask: Mask;
  /** Current playhead time (seconds from clip start) */
  currentTime: number;
  /** Clip duration in seconds */
  duration: number;
  /** Called when keyframes are updated */
  onKeyframesChange: (keyframes: MaskKeyframe[]) => void;
  /** Called when navigating to a keyframe time (prev/next buttons) */
  onNavigate?: (time: number) => void;
  /** Called to link mask to tracking data */
  onLinkTracking?: () => void;
  /** Whether tracking is available */
  hasTrackingData?: boolean;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const TIME_TOLERANCE = 0.01;

const EASING_OPTIONS: { value: Easing; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease_in', label: 'Ease In' },
  { value: 'ease_out', label: 'Ease Out' },
  { value: 'ease_in_out', label: 'Ease In Out' },
  { value: 'hold', label: 'Hold' },
  { value: 'step', label: 'Step' },
];

// =============================================================================
// Component
// =============================================================================

export function MaskKeyframeEditor({
  mask,
  currentTime,
  duration,
  onKeyframesChange,
  onNavigate,
  onLinkTracking,
  hasTrackingData = false,
  disabled = false,
  className = '',
}: MaskKeyframeEditorProps): React.ReactElement {
  const keyframes = useMemo(() => mask.keyframes ?? [], [mask.keyframes]);
  const isLinked = Boolean(mask.trackingSourceId);

  // Check if a keyframe exists at current time
  const keyframeAtCurrentTime = useMemo(
    () => keyframes.find((kf) => Math.abs(kf.timeOffset - currentTime) < TIME_TOLERANCE),
    [keyframes, currentTime],
  );

  // Add keyframe at current time with the currently visible (interpolated) shape
  const handleAddKeyframe = useCallback(() => {
    if (disabled || keyframeAtCurrentTime) return;
    // Use the interpolated shape at currentTime so mid-animation keyframes
    // capture the visible pose, not the static base shape.
    const visibleShape = keyframes.length > 0
      ? resolveShapeAtTime(mask.shape, keyframes, currentTime)
      : cloneMaskShape(mask.shape);
    const newKf: MaskKeyframe = {
      timeOffset: currentTime,
      shape: visibleShape,
      easing: 'linear',
    };
    const updated = [...keyframes, newKf].sort((a, b) => a.timeOffset - b.timeOffset);
    onKeyframesChange(updated);
  }, [disabled, keyframeAtCurrentTime, currentTime, mask.shape, keyframes, onKeyframesChange]);

  // Remove keyframe at current time
  const handleRemoveKeyframe = useCallback(() => {
    if (disabled || !keyframeAtCurrentTime) return;
    const updated = keyframes.filter(
      (kf) => Math.abs(kf.timeOffset - currentTime) >= TIME_TOLERANCE,
    );
    onKeyframesChange(updated);
  }, [disabled, keyframeAtCurrentTime, currentTime, keyframes, onKeyframesChange]);

  // Navigate to previous keyframe
  const handlePrevKeyframe = useCallback(() => {
    const prev = keyframes.filter((kf) => kf.timeOffset < currentTime - TIME_TOLERANCE);
    if (prev.length > 0 && onNavigate) {
      const target = prev[prev.length - 1];
      onNavigate(target.timeOffset);
    }
  }, [keyframes, currentTime, onNavigate]);

  // Navigate to next keyframe
  const handleNextKeyframe = useCallback(() => {
    const next = keyframes.filter((kf) => kf.timeOffset > currentTime + TIME_TOLERANCE);
    if (next.length > 0 && onNavigate) {
      const target = next[0];
      onNavigate(target.timeOffset);
    }
  }, [keyframes, currentTime, onNavigate]);

  // Update easing for a specific keyframe
  const handleEasingChange = useCallback(
    (index: number, easing: Easing) => {
      if (disabled) return;
      const updated = keyframes.map((kf, i) => (i === index ? { ...kf, easing } : kf));
      onKeyframesChange(updated);
    },
    [disabled, keyframes, onKeyframesChange],
  );

  // Delete a specific keyframe by index
  const handleDeleteKeyframe = useCallback(
    (index: number) => {
      if (disabled) return;
      const updated = keyframes.filter((_, i) => i !== index);
      onKeyframesChange(updated);
    },
    [disabled, keyframes, onKeyframesChange],
  );

  const hasPrev = keyframes.some((kf) => kf.timeOffset < currentTime - TIME_TOLERANCE);
  const hasNext = keyframes.some((kf) => kf.timeOffset > currentTime + TIME_TOLERANCE);

  return (
    <div data-testid="mask-keyframe-editor" className={`bg-zinc-900 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b border-zinc-700">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Animation</span>
        <span className="text-xs text-zinc-500">
          {keyframes.length} keyframe{keyframes.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Timeline Strip */}
      {duration > 0 && (
        <div className="px-3 pt-2 pb-1">
          <div
            data-testid="keyframe-timeline"
            className="relative h-6 bg-zinc-800 rounded border border-zinc-600"
          >
            {/* Keyframe markers */}
            {keyframes.map((kf) => {
              const pct = Math.max(0, Math.min(100, (kf.timeOffset / duration) * 100));
              const isAtPlayhead = Math.abs(kf.timeOffset - currentTime) < TIME_TOLERANCE;
              return (
                <div
                  key={kf.timeOffset}
                  data-testid="keyframe-marker"
                  className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rotate-45 border cursor-pointer
                    ${isAtPlayhead ? 'bg-yellow-400 border-yellow-300' : 'bg-amber-600 border-amber-500'}
                  `}
                  style={{ left: `${pct}%` }}
                  title={`${kf.timeOffset.toFixed(2)}s`}
                />
              );
            })}
            {/* Playhead */}
            <div
              data-testid="playhead-indicator"
              className="absolute top-0 bottom-0 w-0.5 bg-red-500"
              style={{
                left: `${Math.max(0, Math.min(100, (currentTime / duration) * 100))}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-1 px-3 py-2">
        {/* Navigate Previous */}
        <button
          type="button"
          onClick={handlePrevKeyframe}
          disabled={disabled || !hasPrev}
          aria-label="Previous keyframe"
          className="p-1 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-400"
        >
          <ChevronLeft size={14} />
        </button>

        {/* Add/Remove Keyframe */}
        {keyframeAtCurrentTime ? (
          <button
            type="button"
            onClick={handleRemoveKeyframe}
            disabled={disabled}
            aria-label="Remove keyframe"
            className="px-2 py-1 text-xs rounded bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 disabled:opacity-30"
          >
            Remove
          </button>
        ) : (
          <button
            type="button"
            onClick={handleAddKeyframe}
            disabled={disabled}
            aria-label="Set keyframe"
            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-zinc-700 text-zinc-300 hover:bg-zinc-600 disabled:opacity-30"
          >
            <Plus size={12} />
            Set Keyframe
          </button>
        )}

        {/* Navigate Next */}
        <button
          type="button"
          onClick={handleNextKeyframe}
          disabled={disabled || !hasNext}
          aria-label="Next keyframe"
          className="p-1 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-400"
        >
          <ChevronRight size={14} />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Link to Tracker */}
        {hasTrackingData && onLinkTracking && (
          <button
            type="button"
            onClick={onLinkTracking}
            disabled={disabled}
            aria-label={isLinked ? 'Linked to tracker' : 'Link to tracker'}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded
              ${isLinked ? 'bg-blue-600/20 text-blue-400' : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'}
              disabled:opacity-30`}
          >
            <Link size={12} />
            {isLinked ? 'Linked' : 'Link Tracker'}
          </button>
        )}
      </div>

      {/* Keyframe List */}
      {keyframes.length > 0 && (
        <div className="px-3 pb-2 space-y-1 max-h-32 overflow-y-auto">
          {keyframes.map((kf, idx) => (
            <div
              key={kf.timeOffset}
              data-testid="keyframe-list-item"
              className="flex items-center gap-2 text-xs text-zinc-400"
            >
              <span className="w-12 text-zinc-500">{kf.timeOffset.toFixed(2)}s</span>
              <span className="w-16 text-zinc-500 truncate">{kf.shape.type}</span>
              <select
                value={kf.easing}
                onChange={(e) => handleEasingChange(idx, e.target.value as Easing)}
                disabled={disabled}
                aria-label={`Easing for keyframe at ${kf.timeOffset.toFixed(2)}s`}
                className="flex-1 px-1 py-0.5 text-xs bg-zinc-800 border border-zinc-600 rounded text-zinc-300 disabled:opacity-30"
              >
                {EASING_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => handleDeleteKeyframe(idx)}
                disabled={disabled}
                aria-label={`Delete keyframe at ${kf.timeOffset.toFixed(2)}s`}
                className="p-0.5 hover:bg-zinc-700 rounded text-zinc-500 hover:text-red-400 disabled:opacity-30"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default MaskKeyframeEditor;

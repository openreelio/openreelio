/**
 * ColorMatchSection — Auto color match section in the effect inspector.
 *
 * Provides a reference clip picker and "Match Color" button that
 * analyzes both clips and applies histogram-matched curves to the target.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Palette, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { refreshProjectState } from '@/utils/stateRefreshHelper';
import type { Clip, ClipId } from '@/types';

/** Result returned from the auto_color_match IPC command. */
interface ColorMatchResult {
  effectId: string;
  brightnessOffset: number;
  saturationMultiplier: number;
  temperatureShift: number;
}

export interface ColorMatchSectionProps {
  /** Clip context for the target clip */
  clipContext?: {
    sequenceId: string;
    trackId: string;
    clipId: string;
  };
  /** Whether controls are read-only */
  readOnly?: boolean;
  /** Callback after color match is applied */
  onMatchApplied?: () => void;
}

/** Collects all video clips from the requested sequence, excluding the target clip. */
function useAvailableReferenceClips(sequenceId?: string, excludeClipId?: string): Clip[] {
  return useProjectStore((state) => {
    if (!sequenceId) return [];

    const sequence = state.sequences.get(sequenceId);
    if (!sequence) return [];

    const clips: Clip[] = [];
    for (const track of sequence.tracks) {
      if (track.kind === 'audio') continue;
      for (const clip of track.clips) {
        if (clip.id !== excludeClipId) {
          clips.push(clip);
        }
      }
    }

    return clips;
  });
}

export const ColorMatchSection = memo(function ColorMatchSection({
  clipContext,
  readOnly = false,
  onMatchApplied,
}: ColorMatchSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [referenceClipId, setReferenceClipId] = useState<ClipId | null>(null);
  const [isMatching, setIsMatching] = useState(false);
  const [result, setResult] = useState<ColorMatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const referenceClips = useAvailableReferenceClips(clipContext?.sequenceId, clipContext?.clipId);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const referenceClipIdSet = useMemo(
    () => new Set(referenceClips.map((clip) => clip.id)),
    [referenceClips]
  );
  const canUseSelectedReference = useMemo(
    () => selectedClipIds.some((id) => referenceClipIdSet.has(id)),
    [referenceClipIdSet, selectedClipIds]
  );

  useEffect(() => {
    if (referenceClipId && !referenceClipIdSet.has(referenceClipId)) {
      setReferenceClipId(null);
    }
  }, [referenceClipId, referenceClipIdSet]);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleMatch = useCallback(async () => {
    if (
      !clipContext ||
      !referenceClipId ||
      !referenceClipIdSet.has(referenceClipId) ||
      readOnly ||
      isMatching
    ) {
      return;
    }

    setIsMatching(true);
    setError(null);
    setResult(null);

    try {
      const matchResult = await invoke<ColorMatchResult>('auto_color_match', {
        referenceClipId,
        sequenceId: clipContext.sequenceId,
        targetClipId: clipContext.clipId,
      });

      setResult(matchResult);
      await refreshProjectState();
      onMatchApplied?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsMatching(false);
    }
  }, [clipContext, referenceClipId, referenceClipIdSet, readOnly, isMatching, onMatchApplied]);

  /** Auto-select the first selected clip as reference if it's not the target. */
  const handleUseSelectedAsReference = useCallback(() => {
    const candidate = selectedClipIds.find((id) => referenceClipIdSet.has(id));
    if (candidate) {
      setReferenceClipId(candidate);
    }
  }, [referenceClipIdSet, selectedClipIds]);

  const hasValidSelection = Boolean(
    referenceClipId && clipContext && referenceClipIdSet.has(referenceClipId)
  );
  const ChevronIcon = isExpanded ? ChevronDown : ChevronRight;

  return (
    <div className="border-t border-editor-border" data-testid="color-match-section">
      {/* Header */}
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center w-full px-2 py-1.5 text-xs text-editor-text-muted hover:text-editor-text transition-colors"
        aria-expanded={isExpanded}
        aria-label="Toggle color match section"
      >
        <ChevronIcon className="w-3 h-3 mr-1 flex-shrink-0" />
        <Palette className="w-3.5 h-3.5 mr-1.5 flex-shrink-0" />
        <span className="font-medium">Color Match</span>
        {result && (
          <span className="ml-auto text-[10px] text-green-400">Applied</span>
        )}
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="px-3 pb-2 space-y-2">
          {/* Reference Clip Picker */}
          <div>
            <label
              htmlFor="reference-clip-select"
              className="block text-[10px] text-editor-text-muted mb-1"
            >
              Reference Clip
            </label>
            <div className="flex gap-1">
              <select
                id="reference-clip-select"
                value={referenceClipId ?? ''}
                onChange={(e) => setReferenceClipId(e.target.value || null)}
                disabled={readOnly || isMatching}
                className="flex-1 h-6 px-1.5 text-xs bg-editor-surface border border-editor-border rounded text-editor-text disabled:opacity-50"
                aria-label="Select reference clip"
              >
                <option value="">Select a clip...</option>
                {referenceClips.map((clip) => (
                  <option key={clip.id} value={clip.id}>
                    {clip.label ?? clip.assetId.slice(0, 8)}
                  </option>
                ))}
              </select>

              {selectedClipIds.length > 0 && canUseSelectedReference && (
                  <button
                    type="button"
                    onClick={handleUseSelectedAsReference}
                    disabled={readOnly || isMatching}
                    className="px-1.5 h-6 text-[10px] bg-editor-surface border border-editor-border rounded text-editor-text-muted hover:text-editor-text transition-colors disabled:opacity-50"
                    title="Use selected clip as reference"
                    aria-label="Use selected clip as reference"
                  >
                    Selected
                  </button>
                )}
            </div>
          </div>

          {/* Match Button */}
          <button
            type="button"
            onClick={handleMatch}
            disabled={!hasValidSelection || readOnly || isMatching}
            className="flex items-center justify-center w-full h-7 px-3 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Match color to reference clip"
          >
            {isMatching ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Palette className="w-3.5 h-3.5 mr-1.5" />
                Match Color
              </>
            )}
          </button>

          {/* Result Summary */}
          {result && (
            <div
              className="text-[10px] text-editor-text-muted space-y-0.5 bg-editor-surface/50 rounded p-1.5"
              data-testid="color-match-result"
            >
              <div>
                Brightness:{' '}
                <span className="text-editor-text">
                  {result.brightnessOffset > 0 ? '+' : ''}
                  {(result.brightnessOffset * 100).toFixed(1)}%
                </span>
              </div>
              <div>
                Saturation:{' '}
                <span className="text-editor-text">
                  {result.saturationMultiplier.toFixed(2)}x
                </span>
              </div>
              <div>
                Temperature:{' '}
                <span className="text-editor-text">
                  {result.temperatureShift > 0 ? 'Warmer' : result.temperatureShift < 0 ? 'Cooler' : 'Neutral'}{' '}
                  ({(result.temperatureShift * 100).toFixed(1)})
                </span>
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div
              className="text-[10px] text-red-400 bg-red-900/20 rounded p-1.5"
              role="alert"
              data-testid="color-match-error"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

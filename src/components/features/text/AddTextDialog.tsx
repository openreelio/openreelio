/**
 * AddTextDialog Component
 *
 * Dialog for adding text clips to the timeline.
 * Allows users to enter text content, select a track, set duration,
 * and choose from text presets (Title, Lower Third, Subtitle).
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { X, Type } from 'lucide-react';
import type { Track, TextClipData, TrackKind } from '@/types';
import { TextPresetPicker } from './TextPresetPicker';
import { getPresetById, presetToTextClipData, type TextPreset } from '@/data/textPresets';

/** Payload for adding a text clip */
export interface AddTextPayload {
  trackId: string;
  timelineIn: number;
  duration: number;
  textData: TextClipData;
}

export interface AddTextDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Callback when dialog is closed */
  onClose: () => void;
  /** Callback when text is added */
  onAdd: (payload: AddTextPayload) => Promise<void>;
  /** Available tracks (only video and overlay will be shown) */
  tracks: Track[];
  /** Current playhead time (insertion point) */
  currentTime: number;
}

// =============================================================================
// Constants
// =============================================================================

const MIN_DURATION = 0.5;
const MAX_DURATION = 300;
const DEFAULT_DURATION = 3;
const DEFAULT_TEXT = 'Text';

/** Fallback style when no preset is selected */
const DEFAULT_TEXT_STYLE: TextClipData['style'] = {
  fontSize: 42,
  fontFamily: 'Arial',
  color: '#FFFFFF',
  bold: false,
  italic: false,
  underline: false,
  alignment: 'center',
  lineHeight: 1.2,
  letterSpacing: 0,
  backgroundPadding: 0,
};

/** Track kinds that support text clips */
const TEXT_SUPPORTED_TRACK_KINDS: TrackKind[] = ['video', 'overlay'];

function getClipTimelineDurationSec(clip: Track['clips'][number]): number {
  const safeSpeed = clip.speed > 0 ? clip.speed : 1;
  const sourceDuration = clip.range.sourceOutSec - clip.range.sourceInSec;

  if (Number.isFinite(sourceDuration) && sourceDuration > 0) {
    return sourceDuration / safeSpeed;
  }

  return Number.isFinite(clip.place.durationSec) && clip.place.durationSec > 0
    ? clip.place.durationSec
    : 0;
}

function trackHasOverlap(track: Track, timelineIn: number, durationSec: number): boolean {
  const candidateEnd = timelineIn + durationSec;

  return track.clips.some((clip) => {
    const clipStart = clip.place.timelineInSec;
    const clipEnd = clipStart + getClipTimelineDurationSec(clip);
    return timelineIn < clipEnd && candidateEnd > clipStart;
  });
}

// =============================================================================
// Component
// =============================================================================

export function AddTextDialog({
  isOpen,
  onClose,
  onAdd,
  tracks,
  currentTime,
}: AddTextDialogProps): JSX.Element | null {
  // ===========================================================================
  // State
  // ===========================================================================

  const [content, setContent] = useState(DEFAULT_TEXT);
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [selectedTrackId, setSelectedTrackId] = useState<string>('');
  const [selectedPreset, setSelectedPreset] = useState<TextPreset | null>(
    () => getPresetById('centered-title') ?? null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const textInputRef = useRef<HTMLTextAreaElement>(null);

  // ===========================================================================
  // Computed Values
  // ===========================================================================

  // Filter tracks to only show video and overlay tracks that are not locked
  const availableTracks = useMemo(() => {
    return tracks.filter(
      (track) => TEXT_SUPPORTED_TRACK_KINDS.includes(track.kind) && !track.locked,
    );
  }, [tracks]);

  // Validate content
  const isContentValid = content.trim().length > 0;
  const clampedDuration = Math.max(MIN_DURATION, Math.min(MAX_DURATION, duration));

  const selectedTrack = useMemo(
    () => availableTracks.find((track) => track.id === selectedTrackId),
    [availableTracks, selectedTrackId],
  );

  const hasTrackConflict = useMemo(() => {
    if (!selectedTrack) {
      return false;
    }

    return trackHasOverlap(selectedTrack, currentTime, clampedDuration);
  }, [selectedTrack, currentTime, clampedDuration]);

  const canSubmit = isContentValid && !!selectedTrack && !hasTrackConflict && !isSubmitting;

  // ===========================================================================
  // Effects
  // ===========================================================================

  // Set default track when tracks change or dialog opens
  useEffect(() => {
    if (isOpen && availableTracks.length > 0 && !selectedTrackId) {
      setSelectedTrackId(availableTracks[0].id);
    }
  }, [isOpen, availableTracks, selectedTrackId]);

  // Focus text input when dialog opens
  useEffect(() => {
    if (isOpen && textInputRef.current) {
      textInputRef.current.focus();
      textInputRef.current.select();
    }
  }, [isOpen]);

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      setContent(DEFAULT_TEXT);
      setDuration(DEFAULT_DURATION);
      setSelectedPreset(getPresetById('centered-title') ?? null);
      setSubmitError(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleClose = useCallback(() => {
    if (isSubmitting) {
      return;
    }

    onClose();
  }, [isSubmitting, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    },
    [handleClose],
  );

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (submitError) {
        setSubmitError(null);
      }

      setContent(e.target.value);
    },
    [submitError],
  );

  const handleDurationChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (submitError) {
        setSubmitError(null);
      }

      const value = parseFloat(e.target.value);
      if (!isNaN(value)) {
        setDuration(value);
      }
    },
    [submitError],
  );

  const handleTrackChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (submitError) {
        setSubmitError(null);
      }

      setSelectedTrackId(e.target.value);
    },
    [submitError],
  );

  const handlePresetSelect = useCallback(
    (preset: TextPreset) => {
      if (submitError) {
        setSubmitError(null);
      }

      setSelectedPreset(preset);
    },
    [submitError],
  );

  const handleAdd = useCallback(async () => {
    if (!canSubmit || !selectedTrack) {
      return;
    }

    const textData: TextClipData = selectedPreset
      ? presetToTextClipData(selectedPreset, content)
      : {
          content,
          style: DEFAULT_TEXT_STYLE,
          position: { x: 0.5, y: 0.5 },
          rotation: 0,
          opacity: 1.0,
        };

    try {
      setIsSubmitting(true);
      setSubmitError(null);

      await onAdd({
        trackId: selectedTrack.id,
        timelineIn: currentTime,
        duration: clampedDuration,
        textData,
      });

      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSubmitError(message || 'Failed to add text clip');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSubmit,
    clampedDuration,
    content,
    currentTime,
    onAdd,
    onClose,
    selectedPreset,
    selectedTrack,
  ]);

  // ===========================================================================
  // Render
  // ===========================================================================

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleClose}
      onKeyDown={handleKeyDown}
    >
      <div
        data-testid="add-text-dialog"
        role="dialog"
        aria-label="Add Text"
        aria-modal="true"
        className="bg-editor-sidebar border border-editor-border rounded-lg shadow-xl w-[400px] max-h-[90vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-editor-border">
          <h2 className="text-lg font-semibold text-editor-text flex items-center gap-2">
            <Type className="w-5 h-5 text-teal-400" />
            Add Text
          </h2>
          <button
            type="button"
            className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text transition-colors"
            onClick={handleClose}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Text Content */}
          <div className="space-y-2">
            <label htmlFor="text-content" className="block text-sm font-medium text-editor-text">
              Text Content
            </label>
            <textarea
              ref={textInputRef}
              id="text-content"
              className="w-full h-24 px-3 py-2 bg-editor-input border border-editor-border rounded text-sm text-editor-text placeholder-editor-text-muted resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              value={content}
              onChange={handleContentChange}
              placeholder="Enter your text here..."
            />
          </div>

          {/* Presets */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-editor-text">Style Preset</label>
            <TextPresetPicker
              onSelect={handlePresetSelect}
              selectedPresetId={selectedPreset?.id}
              compact
              showCategories
            />
          </div>

          {/* Track Selection */}
          <div className="space-y-2">
            <label htmlFor="track-select" className="block text-sm font-medium text-editor-text">
              Track
            </label>
            <select
              id="track-select"
              className="w-full px-3 py-2 bg-editor-input border border-editor-border rounded text-sm text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              value={selectedTrackId}
              onChange={handleTrackChange}
              disabled={isSubmitting}
            >
              {availableTracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name} ({track.kind})
                </option>
              ))}
            </select>
            {hasTrackConflict && (
              <p className="text-xs text-red-400">
                Selected track already has a clip at this time. Choose another track or move the
                playhead.
              </p>
            )}
          </div>

          {/* Duration */}
          <div className="space-y-2">
            <label htmlFor="duration-input" className="block text-sm font-medium text-editor-text">
              Duration (seconds)
            </label>
            <input
              id="duration-input"
              type="number"
              min={MIN_DURATION}
              max={MAX_DURATION}
              step={0.5}
              className="w-full px-3 py-2 bg-editor-input border border-editor-border rounded text-sm text-editor-text focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              value={duration}
              onChange={handleDurationChange}
              disabled={isSubmitting}
            />
            <p className="text-xs text-editor-text-muted">
              Text will be added at {currentTime.toFixed(2)}s on the timeline
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-editor-border">
          {submitError && <p className="mr-auto text-xs text-red-400">{submitError}</p>}
          <button
            type="button"
            className="px-4 py-2 text-sm text-editor-text-muted hover:text-editor-text rounded border border-editor-border hover:bg-editor-border transition-colors"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-4 py-2 text-sm bg-teal-600 text-white rounded hover:bg-teal-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            onClick={handleAdd}
            disabled={!canSubmit}
          >
            {isSubmitting ? 'Adding...' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

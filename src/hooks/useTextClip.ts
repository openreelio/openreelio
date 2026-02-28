/**
 * useTextClip Hook
 *
 * Hook for text clip CRUD operations.
 * Integrates with the project store to execute text clip commands.
 *
 * Text clips are implemented using the Effect system with TextOverlay effects.
 * Each text clip has a virtual asset ID with the __text__ prefix.
 */

import { useState, useCallback } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import type { TextClipData, ClipId, TrackId, TimeSec } from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('useTextClip');

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_FUNCTION_PATTERN = /^rgba?\(([^)]+)\)$/i;

function toHexByte(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0').toUpperCase();
}

function parseRgbChannel(raw: string): number | undefined {
  const value = raw.trim();
  if (value.endsWith('%')) {
    const percentage = Number.parseFloat(value.slice(0, -1));
    if (!Number.isFinite(percentage)) {
      return undefined;
    }
    return Math.min(255, Math.max(0, (percentage / 100) * 255));
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.min(255, Math.max(0, parsed));
}

function parseAlphaChannel(raw: string): number | undefined {
  const value = raw.trim();
  if (value.endsWith('%')) {
    const percentage = Number.parseFloat(value.slice(0, -1));
    if (!Number.isFinite(percentage)) {
      return undefined;
    }
    return Math.min(1, Math.max(0, percentage / 100));
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.min(1, Math.max(0, parsed));
}

function normalizeColorToHex(color: string): string {
  const trimmed = color.trim();
  if (trimmed.length === 0) {
    return color;
  }

  if (HEX_COLOR_PATTERN.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  const match = RGB_FUNCTION_PATTERN.exec(trimmed);
  if (!match) {
    return color;
  }

  const isRgba = /^rgba/i.test(trimmed);
  const parts = match[1].split(',').map((part) => part.trim());
  if ((!isRgba && parts.length !== 3) || (isRgba && parts.length !== 4)) {
    return color;
  }

  const red = parseRgbChannel(parts[0]);
  const green = parseRgbChannel(parts[1]);
  const blue = parseRgbChannel(parts[2]);
  const alpha = isRgba ? parseAlphaChannel(parts[3]) : 1;

  if (red === undefined || green === undefined || blue === undefined || alpha === undefined) {
    return color;
  }

  const hex = `${toHexByte(red)}${toHexByte(green)}${toHexByte(blue)}`;
  const alphaHex = alpha < 1 ? toHexByte(alpha * 255) : '';
  return `#${hex}${alphaHex}`;
}

function normalizeTextClipDataColors(textData: TextClipData): TextClipData {
  return {
    ...textData,
    style: {
      ...textData.style,
      color: normalizeColorToHex(textData.style.color),
      backgroundColor:
        typeof textData.style.backgroundColor === 'string'
          ? normalizeColorToHex(textData.style.backgroundColor)
          : textData.style.backgroundColor,
    },
    shadow: textData.shadow
      ? {
          ...textData.shadow,
          color: normalizeColorToHex(textData.shadow.color),
        }
      : textData.shadow,
    outline: textData.outline
      ? {
          ...textData.outline,
          color: normalizeColorToHex(textData.outline.color),
        }
      : textData.outline,
  };
}

// =============================================================================
// Types
// =============================================================================

/**
 * Parameters for adding a text clip.
 */
export interface AddTextClipParams {
  /** Track to add the text clip to */
  trackId: TrackId;
  /** Timeline position in seconds */
  timelineIn: TimeSec;
  /** Duration in seconds */
  duration: TimeSec;
  /** Text content and styling */
  textData: TextClipData;
}

/**
 * Parameters for updating a text clip.
 */
export interface UpdateTextClipParams {
  /** Track containing the text clip */
  trackId: TrackId;
  /** ID of the text clip to update */
  clipId: ClipId;
  /** New text content and styling */
  textData: TextClipData;
}

/**
 * Parameters for removing a text clip.
 */
export interface RemoveTextClipParams {
  /** Track containing the text clip */
  trackId: TrackId;
  /** ID of the text clip to remove */
  clipId: ClipId;
}

/**
 * Result type for useTextClip hook.
 */
export interface UseTextClipResult {
  /** Add a new text clip to a track */
  addTextClip: (params: AddTextClipParams) => Promise<ClipId | undefined>;
  /** Update an existing text clip */
  updateTextClip: (params: UpdateTextClipParams) => Promise<void>;
  /** Remove a text clip */
  removeTextClip: (params: RemoveTextClipParams) => Promise<void>;
  /** Whether an add operation is in progress */
  isAdding: boolean;
  /** Whether an update operation is in progress */
  isUpdating: boolean;
  /** Whether a remove operation is in progress */
  isRemoving: boolean;
  /** Whether any operation is in progress */
  isLoading: boolean;
  /** Current error message */
  error: string | null;
  /** Clear the error state */
  clearError: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for managing text clips on the timeline.
 *
 * @example
 * ```tsx
 * const { addTextClip, updateTextClip, removeTextClip, isLoading, error } = useTextClip();
 *
 * // Add a text clip
 * const clipId = await addTextClip({
 *   trackId: 'video-track',
 *   timelineIn: 5.0,
 *   duration: 3.0,
 *   textData: createTitleTextClipData('Hello World'),
 * });
 *
 * // Update the text
 * await updateTextClip({
 *   trackId: 'video-track',
 *   clipId,
 *   textData: { ...textData, content: 'Updated Text' },
 * });
 *
 * // Remove the text clip
 * await removeTextClip({
 *   trackId: 'video-track',
 *   clipId,
 * });
 * ```
 */
export function useTextClip(): UseTextClipResult {
  const [isAdding, setIsAdding] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get active sequence ID from store
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const executeCommand = useProjectStore((state) => state.executeCommand);

  /**
   * Add a new text clip to a track.
   */
  const addTextClip = useCallback(
    async (params: AddTextClipParams): Promise<ClipId | undefined> => {
      if (!activeSequenceId) {
        const errorMsg = 'No active sequence';
        setError(errorMsg);
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      // Validate parameters
      if (params.duration <= 0) {
        const errorMsg = 'Duration must be positive';
        setError(errorMsg);
        throw new Error(errorMsg);
      }

      if (params.timelineIn < 0) {
        const errorMsg = 'Timeline position cannot be negative';
        setError(errorMsg);
        throw new Error(errorMsg);
      }

      if (!params.textData.content.trim()) {
        const errorMsg = 'Text content cannot be empty';
        setError(errorMsg);
        throw new Error(errorMsg);
      }

      setIsAdding(true);
      setError(null);

      try {
        const normalizedTextData = normalizeTextClipDataColors(params.textData);

        logger.debug('Adding text clip', {
          trackId: params.trackId,
          timelineIn: params.timelineIn,
          duration: params.duration,
          content: params.textData.content.substring(0, 50),
        });

        const result = await executeCommand({
          type: 'AddTextClip',
          payload: {
            sequenceId: activeSequenceId,
            trackId: params.trackId,
            timelineIn: params.timelineIn,
            duration: params.duration,
            textData: normalizedTextData,
          },
        });

        const createdId = result.createdIds?.[0];
        logger.info('Text clip added successfully', { clipId: createdId });

        return createdId;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to add text clip', { error: err });
        setError(errorMsg);
        throw err;
      } finally {
        setIsAdding(false);
      }
    },
    [activeSequenceId, executeCommand],
  );

  /**
   * Update an existing text clip.
   */
  const updateTextClip = useCallback(
    async (params: UpdateTextClipParams): Promise<void> => {
      if (!activeSequenceId) {
        const errorMsg = 'No active sequence';
        setError(errorMsg);
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      if (!params.textData.content.trim()) {
        const errorMsg = 'Text content cannot be empty';
        setError(errorMsg);
        throw new Error(errorMsg);
      }

      setIsUpdating(true);
      setError(null);

      try {
        const normalizedTextData = normalizeTextClipDataColors(params.textData);

        logger.debug('Updating text clip', {
          trackId: params.trackId,
          clipId: params.clipId,
          content: params.textData.content.substring(0, 50),
        });

        await executeCommand({
          type: 'UpdateTextClip',
          payload: {
            sequenceId: activeSequenceId,
            trackId: params.trackId,
            clipId: params.clipId,
            textData: normalizedTextData,
          },
        });

        logger.info('Text clip updated successfully', { clipId: params.clipId });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to update text clip', { error: err, clipId: params.clipId });
        setError(errorMsg);
        throw err;
      } finally {
        setIsUpdating(false);
      }
    },
    [activeSequenceId, executeCommand],
  );

  /**
   * Remove a text clip.
   */
  const removeTextClip = useCallback(
    async (params: RemoveTextClipParams): Promise<void> => {
      if (!activeSequenceId) {
        const errorMsg = 'No active sequence';
        setError(errorMsg);
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      setIsRemoving(true);
      setError(null);

      try {
        logger.debug('Removing text clip', {
          trackId: params.trackId,
          clipId: params.clipId,
        });

        await executeCommand({
          type: 'RemoveTextClip',
          payload: {
            sequenceId: activeSequenceId,
            trackId: params.trackId,
            clipId: params.clipId,
          },
        });

        logger.info('Text clip removed successfully', { clipId: params.clipId });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to remove text clip', { error: err, clipId: params.clipId });
        setError(errorMsg);
        throw err;
      } finally {
        setIsRemoving(false);
      }
    },
    [activeSequenceId, executeCommand],
  );

  /**
   * Clear the error state.
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Compute combined loading state
  const isLoading = isAdding || isUpdating || isRemoving;

  return {
    addTextClip,
    updateTextClip,
    removeTextClip,
    isAdding,
    isUpdating,
    isRemoving,
    isLoading,
    error,
    clearError,
  };
}

export default useTextClip;

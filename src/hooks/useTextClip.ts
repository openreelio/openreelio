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
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '@/stores/projectStore';
import type {
  TextClipData,
  CommandResult,
  ClipId,
  TrackId,
  TimeSec,
} from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('useTextClip');

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
        logger.debug('Adding text clip', {
          trackId: params.trackId,
          timelineIn: params.timelineIn,
          duration: params.duration,
          content: params.textData.content.substring(0, 50),
        });

        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'AddTextClip',
          payload: {
            sequenceId: activeSequenceId,
            trackId: params.trackId,
            timelineIn: params.timelineIn,
            duration: params.duration,
            textData: params.textData,
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
    [activeSequenceId]
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
        logger.debug('Updating text clip', {
          trackId: params.trackId,
          clipId: params.clipId,
          content: params.textData.content.substring(0, 50),
        });

        await invoke<CommandResult>('execute_command', {
          commandType: 'UpdateTextClip',
          payload: {
            sequenceId: activeSequenceId,
            trackId: params.trackId,
            clipId: params.clipId,
            textData: params.textData,
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
    [activeSequenceId]
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

        await invoke<CommandResult>('execute_command', {
          commandType: 'RemoveTextClip',
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
    [activeSequenceId]
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

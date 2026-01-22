/**
 * useCaption Hook
 *
 * Hook for caption CRUD operations.
 * Integrates with the project store to execute caption commands.
 */

import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '@/stores/projectStore';
import type { Caption, CommandResult } from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('useCaption');

// =============================================================================
// Types
// =============================================================================

export interface CreateCaptionParams {
  /** Caption text */
  text: string;
  /** Start time in seconds */
  startSec: number;
  /** End time in seconds */
  endSec: number;
  /** Optional speaker name */
  speaker?: string;
}

export interface UseCaptionResult {
  /** Update an existing caption */
  updateCaption: (trackId: string, caption: Caption) => Promise<void>;
  /** Create a new caption */
  createCaption: (trackId: string, params: CreateCaptionParams) => Promise<string | undefined>;
  /** Delete a caption */
  deleteCaption: (trackId: string, captionId: string) => Promise<void>;
  /** Whether an update is in progress */
  isUpdating: boolean;
  /** Whether a creation is in progress */
  isCreating: boolean;
  /** Whether a deletion is in progress */
  isDeleting: boolean;
  /** Current error message */
  error: string | null;
  /** Clear the error state */
  clearError: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useCaption(): UseCaptionResult {
  const [isUpdating, setIsUpdating] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get active sequence ID from store
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);

  /**
   * Update an existing caption
   */
  const updateCaption = useCallback(
    async (trackId: string, caption: Caption): Promise<void> => {
      if (!activeSequenceId) {
        const errorMsg = 'No active sequence';
        setError(errorMsg);
        throw new Error(errorMsg);
      }

      setIsUpdating(true);
      setError(null);

      try {
        logger.debug('Updating caption', {
          trackId,
          captionId: caption.id,
          text: caption.text.substring(0, 50),
        });

        await invoke<CommandResult>('execute_command', {
          commandType: 'UpdateCaption',
          payload: {
            sequenceId: activeSequenceId,
            trackId,
            captionId: caption.id,
            text: caption.text,
            startSec: caption.startSec,
            endSec: caption.endSec,
            // Include speaker in metadata if available
          },
        });

        logger.info('Caption updated successfully', { captionId: caption.id });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to update caption', { error: err, captionId: caption.id });
        setError(errorMsg);
        throw err;
      } finally {
        setIsUpdating(false);
      }
    },
    [activeSequenceId]
  );

  /**
   * Create a new caption
   */
  const createCaption = useCallback(
    async (trackId: string, params: CreateCaptionParams): Promise<string | undefined> => {
      if (!activeSequenceId) {
        const errorMsg = 'No active sequence';
        setError(errorMsg);
        throw new Error(errorMsg);
      }

      setIsCreating(true);
      setError(null);

      try {
        logger.debug('Creating caption', {
          trackId,
          startSec: params.startSec,
          endSec: params.endSec,
        });

        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'CreateCaption',
          payload: {
            sequenceId: activeSequenceId,
            trackId,
            text: params.text,
            startSec: params.startSec,
            endSec: params.endSec,
          },
        });

        const createdId = result.createdIds?.[0];
        logger.info('Caption created successfully', { captionId: createdId });

        return createdId;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to create caption', { error: err });
        setError(errorMsg);
        throw err;
      } finally {
        setIsCreating(false);
      }
    },
    [activeSequenceId]
  );

  /**
   * Delete a caption
   */
  const deleteCaption = useCallback(
    async (trackId: string, captionId: string): Promise<void> => {
      if (!activeSequenceId) {
        const errorMsg = 'No active sequence';
        setError(errorMsg);
        throw new Error(errorMsg);
      }

      setIsDeleting(true);
      setError(null);

      try {
        logger.debug('Deleting caption', { trackId, captionId });

        await invoke<CommandResult>('execute_command', {
          commandType: 'DeleteCaption',
          payload: {
            sequenceId: activeSequenceId,
            trackId,
            captionId,
          },
        });

        logger.info('Caption deleted successfully', { captionId });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to delete caption', { error: err, captionId });
        setError(errorMsg);
        throw err;
      } finally {
        setIsDeleting(false);
      }
    },
    [activeSequenceId]
  );

  /**
   * Clear the error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    updateCaption,
    createCaption,
    deleteCaption,
    isUpdating,
    isCreating,
    isDeleting,
    error,
    clearError,
  };
}

export default useCaption;

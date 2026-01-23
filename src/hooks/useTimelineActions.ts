/**
 * useTimelineActions Hook
 *
 * Provides callbacks for Timeline component that execute Tauri IPC commands.
 * All commands are executed through the project store's executeCommand,
 * which automatically handles state synchronization with the backend.
 *
 * Architecture Notes:
 * - No manual state refresh needed: executeCommand handles this atomically
 * - All operations are serialized through the command queue to prevent races
 * - Error handling is centralized in the command executor
 */

import { useCallback } from 'react';
import { useProjectStore } from '@/stores';
import { createLogger } from '@/services/logger';
import type {
  AssetDropData,
  ClipMoveData,
  ClipTrimData,
  ClipSplitData,
  TrackControlData,
  CaptionUpdateData,
} from '@/components/timeline/Timeline';
import type { Sequence } from '@/types';

const logger = createLogger('TimelineActions');

// =============================================================================
// Types
// =============================================================================

interface UseTimelineActionsOptions {
  sequence: Sequence | null;
}

interface TimelineActions {
  handleClipMove: (data: ClipMoveData) => Promise<void>;
  handleClipTrim: (data: ClipTrimData) => Promise<void>;
  handleClipSplit: (data: ClipSplitData) => Promise<void>;
  handleAssetDrop: (data: AssetDropData) => Promise<void>;
  handleDeleteClips: (clipIds: string[]) => Promise<void>;
  handleTrackMuteToggle: (data: TrackControlData) => Promise<void>;
  handleTrackLockToggle: (data: TrackControlData) => Promise<void>;
  handleTrackVisibilityToggle: (data: TrackControlData) => Promise<void>;
  handleUpdateCaption: (data: CaptionUpdateData) => Promise<void>;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Custom hook that provides Timeline action callbacks connected to Tauri IPC.
 *
 * All handlers execute commands through the project store, which:
 * 1. Serializes operations via command queue to prevent race conditions
 * 2. Automatically refreshes state from backend after each command
 * 3. Handles errors and updates error state
 */
export function useTimelineActions({ sequence }: UseTimelineActionsOptions): TimelineActions {
  const executeCommand = useProjectStore((state) => state.executeCommand);

  /**
   * Handle clip move operation.
   * State refresh is automatic via executeCommand.
   */
  const handleClipMove = useCallback(
    async (data: ClipMoveData): Promise<void> => {
      if (!sequence) {
        logger.warn('Cannot move clip: no sequence');
        return;
      }

      try {
        await executeCommand({
          type: 'MoveClip',
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
            clipId: data.clipId,
            newTimelineIn: data.newTimelineIn,
            newTrackId: data.newTrackId,
          },
        });
      } catch (error) {
        logger.error('Failed to move clip', { error, clipId: data.clipId });
      }
    },
    [sequence, executeCommand],
  );

  /**
   * Handle clip trim operation.
   * State refresh is automatic via executeCommand.
   */
  const handleClipTrim = useCallback(
    async (data: ClipTrimData): Promise<void> => {
      if (!sequence) {
        logger.warn('Cannot trim clip: no sequence');
        return;
      }

      try {
        await executeCommand({
          type: 'TrimClip',
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
            clipId: data.clipId,
            newSourceIn: data.newSourceIn,
            newSourceOut: data.newSourceOut,
            newTimelineIn: data.newTimelineIn,
          },
        });
      } catch (error) {
        logger.error('Failed to trim clip', { error, clipId: data.clipId });
      }
    },
    [sequence, executeCommand],
  );

  /**
   * Handle clip split operation.
   * State refresh is automatic via executeCommand.
   */
  const handleClipSplit = useCallback(
    async (data: ClipSplitData): Promise<void> => {
      if (!sequence) {
        logger.warn('Cannot split clip: no sequence');
        return;
      }

      try {
        await executeCommand({
          type: 'SplitClip',
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
            clipId: data.clipId,
            splitTime: data.splitTime,
          },
        });
      } catch (error) {
        logger.error('Failed to split clip', { error, clipId: data.clipId });
      }
    },
    [sequence, executeCommand],
  );

  /**
   * Handle asset drop onto timeline.
   * State refresh is automatic via executeCommand.
   */
  const handleAssetDrop = useCallback(
    async (data: AssetDropData): Promise<void> => {
      if (!sequence) {
        logger.warn('Cannot drop asset: no sequence');
        return;
      }

      try {
        await executeCommand({
          type: 'InsertClip',
          payload: {
            sequenceId: sequence.id,
            trackId: data.trackId,
            assetId: data.assetId,
            timelineIn: data.timelinePosition,
          },
        });
      } catch (error) {
        logger.error('Failed to insert clip', { error, assetId: data.assetId });
      }
    },
    [sequence, executeCommand],
  );

  /**
   * Handle delete clips operation.
   *
   * Note: Clips are deleted sequentially through the command queue.
   * Each command automatically refreshes state, so the sequence reference
   * might become stale between deletions. We capture the track IDs upfront.
   */
  const handleDeleteClips = useCallback(
    async (clipIds: string[]): Promise<void> => {
      if (!sequence || clipIds.length === 0) {
        logger.warn('Cannot delete clips: no sequence or empty selection');
        return;
      }

      // Build deletion map upfront to avoid stale sequence references
      const deletionMap: Array<{ clipId: string; trackId: string }> = [];
      for (const clipId of clipIds) {
        for (const track of sequence.tracks) {
          const clip = track.clips.find((c) => c.id === clipId);
          if (clip) {
            deletionMap.push({ clipId, trackId: track.id });
            break;
          }
        }
      }

      if (deletionMap.length === 0) {
        logger.warn('No clips found to delete', { clipIds });
        return;
      }

      try {
        // Delete clips sequentially - command queue ensures ordering
        for (const { clipId, trackId } of deletionMap) {
          await executeCommand({
            type: 'DeleteClip',
            payload: {
              sequenceId: sequence.id,
              trackId,
              clipId,
            },
          });
        }
      } catch (error) {
        logger.error('Failed to delete clips', { error, clipIds });
      }
    },
    [sequence, executeCommand],
  );

  /**
   * Handle track mute toggle.
   * State refresh is automatic via executeCommand.
   */
  const handleTrackMuteToggle = useCallback(
    async (data: TrackControlData): Promise<void> => {
      if (!sequence) {
        logger.warn('Cannot toggle track mute: no sequence');
        return;
      }

      try {
        await executeCommand({
          type: 'ToggleTrackMute',
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
          },
        });
      } catch (error) {
        logger.error('Failed to toggle track mute', { error, trackId: data.trackId });
      }
    },
    [sequence, executeCommand],
  );

  /**
   * Handle track lock toggle.
   * State refresh is automatic via executeCommand.
   */
  const handleTrackLockToggle = useCallback(
    async (data: TrackControlData): Promise<void> => {
      if (!sequence) {
        logger.warn('Cannot toggle track lock: no sequence');
        return;
      }

      try {
        await executeCommand({
          type: 'ToggleTrackLock',
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
          },
        });
      } catch (error) {
        logger.error('Failed to toggle track lock', { error, trackId: data.trackId });
      }
    },
    [sequence, executeCommand],
  );

  /**
   * Handle track visibility toggle.
   * State refresh is automatic via executeCommand.
   */
  const handleTrackVisibilityToggle = useCallback(
    async (data: TrackControlData): Promise<void> => {
      if (!sequence) {
        logger.warn('Cannot toggle track visibility: no sequence');
        return;
      }

      try {
        await executeCommand({
          type: 'ToggleTrackVisibility',
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
          },
        });
      } catch (error) {
        logger.error('Failed to toggle track visibility', { error, trackId: data.trackId });
      }
    },
    [sequence, executeCommand],
  );

  /**
   * Handle caption update.
   * State refresh is automatic via executeCommand.
   */
  const handleUpdateCaption = useCallback(
    async (data: CaptionUpdateData): Promise<void> => {
      if (!sequence) {
        logger.warn('Cannot update caption: no sequence');
        return;
      }

      try {
        await executeCommand({
          type: 'UpdateCaption',
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
            captionId: data.captionId,
            text: data.text,
            startSec: data.startSec,
            endSec: data.endSec,
            style: data.style,
          },
        });
      } catch (error) {
        logger.error('Failed to update caption', { error, captionId: data.captionId });
      }
    },
    [sequence, executeCommand],
  );

  return {
    handleClipMove,
    handleClipTrim,
    handleClipSplit,
    handleAssetDrop,
    handleDeleteClips,
    handleTrackMuteToggle,
    handleTrackLockToggle,
    handleTrackVisibilityToggle,
    handleUpdateCaption,
  };
}

/**
 * useTimelineActions Hook
 *
 * Provides callbacks for Timeline component that execute Tauri IPC commands
 * and refresh project state.
 */

import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '@/stores';
import { createLogger } from '@/services/logger';

const logger = createLogger('TimelineActions');
import type {
  AssetDropData,
  ClipMoveData,
  ClipTrimData,
  ClipSplitData,
  TrackControlData,
  CaptionUpdateData,
} from '@/components/timeline/Timeline';
import type { Sequence, Asset } from '@/types';

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
// Helper Functions
// =============================================================================

/**
 * Refreshes the project state from the backend
 */
async function refreshProjectState(
  setAssets: (assets: Map<string, Asset>) => void,
  setSequences: (sequences: Map<string, Sequence>) => void,
): Promise<void> {
  try {
    const projectState = await invoke<{
      assets: Asset[];
      sequences: Sequence[];
      activeSequenceId: string | null;
    }>('get_project_state');

    // Update assets
    const assetsMap = new Map<string, Asset>();
    for (const asset of projectState.assets) {
      assetsMap.set(asset.id, asset);
    }
    setAssets(assetsMap);

    // Update sequences
    const sequencesMap = new Map<string, Sequence>();
    for (const sequence of projectState.sequences) {
      sequencesMap.set(sequence.id, sequence);
    }
    setSequences(sequencesMap);
  } catch (error) {
    logger.error('Failed to refresh project state', { error });
    throw error;
  }
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Custom hook that provides Timeline action callbacks connected to Tauri IPC
 */
export function useTimelineActions({ sequence }: UseTimelineActionsOptions): TimelineActions {
  const executeCommand = useProjectStore((state) => state.executeCommand);

  // Access store setter via getState for refresh
  const refreshState = useCallback(async () => {
    await refreshProjectState(
      (assets) => useProjectStore.setState({ assets }),
      (sequences) => useProjectStore.setState({ sequences }),
    );
  }, []);

  /**
   * Handle clip move operation
   */
  const handleClipMove = useCallback(
    async (data: ClipMoveData): Promise<void> => {
      if (!sequence) return;

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
        await refreshState();
      } catch (error) {
        logger.error('Failed to move clip', { error });
      }
    },
    [sequence, executeCommand, refreshState],
  );

  /**
   * Handle clip trim operation
   */
  const handleClipTrim = useCallback(
    async (data: ClipTrimData): Promise<void> => {
      if (!sequence) return;

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
        await refreshState();
      } catch (error) {
        logger.error('Failed to trim clip', { error });
      }
    },
    [sequence, executeCommand, refreshState],
  );

  /**
   * Handle clip split operation
   */
  const handleClipSplit = useCallback(
    async (data: ClipSplitData): Promise<void> => {
      if (!sequence) return;

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
        await refreshState();
      } catch (error) {
        logger.error('Failed to split clip', { error });
      }
    },
    [sequence, executeCommand, refreshState],
  );

  /**
   * Handle asset drop onto timeline
   */
  const handleAssetDrop = useCallback(
    async (data: AssetDropData): Promise<void> => {
      if (!sequence) return;

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
        await refreshState();
      } catch (error) {
        logger.error('Failed to insert clip', { error });
      }
    },
    [sequence, executeCommand, refreshState],
  );

  /**
   * Handle delete clips operation
   */
  const handleDeleteClips = useCallback(
    async (clipIds: string[]): Promise<void> => {
      if (!sequence || clipIds.length === 0) return;

      try {
        // Find track for each clip and delete
        for (const clipId of clipIds) {
          // Find which track contains this clip
          let trackId: string | null = null;
          for (const track of sequence.tracks) {
            const clip = track.clips.find((c) => c.id === clipId);
            if (clip) {
              trackId = track.id;
              break;
            }
          }

          if (trackId) {
            await executeCommand({
              type: 'DeleteClip',
              payload: {
                sequenceId: sequence.id,
                trackId,
                clipId,
              },
            });
          }
        }
        await refreshState();
      } catch (error) {
        logger.error('Failed to delete clips', { error });
      }
    },
    [sequence, executeCommand, refreshState],
  );

  /**
   * Handle track mute toggle
   */
  const handleTrackMuteToggle = useCallback(
    async (data: TrackControlData): Promise<void> => {
      if (!sequence) return;

      try {
        await executeCommand({
          type: 'ToggleTrackMute',
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
          },
        });
        await refreshState();
      } catch (error) {
        logger.error('Failed to toggle track mute', { error });
      }
    },
    [sequence, executeCommand, refreshState],
  );

  /**
   * Handle track lock toggle
   */
  const handleTrackLockToggle = useCallback(
    async (data: TrackControlData): Promise<void> => {
      if (!sequence) return;

      try {
        await executeCommand({
          type: 'ToggleTrackLock',
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
          },
        });
        await refreshState();
      } catch (error) {
        logger.error('Failed to toggle track lock', { error });
      }
    },
    [sequence, executeCommand, refreshState],
  );

  /**
   * Handle track visibility toggle
   */
  const handleTrackVisibilityToggle = useCallback(
    async (data: TrackControlData): Promise<void> => {
      if (!sequence) return;

      try {
        await executeCommand({
          type: 'ToggleTrackVisibility',
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
          },
        });
        await refreshState();
      } catch (error) {
        logger.error('Failed to toggle track visibility', { error });
      }
    },
    [sequence, executeCommand, refreshState],
  );

  /**
   * Handle caption update
   */
  const handleUpdateCaption = useCallback(
    async (data: CaptionUpdateData): Promise<void> => {
      if (!sequence) return;

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
        await refreshState();
      } catch (error) {
        logger.error('Failed to update caption', { error });
      }
    },
    [sequence, executeCommand, refreshState],
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

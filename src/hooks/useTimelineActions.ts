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
import { useTimelineStore } from '@/stores/timelineStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { createLogger } from '@/services/logger';
import { refreshProjectState } from '@/utils/stateRefreshHelper';
import type {
  AssetDropData,
  ClipAudioUpdateData,
  ClipMoveData,
  ClipTrimData,
  ClipSplitData,
  TrackControlData,
  TrackCreateData,
  CaptionUpdateData,
} from '@/components/timeline/Timeline';
import type { Asset, Command, CommandResult, Sequence, Track } from '@/types';
import {
  buildLinkedMoveTargets,
  buildLinkedTrimTargets,
  expandClipIdsWithLinkedCompanions,
  findClipReference,
  getLinkedSplitTargets,
} from '@/utils/clipLinking';
import {
  buildClipAudioPayload,
  buildClipDeletionMap,
  ensureSourceClipExistsOrWarn,
  findClipByAssetAtTimeline,
  getAssetInsertDurationSec,
  getDefaultTrackInsertPosition,
  getNextTrackName,
  getSequenceSnapshotOrWarn,
  getClipTimelineDuration,
  hasClipAudioUpdates,
  resolveAssetHasLinkedAudio,
  runLinkedCompanionCommands,
  selectPreferredAudioTrack,
  selectPreferredVisualTrack,
  trackHasOverlap,
} from '@/hooks/timelineActions/helpers';

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
  handleClipAudioUpdate: (data: ClipAudioUpdateData) => Promise<void>;
  handleAssetDrop: (data: AssetDropData) => Promise<void>;
  handleDeleteClips: (clipIds: string[]) => Promise<void>;
  handleTrackCreate: (data: TrackCreateData) => Promise<void>;
  handleTrackMuteToggle: (data: TrackControlData) => Promise<void>;
  handleTrackLockToggle: (data: TrackControlData) => Promise<void>;
  handleTrackVisibilityToggle: (data: TrackControlData) => Promise<void>;
  handleUpdateCaption: (data: CaptionUpdateData) => Promise<void>;
}

type ExecuteTimelineCommand = (command: Command) => Promise<CommandResult>;

interface ResolvedDroppedAssetContext {
  droppedAssetId: string;
  droppedAsset: Asset | undefined;
  droppedAssetKind: Asset['kind'] | undefined;
}

interface ResolveDroppedAssetContextOptions {
  data: AssetDropData;
  sequence: Sequence;
  assets: Map<string, Asset>;
}

/**
 * Recursively searches the file tree for an entry matching the given
 * relative path and returns its auto-registered asset ID.
 */
function findAssetIdInTree(
  entries: import('@/types').FileTreeEntry[],
  relativePath: string,
): string | undefined {
  for (const entry of entries) {
    if (!entry.isDirectory && entry.relativePath === relativePath) {
      return entry.assetId;
    }
    if (entry.isDirectory && entry.children.length > 0) {
      const found = findAssetIdInTree(entry.children, relativePath);
      if (found) return found;
    }
  }
  return undefined;
}

function findAssetIdInAssetsByRelativePath(
  assets: Map<string, Asset>,
  relativePath: string,
): string | undefined {
  for (const asset of assets.values()) {
    if (asset.relativePath === relativePath) {
      return asset.id;
    }
  }
  return undefined;
}

async function resolveDroppedAssetContext({
  data,
  sequence,
  assets,
}: ResolveDroppedAssetContextOptions): Promise<ResolvedDroppedAssetContext | null> {
  let droppedAssetId = data.assetId;
  let droppedAsset = droppedAssetId ? assets.get(droppedAssetId) : undefined;
  let droppedAssetKind = droppedAsset?.kind ?? data.assetKind;
  const workspaceRelativePath =
    'workspaceRelativePath' in data && typeof data.workspaceRelativePath === 'string'
      ? data.workspaceRelativePath
      : undefined;

  if (
    workspaceRelativePath &&
    droppedAssetId &&
    droppedAsset?.relativePath &&
    droppedAsset.relativePath !== workspaceRelativePath
  ) {
    logger.warn('Drop payload assetId does not match workspace path; resolving by workspace path', {
      sequenceId: sequence.id,
      trackId: data.trackId,
      payloadAssetId: droppedAssetId,
      payloadAssetRelativePath: droppedAsset.relativePath,
      workspaceRelativePath,
    });
    droppedAssetId = undefined;
    droppedAsset = undefined;
    droppedAssetKind = data.assetKind;
  }

  // In the filesystem-first model, files are auto-registered by the backend.
  // If we have a workspace path but no asset ID, look it up from the file tree
  // or refresh project state to pick up the auto-registered asset.
  const needsAssetLookup = !!workspaceRelativePath && (!droppedAssetId || droppedAsset == null);

  if (needsAssetLookup && workspaceRelativePath) {
    const existingAssetId = findAssetIdInAssetsByRelativePath(
      useProjectStore.getState().assets,
      workspaceRelativePath,
    );
    if (existingAssetId) {
      droppedAssetId = existingAssetId;
      droppedAsset = useProjectStore.getState().assets.get(existingAssetId);
      droppedAssetKind = droppedAsset?.kind ?? data.assetKind;
    }

    if (droppedAssetId && droppedAsset) {
      return {
        droppedAssetId,
        droppedAsset,
        droppedAssetKind,
      };
    }

    // Refresh tree to ensure auto-registration is picked up
    try {
      await useWorkspaceStore.getState().refreshTree();
    } catch {
      // Non-fatal: tree refresh may fail but asset may still be available
    }

    // Look up asset ID from the file tree (auto-registered by backend)
    const fileTree = useWorkspaceStore.getState().fileTree;
    const foundAssetId = findAssetIdInTree(fileTree, workspaceRelativePath);

    if (foundAssetId && useProjectStore.getState().assets.has(foundAssetId)) {
      droppedAssetId = foundAssetId;
      droppedAsset = useProjectStore.getState().assets.get(foundAssetId);
      droppedAssetKind = droppedAsset?.kind ?? data.assetKind;
      return {
        droppedAssetId,
        droppedAsset,
        droppedAssetKind,
      };
    }

    // Refresh project assets as a fallback (covers stale index asset IDs)
    try {
      const freshState = await refreshProjectState();
      useProjectStore.setState((draft) => {
        draft.assets = freshState.assets;
      });
    } catch (error) {
      logger.warn('Failed to refresh project assets for workspace drop', {
        sequenceId: sequence.id,
        trackId: data.trackId,
        workspaceRelativePath,
        error,
      });
    }

    const refreshedAssets = useProjectStore.getState().assets;
    const refreshedTree = useWorkspaceStore.getState().fileTree;
    const refreshedTreeAssetId = findAssetIdInTree(refreshedTree, workspaceRelativePath);
    const refreshedPathAssetId = findAssetIdInAssetsByRelativePath(
      refreshedAssets,
      workspaceRelativePath,
    );

    droppedAssetId =
      (refreshedTreeAssetId && refreshedAssets.has(refreshedTreeAssetId)
        ? refreshedTreeAssetId
        : undefined) ?? refreshedPathAssetId;

    if (!droppedAssetId) {
      logger.warn('Cannot drop workspace file: asset not found after refresh', {
        sequenceId: sequence.id,
        trackId: data.trackId,
        workspaceRelativePath,
      });
      return null;
    }

    droppedAsset = refreshedAssets.get(droppedAssetId);
    droppedAssetKind = droppedAsset?.kind ?? data.assetKind;
  }

  if (!droppedAssetId) {
    logger.warn('Cannot drop asset: missing asset ID and workspace path', {
      sequenceId: sequence.id,
      trackId: data.trackId,
    });
    return null;
  }

  return {
    droppedAssetId,
    droppedAsset,
    droppedAssetKind,
  };
}

interface ResolveOrCreateTrackOptions {
  kind: TrackCreateData['kind'];
  sequence: Sequence;
  sequenceSnapshot: Sequence;
  preferredTrack: Track | undefined;
  timelineIn: number;
  durationSec: number;
  assetId: string;
  executeCommand: ExecuteTimelineCommand;
  getCurrentSequence: () => Sequence | null;
  createTrackFailureMessage: string;
  snapshotUnavailableMessage: string;
  missingTrackMessage: string;
}

async function resolveOrCreateTrack({
  kind,
  sequence,
  sequenceSnapshot,
  preferredTrack,
  timelineIn,
  durationSec,
  assetId,
  executeCommand,
  getCurrentSequence,
  createTrackFailureMessage,
  snapshotUnavailableMessage,
  missingTrackMessage,
}: ResolveOrCreateTrackOptions): Promise<Track | null> {
  const selectedTrack =
    kind === 'video'
      ? selectPreferredVisualTrack(sequenceSnapshot, preferredTrack, timelineIn, durationSec)
      : selectPreferredAudioTrack(sequenceSnapshot, preferredTrack, timelineIn, durationSec);

  if (selectedTrack) {
    return selectedTrack;
  }

  const createdTrackResult = await executeCommand({
    type: 'CreateTrack',
    payload: {
      sequenceId: sequence.id,
      kind,
      name: getNextTrackName(sequenceSnapshot, kind),
      position: getDefaultTrackInsertPosition(sequenceSnapshot, kind),
    },
  });

  const createdTrackId = createdTrackResult.createdIds[0];
  if (!createdTrackId) {
    logger.warn(createTrackFailureMessage, {
      sequenceId: sequence.id,
      assetId,
    });
    return null;
  }

  const refreshedSequence = getCurrentSequence();
  if (!refreshedSequence) {
    logger.warn(snapshotUnavailableMessage, {
      sequenceId: sequence.id,
      createdTrackId,
    });
    return null;
  }

  const createdTrack = refreshedSequence.tracks.find((track) => track.id === createdTrackId);
  if (!createdTrack) {
    logger.warn(missingTrackMessage, {
      sequenceId: sequence.id,
      createdTrackId,
    });
    return null;
  }

  return createdTrack;
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
  const assets = useProjectStore((state) => state.assets);
  const linkedSelectionEnabled = useTimelineStore((state) => state.linkedSelectionEnabled);

  const getCurrentSequence = useCallback((): Sequence | null => {
    if (!sequence) {
      return null;
    }

    return useProjectStore.getState().sequences.get(sequence.id) ?? sequence;
  }, [sequence]);

  const executeTrackToggle = useCallback(
    async (
      data: TrackControlData,
      commandType: 'ToggleTrackMute' | 'ToggleTrackLock' | 'ToggleTrackVisibility',
      missingSequenceMessage: string,
      failureMessage: string,
    ): Promise<void> => {
      if (!sequence) {
        logger.warn(missingSequenceMessage);
        return;
      }

      try {
        await executeCommand({
          type: commandType,
          payload: {
            sequenceId: data.sequenceId,
            trackId: data.trackId,
          },
        });
      } catch (error) {
        logger.error(failureMessage, { error, trackId: data.trackId });
      }
    },
    [sequence, executeCommand],
  );

  /**
   * Handle clip move operation.
   * State refresh is automatic via executeCommand.
   */
  const handleClipMove = useCallback(
    async (data: ClipMoveData): Promise<void> => {
      const sequenceSnapshot = getSequenceSnapshotOrWarn({
        sequence,
        getCurrentSequence,
        logger,
        missingSequenceMessage: 'Cannot move clip: no sequence',
        missingSnapshotMessage: 'Cannot move clip: sequence snapshot unavailable',
        missingSnapshotContext: {
          sequenceId: data.sequenceId,
          clipId: data.clipId,
        },
      });
      if (!sequenceSnapshot) {
        return;
      }

      if (
        !ensureSourceClipExistsOrWarn({
          sequenceSnapshot,
          clipId: data.clipId,
          logger,
          missingClipMessage: 'Cannot move clip: source clip no longer exists',
          missingClipContext: {
            sequenceId: data.sequenceId,
            clipId: data.clipId,
          },
        })
      ) {
        return;
      }

      const shouldMoveLinkedCompanions = linkedSelectionEnabled && !data.ignoreLinkedSelection;
      const linkedMoveTargets = shouldMoveLinkedCompanions
        ? buildLinkedMoveTargets(sequenceSnapshot, data.clipId, data.newTimelineIn)
        : [];

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

        await runLinkedCompanionCommands(
          linkedMoveTargets,
          getCurrentSequence,
          async (linkedMove, latestSequence): Promise<void> => {
            const linkedClipRef = findClipReference(latestSequence, linkedMove.clipId);
            if (!linkedClipRef) {
              return;
            }

            const linkedClipDuration = getClipTimelineDuration(linkedClipRef.clip);
            const targetTrack = latestSequence.tracks.find(
              (track) => track.id === linkedMove.trackId,
            );
            if (!targetTrack) {
              return;
            }

            const hasOverlap = trackHasOverlap(
              targetTrack,
              linkedMove.newTimelineIn,
              linkedClipDuration,
              linkedMove.clipId,
            );

            if (hasOverlap) {
              logger.warn('Linked companion move skipped due to overlap', {
                sequenceId: data.sequenceId,
                sourceClipId: data.clipId,
                linkedClipId: linkedMove.clipId,
                targetTrackId: linkedMove.trackId,
                newTimelineIn: linkedMove.newTimelineIn,
              });
              return;
            }

            await executeCommand({
              type: 'MoveClip',
              payload: {
                sequenceId: data.sequenceId,
                trackId: linkedMove.trackId,
                clipId: linkedMove.clipId,
                newTimelineIn: linkedMove.newTimelineIn,
              },
            });
          },
        );
      } catch (error) {
        logger.error('Failed to move clip', { error, clipId: data.clipId });
      }
    },
    [sequence, executeCommand, linkedSelectionEnabled, getCurrentSequence],
  );

  /**
   * Handle clip trim operation.
   * State refresh is automatic via executeCommand.
   */
  const handleClipTrim = useCallback(
    async (data: ClipTrimData): Promise<void> => {
      const sequenceSnapshot = getSequenceSnapshotOrWarn({
        sequence,
        getCurrentSequence,
        logger,
        missingSequenceMessage: 'Cannot trim clip: no sequence',
        missingSnapshotMessage: 'Cannot trim clip: sequence snapshot unavailable',
        missingSnapshotContext: {
          sequenceId: data.sequenceId,
          clipId: data.clipId,
        },
      });
      if (!sequenceSnapshot) {
        return;
      }

      if (
        !ensureSourceClipExistsOrWarn({
          sequenceSnapshot,
          clipId: data.clipId,
          logger,
          missingClipMessage: 'Cannot trim clip: source clip no longer exists',
          missingClipContext: {
            sequenceId: data.sequenceId,
            clipId: data.clipId,
          },
        })
      ) {
        return;
      }

      const shouldTrimLinkedCompanions = linkedSelectionEnabled && !data.ignoreLinkedSelection;
      const linkedTrimTargets = shouldTrimLinkedCompanions
        ? buildLinkedTrimTargets(sequenceSnapshot, data)
        : [];

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

        await runLinkedCompanionCommands(
          linkedTrimTargets,
          getCurrentSequence,
          async (linkedTrim): Promise<void> => {
            await executeCommand({
              type: 'TrimClip',
              payload: {
                sequenceId: linkedTrim.sequenceId,
                trackId: linkedTrim.trackId,
                clipId: linkedTrim.clipId,
                newSourceIn: linkedTrim.newSourceIn,
                newSourceOut: linkedTrim.newSourceOut,
                newTimelineIn: linkedTrim.newTimelineIn,
              },
            });
          },
        );
      } catch (error) {
        logger.error('Failed to trim clip', { error, clipId: data.clipId });
      }
    },
    [sequence, executeCommand, linkedSelectionEnabled, getCurrentSequence],
  );

  /**
   * Handle clip split operation.
   * State refresh is automatic via executeCommand.
   */
  const handleClipSplit = useCallback(
    async (data: ClipSplitData): Promise<void> => {
      const sequenceSnapshot = getSequenceSnapshotOrWarn({
        sequence,
        getCurrentSequence,
        logger,
        missingSequenceMessage: 'Cannot split clip: no sequence',
        missingSnapshotMessage: 'Cannot split clip: sequence snapshot unavailable',
        missingSnapshotContext: {
          sequenceId: data.sequenceId,
          clipId: data.clipId,
        },
      });
      if (!sequenceSnapshot) {
        return;
      }

      if (
        !ensureSourceClipExistsOrWarn({
          sequenceSnapshot,
          clipId: data.clipId,
          logger,
          missingClipMessage: 'Cannot split clip: source clip no longer exists',
          missingClipContext: {
            sequenceId: data.sequenceId,
            clipId: data.clipId,
          },
        })
      ) {
        return;
      }

      const shouldSplitLinkedCompanions = linkedSelectionEnabled && !data.ignoreLinkedSelection;
      const linkedSplitTargets = shouldSplitLinkedCompanions
        ? getLinkedSplitTargets(sequenceSnapshot, data.clipId, data.splitTime)
        : [];

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

        await runLinkedCompanionCommands(
          linkedSplitTargets,
          getCurrentSequence,
          async (linkedSplit): Promise<void> => {
            await executeCommand({
              type: 'SplitClip',
              payload: {
                sequenceId: data.sequenceId,
                trackId: linkedSplit.trackId,
                clipId: linkedSplit.clipId,
                splitTime: data.splitTime,
              },
            });
          },
        );
      } catch (error) {
        logger.error('Failed to split clip', { error, clipId: data.clipId });
      }
    },
    [sequence, executeCommand, linkedSelectionEnabled, getCurrentSequence],
  );

  /**
   * Handle clip-level audio setting updates.
   */
  const handleClipAudioUpdate = useCallback(
    async (data: ClipAudioUpdateData): Promise<void> => {
      if (!sequence) {
        logger.warn('Cannot update clip audio: no sequence');
        return;
      }

      const payload = buildClipAudioPayload(data);
      if (!hasClipAudioUpdates(payload)) {
        return;
      }

      try {
        await executeCommand({
          type: 'SetClipAudio',
          payload,
        });
      } catch (error) {
        logger.error('Failed to update clip audio settings', {
          error,
          clipId: data.clipId,
          trackId: data.trackId,
        });
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
      const sequenceSnapshot = getSequenceSnapshotOrWarn({
        sequence,
        getCurrentSequence,
        logger,
        missingSequenceMessage: 'Cannot drop asset: no sequence',
        missingSnapshotMessage: 'Cannot drop asset: sequence snapshot unavailable',
        missingSnapshotContext: {
          sequenceId: sequence?.id,
          trackId: data.trackId,
          assetId: data.assetId,
          workspaceRelativePath:
            'workspaceRelativePath' in data ? data.workspaceRelativePath : undefined,
        },
      });

      if (!sequence || !sequenceSnapshot) {
        return;
      }

      const droppedAssetContext = await resolveDroppedAssetContext({
        data,
        sequence,
        assets,
      });
      if (!droppedAssetContext) {
        return;
      }

      const { droppedAssetId, droppedAsset, droppedAssetKind } = droppedAssetContext;

      const targetTrack = sequenceSnapshot.tracks.find((track) => track.id === data.trackId);

      try {
        if (!droppedAsset || droppedAssetKind !== 'video') {
          await executeCommand({
            type: 'InsertClip',
            payload: {
              sequenceId: sequence.id,
              trackId: data.trackId,
              assetId: droppedAssetId,
              timelineIn: data.timelinePosition,
            },
          });
          return;
        }

        const clipDurationSec = getAssetInsertDurationSec(droppedAsset);
        const visualTrack = await resolveOrCreateTrack({
          kind: 'video',
          sequence,
          sequenceSnapshot,
          preferredTrack: targetTrack,
          timelineIn: data.timelinePosition,
          durationSec: clipDurationSec,
          assetId: droppedAssetId,
          executeCommand,
          getCurrentSequence,
          createTrackFailureMessage: 'Unable to auto-create visual track for dropped video asset',
          snapshotUnavailableMessage:
            'Created visual track cannot be resolved: sequence snapshot unavailable',
          missingTrackMessage: 'Created visual track not found after state refresh',
        });
        if (!visualTrack) {
          return;
        }

        const primaryVideoInsertResult = await executeCommand({
          type: 'InsertClip',
          payload: {
            sequenceId: sequence.id,
            trackId: visualTrack.id,
            assetId: droppedAssetId,
            timelineIn: data.timelinePosition,
          },
        });

        let primaryVideoClipId: string | undefined = primaryVideoInsertResult.createdIds[0];
        if (!primaryVideoClipId) {
          const postVideoInsertSequence = getCurrentSequence();
          const postVideoTrack = postVideoInsertSequence?.tracks.find(
            (track) => track.id === visualTrack.id,
          );
          primaryVideoClipId = findClipByAssetAtTimeline(
            postVideoTrack,
            droppedAssetId,
            data.timelinePosition,
          )?.id;
        }

        const latestDroppedAsset =
          useProjectStore.getState().assets.get(droppedAssetId) ?? droppedAsset;
        const hasLinkedAudio = await resolveAssetHasLinkedAudio(latestDroppedAsset, logger);
        if (!hasLinkedAudio) {
          return;
        }

        try {
          const postVideoInsertSequence = getCurrentSequence();
          if (!postVideoInsertSequence) {
            logger.warn(
              'Unable to insert linked audio: sequence snapshot unavailable after insert',
              {
                sequenceId: sequence.id,
                assetId: droppedAssetId,
              },
            );
            return;
          }

          const latestTargetTrack = postVideoInsertSequence.tracks.find(
            (track) => track.id === data.trackId,
          );

          const audioTrack = await resolveOrCreateTrack({
            kind: 'audio',
            sequence,
            sequenceSnapshot: postVideoInsertSequence,
            preferredTrack: latestTargetTrack,
            timelineIn: data.timelinePosition,
            durationSec: clipDurationSec,
            assetId: droppedAssetId,
            executeCommand,
            getCurrentSequence,
            createTrackFailureMessage:
              'Unable to auto-create audio track for linked audio extraction',
            snapshotUnavailableMessage:
              'Created audio track cannot be resolved: sequence snapshot unavailable',
            missingTrackMessage: 'Created audio track not found after state refresh',
          });
          if (!audioTrack) {
            return;
          }

          await executeCommand({
            type: 'InsertClip',
            payload: {
              sequenceId: sequence.id,
              trackId: audioTrack.id,
              assetId: droppedAssetId,
              timelineIn: data.timelinePosition,
            },
          });

          if (!primaryVideoClipId) {
            logger.warn('Linked audio inserted, but source video clip ID could not be resolved', {
              sequenceId: sequence.id,
              assetId: droppedAssetId,
              videoTrackId: visualTrack.id,
              timelinePosition: data.timelinePosition,
            });
            return;
          }

          try {
            await executeCommand({
              type: 'SetClipMute',
              payload: {
                sequenceId: sequence.id,
                trackId: visualTrack.id,
                clipId: primaryVideoClipId,
                muted: true,
              },
            });
          } catch (muteError) {
            logger.warn('Linked A/V pair inserted, but failed to mute source video clip audio', {
              sequenceId: sequence.id,
              assetId: droppedAssetId,
              videoTrackId: visualTrack.id,
              videoClipId: primaryVideoClipId,
              error: muteError,
            });
          }
        } catch (audioInsertError) {
          logger.warn('Primary clip inserted, but linked audio extraction failed', {
            sequenceId: sequence.id,
            trackId: data.trackId,
            assetId: droppedAssetId,
            timelinePosition: data.timelinePosition,
            error: audioInsertError,
          });
        }
      } catch (error) {
        logger.error('Failed to insert clip', { error, assetId: droppedAssetId });
      }
    },
    [sequence, executeCommand, assets, getCurrentSequence],
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

      const sequenceSnapshot = getCurrentSequence();
      if (!sequenceSnapshot) {
        logger.warn('Cannot delete clips: sequence snapshot unavailable', {
          sequenceId: sequence.id,
          clipIds,
        });
        return;
      }

      const clipIdsToDelete = linkedSelectionEnabled
        ? expandClipIdsWithLinkedCompanions(sequenceSnapshot, clipIds)
        : clipIds;

      const deletionMap = buildClipDeletionMap(sequenceSnapshot, clipIdsToDelete);

      if (deletionMap.length === 0) {
        logger.warn('No clips found to delete', { clipIds: clipIdsToDelete });
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
        logger.error('Failed to delete clips', { error, clipIds: clipIdsToDelete });
      }
    },
    [sequence, executeCommand, linkedSelectionEnabled, getCurrentSequence],
  );

  /**
   * Handle creating a new track with deterministic naming and placement.
   */
  const handleTrackCreate = useCallback(
    async (data: TrackCreateData): Promise<void> => {
      if (!sequence) {
        logger.warn('Cannot create track: no sequence');
        return;
      }

      const trimmedName = data.name?.trim();
      const trackName =
        trimmedName && trimmedName.length > 0 ? trimmedName : getNextTrackName(sequence, data.kind);
      const position =
        typeof data.position === 'number'
          ? data.position
          : getDefaultTrackInsertPosition(sequence, data.kind);

      try {
        await executeCommand({
          type: 'CreateTrack',
          payload: {
            sequenceId: data.sequenceId,
            kind: data.kind,
            name: trackName,
            position,
          },
        });
      } catch (error) {
        logger.error('Failed to create track', {
          error,
          sequenceId: data.sequenceId,
          kind: data.kind,
          name: trackName,
          position,
        });
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
      await executeTrackToggle(
        data,
        'ToggleTrackMute',
        'Cannot toggle track mute: no sequence',
        'Failed to toggle track mute',
      );
    },
    [executeTrackToggle],
  );

  /**
   * Handle track lock toggle.
   * State refresh is automatic via executeCommand.
   */
  const handleTrackLockToggle = useCallback(
    async (data: TrackControlData): Promise<void> => {
      await executeTrackToggle(
        data,
        'ToggleTrackLock',
        'Cannot toggle track lock: no sequence',
        'Failed to toggle track lock',
      );
    },
    [executeTrackToggle],
  );

  /**
   * Handle track visibility toggle.
   * State refresh is automatic via executeCommand.
   */
  const handleTrackVisibilityToggle = useCallback(
    async (data: TrackControlData): Promise<void> => {
      await executeTrackToggle(
        data,
        'ToggleTrackVisibility',
        'Cannot toggle track visibility: no sequence',
        'Failed to toggle track visibility',
      );
    },
    [executeTrackToggle],
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
    handleClipAudioUpdate,
    handleAssetDrop,
    handleDeleteClips,
    handleTrackCreate,
    handleTrackMuteToggle,
    handleTrackLockToggle,
    handleTrackVisibilityToggle,
    handleUpdateCaption,
  };
}

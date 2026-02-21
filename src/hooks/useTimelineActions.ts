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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/stores';
import { useTimelineStore } from '@/stores/timelineStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useToastStore } from '@/hooks/useToast';
import { createLogger } from '@/services/logger';
import { refreshProjectState } from '@/utils/stateRefreshHelper';
import { probeMedia } from '@/utils/ffmpeg';
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

const WORKSPACE_DROP_QUEUE_MAX_ATTEMPTS = 3;
const WORKSPACE_DROP_QUEUE_RETRY_DELAY_MS = 350;

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
  pendingWorkspaceDrops: PendingWorkspaceDropState[];
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

interface QueuedWorkspaceDrop {
  id: string;
  data: AssetDropData;
  attempts: number;
  enqueuedAt: number;
  resolvedDurationSec?: number;
  resolveCompletion: (inserted: boolean) => void;
}

export interface PendingWorkspaceDropState {
  id: string;
  trackId: string;
  timelinePosition: number;
  label: string;
  workspaceRelativePath: string;
  assetKind?: Asset['kind'];
  durationSec?: number;
  progressPercent: number;
  attempts: number;
  status: 'queued' | 'resolving' | 'inserting';
}

function createWorkspaceDropId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `workspace-drop-${crypto.randomUUID()}`;
  }

  return `workspace-drop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function waitForDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getWorkspaceRelativePathFromDrop(data: AssetDropData): string | undefined {
  return 'workspaceRelativePath' in data && typeof data.workspaceRelativePath === 'string'
    ? data.workspaceRelativePath
    : undefined;
}

function getWorkspaceFileName(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const name = segments[segments.length - 1]?.trim();
  return name && name.length > 0 ? name : relativePath;
}

function normalizeDurationSec(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function normalizeProgressPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function shouldProbePendingDuration(assetKind: Asset['kind'] | undefined): boolean {
  return assetKind === 'video' || assetKind === 'audio';
}

function shouldQueueWorkspaceDropInBackground(
  data: AssetDropData,
  assets: Map<string, Asset>,
): boolean {
  const workspaceRelativePath = getWorkspaceRelativePathFromDrop(data);
  if (!workspaceRelativePath) {
    return false;
  }

  const payloadAssetId = data.assetId;
  if (!payloadAssetId) {
    return true;
  }

  const payloadAsset = assets.get(payloadAssetId);
  if (!payloadAsset) {
    return true;
  }

  return Boolean(payloadAsset.relativePath && payloadAsset.relativePath !== workspaceRelativePath);
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

    let resolvedAssets = useProjectStore.getState().assets;
    let resolvedTree = useWorkspaceStore.getState().fileTree;
    let resolvedTreeAssetId = findAssetIdInTree(resolvedTree, workspaceRelativePath);
    let resolvedPathAssetId = findAssetIdInAssetsByRelativePath(
      resolvedAssets,
      workspaceRelativePath,
    );

    droppedAssetId =
      (resolvedTreeAssetId && resolvedAssets.has(resolvedTreeAssetId)
        ? resolvedTreeAssetId
        : undefined) ?? resolvedPathAssetId;

    if (!droppedAssetId) {
      logger.info('Workspace drop unresolved after refresh; triggering workspace scan', {
        sequenceId: sequence.id,
        trackId: data.trackId,
        workspaceRelativePath,
      });

      try {
        await useWorkspaceStore.getState().scanWorkspace();
      } catch (error) {
        logger.warn('Failed to scan workspace while resolving dropped file', {
          sequenceId: sequence.id,
          trackId: data.trackId,
          workspaceRelativePath,
          error,
        });
      }

      try {
        const freshState = await refreshProjectState();
        useProjectStore.setState((draft) => {
          draft.assets = freshState.assets;
        });
      } catch (error) {
        logger.warn('Failed to refresh project assets after workspace scan', {
          sequenceId: sequence.id,
          trackId: data.trackId,
          workspaceRelativePath,
          error,
        });
      }

      resolvedAssets = useProjectStore.getState().assets;
      resolvedTree = useWorkspaceStore.getState().fileTree;
      resolvedTreeAssetId = findAssetIdInTree(resolvedTree, workspaceRelativePath);
      resolvedPathAssetId = findAssetIdInAssetsByRelativePath(
        resolvedAssets,
        workspaceRelativePath,
      );

      droppedAssetId =
        (resolvedTreeAssetId && resolvedAssets.has(resolvedTreeAssetId)
          ? resolvedTreeAssetId
          : undefined) ?? resolvedPathAssetId;
    }

    if (!droppedAssetId) {
      logger.warn('Cannot drop workspace file: asset not found after scan', {
        sequenceId: sequence.id,
        trackId: data.trackId,
        workspaceRelativePath,
      });
      return null;
    }

    droppedAsset = resolvedAssets.get(droppedAssetId);
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
  const linkedSelectionEnabled = useTimelineStore((state) => state.linkedSelectionEnabled);

  const getCurrentSequence = useCallback((): Sequence | null => {
    if (!sequence) {
      return null;
    }

    return useProjectStore.getState().sequences.get(sequence.id) ?? sequence;
  }, [sequence]);

  const workspaceDropQueueRef = useRef<QueuedWorkspaceDrop[]>([]);
  const isProcessingWorkspaceDropQueueRef = useRef(false);
  const sequenceIdRef = useRef<string | null>(sequence?.id ?? null);
  const [pendingWorkspaceDrops, setPendingWorkspaceDrops] = useState<PendingWorkspaceDropState[]>(
    [],
  );

  const upsertPendingWorkspaceDrop = useCallback(
    (dropId: string, patch: Partial<Omit<PendingWorkspaceDropState, 'id'>>): void => {
      const normalizedPatch = {
        ...patch,
        ...(patch.progressPercent !== undefined
          ? { progressPercent: normalizeProgressPercent(patch.progressPercent) }
          : {}),
      };

      setPendingWorkspaceDrops((current) =>
        current.map((entry) => {
          if (entry.id !== dropId) {
            return entry;
          }

          return {
            ...entry,
            ...normalizedPatch,
          };
        }),
      );
    },
    [],
  );

  const removePendingWorkspaceDrop = useCallback((dropId: string): void => {
    setPendingWorkspaceDrops((current) => current.filter((entry) => entry.id !== dropId));
  }, []);

  const resolvePendingWorkspaceDropDurationSec = useCallback(
    async (
      queuedDrop: QueuedWorkspaceDrop,
      droppedAssetContext: ResolvedDroppedAssetContext,
    ): Promise<number | undefined> => {
      if (queuedDrop.resolvedDurationSec !== undefined) {
        return queuedDrop.resolvedDurationSec;
      }

      const { droppedAsset, droppedAssetKind } = droppedAssetContext;
      const assetDurationSec = normalizeDurationSec(droppedAsset?.durationSec);
      if (assetDurationSec !== undefined) {
        queuedDrop.resolvedDurationSec = assetDurationSec;
        return assetDurationSec;
      }

      if (!droppedAsset || !shouldProbePendingDuration(droppedAssetKind)) {
        return undefined;
      }

      try {
        const mediaInfo = await probeMedia(droppedAsset.uri);
        const probedDurationSec = normalizeDurationSec(mediaInfo.durationSec);
        if (probedDurationSec === undefined) {
          return undefined;
        }

        queuedDrop.resolvedDurationSec = probedDurationSec;
        return probedDurationSec;
      } catch (error) {
        logger.debug('Unable to probe queued workspace drop duration', {
          assetId: droppedAsset.id,
          uri: droppedAsset.uri,
          error,
        });
        return undefined;
      }
    },
    [],
  );

  useEffect(() => {
    const nextSequenceId = sequence?.id ?? null;
    if (sequenceIdRef.current === nextSequenceId) {
      return;
    }

    const abandonedDrops = workspaceDropQueueRef.current.splice(0);
    for (const abandonedDrop of abandonedDrops) {
      abandonedDrop.resolveCompletion(false);
    }

    setPendingWorkspaceDrops([]);
    sequenceIdRef.current = nextSequenceId;
  }, [sequence?.id]);

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

  const insertResolvedDroppedAsset = useCallback(
    async (
      data: AssetDropData,
      droppedAssetContext: ResolvedDroppedAssetContext,
      durationSecHint?: number,
    ): Promise<boolean> => {
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
          workspaceRelativePath: getWorkspaceRelativePathFromDrop(data),
        },
      });

      if (!sequence || !sequenceSnapshot) {
        return false;
      }

      const { droppedAssetId, droppedAsset, droppedAssetKind } = droppedAssetContext;
      const targetTrack = sequenceSnapshot.tracks.find((track) => track.id === data.trackId);
      const normalizedDurationSecHint = normalizeDurationSec(durationSecHint);

      let insertedPrimaryClip = false;

      try {
        if (!droppedAsset || droppedAssetKind !== 'video') {
          const insertResult = await executeCommand({
            type: 'InsertClip',
            payload: {
              sequenceId: sequence.id,
              trackId: data.trackId,
              assetId: droppedAssetId,
              timelineIn: data.timelinePosition,
            },
          });

          if (normalizedDurationSecHint !== undefined) {
            let insertedClipId: string | undefined = insertResult.createdIds[0];
            if (!insertedClipId) {
              const postInsertSequence = getCurrentSequence();
              const postInsertTrack = postInsertSequence?.tracks.find(
                (track) => track.id === data.trackId,
              );
              insertedClipId = findClipByAssetAtTimeline(
                postInsertTrack,
                droppedAssetId,
                data.timelinePosition,
              )?.id;
            }

            if (insertedClipId) {
              try {
                await executeCommand({
                  type: 'TrimClip',
                  payload: {
                    sequenceId: sequence.id,
                    trackId: data.trackId,
                    clipId: insertedClipId,
                    newSourceOut: normalizedDurationSecHint,
                  },
                });
              } catch (trimError) {
                logger.warn('Inserted clip but failed to apply probed duration', {
                  sequenceId: sequence.id,
                  assetId: droppedAssetId,
                  clipId: insertedClipId,
                  trackId: data.trackId,
                  durationSec: normalizedDurationSecHint,
                  error: trimError,
                });
              }
            }
          }

          return true;
        }

        const clipDurationSec =
          normalizedDurationSecHint ?? getAssetInsertDurationSec(droppedAsset);
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
          return false;
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
        insertedPrimaryClip = true;

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

        if (normalizedDurationSecHint !== undefined && primaryVideoClipId) {
          try {
            await executeCommand({
              type: 'TrimClip',
              payload: {
                sequenceId: sequence.id,
                trackId: visualTrack.id,
                clipId: primaryVideoClipId,
                newSourceOut: normalizedDurationSecHint,
              },
            });
          } catch (trimPrimaryError) {
            logger.warn('Inserted video clip but failed to apply probed duration', {
              sequenceId: sequence.id,
              trackId: visualTrack.id,
              clipId: primaryVideoClipId,
              assetId: droppedAssetId,
              durationSec: normalizedDurationSecHint,
              error: trimPrimaryError,
            });
          }
        }

        const latestDroppedAsset =
          useProjectStore.getState().assets.get(droppedAssetId) ?? droppedAsset;
        const hasLinkedAudio = await resolveAssetHasLinkedAudio(latestDroppedAsset, logger);
        if (!hasLinkedAudio) {
          return true;
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
            return true;
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
            return true;
          }

          const audioInsertResult = await executeCommand({
            type: 'InsertClip',
            payload: {
              sequenceId: sequence.id,
              trackId: audioTrack.id,
              assetId: droppedAssetId,
              timelineIn: data.timelinePosition,
            },
          });

          if (normalizedDurationSecHint !== undefined) {
            let insertedAudioClipId: string | undefined = audioInsertResult.createdIds[0];
            if (!insertedAudioClipId) {
              const latestSequence = getCurrentSequence();
              const latestAudioTrack = latestSequence?.tracks.find(
                (track) => track.id === audioTrack.id,
              );
              insertedAudioClipId = findClipByAssetAtTimeline(
                latestAudioTrack,
                droppedAssetId,
                data.timelinePosition,
              )?.id;
            }

            if (insertedAudioClipId) {
              try {
                await executeCommand({
                  type: 'TrimClip',
                  payload: {
                    sequenceId: sequence.id,
                    trackId: audioTrack.id,
                    clipId: insertedAudioClipId,
                    newSourceOut: normalizedDurationSecHint,
                  },
                });
              } catch (trimAudioError) {
                logger.warn('Inserted audio clip but failed to apply probed duration', {
                  sequenceId: sequence.id,
                  trackId: audioTrack.id,
                  clipId: insertedAudioClipId,
                  assetId: droppedAssetId,
                  durationSec: normalizedDurationSecHint,
                  error: trimAudioError,
                });
              }
            }
          }

          if (!primaryVideoClipId) {
            logger.warn('Linked audio inserted, but source video clip ID could not be resolved', {
              sequenceId: sequence.id,
              assetId: droppedAssetId,
              videoTrackId: visualTrack.id,
              timelinePosition: data.timelinePosition,
            });
            return true;
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

        return true;
      } catch (error) {
        logger.error('Failed to insert clip', { error, assetId: droppedAssetId });
        return insertedPrimaryClip;
      }
    },
    [sequence, executeCommand, getCurrentSequence],
  );

  const processWorkspaceDropQueue = useCallback(async (): Promise<void> => {
    if (isProcessingWorkspaceDropQueueRef.current) {
      return;
    }

    isProcessingWorkspaceDropQueueRef.current = true;

    try {
      while (workspaceDropQueueRef.current.length > 0) {
        // Read the latest sequence from the store on each iteration to avoid
        // stale closure references during the long-running async loop.
        const currentSequence = getCurrentSequence();
        if (!currentSequence) {
          logger.warn('Dropping queued workspace inserts: no active sequence', {
            queuedItems: workspaceDropQueueRef.current.length,
          });
          const pendingDrops = workspaceDropQueueRef.current.splice(0);
          for (const pendingDrop of pendingDrops) {
            removePendingWorkspaceDrop(pendingDrop.id);
            pendingDrop.resolveCompletion(false);
          }
          return;
        }

        const queuedDrop = workspaceDropQueueRef.current[0];
        const resolveAttempt = queuedDrop.attempts + 1;
        upsertPendingWorkspaceDrop(queuedDrop.id, {
          status: 'resolving',
          attempts: resolveAttempt,
          progressPercent: Math.min(68, 20 + resolveAttempt * 18),
        });
        const workspaceRelativePath = getWorkspaceRelativePathFromDrop(queuedDrop.data);

        if (!workspaceRelativePath) {
          const [invalidDrop] = workspaceDropQueueRef.current.splice(0, 1);
          if (invalidDrop) {
            removePendingWorkspaceDrop(invalidDrop.id);
          }
          invalidDrop?.resolveCompletion(false);
          continue;
        }

        const droppedAssetContext = await resolveDroppedAssetContext({
          data: queuedDrop.data,
          sequence: currentSequence,
          assets: useProjectStore.getState().assets,
        });

        if (!droppedAssetContext) {
          queuedDrop.attempts += 1;

          if (queuedDrop.attempts >= WORKSPACE_DROP_QUEUE_MAX_ATTEMPTS) {
            logger.warn('Queued workspace drop failed after retries', {
              sequenceId: currentSequence.id,
              trackId: queuedDrop.data.trackId,
              workspaceRelativePath,
              attempts: queuedDrop.attempts,
            });
            useToastStore.getState().addToast({
              message: `Failed to load ${getWorkspaceFileName(workspaceRelativePath)}. Run Scan Workspace and retry.`,
              variant: 'warning',
              duration: 5500,
            });
            const [failedDrop] = workspaceDropQueueRef.current.splice(0, 1);
            if (failedDrop) {
              removePendingWorkspaceDrop(failedDrop.id);
            }
            failedDrop?.resolveCompletion(false);
            continue;
          }

          upsertPendingWorkspaceDrop(queuedDrop.id, {
            status: 'resolving',
            attempts: queuedDrop.attempts,
            progressPercent: Math.min(74, 26 + queuedDrop.attempts * 16),
          });

          await waitForDelay(WORKSPACE_DROP_QUEUE_RETRY_DELAY_MS * queuedDrop.attempts);
          continue;
        }

        const resolvedDurationSec = await resolvePendingWorkspaceDropDurationSec(
          queuedDrop,
          droppedAssetContext,
        );
        upsertPendingWorkspaceDrop(queuedDrop.id, {
          assetKind: droppedAssetContext.droppedAssetKind ?? queuedDrop.data.assetKind,
          progressPercent: 82,
          ...(resolvedDurationSec !== undefined ? { durationSec: resolvedDurationSec } : {}),
        });

        upsertPendingWorkspaceDrop(queuedDrop.id, {
          status: 'inserting',
          progressPercent: 92,
        });

        const inserted = await insertResolvedDroppedAsset(
          queuedDrop.data,
          droppedAssetContext,
          resolvedDurationSec,
        );
        if (!inserted) {
          queuedDrop.attempts += 1;
          upsertPendingWorkspaceDrop(queuedDrop.id, {
            status: 'resolving',
            attempts: queuedDrop.attempts,
            progressPercent: Math.min(78, 32 + queuedDrop.attempts * 14),
          });

          if (queuedDrop.attempts >= WORKSPACE_DROP_QUEUE_MAX_ATTEMPTS) {
            logger.warn('Queued workspace drop insertion failed after retries', {
              sequenceId: currentSequence.id,
              trackId: queuedDrop.data.trackId,
              workspaceRelativePath,
              attempts: queuedDrop.attempts,
            });
            useToastStore.getState().addToast({
              message: `Could not insert ${getWorkspaceFileName(workspaceRelativePath)} after loading.`,
              variant: 'warning',
              duration: 4500,
            });
            const [failedInsertDrop] = workspaceDropQueueRef.current.splice(0, 1);
            if (failedInsertDrop) {
              removePendingWorkspaceDrop(failedInsertDrop.id);
            }
            failedInsertDrop?.resolveCompletion(false);
            continue;
          }

          await waitForDelay(WORKSPACE_DROP_QUEUE_RETRY_DELAY_MS * queuedDrop.attempts);
          continue;
        }

        const elapsedMs = Date.now() - queuedDrop.enqueuedAt;
        logger.info('Queued workspace drop inserted', {
          sequenceId: currentSequence.id,
          trackId: queuedDrop.data.trackId,
          workspaceRelativePath,
          attempts: queuedDrop.attempts + 1,
          elapsedMs,
        });

        const [completedDrop] = workspaceDropQueueRef.current.splice(0, 1);
        if (completedDrop) {
          removePendingWorkspaceDrop(completedDrop.id);
        }
        completedDrop?.resolveCompletion(true);
      }
    } finally {
      isProcessingWorkspaceDropQueueRef.current = false;
      if (workspaceDropQueueRef.current.length > 0) {
        void processWorkspaceDropQueue();
      }
    }
  }, [
    getCurrentSequence,
    insertResolvedDroppedAsset,
    resolvePendingWorkspaceDropDurationSec,
    removePendingWorkspaceDrop,
    upsertPendingWorkspaceDrop,
  ]);

  const enqueueWorkspaceDrop = useCallback(
    (data: AssetDropData): Promise<boolean> => {
      const workspaceRelativePath = getWorkspaceRelativePathFromDrop(data);
      if (!workspaceRelativePath) {
        return Promise.resolve(false);
      }

      const dropId = createWorkspaceDropId();
      const fileName = getWorkspaceFileName(workspaceRelativePath);
      const latestAssets = useProjectStore.getState().assets;
      const payloadAsset = data.assetId ? latestAssets.get(data.assetId) : undefined;
      const payloadMatchesPath = payloadAsset?.relativePath === workspaceRelativePath;
      const initialAssetKind =
        data.assetKind ?? (payloadMatchesPath ? payloadAsset?.kind : undefined);
      const initialDurationSec =
        payloadMatchesPath && payloadAsset
          ? normalizeDurationSec(payloadAsset.durationSec)
          : undefined;

      let resolveCompletion: (inserted: boolean) => void = () => {};
      const completion = new Promise<boolean>((resolve) => {
        resolveCompletion = resolve;
      });

      setPendingWorkspaceDrops((current) => [
        ...current,
        {
          id: dropId,
          trackId: data.trackId,
          timelinePosition: data.timelinePosition,
          label: fileName,
          workspaceRelativePath,
          assetKind: initialAssetKind,
          durationSec: initialDurationSec,
          progressPercent: 8,
          attempts: 0,
          status: 'queued',
        },
      ]);

      workspaceDropQueueRef.current.push({
        id: dropId,
        data,
        attempts: 0,
        enqueuedAt: Date.now(),
        resolvedDurationSec: initialDurationSec,
        resolveCompletion,
      });

      logger.info('Queued workspace drop for background loading', {
        sequenceId: sequence?.id,
        trackId: data.trackId,
        workspaceRelativePath,
        queueLength: workspaceDropQueueRef.current.length,
      });

      void processWorkspaceDropQueue();
      return completion;
    },
    [sequence, processWorkspaceDropQueue],
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

      const latestAssets = useProjectStore.getState().assets;
      const queueInBackground = shouldQueueWorkspaceDropInBackground(data, latestAssets);
      if (queueInBackground) {
        await enqueueWorkspaceDrop(data);
        return;
      }

      const droppedAssetContext = await resolveDroppedAssetContext({
        data,
        sequence,
        assets: latestAssets,
      });

      if (!droppedAssetContext) {
        if (getWorkspaceRelativePathFromDrop(data)) {
          await enqueueWorkspaceDrop(data);
        }
        return;
      }

      await insertResolvedDroppedAsset(data, droppedAssetContext);
    },
    [sequence, enqueueWorkspaceDrop, insertResolvedDroppedAsset],
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
    pendingWorkspaceDrops,
    handleDeleteClips,
    handleTrackCreate,
    handleTrackMuteToggle,
    handleTrackLockToggle,
    handleTrackVisibilityToggle,
    handleUpdateCaption,
  };
}

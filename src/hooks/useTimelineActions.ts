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
import { probeMedia } from '@/utils/ffmpeg';
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
import type { Asset, Clip, Sequence, Track } from '@/types';
import {
  buildLinkedMoveTargets,
  buildLinkedTrimTargets,
  expandClipIdsWithLinkedCompanions,
  findClipReference,
  getLinkedSplitTargets,
} from '@/utils/clipLinking';

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

const TRACK_KIND_LABEL: Record<TrackCreateData['kind'], string> = {
  video: 'Video',
  audio: 'Audio',
};

const DEFAULT_INSERT_CLIP_DURATION_SEC = 10;
const TIMELINE_TIME_EPSILON_SEC = 1e-6;

function getClipTimelineDuration(clip: Clip): number {
  const safeSpeed = clip.speed > 0 ? clip.speed : 1;
  return (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && endA > startB;
}

function trackHasOverlap(
  track: Track,
  timelineIn: number,
  durationSec: number,
  ignoreClipId?: string,
): boolean {
  const candidateEnd = timelineIn + durationSec;

  return track.clips.some((clip) => {
    if (ignoreClipId && clip.id === ignoreClipId) {
      return false;
    }

    const clipStart = clip.place.timelineInSec;
    const clipEnd = clipStart + getClipTimelineDuration(clip);
    return rangesOverlap(timelineIn, candidateEnd, clipStart, clipEnd);
  });
}

function getAssetInsertDurationSec(asset: Asset): number {
  if (
    typeof asset.durationSec === 'number' &&
    Number.isFinite(asset.durationSec) &&
    asset.durationSec > 0
  ) {
    return asset.durationSec;
  }

  return DEFAULT_INSERT_CLIP_DURATION_SEC;
}

async function resolveAssetHasLinkedAudio(asset: Asset): Promise<boolean> {
  if (asset.kind !== 'video') {
    return false;
  }

  if (asset.audio) {
    return true;
  }

  try {
    const mediaInfo = await probeMedia(asset.uri);
    return Boolean(mediaInfo.audio);
  } catch (error) {
    logger.warn('Unable to probe dropped video for audio stream detection', {
      assetId: asset.id,
      uri: asset.uri,
      error,
    });
    return false;
  }
}

function findClipByAssetAtTimeline(
  track: Track | undefined,
  assetId: string,
  timelineInSec: number,
): Clip | undefined {
  if (!track) {
    return undefined;
  }

  return track.clips.find(
    (clip) =>
      clip.assetId === assetId &&
      Math.abs(clip.place.timelineInSec - timelineInSec) <= TIMELINE_TIME_EPSILON_SEC,
  );
}

function findAvailableAudioTrack(
  sequence: Sequence,
  timelineIn: number,
  durationSec: number,
): Track | undefined {
  return sequence.tracks.find((track) => {
    if (track.kind !== 'audio' || track.locked) {
      return false;
    }

    return !trackHasOverlap(track, timelineIn, durationSec);
  });
}

function isVisualTrackKind(trackKind: Track['kind']): boolean {
  return trackKind === 'video' || trackKind === 'overlay';
}

function canInsertClipOnTrack(track: Track, timelineIn: number, durationSec: number): boolean {
  return !track.locked && !trackHasOverlap(track, timelineIn, durationSec);
}

function findAvailableVisualTrack(
  sequence: Sequence,
  timelineIn: number,
  durationSec: number,
): Track | undefined {
  return sequence.tracks.find(
    (track) =>
      isVisualTrackKind(track.kind) && canInsertClipOnTrack(track, timelineIn, durationSec),
  );
}

function selectPreferredVisualTrack(
  sequence: Sequence,
  targetTrack: Track | undefined,
  timelineIn: number,
  durationSec: number,
): Track | undefined {
  if (
    targetTrack &&
    isVisualTrackKind(targetTrack.kind) &&
    canInsertClipOnTrack(targetTrack, timelineIn, durationSec)
  ) {
    return targetTrack;
  }

  return findAvailableVisualTrack(sequence, timelineIn, durationSec);
}

function selectPreferredAudioTrack(
  sequence: Sequence,
  targetTrack: Track | undefined,
  timelineIn: number,
  durationSec: number,
): Track | undefined {
  if (
    targetTrack &&
    targetTrack.kind === 'audio' &&
    canInsertClipOnTrack(targetTrack, timelineIn, durationSec)
  ) {
    return targetTrack;
  }

  return findAvailableAudioTrack(sequence, timelineIn, durationSec);
}

function getNextTrackName(sequence: Sequence, kind: TrackCreateData['kind']): string {
  const baseLabel = TRACK_KIND_LABEL[kind];
  let highestIndex = 0;

  for (const track of sequence.tracks) {
    if (track.kind !== kind) continue;

    const trimmedName = track.name.trim();
    if (trimmedName === baseLabel) {
      highestIndex = Math.max(highestIndex, 1);
      continue;
    }

    const match = new RegExp(`^${baseLabel}\\s+(\\d+)$`).exec(trimmedName);
    if (match) {
      highestIndex = Math.max(highestIndex, parseInt(match[1], 10));
    }
  }

  return `${baseLabel} ${highestIndex + 1}`;
}

/**
 * Calculates insertion index that matches common NLE lane layout.
 * - New video tracks are inserted above existing video tracks (below overlays).
 * - New audio tracks are appended below existing audio tracks.
 */
function getDefaultTrackInsertPosition(sequence: Sequence, kind: TrackCreateData['kind']): number {
  if (kind === 'video') {
    let firstVideoIndex = -1;
    let firstLowerLaneIndex = -1;

    for (let index = 0; index < sequence.tracks.length; index += 1) {
      const track = sequence.tracks[index];

      if (firstVideoIndex === -1 && track.kind === 'video') {
        firstVideoIndex = index;
      }

      if (firstLowerLaneIndex === -1 && (track.kind === 'caption' || track.kind === 'audio')) {
        firstLowerLaneIndex = index;
      }
    }

    if (firstVideoIndex !== -1) {
      return firstVideoIndex;
    }

    if (firstLowerLaneIndex !== -1) {
      return firstLowerLaneIndex;
    }

    return sequence.tracks.length;
  }

  let lastAudioIndex = -1;
  for (let index = 0; index < sequence.tracks.length; index += 1) {
    if (sequence.tracks[index].kind === 'audio') {
      lastAudioIndex = index;
    }
  }

  return lastAudioIndex !== -1 ? lastAudioIndex + 1 : sequence.tracks.length;
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

      const sequenceSnapshot = getCurrentSequence();
      if (!sequenceSnapshot) {
        logger.warn('Cannot move clip: sequence snapshot unavailable', {
          sequenceId: data.sequenceId,
          clipId: data.clipId,
        });
        return;
      }

      const sourceClipRef = findClipReference(sequenceSnapshot, data.clipId);
      if (!sourceClipRef) {
        logger.warn('Cannot move clip: source clip no longer exists', {
          sequenceId: data.sequenceId,
          clipId: data.clipId,
        });
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

        for (const linkedMove of linkedMoveTargets) {
          const latestSequence = getCurrentSequence();
          if (!latestSequence) {
            break;
          }

          const linkedClipRef = findClipReference(latestSequence, linkedMove.clipId);
          if (!linkedClipRef) {
            continue;
          }

          const linkedClipDuration = getClipTimelineDuration(linkedClipRef.clip);
          const targetTrack = latestSequence.tracks.find(
            (track) => track.id === linkedMove.trackId,
          );
          if (!targetTrack) {
            continue;
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
            continue;
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
        }
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
      if (!sequence) {
        logger.warn('Cannot trim clip: no sequence');
        return;
      }

      const sequenceSnapshot = getCurrentSequence();
      if (!sequenceSnapshot) {
        logger.warn('Cannot trim clip: sequence snapshot unavailable', {
          sequenceId: data.sequenceId,
          clipId: data.clipId,
        });
        return;
      }

      const sourceClipRef = findClipReference(sequenceSnapshot, data.clipId);
      if (!sourceClipRef) {
        logger.warn('Cannot trim clip: source clip no longer exists', {
          sequenceId: data.sequenceId,
          clipId: data.clipId,
        });
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

        for (const linkedTrim of linkedTrimTargets) {
          const latestSequence = getCurrentSequence();
          if (!latestSequence) {
            break;
          }

          if (!findClipReference(latestSequence, linkedTrim.clipId)) {
            continue;
          }

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
        }
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
      if (!sequence) {
        logger.warn('Cannot split clip: no sequence');
        return;
      }

      const sequenceSnapshot = getCurrentSequence();
      if (!sequenceSnapshot) {
        logger.warn('Cannot split clip: sequence snapshot unavailable', {
          sequenceId: data.sequenceId,
          clipId: data.clipId,
        });
        return;
      }

      const sourceClipRef = findClipReference(sequenceSnapshot, data.clipId);
      if (!sourceClipRef) {
        logger.warn('Cannot split clip: source clip no longer exists', {
          sequenceId: data.sequenceId,
          clipId: data.clipId,
        });
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

        for (const linkedSplit of linkedSplitTargets) {
          const latestSequence = getCurrentSequence();
          if (!latestSequence) {
            break;
          }

          if (!findClipReference(latestSequence, linkedSplit.clipId)) {
            continue;
          }

          await executeCommand({
            type: 'SplitClip',
            payload: {
              sequenceId: data.sequenceId,
              trackId: linkedSplit.trackId,
              clipId: linkedSplit.clipId,
              splitTime: data.splitTime,
            },
          });
        }
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

      const payload: Record<string, unknown> = {
        sequenceId: data.sequenceId,
        trackId: data.trackId,
        clipId: data.clipId,
      };

      if (data.volumeDb !== undefined) {
        payload.volumeDb = data.volumeDb;
      }
      if (data.pan !== undefined) {
        payload.pan = data.pan;
      }
      if (data.muted !== undefined) {
        payload.muted = data.muted;
      }
      if (data.fadeInSec !== undefined) {
        payload.fadeInSec = data.fadeInSec;
      }
      if (data.fadeOutSec !== undefined) {
        payload.fadeOutSec = data.fadeOutSec;
      }

      if (Object.keys(payload).length <= 3) {
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
      if (!sequence) {
        logger.warn('Cannot drop asset: no sequence');
        return;
      }

      const sequenceSnapshot = getCurrentSequence();
      if (!sequenceSnapshot) {
        logger.warn('Cannot drop asset: sequence snapshot unavailable', {
          sequenceId: sequence.id,
          trackId: data.trackId,
          assetId: data.assetId,
          workspaceRelativePath:
            'workspaceRelativePath' in data ? data.workspaceRelativePath : undefined,
        });
        return;
      }

      let droppedAssetId = data.assetId;
      let droppedAsset = droppedAssetId ? assets.get(droppedAssetId) : undefined;
      let droppedAssetKind = droppedAsset?.kind ?? data.assetKind;
      const workspaceRelativePath =
        'workspaceRelativePath' in data && typeof data.workspaceRelativePath === 'string'
          ? data.workspaceRelativePath
          : undefined;

      const shouldRegisterWorkspaceFile =
        !!workspaceRelativePath && (!droppedAssetId || droppedAsset == null);

      if (shouldRegisterWorkspaceFile && workspaceRelativePath) {
        const registerResult = await useWorkspaceStore
          .getState()
          .registerFile(workspaceRelativePath);

        if (!registerResult) {
          logger.warn('Cannot drop workspace file: registration failed', {
            sequenceId: sequence.id,
            trackId: data.trackId,
            workspaceRelativePath,
          });
          return;
        }

        droppedAssetId = registerResult.assetId;

        droppedAsset = useProjectStore.getState().assets.get(droppedAssetId);
        if (!droppedAsset) {
          try {
            const freshState = await refreshProjectState();
            useProjectStore.setState((draft) => {
              draft.assets = freshState.assets;
            });
            droppedAsset = useProjectStore.getState().assets.get(droppedAssetId);
          } catch (error) {
            logger.warn('Failed to refresh project assets after workspace registration', {
              sequenceId: sequence.id,
              trackId: data.trackId,
              workspaceRelativePath,
              assetId: droppedAssetId,
              error,
            });
          }
        }

        droppedAssetKind = droppedAsset?.kind ?? data.assetKind;
      }

      if (!droppedAssetId) {
        logger.warn('Cannot drop asset: missing asset ID and workspace path', {
          sequenceId: sequence.id,
          trackId: data.trackId,
        });
        return;
      }

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
        let visualTrack = selectPreferredVisualTrack(
          sequenceSnapshot,
          targetTrack,
          data.timelinePosition,
          clipDurationSec,
        );

        if (!visualTrack) {
          const createdTrackResult = await executeCommand({
            type: 'CreateTrack',
            payload: {
              sequenceId: sequence.id,
              kind: 'video',
              name: getNextTrackName(sequenceSnapshot, 'video'),
              position: getDefaultTrackInsertPosition(sequenceSnapshot, 'video'),
            },
          });

          const createdTrackId = createdTrackResult.createdIds[0];
          if (!createdTrackId) {
            logger.warn('Unable to auto-create visual track for dropped video asset', {
              sequenceId: sequence.id,
              assetId: droppedAssetId,
            });
            return;
          }

          const refreshedSequence = getCurrentSequence();
          if (!refreshedSequence) {
            logger.warn('Created visual track cannot be resolved: sequence snapshot unavailable', {
              sequenceId: sequence.id,
              createdTrackId,
            });
            return;
          }

          visualTrack = refreshedSequence.tracks.find((track) => track.id === createdTrackId);

          if (!visualTrack) {
            logger.warn('Created visual track not found after state refresh', {
              sequenceId: sequence.id,
              createdTrackId,
            });
            return;
          }
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
        const hasLinkedAudio = await resolveAssetHasLinkedAudio(latestDroppedAsset);
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

          let audioTrack = selectPreferredAudioTrack(
            postVideoInsertSequence,
            latestTargetTrack,
            data.timelinePosition,
            clipDurationSec,
          );

          if (!audioTrack) {
            const createdTrackResult = await executeCommand({
              type: 'CreateTrack',
              payload: {
                sequenceId: sequence.id,
                kind: 'audio',
                name: getNextTrackName(postVideoInsertSequence, 'audio'),
                position: getDefaultTrackInsertPosition(postVideoInsertSequence, 'audio'),
              },
            });

            const createdTrackId = createdTrackResult.createdIds[0];
            if (!createdTrackId) {
              logger.warn('Unable to auto-create audio track for linked audio extraction', {
                sequenceId: sequence.id,
                assetId: droppedAssetId,
              });
              return;
            }

            const refreshedSequence = getCurrentSequence();
            if (!refreshedSequence) {
              logger.warn('Created audio track cannot be resolved: sequence snapshot unavailable', {
                sequenceId: sequence.id,
                createdTrackId,
              });
              return;
            }
            audioTrack = refreshedSequence.tracks.find((track) => track.id === createdTrackId);

            if (!audioTrack) {
              logger.warn('Created audio track not found after state refresh', {
                sequenceId: sequence.id,
                createdTrackId,
              });
              return;
            }
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

      // Build deletion map upfront to avoid stale sequence references
      const deletionMap: Array<{ clipId: string; trackId: string }> = [];
      for (const clipId of clipIdsToDelete) {
        for (const track of sequenceSnapshot.tracks) {
          const clip = track.clips.find((c) => c.id === clipId);
          if (clip) {
            deletionMap.push({ clipId, trackId: track.id });
            break;
          }
        }
      }

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

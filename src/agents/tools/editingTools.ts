/**
 * Editing Tools
 *
 * Video editing tools for the AI agent system.
 * These tools wrap IPC commands to enable AI-driven editing operations.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { getTimelineSnapshot, findWorkspaceFile } from './storeAccessor';
import { executeAgentCommand } from './commandExecutor';
import { useProjectStore } from '@/stores/projectStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { probeMedia } from '@/utils/ffmpeg';
import { refreshProjectState } from '@/utils/stateRefreshHelper';
import type { Asset, Sequence, Track } from '@/types';

const logger = createLogger('EditingTools');
const DEFAULT_INSERT_CLIP_DURATION_SEC = 10;

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

function trackHasOverlap(track: Track, timelineIn: number, durationSec: number): boolean {
  const end = timelineIn + durationSec;
  return track.clips.some((clip) => {
    const clipStart = clip.place.timelineInSec;
    const clipEnd = clip.place.timelineInSec + clip.place.durationSec;
    return timelineIn < clipEnd && end > clipStart;
  });
}

function canInsertClipOnTrack(track: Track, timelineIn: number, durationSec: number): boolean {
  return !track.locked && !trackHasOverlap(track, timelineIn, durationSec);
}

function findAvailableAudioTrack(
  sequence: Sequence,
  timelineIn: number,
  durationSec: number,
): Track | undefined {
  return sequence.tracks.find(
    (track) => track.kind === 'audio' && canInsertClipOnTrack(track, timelineIn, durationSec),
  );
}

function getNextAudioTrackName(sequence: Sequence): string {
  const baseLabel = 'Audio';
  let highestIndex = 0;

  for (const track of sequence.tracks) {
    if (track.kind !== 'audio') {
      continue;
    }

    const trimmedName = track.name.trim();
    if (trimmedName === baseLabel) {
      highestIndex = Math.max(highestIndex, 1);
      continue;
    }

    const match = /^Audio\s+(\d+)$/.exec(trimmedName);
    if (match) {
      highestIndex = Math.max(highestIndex, parseInt(match[1], 10));
    }
  }

  return `${baseLabel} ${highestIndex + 1}`;
}

function getDefaultAudioTrackInsertPosition(sequence: Sequence): number {
  let lastAudioIndex = -1;
  for (let index = 0; index < sequence.tracks.length; index += 1) {
    if (sequence.tracks[index].kind === 'audio') {
      lastAudioIndex = index;
    }
  }

  return lastAudioIndex !== -1 ? lastAudioIndex + 1 : sequence.tracks.length;
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
    logger.warn('Unable to probe inserted video for audio stream detection', {
      assetId: asset.id,
      uri: asset.uri,
      error,
    });
    return false;
  }
}

// =============================================================================
// Shared Helpers
// =============================================================================

/**
 * Handles linked audio extraction after inserting a video clip.
 * If the video has an audio stream, creates a separate audio clip on an
 * audio track and mutes the video clip's embedded audio.
 */
async function handleLinkedAudio(
  asset: Asset,
  sequenceId: string,
  videoTrackId: string,
  videoClipId: string | undefined,
  timelineStart: number,
): Promise<void> {
  const shouldAutoExtractLinkedAudio = true;
  if (asset.kind !== 'video' || !shouldAutoExtractLinkedAudio) return;

  const hasLinkedAudio = await resolveAssetHasLinkedAudio(asset);
  if (!hasLinkedAudio) return;

  const durationSec = getAssetInsertDurationSec(asset);
  const project = useProjectStore.getState();
  const sequence = project.sequences.get(sequenceId);
  if (!sequence) return;

  let audioTrack = findAvailableAudioTrack(sequence, timelineStart, durationSec);

  if (!audioTrack) {
    const createTrackResult = await executeAgentCommand('CreateTrack', {
      sequenceId,
      kind: 'audio',
      name: getNextAudioTrackName(sequence),
      position: getDefaultAudioTrackInsertPosition(sequence),
    });

    const createdTrackId = createTrackResult.createdIds[0];
    if (createdTrackId) {
      const refreshedProject = useProjectStore.getState();
      const refreshedSequence = refreshedProject.sequences.get(sequenceId);
      audioTrack = refreshedSequence?.tracks.find((track) => track.id === createdTrackId);
    }
  }

  if (!audioTrack) return;

  await executeAgentCommand('InsertClip', {
    sequenceId,
    trackId: audioTrack.id,
    assetId: asset.id,
    timelineStart,
  });

  if (videoClipId) {
    try {
      await executeAgentCommand('SetClipMute', {
        sequenceId,
        trackId: videoTrackId,
        clipId: videoClipId,
        muted: true,
      });
    } catch (muteError) {
      logger.warn('Inserted linked audio but failed to mute source video clip audio', {
        sequenceId,
        trackId: videoTrackId,
        clipId: videoClipId,
        error: muteError,
      });
    }
  }
}

// =============================================================================
// Tool Definitions
// =============================================================================

const EDITING_TOOLS: ToolDefinition[] = [
  // -------------------------------------------------------------------------
  // Move Clip
  // -------------------------------------------------------------------------
  {
    name: 'move_clip',
    description: 'Move a clip to a new position on the timeline, optionally to a different track',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence containing the clip',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track containing the clip',
        },
        clipId: {
          type: 'string',
          description: 'The ID of the clip to move',
        },
        newTimelineIn: {
          type: 'number',
          description: 'New timeline position in seconds',
        },
        newTrackId: {
          type: 'string',
          description: 'Optional: ID of the target track if moving to a different track',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'newTimelineIn'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('MoveClip', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          newTimelineIn: args.newTimelineIn as number,
          newTrackId: args.newTrackId as string | undefined,
        });

        logger.debug('move_clip executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('move_clip failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Trim Clip
  // -------------------------------------------------------------------------
  {
    name: 'trim_clip',
    description: 'Trim a clip by adjusting its source in/out points or timeline position',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence containing the clip',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track containing the clip',
        },
        clipId: {
          type: 'string',
          description: 'The ID of the clip to trim',
        },
        newSourceIn: {
          type: 'number',
          description: 'New source in point in seconds (start of clip in source media)',
        },
        newSourceOut: {
          type: 'number',
          description: 'New source out point in seconds (end of clip in source media)',
        },
        newTimelineIn: {
          type: 'number',
          description: 'New timeline position in seconds',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('TrimClip', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          newSourceIn: args.newSourceIn as number | undefined,
          newSourceOut: args.newSourceOut as number | undefined,
          newTimelineIn: args.newTimelineIn as number | undefined,
        });

        logger.debug('trim_clip executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('trim_clip failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Split Clip
  // -------------------------------------------------------------------------
  {
    name: 'split_clip',
    description: 'Split a clip at a specific time point, creating two separate clips',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence containing the clip',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track containing the clip',
        },
        clipId: {
          type: 'string',
          description: 'The ID of the clip to split',
        },
        splitTime: {
          type: 'number',
          description: 'Time in seconds where the clip should be split',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'splitTime'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('SplitClip', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          splitTime: args.splitTime as number,
        });

        logger.debug('split_clip executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('split_clip failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Delete Clip
  // -------------------------------------------------------------------------
  {
    name: 'delete_clip',
    description: 'Remove a clip from the timeline',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence containing the clip',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track containing the clip',
        },
        clipId: {
          type: 'string',
          description: 'The ID of the clip to delete',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('RemoveClip', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
        });

        logger.debug('delete_clip executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('delete_clip failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Delete Clips In Range
  // -------------------------------------------------------------------------
  {
    name: 'delete_clips_in_range',
    description: 'Delete all clips that overlap a given timeline range',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence containing clips',
        },
        startTime: {
          type: 'number',
          description: 'Range start in seconds',
        },
        endTime: {
          type: 'number',
          description: 'Range end in seconds',
        },
        trackId: {
          type: 'string',
          description: 'Optional track ID to limit deletion scope',
        },
      },
      required: ['sequenceId', 'startTime', 'endTime'],
    },
    handler: async (args) => {
      const sequenceId = args.sequenceId as string;
      const startTime = args.startTime as number;
      const endTime = args.endTime as number;
      const trackId = args.trackId as string | undefined;

      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
        return { success: false, error: 'Invalid range: endTime must be greater than startTime' };
      }

      try {
        const snapshot = getTimelineSnapshot();
        const candidates = snapshot.clips
          .filter((clip) => (trackId ? clip.trackId === trackId : true))
          .filter((clip) => {
            const clipStart = clip.timelineIn;
            const clipEnd = clip.timelineIn + clip.duration;
            return clipStart < endTime && clipEnd > startTime;
          })
          .sort((a, b) => b.timelineIn - a.timelineIn);

        const removedClipIds: string[] = [];
        for (const clip of candidates) {
          try {
            await executeAgentCommand('RemoveClip', {
              sequenceId,
              trackId: clip.trackId,
              clipId: clip.id,
            });
            removedClipIds.push(clip.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('delete_clips_in_range partial failure', {
              error: message,
              removedSoFar: removedClipIds,
              failedClipId: clip.id,
            });
            return {
              success: false,
              error: message,
              result: {
                removedCount: removedClipIds.length,
                removedClipIds,
                range: { startTime, endTime, trackId },
              },
            };
          }
        }

        logger.debug('delete_clips_in_range executed', {
          sequenceId,
          trackId,
          startTime,
          endTime,
          removedCount: removedClipIds.length,
        });

        return {
          success: true,
          result: {
            removedCount: removedClipIds.length,
            removedClipIds,
            range: { startTime, endTime, trackId },
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('delete_clips_in_range failed', {
          error: message,
          sequenceId,
          trackId,
          startTime,
          endTime,
        });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Insert Clip
  // -------------------------------------------------------------------------
  {
    name: 'insert_clip',
    description: 'Insert a new clip from an asset onto the timeline',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence to insert into',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track to insert into',
        },
        assetId: {
          type: 'string',
          description: 'The ID of the asset to create a clip from',
        },
        timelineStart: {
          type: 'number',
          description: 'Timeline position in seconds where the clip should start',
        },
      },
      required: ['sequenceId', 'trackId', 'assetId', 'timelineStart'],
    },
    handler: async (args) => {
      try {
        const sequenceId = args.sequenceId as string;
        const trackId = args.trackId as string;
        const assetId = args.assetId as string;
        const timelineStart = args.timelineStart as number;

        const result = await executeAgentCommand('InsertClip', {
          sequenceId,
          trackId,
          assetId,
          timelineStart,
        });

        const project = useProjectStore.getState();
        const asset = project.assets.get(assetId);
        const targetTrack = project.sequences
          .get(sequenceId)
          ?.tracks.find((track) => track.id === trackId);
        const shouldAutoExtractLinkedAudio = targetTrack ? targetTrack.kind !== 'audio' : true;

        if (asset && shouldAutoExtractLinkedAudio) {
          await handleLinkedAudio(asset, sequenceId, trackId, result.createdIds[0], timelineStart);
        }

        logger.debug('insert_clip executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('insert_clip failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Insert Clip From File (workspace-aware)
  // -------------------------------------------------------------------------
  {
    name: 'insert_clip_from_file',
    description:
      'Insert a clip from a workspace file by its relative path or name. Automatically registers the file as a project asset if not already registered, then inserts it onto the timeline. This is the preferred way to add workspace files to the timeline.',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description:
            'Relative path or file name within the workspace (e.g., "footage/interview.mp4" or "interview.mp4")',
        },
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence to insert into',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track to insert into',
        },
        timelineStart: {
          type: 'number',
          description: 'Timeline position in seconds where the clip should start',
        },
      },
      required: ['file', 'sequenceId', 'trackId', 'timelineStart'],
    },
    handler: async (args) => {
      try {
        const file = args.file as string;
        const sequenceId = args.sequenceId as string;
        const trackId = args.trackId as string;
        const timelineStart = args.timelineStart as number;

        // 1. Find the file in the workspace
        const matches = findWorkspaceFile(file);
        if (matches.length === 0) {
          return {
            success: false,
            error: `No workspace file found matching "${file}". Use get_workspace_files to see available files.`,
          };
        }

        // Prefer exact relativePath match, then first result
        const exactMatch = matches.find((m) => m.relativePath === file);
        const targetFile = exactMatch ?? matches[0];

        // 2. Get or register the asset ID
        let assetId = targetFile.assetId;

        if (!assetId) {
          // Auto-register the file
          const registerResult = await useWorkspaceStore
            .getState()
            .registerFile(targetFile.relativePath);

          if (!registerResult) {
            return {
              success: false,
              error: `Failed to register workspace file "${targetFile.relativePath}"`,
            };
          }
          assetId = registerResult.assetId;

          if (!useProjectStore.getState().assets.has(assetId)) {
            try {
              const freshState = await refreshProjectState();
              useProjectStore.setState((draft) => {
                draft.assets = freshState.assets;
              });
            } catch (error) {
              logger.warn('Could not refresh project assets after workspace auto-registration', {
                file: targetFile.relativePath,
                assetId,
                error,
              });
            }
          }
        }

        // 3. Insert the clip
        const result = await executeAgentCommand('InsertClip', {
          sequenceId,
          trackId,
          assetId,
          timelineStart,
        });

        // 4. Handle linked audio for video files
        const project = useProjectStore.getState();
        const asset = project.assets.get(assetId);
        if (asset) {
          await handleLinkedAudio(asset, sequenceId, trackId, result.createdIds[0], timelineStart);
        }

        logger.debug('insert_clip_from_file executed', {
          file: targetFile.relativePath,
          assetId,
        });

        return {
          success: true,
          result: {
            ...result,
            assetId,
            relativePath: targetFile.relativePath,
            wasAutoRegistered: !targetFile.registered,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('insert_clip_from_file failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register all editing tools with the global registry.
 */
export function registerEditingTools(): void {
  globalToolRegistry.registerMany(EDITING_TOOLS);
  logger.info('Editing tools registered', { count: EDITING_TOOLS.length });
}

/**
 * Unregister all editing tools from the global registry.
 */
export function unregisterEditingTools(): void {
  for (const tool of EDITING_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Editing tools unregistered', { count: EDITING_TOOLS.length });
}

/**
 * Get the list of editing tool names.
 */
export function getEditingToolNames(): string[] {
  return EDITING_TOOLS.map((t) => t.name);
}

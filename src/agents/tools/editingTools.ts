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
import {
  buildRippleEditPlan,
  buildRollEditPlan,
  buildSlipEditPlan,
  buildSlideEditPlan,
  type PlannedCommandStep,
} from './compoundEditPlanning';
import type { Asset, Color, Sequence, Track, CommandResult } from '@/types';

const logger = createLogger('EditingTools');
const DEFAULT_INSERT_CLIP_DURATION_SEC = 10;
const DEFAULT_FREEZE_FRAME_RATE = 30;

const MARKER_COLOR_PRESETS: Record<string, Color> = {
  red: { r: 1, g: 0, b: 0 },
  orange: { r: 1, g: 0.5, b: 0 },
  yellow: { r: 1, g: 0.8, b: 0 },
  green: { r: 0, g: 1, b: 0 },
  blue: { r: 0, g: 0, b: 1 },
  purple: { r: 0.5, g: 0, b: 0.5 },
  pink: { r: 1, g: 0.4, b: 0.7 },
  cyan: { r: 0, g: 1, b: 1 },
  white: { r: 1, g: 1, b: 1 },
  black: { r: 0, g: 0, b: 0 },
};

function parseHexMarkerColor(input: string): Color | undefined {
  const normalized = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(normalized)) {
    return undefined;
  }

  const color: Color = {
    r: parseInt(normalized.slice(0, 2), 16) / 255,
    g: parseInt(normalized.slice(2, 4), 16) / 255,
    b: parseInt(normalized.slice(4, 6), 16) / 255,
  };

  if (normalized.length === 8) {
    color.a = parseInt(normalized.slice(6, 8), 16) / 255;
  }

  return color;
}

function normalizeMarkerColor(input: unknown): Color | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    const preset = MARKER_COLOR_PRESETS[normalized];
    if (preset) {
      return { ...preset };
    }

    const parsedHex = parseHexMarkerColor(input);
    if (parsedHex) {
      return parsedHex;
    }

    throw new Error('Invalid marker color. Use a named color or hex (#RRGGBB or #RRGGBBAA).');
  }

  if (typeof input === 'object') {
    const raw = input as Partial<Color>;
    const r = Number(raw.r);
    const g = Number(raw.g);
    const b = Number(raw.b);

    if (![r, g, b].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error('Invalid marker color. RGB values must be numbers between 0 and 1.');
    }

    const color: Color = { r, g, b };
    if (raw.a !== undefined) {
      const a = Number(raw.a);
      if (!Number.isFinite(a) || a < 0 || a > 1) {
        throw new Error('Invalid marker color. Alpha must be a number between 0 and 1.');
      }
      color.a = a;
    }

    return color;
  }

  throw new Error('Invalid marker color. Use a named color, hex string, or an RGBA object.');
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

interface PlannedExecutionResult {
  success: boolean;
  results: CommandResult[];
  error?: string;
  rollbackSucceeded: boolean;
}

async function rollbackExecutedCommands(appliedCount: number): Promise<boolean> {
  if (appliedCount === 0) {
    return true;
  }

  const project = useProjectStore.getState() as {
    undo?: () => Promise<{ success: boolean }>;
  };

  if (typeof project.undo !== 'function') {
    logger.warn('Compound tool rollback skipped: undo API unavailable', { appliedCount });
    return false;
  }

  for (let index = 0; index < appliedCount; index += 1) {
    try {
      const undoResult = await project.undo();
      if (!undoResult.success) {
        logger.error('Compound tool rollback failed: undo returned unsuccessful result', {
          step: index + 1,
          appliedCount,
        });
        return false;
      }
    } catch (undoError) {
      logger.error('Compound tool rollback failed: undo threw error', {
        step: index + 1,
        appliedCount,
        error: undoError instanceof Error ? undoError.message : String(undoError),
      });
      return false;
    }
  }

  return true;
}

async function executePlannedCommands(
  steps: PlannedCommandStep[],
): Promise<PlannedExecutionResult> {
  const results: CommandResult[] = [];
  let appliedCount = 0;

  for (const step of steps) {
    try {
      const commandResult = await executeAgentCommand(step.commandType, step.payload);
      results.push(commandResult);
      appliedCount += 1;
    } catch (error) {
      const rollbackSucceeded = await rollbackExecutedCommands(appliedCount);
      return {
        success: false,
        results,
        error: error instanceof Error ? error.message : String(error),
        rollbackSucceeded,
      };
    }
  }

  return {
    success: true,
    results,
    rollbackSucceeded: true,
  };
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
      logger.error('Failed to mute source video clip audio after linked audio insertion', {
        sequenceId,
        trackId: videoTrackId,
        clipId: videoClipId,
        error: muteError,
      });
      throw new Error(
        `Linked audio inserted but failed to mute original video clip audio: ${muteError instanceof Error ? muteError.message : String(muteError)}`,
      );
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
        const clipId = result.createdIds[0];

        if (!clipId) {
          logger.error('insert_clip failed to produce a clip id', {
            sequenceId,
            trackId,
            assetId,
          });
          return { success: false, error: 'InsertClip did not return a created clip id' };
        }

        const project = useProjectStore.getState();
        const asset = project.assets.get(assetId);
        const targetTrack = project.sequences
          .get(sequenceId)
          ?.tracks.find((track) => track.id === trackId);
        const shouldAutoExtractLinkedAudio = targetTrack ? targetTrack.kind !== 'audio' : true;

        if (asset && shouldAutoExtractLinkedAudio) {
          try {
            await handleLinkedAudio(asset, sequenceId, trackId, clipId, timelineStart);
          } catch (linkedAudioError) {
            const msg =
              linkedAudioError instanceof Error
                ? linkedAudioError.message
                : String(linkedAudioError);
            logger.error('insert_clip: linked audio handling failed', { error: msg });
            return { success: false, error: msg };
          }
        }

        logger.debug('insert_clip executed', { opId: result.opId });
        return {
          success: true,
          result: {
            ...result,
            assetId,
            clipId,
            sequenceId,
            timelineStart,
            trackId,
          },
        };
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

        // 2. Get the asset ID (files are auto-registered by the backend)
        let assetId = targetFile.assetId;

        if (!assetId) {
          // File not yet auto-registered; refresh tree and project state
          try {
            await useWorkspaceStore.getState().refreshTree();
            const freshState = await refreshProjectState();
            useProjectStore.setState((draft) => {
              draft.assets = freshState.assets;
            });
          } catch (error) {
            logger.warn('Could not refresh state for unregistered workspace file', {
              file: targetFile.relativePath,
              error,
            });
          }

          // Re-check the tree for the asset ID after refresh
          const refreshedTree = useWorkspaceStore.getState().fileTree;
          const findInTree = (entries: typeof refreshedTree, path: string): string | undefined => {
            for (const e of entries) {
              if (!e.isDirectory && e.relativePath === path) return e.assetId;
              if (e.isDirectory) {
                const found = findInTree(e.children, path);
                if (found) return found;
              }
            }
            return undefined;
          };
          assetId = findInTree(refreshedTree, targetFile.relativePath);

          if (!assetId) {
            return {
              success: false,
              error: `Workspace file "${targetFile.relativePath}" is not yet registered as an asset. Try scanning the workspace first.`,
            };
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
          try {
            await handleLinkedAudio(
              asset,
              sequenceId,
              trackId,
              result.createdIds[0],
              timelineStart,
            );
          } catch (linkedAudioError) {
            const msg =
              linkedAudioError instanceof Error
                ? linkedAudioError.message
                : String(linkedAudioError);
            logger.error('insert_clip_from_file: linked audio handling failed', { error: msg });
            return { success: false, error: msg };
          }
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

  // -------------------------------------------------------------------------
  // Add Track
  // -------------------------------------------------------------------------
  {
    name: 'add_track',
    description: 'Create a new video or audio track in the timeline',
    category: 'track',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        kind: { type: 'string', enum: ['video', 'audio'], description: 'Track kind' },
        name: { type: 'string', description: 'Display name for the track' },
      },
      required: ['sequenceId', 'kind', 'name'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('CreateTrack', {
          sequenceId: args.sequenceId as string,
          kind: args.kind as string,
          name: args.name as string,
        });
        logger.debug('add_track executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_track failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Remove Track
  // -------------------------------------------------------------------------
  {
    name: 'remove_track',
    description: 'Remove an empty track from the timeline. Fails if the track contains clips.',
    category: 'track',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        trackId: { type: 'string', description: 'ID of the track to remove' },
      },
      required: ['sequenceId', 'trackId'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('RemoveTrack', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
        });
        logger.debug('remove_track executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('remove_track failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Rename Track
  // -------------------------------------------------------------------------
  {
    name: 'rename_track',
    description: 'Change the display name of a track',
    category: 'track',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        trackId: { type: 'string', description: 'ID of the track to rename' },
        name: { type: 'string', description: 'New name for the track' },
      },
      required: ['sequenceId', 'trackId', 'name'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('RenameTrack', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          newName: args.name as string,
        });
        logger.debug('rename_track executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('rename_track failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Change Clip Speed
  // -------------------------------------------------------------------------
  {
    name: 'change_clip_speed',
    description:
      'Change the playback speed of a clip (0.1-10.0). Duration is automatically recalculated.',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        trackId: { type: 'string', description: 'Track containing the clip' },
        clipId: { type: 'string', description: 'ID of the clip' },
        speed: { type: 'number', description: 'Playback speed multiplier (0.1-10.0)' },
        reverse: { type: 'boolean', description: 'Whether to reverse playback' },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'speed'],
    },
    handler: async (args) => {
      try {
        const speed = args.speed as number;
        if (!Number.isFinite(speed) || speed < 0.1 || speed > 10.0) {
          return { success: false, error: 'Speed must be a finite number between 0.1 and 10.0' };
        }
        const reverse = (args.reverse as boolean) ?? false;
        if (reverse) {
          return {
            success: false,
            error:
              'Reverse playback is not yet supported by the playback/render pipeline. ' +
              'Set reverse=false and retry.',
          };
        }

        const result = await executeAgentCommand('SetClipSpeed', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          speed,
          reverse,
        });
        logger.debug('change_clip_speed executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('change_clip_speed failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Freeze Frame
  // -------------------------------------------------------------------------
  {
    name: 'freeze_frame',
    description:
      'Create a freeze frame (still image) at a specified time within a clip. Splits the clip and inserts a still frame.',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        trackId: { type: 'string', description: 'Track containing the clip' },
        clipId: { type: 'string', description: 'ID of the clip' },
        frameTime: { type: 'number', description: 'Time within the clip to freeze (seconds)' },
        duration: {
          type: 'number',
          description: 'Duration of the freeze frame in seconds (default: 2.0)',
        },
        frameRate: {
          type: 'number',
          description: 'Source frame rate used to derive one-frame freeze segment (default: 30)',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'frameTime'],
    },
    handler: async (args) => {
      let appliedCommandCount = 0;

      const rollbackAppliedCommands = async (): Promise<boolean> => {
        if (appliedCommandCount === 0) {
          return true;
        }

        const project = useProjectStore.getState() as {
          undo?: () => Promise<{ success: boolean }>;
        };
        if (typeof project.undo !== 'function') {
          logger.warn('freeze_frame rollback skipped: undo API unavailable');
          appliedCommandCount = 0;
          return true;
        }

        for (let i = 0; i < appliedCommandCount; i += 1) {
          try {
            const undoResult = await project.undo();
            if (!undoResult.success) {
              logger.error('freeze_frame rollback failed: undo returned unsuccessful result', {
                step: i + 1,
                total: appliedCommandCount,
              });
              appliedCommandCount = 0;
              return false;
            }
          } catch (undoError) {
            logger.error('freeze_frame rollback failed: undo threw error', {
              step: i + 1,
              total: appliedCommandCount,
              error: undoError instanceof Error ? undoError.message : String(undoError),
            });
            appliedCommandCount = 0;
            return false;
          }
        }

        appliedCommandCount = 0;
        return true;
      };

      const executeFreezeCommand = async (
        commandType: string,
        payload: Record<string, unknown>,
      ) => {
        const result = await executeAgentCommand(commandType, payload);
        appliedCommandCount += 1;
        return result;
      };

      try {
        const sequenceId = args.sequenceId as string;
        const trackId = args.trackId as string;
        const clipId = args.clipId as string;
        const frameTime = args.frameTime as number;
        const freezeDuration = (args.duration as number) ?? 2.0;
        const frameRate = (args.frameRate as number) ?? DEFAULT_FREEZE_FRAME_RATE;

        if (!Number.isFinite(frameTime) || frameTime < 0) {
          return { success: false, error: 'frameTime must be a finite, non-negative number' };
        }
        if (!Number.isFinite(freezeDuration) || freezeDuration <= 0) {
          return { success: false, error: 'duration must be a finite number greater than 0' };
        }
        if (!Number.isFinite(frameRate) || frameRate <= 0) {
          return { success: false, error: 'frameRate must be a finite number greater than 0' };
        }

        const snapshot = getTimelineSnapshot();
        const clip = snapshot.clips.find((candidate) => {
          return candidate.id === clipId && candidate.trackId === trackId;
        });

        if (!clip) {
          return { success: false, error: `Clip ${clipId} not found on track ${trackId}` };
        }

        const clipStart = clip.timelineIn;
        const clipEnd = clip.timelineIn + clip.duration;
        const absoluteFrameTime = frameTime;
        const relativeFrameTime = clipStart + frameTime;
        const absoluteInBounds = absoluteFrameTime > clipStart && absoluteFrameTime < clipEnd;
        const relativeInBounds = relativeFrameTime > clipStart && relativeFrameTime < clipEnd;

        if (!absoluteInBounds && !relativeInBounds) {
          return {
            success: false,
            error:
              `frameTime must be either (a) timeline time inside clip bounds ` +
              `(${clipStart.toFixed(3)} - ${clipEnd.toFixed(3)}s) or ` +
              `(b) clip-relative time inside (0 - ${clip.duration.toFixed(3)}s)`,
          };
        }

        const resolvedFrameTime = absoluteInBounds ? absoluteFrameTime : relativeFrameTime;
        const frameTimeMode = absoluteInBounds ? 'timeline' : 'clip-relative';

        const sourceFrameDuration = 1 / frameRate;
        const effectiveSpeed = clip.speed > 0 ? clip.speed : 1;
        const timelineFrameDuration = sourceFrameDuration / effectiveSpeed;

        if (freezeDuration <= timelineFrameDuration) {
          return {
            success: false,
            error:
              `duration (${freezeDuration}s) must be greater than one frame on timeline ` +
              `(${timelineFrameDuration.toFixed(6)}s at ${frameRate}fps).`,
          };
        }

        const secondSplitTime = resolvedFrameTime + timelineFrameDuration;
        if (secondSplitTime >= clipEnd) {
          return {
            success: false,
            error: 'Not enough clip media after frameTime to create a freeze frame segment',
          };
        }

        const firstSplit = await executeFreezeCommand('SplitClip', {
          sequenceId,
          trackId,
          clipId,
          splitTime: resolvedFrameTime,
        });

        const freezeClipId = firstSplit.createdIds[0];
        if (!freezeClipId) {
          const rollbackSucceeded = await rollbackAppliedCommands();
          return {
            success: false,
            error:
              'Freeze frame failed: first split did not return a created clip ID' +
              (rollbackSucceeded ? '' : ' (automatic rollback did not complete)'),
          };
        }

        const secondSplit = await executeFreezeCommand('SplitClip', {
          sequenceId,
          trackId,
          clipId: freezeClipId,
          splitTime: secondSplitTime,
        });

        const tailClipId = secondSplit.createdIds[0];
        if (!tailClipId) {
          const rollbackSucceeded = await rollbackAppliedCommands();
          return {
            success: false,
            error:
              'Freeze frame failed: second split did not return a tail clip ID' +
              (rollbackSucceeded ? '' : ' (automatic rollback did not complete)'),
          };
        }

        const freezeSpeed = sourceFrameDuration / freezeDuration;
        await executeFreezeCommand('SetClipSpeed', {
          sequenceId,
          trackId,
          clipId: freezeClipId,
          speed: freezeSpeed,
        });

        const delta = freezeDuration - timelineFrameDuration;
        await executeFreezeCommand('MoveClip', {
          sequenceId,
          trackId,
          clipId: tailClipId,
          newTimelineIn: secondSplitTime + delta,
        });

        return {
          success: true,
          result: {
            freezeClipId,
            tailClipId,
            frameTime,
            resolvedFrameTime,
            frameTimeMode,
            freezeDuration,
            frameRate,
            freezeSpeed,
            timelineFrameDuration,
            description:
              `Freeze frame inserted at ${resolvedFrameTime.toFixed(3)}s (${frameTimeMode}) for ` +
              `${freezeDuration.toFixed(3)}s using ${frameRate}fps source frame size.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const rollbackSucceeded = await rollbackAppliedCommands();
        logger.error('freeze_frame failed', { error: message });
        return {
          success: false,
          error: rollbackSucceeded ? message : `${message} (automatic rollback did not complete)`,
        };
      }
    },
  },
  // -------------------------------------------------------------------------
  // Ripple Edit (Compound)
  // -------------------------------------------------------------------------
  {
    name: 'ripple_edit',
    description:
      'Trim a clip and shift all subsequent clips on the same track to fill or accommodate the change. ' +
      'The trim delta is applied to every clip after the target.',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        trackId: { type: 'string', description: 'Track containing the clip' },
        clipId: { type: 'string', description: 'ID of the clip to trim' },
        trimEnd: {
          type: 'number',
          description:
            'New source out time in seconds. The difference from the current end determines the ripple delta.',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'trimEnd'],
    },
    handler: async (args) => {
      try {
        const plan = buildRippleEditPlan(args as Record<string, unknown>);
        const execution = await executePlannedCommands(plan.steps);
        if (!execution.success) {
          return {
            success: false,
            error: execution.rollbackSucceeded
              ? (execution.error ?? 'ripple_edit failed')
              : `${execution.error ?? 'ripple_edit failed'} (automatic rollback did not complete)`,
          };
        }

        logger.debug('ripple_edit executed', {
          delta: plan.timelineDelta,
          movedClips: plan.movedClipIds.length,
        });

        return {
          success: true,
          result: {
            delta: plan.timelineDelta,
            movedClips: plan.movedClipIds.length,
            movedClipIds: plan.movedClipIds,
            stepsApplied: execution.results.length,
            description: `Ripple edit: shifted ${plan.movedClipIds.length} clips by ${plan.timelineDelta}s`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('ripple_edit failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Roll Edit (Compound)
  // -------------------------------------------------------------------------
  {
    name: 'roll_edit',
    description:
      'Adjust the cut point between two adjacent clips. Extends one clip while shortening the other by the same amount, keeping total duration unchanged.',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        trackId: { type: 'string', description: 'Track containing the clips' },
        leftClipId: { type: 'string', description: 'ID of the clip before the cut point' },
        rightClipId: { type: 'string', description: 'ID of the clip after the cut point' },
        rollAmount: {
          type: 'number',
          description:
            'Seconds to shift the cut point. Positive extends leftClip and shortens rightClip.',
        },
      },
      required: ['sequenceId', 'trackId', 'leftClipId', 'rightClipId', 'rollAmount'],
    },
    handler: async (args) => {
      try {
        const plan = buildRollEditPlan(args as Record<string, unknown>);
        const execution = await executePlannedCommands(plan.steps);
        if (!execution.success) {
          return {
            success: false,
            error: execution.rollbackSucceeded
              ? (execution.error ?? 'roll_edit failed')
              : `${execution.error ?? 'roll_edit failed'} (automatic rollback did not complete)`,
          };
        }

        logger.debug('roll_edit executed', { rollAmount: plan.rollAmount });
        return {
          success: true,
          result: {
            rollAmount: plan.rollAmount,
            stepsApplied: execution.results.length,
            description: `Roll edit: shifted cut point by ${plan.rollAmount}s`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('roll_edit failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Slip Edit
  // -------------------------------------------------------------------------
  {
    name: 'slip_edit',
    description:
      'Adjust the source in/out points of a clip without changing its position or duration on the timeline. ' +
      'Shifts which part of the source media is visible.',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        trackId: { type: 'string', description: 'Track containing the clip' },
        clipId: { type: 'string', description: 'ID of the clip to slip' },
        offsetSeconds: {
          type: 'number',
          description:
            'Seconds to offset the source. Positive shifts source forward (reveals later content).',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'offsetSeconds'],
    },
    handler: async (args) => {
      try {
        const plan = buildSlipEditPlan(args as Record<string, unknown>);
        const execution = await executePlannedCommands(plan.steps);
        if (!execution.success) {
          return {
            success: false,
            error: execution.rollbackSucceeded
              ? (execution.error ?? 'slip_edit failed')
              : `${execution.error ?? 'slip_edit failed'} (automatic rollback did not complete)`,
          };
        }

        logger.debug('slip_edit executed', { offsetSeconds: plan.offsetSeconds });
        return {
          success: true,
          result: {
            offsetSeconds: plan.offsetSeconds,
            stepsApplied: execution.results.length,
            description: `Slip edit: shifted source by ${plan.offsetSeconds}s`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('slip_edit failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Slide Edit (Compound)
  // -------------------------------------------------------------------------
  {
    name: 'slide_edit',
    description:
      'Move a clip along the timeline while adjusting neighboring clips to fill the gap. ' +
      'The previous clip extends to where the slid clip was, and the next clip trims from the start.',
    category: 'clip',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        trackId: { type: 'string', description: 'Track containing the clip' },
        clipId: { type: 'string', description: 'ID of the clip to slide' },
        slideAmount: {
          type: 'number',
          description: 'Seconds to slide the clip. Positive moves it later in the timeline.',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'slideAmount'],
    },
    handler: async (args) => {
      try {
        const plan = buildSlideEditPlan(args as Record<string, unknown>);
        const execution = await executePlannedCommands(plan.steps);
        if (!execution.success) {
          return {
            success: false,
            error: execution.rollbackSucceeded
              ? (execution.error ?? 'slide_edit failed')
              : `${execution.error ?? 'slide_edit failed'} (automatic rollback did not complete)`,
          };
        }

        logger.debug('slide_edit executed', { slideAmount: plan.slideAmount });
        return {
          success: true,
          result: {
            slideAmount: plan.slideAmount,
            adjustedPrev: plan.adjustedPrevClipId,
            adjustedNext: plan.adjustedNextClipId,
            stepsApplied: execution.results.length,
            description: `Slide edit: moved clip by ${plan.slideAmount}s and adjusted neighbors`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('slide_edit failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  // -------------------------------------------------------------------------
  // Add Marker
  // -------------------------------------------------------------------------
  {
    name: 'add_marker',
    description: 'Add a timeline marker at a specific time with a label and optional color.',
    category: 'timeline',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        time: { type: 'number', description: 'Time position in seconds for the marker' },
        label: { type: 'string', description: 'Label text for the marker' },
        color: {
          type: 'string',
          description:
            'Optional marker color (named color like "red" or hex like "#FF0000" / "#FF0000CC")',
        },
      },
      required: ['sequenceId', 'time', 'label'],
    },
    handler: async (args) => {
      try {
        const color = normalizeMarkerColor(args.color);
        const result = await executeAgentCommand('AddMarker', {
          sequenceId: args.sequenceId as string,
          timeSec: args.time as number,
          label: args.label as string,
          color,
        });
        logger.debug('add_marker executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_marker failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Remove Marker
  // -------------------------------------------------------------------------
  {
    name: 'remove_marker',
    description: 'Remove a timeline marker by its ID.',
    category: 'timeline',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Target sequence ID' },
        markerId: { type: 'string', description: 'ID of the marker to remove' },
      },
      required: ['sequenceId', 'markerId'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('RemoveMarker', {
          sequenceId: args.sequenceId as string,
          markerId: args.markerId as string,
        });
        logger.debug('remove_marker executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('remove_marker failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // List Markers (Analysis — stays on frontend)
  // -------------------------------------------------------------------------
  {
    name: 'list_markers',
    description: 'List all markers on the current timeline, optionally filtered by time range.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        fromTime: { type: 'number', description: 'Start of time range in seconds (inclusive)' },
        toTime: { type: 'number', description: 'End of time range in seconds (inclusive)' },
      },
    },
    handler: async (args) => {
      try {
        // Access the active sequence via project store
        const project = useProjectStore.getState();
        if (!project.activeSequenceId) {
          return { success: false, error: 'No active sequence' };
        }
        const activeSequence = project.sequences.get(project.activeSequenceId);
        if (!activeSequence) {
          return { success: false, error: 'Active sequence not found' };
        }

        let markers = activeSequence.markers ?? [];

        // Optional time range filter
        const fromTime = args.fromTime as number | undefined;
        const toTime = args.toTime as number | undefined;
        if (fromTime !== undefined || toTime !== undefined) {
          markers = markers.filter((m: { timeSec: number }) => {
            if (fromTime !== undefined && m.timeSec < fromTime) return false;
            if (toTime !== undefined && m.timeSec > toTime) return false;
            return true;
          });
        }

        return {
          success: true,
          result: {
            markers: markers.map(
              (m: {
                id: string;
                timeSec: number;
                label: string;
                color?: unknown;
                markerType?: string;
              }) => ({
                id: m.id,
                time: m.timeSec,
                label: m.label,
                color: m.color,
                type: m.markerType,
              }),
            ),
            count: markers.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('list_markers failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Navigate to Marker (Frontend — sets playhead position)
  // -------------------------------------------------------------------------
  {
    name: 'navigate_to_marker',
    description:
      "Set the playhead position to a marker's time. Use list_markers first to find available markers.",
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'number', description: 'Time position in seconds to navigate to' },
      },
      required: ['time'],
    },
    handler: async (args) => {
      try {
        const time = args.time as number;
        if (time < 0) {
          return { success: false, error: 'Time must be non-negative' };
        }

        // Use playback store to set playhead position
        const { usePlaybackStore } = await import('@/stores/playbackStore');
        usePlaybackStore.getState().seek(time, 'agent');

        logger.debug('navigate_to_marker executed', { time });
        return {
          success: true,
          result: {
            navigatedTo: time,
            description: `Playhead moved to ${time}s`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('navigate_to_marker failed', { error: message });
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

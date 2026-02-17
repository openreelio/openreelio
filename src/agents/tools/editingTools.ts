/**
 * Editing Tools
 *
 * Video editing tools for the AI agent system.
 * These tools wrap IPC commands to enable AI-driven editing operations.
 */

import { invoke } from '@tauri-apps/api/core';
import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { getTimelineSnapshot } from './storeAccessor';

const logger = createLogger('EditingTools');

// =============================================================================
// Types
// =============================================================================

/** Result from execute_command IPC */
interface CommandResult {
  opId: string;
  success: boolean;
  error?: string;
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
        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'MoveClip',
          payload: {
            sequenceId: args.sequenceId as string,
            trackId: args.trackId as string,
            clipId: args.clipId as string,
            newTimelineIn: args.newTimelineIn as number,
            newTrackId: args.newTrackId as string | undefined,
          },
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
        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'TrimClip',
          payload: {
            sequenceId: args.sequenceId as string,
            trackId: args.trackId as string,
            clipId: args.clipId as string,
            newSourceIn: args.newSourceIn as number | undefined,
            newSourceOut: args.newSourceOut as number | undefined,
            newTimelineIn: args.newTimelineIn as number | undefined,
          },
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
        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'SplitClip',
          payload: {
            sequenceId: args.sequenceId as string,
            trackId: args.trackId as string,
            clipId: args.clipId as string,
            splitTime: args.splitTime as number,
          },
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
        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'RemoveClip',
          payload: {
            sequenceId: args.sequenceId as string,
            trackId: args.trackId as string,
            clipId: args.clipId as string,
          },
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
          await invoke<CommandResult>('execute_command', {
            commandType: 'RemoveClip',
            payload: {
              sequenceId,
              trackId: clip.trackId,
              clipId: clip.id,
            },
          });
          removedClipIds.push(clip.id);
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
        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'InsertClip',
          payload: {
            sequenceId: args.sequenceId as string,
            trackId: args.trackId as string,
            assetId: args.assetId as string,
            timelineStart: args.timelineStart as number,
          },
        });

        logger.debug('insert_clip executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('insert_clip failed', { error: message });
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

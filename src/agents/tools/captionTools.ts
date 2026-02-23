/**
 * Caption Tools
 *
 * Caption-related tools for creating, updating, and deleting caption clips.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { executeAgentCommand } from './commandExecutor';
import { useProjectStore } from '@/stores/projectStore';
import type { Sequence } from '@/types';

const logger = createLogger('CaptionTools');

function getSequence(sequenceId: string): Sequence | undefined {
  return useProjectStore.getState().sequences.get(sequenceId);
}

function resolveCaptionTrackId(
  sequence: Sequence,
  captionId: string,
  explicitTrackId?: string,
): string | null {
  if (explicitTrackId) {
    return explicitTrackId;
  }

  for (const track of sequence.tracks) {
    if (track.kind !== 'caption') {
      continue;
    }

    if (track.clips.some((clip) => clip.id === captionId)) {
      return track.id;
    }
  }

  const firstCaptionTrack = sequence.tracks.find((track) => track.kind === 'caption');
  return firstCaptionTrack?.id ?? null;
}

async function ensureCaptionTrack(sequenceId: string, explicitTrackId?: string): Promise<string> {
  const sequence = getSequence(sequenceId);
  if (!sequence) {
    throw new Error(`Sequence '${sequenceId}' not found`);
  }

  if (explicitTrackId) {
    const hasTrack = sequence.tracks.some((track) => track.id === explicitTrackId);
    if (!hasTrack) {
      throw new Error(`Track '${explicitTrackId}' not found in sequence '${sequenceId}'`);
    }
    return explicitTrackId;
  }

  const existingCaptionTrack = sequence.tracks.find((track) => track.kind === 'caption');
  if (existingCaptionTrack) {
    return existingCaptionTrack.id;
  }

  const createTrackResult = await executeAgentCommand('CreateTrack', {
    sequenceId,
    kind: 'caption',
    name: 'Captions',
  });

  const createdTrackId = createTrackResult.createdIds[0];
  if (!createdTrackId) {
    throw new Error('Failed to create caption track');
  }

  return createdTrackId;
}

const CAPTION_TOOLS: ToolDefinition[] = [
  {
    name: 'add_caption',
    description: 'Add a caption/subtitle at a specific time position',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'Optional caption track ID (auto-created when omitted)',
        },
        text: {
          type: 'string',
          description: 'The caption text',
        },
        startTime: {
          type: 'number',
          description: 'Start time in seconds',
        },
        endTime: {
          type: 'number',
          description: 'End time in seconds',
        },
        style: {
          type: 'object',
          description: 'Optional caption style payload',
        },
      },
      required: ['sequenceId', 'text', 'startTime', 'endTime'],
    },
    handler: async (args) => {
      try {
        const sequenceId = args.sequenceId as string;
        const trackId = await ensureCaptionTrack(sequenceId, args.trackId as string | undefined);

        const result = await executeAgentCommand('CreateCaption', {
          sequenceId,
          trackId,
          text: args.text as string,
          startSec: args.startTime as number,
          endSec: args.endTime as number,
          style: args.style as Record<string, unknown> | undefined,
        });

        logger.debug('add_caption executed', {
          opId: result.opId,
          trackId,
          captionId: result.createdIds[0],
        });

        return {
          success: true,
          result: {
            ...result,
            captionId: result.createdIds[0],
            trackId,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_caption failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'update_caption',
    description: 'Update an existing caption text and/or timing',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'Optional caption track ID (auto-resolved by captionId when omitted)',
        },
        captionId: {
          type: 'string',
          description: 'The ID of the caption to update',
        },
        text: {
          type: 'string',
          description: 'New caption text',
        },
        startTime: {
          type: 'number',
          description: 'Optional new start time in seconds',
        },
        endTime: {
          type: 'number',
          description: 'Optional new end time in seconds',
        },
      },
      required: ['sequenceId', 'captionId'],
    },
    handler: async (args) => {
      try {
        const sequenceId = args.sequenceId as string;
        const captionId = args.captionId as string;

        const sequence = getSequence(sequenceId);
        if (!sequence) {
          return { success: false, error: `Sequence '${sequenceId}' not found` };
        }

        const trackId = resolveCaptionTrackId(
          sequence,
          captionId,
          args.trackId as string | undefined,
        );
        if (!trackId) {
          return { success: false, error: `Could not resolve caption track for '${captionId}'` };
        }

        const result = await executeAgentCommand('UpdateCaption', {
          sequenceId,
          trackId,
          captionId,
          text: args.text as string | undefined,
          startSec: args.startTime as number | undefined,
          endSec: args.endTime as number | undefined,
        });

        logger.debug('update_caption executed', { opId: result.opId, captionId, trackId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('update_caption failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'delete_caption',
    description: 'Remove a caption from the timeline',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'Optional caption track ID (auto-resolved by captionId when omitted)',
        },
        captionId: {
          type: 'string',
          description: 'The ID of the caption to delete',
        },
      },
      required: ['sequenceId', 'captionId'],
    },
    handler: async (args) => {
      try {
        const sequenceId = args.sequenceId as string;
        const captionId = args.captionId as string;

        const sequence = getSequence(sequenceId);
        if (!sequence) {
          return { success: false, error: `Sequence '${sequenceId}' not found` };
        }

        const trackId = resolveCaptionTrackId(
          sequence,
          captionId,
          args.trackId as string | undefined,
        );
        if (!trackId) {
          return { success: false, error: `Could not resolve caption track for '${captionId}'` };
        }

        const result = await executeAgentCommand('DeleteCaption', {
          sequenceId,
          trackId,
          captionId,
        });

        logger.debug('delete_caption executed', { opId: result.opId, captionId, trackId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('delete_caption failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'style_caption',
    description: 'Change caption visual style metadata',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'Optional caption track ID (auto-resolved by captionId when omitted)',
        },
        captionId: {
          type: 'string',
          description: 'The ID of the caption to style',
        },
        fontSize: {
          type: 'number',
          description: 'Font size in pixels',
        },
        fontFamily: {
          type: 'string',
          description: 'Font family name',
        },
        color: {
          type: 'string',
          description: 'Text color in hex format',
        },
        backgroundColor: {
          type: 'string',
          description: 'Background color in hex format with optional alpha',
        },
        position: {
          type: 'string',
          description: 'Caption position (top, center, bottom)',
          enum: ['top', 'center', 'bottom'],
        },
      },
      required: ['sequenceId', 'captionId'],
    },
    handler: async (args) => {
      try {
        const sequenceId = args.sequenceId as string;
        const captionId = args.captionId as string;

        const sequence = getSequence(sequenceId);
        if (!sequence) {
          return { success: false, error: `Sequence '${sequenceId}' not found` };
        }

        const trackId = resolveCaptionTrackId(
          sequence,
          captionId,
          args.trackId as string | undefined,
        );
        if (!trackId) {
          return { success: false, error: `Could not resolve caption track for '${captionId}'` };
        }

        const style: Record<string, unknown> = {};
        if (args.fontSize !== undefined) style.fontSize = args.fontSize;
        if (args.fontFamily !== undefined) style.fontFamily = args.fontFamily;
        if (args.color !== undefined) style.color = args.color;
        if (args.backgroundColor !== undefined) style.backgroundColor = args.backgroundColor;
        if (args.position !== undefined) style.position = args.position;

        const result = await executeAgentCommand('UpdateCaption', {
          sequenceId,
          trackId,
          captionId,
          style,
        });

        logger.debug('style_caption executed', {
          opId: result.opId,
          captionId,
          trackId,
          styleKeys: Object.keys(style),
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('style_caption failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

export function registerCaptionTools(): void {
  globalToolRegistry.registerMany(CAPTION_TOOLS);
  logger.info('Caption tools registered', { count: CAPTION_TOOLS.length });
}

export function unregisterCaptionTools(): void {
  for (const tool of CAPTION_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Caption tools unregistered', { count: CAPTION_TOOLS.length });
}

export function getCaptionToolNames(): string[] {
  return CAPTION_TOOLS.map((tool) => tool.name);
}

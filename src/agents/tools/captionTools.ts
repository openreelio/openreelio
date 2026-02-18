/**
 * Caption Tools
 *
 * Caption-related tools for the AI agent system.
 * Handles adding, editing, and styling captions/subtitles.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { executeAgentCommand } from './commandExecutor';
import type { CommandResult } from '@/types';

const logger = createLogger('CaptionTools');

// =============================================================================
// Types
// =============================================================================

interface CaptionCommandResult extends CommandResult {
  captionId?: string;
}

// =============================================================================
// Tool Definitions
// =============================================================================

const CAPTION_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Add Caption
  // ---------------------------------------------------------------------------
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
          description:
            'Optional caption style (fontSize, fontFamily, color, backgroundColor, position)',
        },
      },
      required: ['sequenceId', 'text', 'startTime', 'endTime'],
    },
    handler: async (args) => {
      try {
        const result = (await executeAgentCommand('AddCaption', {
          sequenceId: args.sequenceId as string,
          text: args.text as string,
          startTime: args.startTime as number,
          endTime: args.endTime as number,
          style: args.style as Record<string, unknown> | undefined,
        })) as CaptionCommandResult;

        logger.debug('add_caption executed', {
          opId: result.opId,
          captionId: result.captionId,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_caption failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Update Caption
  // ---------------------------------------------------------------------------
  {
    name: 'update_caption',
    description: 'Update the text content of an existing caption',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        captionId: {
          type: 'string',
          description: 'The ID of the caption to update',
        },
        text: {
          type: 'string',
          description: 'The new caption text',
        },
        startTime: {
          type: 'number',
          description: 'New start time in seconds (optional)',
        },
        endTime: {
          type: 'number',
          description: 'New end time in seconds (optional)',
        },
      },
      required: ['sequenceId', 'captionId', 'text'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('UpdateCaption', {
          sequenceId: args.sequenceId as string,
          captionId: args.captionId as string,
          text: args.text as string,
          startTime: args.startTime as number | undefined,
          endTime: args.endTime as number | undefined,
        });

        logger.debug('update_caption executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('update_caption failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Delete Caption
  // ---------------------------------------------------------------------------
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
        captionId: {
          type: 'string',
          description: 'The ID of the caption to delete',
        },
      },
      required: ['sequenceId', 'captionId'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('DeleteCaption', {
          sequenceId: args.sequenceId as string,
          captionId: args.captionId as string,
        });

        logger.debug('delete_caption executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('delete_caption failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Style Caption
  // ---------------------------------------------------------------------------
  {
    name: 'style_caption',
    description: 'Change the visual style of a caption',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
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
          description: 'Text color in hex format (e.g., #FFFFFF)',
        },
        backgroundColor: {
          type: 'string',
          description: 'Background color in hex format with optional alpha (e.g., #00000080)',
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
        const styleProps: Record<string, unknown> = {};
        if (args.fontSize !== undefined) styleProps.fontSize = args.fontSize;
        if (args.fontFamily !== undefined) styleProps.fontFamily = args.fontFamily;
        if (args.color !== undefined) styleProps.color = args.color;
        if (args.backgroundColor !== undefined) styleProps.backgroundColor = args.backgroundColor;
        if (args.position !== undefined) styleProps.position = args.position;

        const result = await executeAgentCommand('StyleCaption', {
          sequenceId: args.sequenceId as string,
          captionId: args.captionId as string,
          style: styleProps,
        });

        logger.debug('style_caption executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('style_caption failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register all caption tools with the global registry.
 */
export function registerCaptionTools(): void {
  globalToolRegistry.registerMany(CAPTION_TOOLS);
  logger.info('Caption tools registered', { count: CAPTION_TOOLS.length });
}

/**
 * Unregister all caption tools from the global registry.
 */
export function unregisterCaptionTools(): void {
  for (const tool of CAPTION_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Caption tools unregistered', { count: CAPTION_TOOLS.length });
}

/**
 * Get the list of caption tool names.
 */
export function getCaptionToolNames(): string[] {
  return CAPTION_TOOLS.map((t) => t.name);
}

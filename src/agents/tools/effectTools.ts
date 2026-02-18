/**
 * Effect Tools
 *
 * Effect-related tools for the AI agent system.
 * Handles adding, removing, and adjusting video/audio effects.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { executeAgentCommand } from './commandExecutor';

const logger = createLogger('EffectTools');

// =============================================================================
// Tool Definitions
// =============================================================================

const EFFECT_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Add Effect
  // ---------------------------------------------------------------------------
  {
    name: 'add_effect',
    description: 'Add an effect to a clip',
    category: 'effect',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track',
        },
        clipId: {
          type: 'string',
          description: 'The ID of the clip',
        },
        effectType: {
          type: 'string',
          description: 'Type of effect to add (e.g., blur, brightness, contrast, saturation)',
        },
        parameters: {
          type: 'object',
          description: 'Effect parameters as key-value pairs',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'effectType'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('AddEffect', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          effectType: args.effectType as string,
          parameters: (args.parameters as Record<string, unknown>) ?? {},
        });

        logger.debug('add_effect executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_effect failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Remove Effect
  // ---------------------------------------------------------------------------
  {
    name: 'remove_effect',
    description: 'Remove an effect from a clip',
    category: 'effect',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track',
        },
        clipId: {
          type: 'string',
          description: 'The ID of the clip',
        },
        effectId: {
          type: 'string',
          description: 'The ID of the effect to remove',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'effectId'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('RemoveEffect', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          effectId: args.effectId as string,
        });

        logger.debug('remove_effect executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('remove_effect failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Adjust Effect Parameter
  // ---------------------------------------------------------------------------
  {
    name: 'adjust_effect_param',
    description: 'Adjust a parameter of an existing effect',
    category: 'effect',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track',
        },
        clipId: {
          type: 'string',
          description: 'The ID of the clip',
        },
        effectId: {
          type: 'string',
          description: 'The ID of the effect',
        },
        paramName: {
          type: 'string',
          description: 'The name of the parameter to adjust',
        },
        paramValue: {
          type: 'number',
          description: 'The new value for the parameter',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'effectId', 'paramName', 'paramValue'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('AdjustEffectParam', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          effectId: args.effectId as string,
          paramName: args.paramName as string,
          paramValue: args.paramValue as number,
        });

        logger.debug('adjust_effect_param executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('adjust_effect_param failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Copy Effects
  // ---------------------------------------------------------------------------
  {
    name: 'copy_effects',
    description: 'Copy all effects from one clip to another',
    category: 'effect',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        sourceTrackId: {
          type: 'string',
          description: 'The ID of the source track',
        },
        sourceClipId: {
          type: 'string',
          description: 'The ID of the source clip',
        },
        targetTrackId: {
          type: 'string',
          description: 'The ID of the target track',
        },
        targetClipId: {
          type: 'string',
          description: 'The ID of the target clip',
        },
      },
      required: ['sequenceId', 'sourceTrackId', 'sourceClipId', 'targetTrackId', 'targetClipId'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('CopyEffects', {
          sequenceId: args.sequenceId as string,
          sourceTrackId: args.sourceTrackId as string,
          sourceClipId: args.sourceClipId as string,
          targetTrackId: args.targetTrackId as string,
          targetClipId: args.targetClipId as string,
        });

        logger.debug('copy_effects executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('copy_effects failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Reset Effects
  // ---------------------------------------------------------------------------
  {
    name: 'reset_effects',
    description: 'Remove all effects from a clip',
    category: 'effect',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track',
        },
        clipId: {
          type: 'string',
          description: 'The ID of the clip',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('ResetEffects', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
        });

        logger.debug('reset_effects executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('reset_effects failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register all effect tools with the global registry.
 */
export function registerEffectTools(): void {
  globalToolRegistry.registerMany(EFFECT_TOOLS);
  logger.info('Effect tools registered', { count: EFFECT_TOOLS.length });
}

/**
 * Unregister all effect tools from the global registry.
 */
export function unregisterEffectTools(): void {
  for (const tool of EFFECT_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Effect tools unregistered', { count: EFFECT_TOOLS.length });
}

/**
 * Get the list of effect tool names.
 */
export function getEffectToolNames(): string[] {
  return EFFECT_TOOLS.map((t) => t.name);
}

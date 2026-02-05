/**
 * Transition Tools
 *
 * Transition-related tools for the AI agent system.
 * Handles adding, removing, and adjusting transitions between clips.
 */

import { invoke } from '@tauri-apps/api/core';
import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';

const logger = createLogger('TransitionTools');

// =============================================================================
// Types
// =============================================================================

interface CommandResult {
  opId: string;
  success: boolean;
  error?: string;
}

// =============================================================================
// Tool Definitions
// =============================================================================

const TRANSITION_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Add Transition
  // ---------------------------------------------------------------------------
  {
    name: 'add_transition',
    description: 'Add a transition between two adjacent clips',
    category: 'transition',
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
          description: 'The ID of the clip to add transition after',
        },
        transitionType: {
          type: 'string',
          description: 'Type of transition (dissolve, wipe, slide, zoom, fade)',
          enum: ['dissolve', 'wipe', 'slide', 'zoom', 'fade'],
        },
        duration: {
          type: 'number',
          description: 'Duration of the transition in seconds',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'transitionType', 'duration'],
    },
    handler: async (args) => {
      try {
        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'AddTransition',
          payload: {
            sequenceId: args.sequenceId as string,
            trackId: args.trackId as string,
            clipId: args.clipId as string,
            transitionType: args.transitionType as string,
            duration: args.duration as number,
          },
        });

        logger.debug('add_transition executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_transition failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Remove Transition
  // ---------------------------------------------------------------------------
  {
    name: 'remove_transition',
    description: 'Remove a transition between clips',
    category: 'transition',
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
        transitionId: {
          type: 'string',
          description: 'The ID of the transition to remove',
        },
      },
      required: ['sequenceId', 'trackId', 'transitionId'],
    },
    handler: async (args) => {
      try {
        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'RemoveTransition',
          payload: {
            sequenceId: args.sequenceId as string,
            trackId: args.trackId as string,
            transitionId: args.transitionId as string,
          },
        });

        logger.debug('remove_transition executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('remove_transition failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Set Transition Duration
  // ---------------------------------------------------------------------------
  {
    name: 'set_transition_duration',
    description: 'Change the duration of an existing transition',
    category: 'transition',
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
        transitionId: {
          type: 'string',
          description: 'The ID of the transition',
        },
        duration: {
          type: 'number',
          description: 'New duration in seconds',
        },
      },
      required: ['sequenceId', 'trackId', 'transitionId', 'duration'],
    },
    handler: async (args) => {
      try {
        const result = await invoke<CommandResult>('execute_command', {
          commandType: 'SetTransitionDuration',
          payload: {
            sequenceId: args.sequenceId as string,
            trackId: args.trackId as string,
            transitionId: args.transitionId as string,
            duration: args.duration as number,
          },
        });

        logger.debug('set_transition_duration executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('set_transition_duration failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register all transition tools with the global registry.
 */
export function registerTransitionTools(): void {
  globalToolRegistry.registerMany(TRANSITION_TOOLS);
  logger.info('Transition tools registered', { count: TRANSITION_TOOLS.length });
}

/**
 * Unregister all transition tools from the global registry.
 */
export function unregisterTransitionTools(): void {
  for (const tool of TRANSITION_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Transition tools unregistered', { count: TRANSITION_TOOLS.length });
}

/**
 * Get the list of transition tool names.
 */
export function getTransitionToolNames(): string[] {
  return TRANSITION_TOOLS.map((t) => t.name);
}

/**
 * Effect Tools
 *
 * Effect-related tools for the AI agent system.
 * Handles adding, removing, and adjusting video/audio effects.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { executeAgentCommand } from './commandExecutor';
import { useProjectStore } from '@/stores/projectStore';
import type { Clip, Sequence } from '@/types';

const logger = createLogger('EffectTools');

interface EffectSnapshot {
  id: string;
  effectType?: string;
  params: Record<string, unknown>;
  enabled: boolean;
}

function getSequence(sequenceId: string): Sequence | undefined {
  return useProjectStore.getState().sequences.get(sequenceId);
}

function findClip(sequence: Sequence, trackId: string, clipId: string): Clip | undefined {
  const track = sequence.tracks.find((candidate) => candidate.id === trackId);
  return track?.clips.find((candidate) => candidate.id === clipId);
}

function toEffectSnapshot(raw: unknown): EffectSnapshot | null {
  if (typeof raw === 'string') {
    return {
      id: raw,
      params: {},
      enabled: true,
    };
  }

  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== 'string') {
    return null;
  }

  return {
    id: candidate.id,
    effectType: typeof candidate.effectType === 'string' ? candidate.effectType : undefined,
    params:
      typeof candidate.params === 'object' && candidate.params !== null
        ? (candidate.params as Record<string, unknown>)
        : {},
    enabled: candidate.enabled === undefined ? true : Boolean(candidate.enabled),
  };
}

function getClipEffects(clip: Clip): EffectSnapshot[] {
  const rawEffects = clip.effects as unknown[];
  return rawEffects
    .map(toEffectSnapshot)
    .filter((effect): effect is EffectSnapshot => effect !== null);
}

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
          params: (args.parameters as Record<string, unknown>) ?? {},
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
        const result = await executeAgentCommand('UpdateEffect', {
          effectId: args.effectId as string,
          params: {
            [args.paramName as string]: args.paramValue as number,
          },
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
        const sequenceId = args.sequenceId as string;
        const sourceTrackId = args.sourceTrackId as string;
        const sourceClipId = args.sourceClipId as string;
        const targetTrackId = args.targetTrackId as string;
        const targetClipId = args.targetClipId as string;

        const sequence = getSequence(sequenceId);
        if (!sequence) {
          return { success: false, error: `Sequence '${sequenceId}' not found` };
        }

        const sourceClip = findClip(sequence, sourceTrackId, sourceClipId);
        if (!sourceClip) {
          return {
            success: false,
            error: `Source clip '${sourceClipId}' was not found on track '${sourceTrackId}'`,
          };
        }

        if (!findClip(sequence, targetTrackId, targetClipId)) {
          return {
            success: false,
            error: `Target clip '${targetClipId}' was not found on track '${targetTrackId}'`,
          };
        }

        const effects = getClipEffects(sourceClip);
        if (effects.length === 0) {
          return {
            success: true,
            result: {
              copiedCount: 0,
              copiedEffectIds: [],
            },
          };
        }

        const createdEffectIds: string[] = [];

        for (const effect of effects) {
          if (!effect.effectType) {
            return {
              success: false,
              error:
                'Source effect details are not available in current state snapshot; cannot copy effect definitions.',
            };
          }

          const addResult = await executeAgentCommand('AddEffect', {
            sequenceId,
            trackId: targetTrackId,
            clipId: targetClipId,
            effectType: effect.effectType,
            params: effect.params,
          });

          const createdEffectId = addResult.createdIds[0];
          if (createdEffectId) {
            createdEffectIds.push(createdEffectId);

            if (!effect.enabled) {
              await executeAgentCommand('UpdateEffect', {
                effectId: createdEffectId,
                enabled: false,
              });
            }
          }
        }

        const result = {
          copiedCount: createdEffectIds.length,
          copiedEffectIds: createdEffectIds,
        };

        logger.debug('copy_effects executed', { copiedCount: result.copiedCount });
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
        const sequenceId = args.sequenceId as string;
        const trackId = args.trackId as string;
        const clipId = args.clipId as string;

        const sequence = getSequence(sequenceId);
        if (!sequence) {
          return { success: false, error: `Sequence '${sequenceId}' not found` };
        }

        const clip = findClip(sequence, trackId, clipId);
        if (!clip) {
          return {
            success: false,
            error: `Clip '${clipId}' was not found on track '${trackId}'`,
          };
        }

        const effects = getClipEffects(clip);
        if (effects.length === 0) {
          return {
            success: true,
            result: {
              removedCount: 0,
              removedEffectIds: [],
            },
          };
        }

        const removedEffectIds: string[] = [];
        for (const effect of effects) {
          await executeAgentCommand('RemoveEffect', {
            sequenceId,
            trackId,
            clipId,
            effectId: effect.id,
          });
          removedEffectIds.push(effect.id);
        }

        const result = {
          removedCount: removedEffectIds.length,
          removedEffectIds,
        };

        logger.debug('reset_effects executed', { removedCount: result.removedCount });
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

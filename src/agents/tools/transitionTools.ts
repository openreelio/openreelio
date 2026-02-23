/**
 * Transition Tools
 *
 * Transition operations are modeled as effect operations in the core engine.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { executeAgentCommand } from './commandExecutor';
import { useProjectStore } from '@/stores/projectStore';
import type { Clip, Sequence } from '@/types';

const logger = createLogger('TransitionTools');

type TransitionEffectType = 'cross_dissolve' | 'wipe' | 'slide' | 'zoom' | 'fade';

function mapTransitionType(value: string): TransitionEffectType {
  return value === 'dissolve' ? 'cross_dissolve' : (value as TransitionEffectType);
}

function getSequence(sequenceId: string): Sequence | undefined {
  return useProjectStore.getState().sequences.get(sequenceId);
}

function clipHasEffectId(clip: Clip, effectId: string): boolean {
  const rawEffects = Array.isArray(clip.effects) ? clip.effects : [];
  return rawEffects.some((effect) => {
    if (typeof effect === 'string') {
      return effect === effectId;
    }

    if (typeof effect === 'object' && effect !== null && 'id' in effect) {
      return (effect as { id?: unknown }).id === effectId;
    }

    return false;
  });
}

function findClipIdForEffect(sequence: Sequence, trackId: string, effectId: string): string | null {
  const track = sequence.tracks.find((candidate) => candidate.id === trackId);
  if (!track) {
    return null;
  }

  const clip = track.clips.find((candidate) => clipHasEffectId(candidate, effectId));
  return clip?.id ?? null;
}

const TRANSITION_TOOLS: ToolDefinition[] = [
  {
    name: 'add_transition',
    description: 'Add a transition effect to a clip',
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
          description: 'The ID of the clip to add transition on',
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
        const result = await executeAgentCommand('AddEffect', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          effectType: mapTransitionType(args.transitionType as string),
          params: {
            duration: args.duration as number,
          },
        });

        logger.debug('add_transition executed', { opId: result.opId });
        return {
          success: true,
          result: {
            ...result,
            transitionId: result.createdIds[0],
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_transition failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'remove_transition',
    description: 'Remove a transition effect by transitionId(effectId)',
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
          description: 'Transition ID (same as effect ID)',
        },
        clipId: {
          type: 'string',
          description: 'Optional clip ID; auto-resolved when omitted',
        },
      },
      required: ['sequenceId', 'trackId', 'transitionId'],
    },
    handler: async (args) => {
      try {
        const sequenceId = args.sequenceId as string;
        const trackId = args.trackId as string;
        const transitionId = args.transitionId as string;

        const requestedClipId = args.clipId as string | undefined;
        let clipId: string | null | undefined = requestedClipId;
        if (!clipId) {
          const sequence = getSequence(sequenceId);
          if (!sequence) {
            return { success: false, error: `Sequence '${sequenceId}' not found` };
          }
          clipId = findClipIdForEffect(sequence, trackId, transitionId);
        }
        if (!clipId) {
          return {
            success: false,
            error: `Could not resolve clip for transition '${transitionId}' on track '${trackId}'`,
          };
        }

        const result = await executeAgentCommand('RemoveEffect', {
          sequenceId,
          trackId,
          clipId,
          effectId: transitionId,
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
  {
    name: 'set_transition_duration',
    description: 'Change transition duration using transitionId(effectId)',
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
          description: 'Transition ID (same as effect ID)',
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
        const result = await executeAgentCommand('UpdateEffect', {
          effectId: args.transitionId as string,
          params: {
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

export function registerTransitionTools(): void {
  globalToolRegistry.registerMany(TRANSITION_TOOLS);
  logger.info('Transition tools registered', { count: TRANSITION_TOOLS.length });
}

export function unregisterTransitionTools(): void {
  for (const tool of TRANSITION_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Transition tools unregistered', { count: TRANSITION_TOOLS.length });
}

export function getTransitionToolNames(): string[] {
  return TRANSITION_TOOLS.map((tool) => tool.name);
}

/**
 * Audio Tools
 *
 * Audio-related tools for the AI agent system.
 * Handles volume, fades, muting, and audio normalization.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { executeAgentCommand } from './commandExecutor';

const logger = createLogger('AudioTools');

// =============================================================================
// Tool Definitions
// =============================================================================

const AUDIO_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Adjust Volume
  // ---------------------------------------------------------------------------
  {
    name: 'adjust_volume',
    description: 'Adjust the volume level of a clip or track (0-200%)',
    category: 'audio',
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
          description: 'The ID of the clip (optional, applies to whole track if omitted)',
        },
        volume: {
          type: 'number',
          description: 'Volume level as percentage (0-200, where 100 is original)',
        },
      },
      required: ['sequenceId', 'trackId', 'volume'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('AdjustVolume', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string | undefined,
          volume: args.volume as number,
        });

        logger.debug('adjust_volume executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('adjust_volume failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Add Fade In
  // ---------------------------------------------------------------------------
  {
    name: 'add_fade_in',
    description: 'Add an audio fade-in effect to the beginning of a clip',
    category: 'audio',
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
        duration: {
          type: 'number',
          description: 'Duration of the fade in seconds',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'duration'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('AddAudioFade', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          fadeType: 'in',
          duration: args.duration as number,
        });

        logger.debug('add_fade_in executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_fade_in failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Add Fade Out
  // ---------------------------------------------------------------------------
  {
    name: 'add_fade_out',
    description: 'Add an audio fade-out effect to the end of a clip',
    category: 'audio',
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
        duration: {
          type: 'number',
          description: 'Duration of the fade in seconds',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'duration'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('AddAudioFade', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          fadeType: 'out',
          duration: args.duration as number,
        });

        logger.debug('add_fade_out executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_fade_out failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Mute Clip
  // ---------------------------------------------------------------------------
  {
    name: 'mute_clip',
    description: 'Mute or unmute the audio of a specific clip',
    category: 'audio',
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
        muted: {
          type: 'boolean',
          description: 'Whether the clip should be muted (true) or unmuted (false)',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'muted'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('SetClipMute', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          muted: args.muted as boolean,
        });

        logger.debug('mute_clip executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('mute_clip failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Mute Track
  // ---------------------------------------------------------------------------
  {
    name: 'mute_track',
    description: 'Mute or unmute an entire audio track',
    category: 'audio',
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
        muted: {
          type: 'boolean',
          description: 'Whether the track should be muted (true) or unmuted (false)',
        },
      },
      required: ['sequenceId', 'trackId', 'muted'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('SetTrackMute', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          muted: args.muted as boolean,
        });

        logger.debug('mute_track executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('mute_track failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Normalize Audio
  // ---------------------------------------------------------------------------
  {
    name: 'normalize_audio',
    description: 'Normalize audio levels of a clip to a target level',
    category: 'audio',
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
        targetLevel: {
          type: 'number',
          description: 'Target normalization level in dB (default: -3)',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId'],
    },
    handler: async (args) => {
      try {
        const result = await executeAgentCommand('NormalizeAudio', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          targetLevel: (args.targetLevel as number | undefined) ?? -3,
        });

        logger.debug('normalize_audio executed', { opId: result.opId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('normalize_audio failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register all audio tools with the global registry.
 */
export function registerAudioTools(): void {
  globalToolRegistry.registerMany(AUDIO_TOOLS);
  logger.info('Audio tools registered', { count: AUDIO_TOOLS.length });
}

/**
 * Unregister all audio tools from the global registry.
 */
export function unregisterAudioTools(): void {
  for (const tool of AUDIO_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Audio tools unregistered', { count: AUDIO_TOOLS.length });
}

/**
 * Get the list of audio tool names.
 */
export function getAudioToolNames(): string[] {
  return AUDIO_TOOLS.map((t) => t.name);
}

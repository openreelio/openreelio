/**
 * Audio Tools
 *
 * Audio-related tools for the AI agent system.
 * Handles volume, fades, muting, and audio normalization.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { executeAgentCommand } from './commandExecutor';
import { useProjectStore } from '@/stores/projectStore';
import type { Sequence } from '@/types';

const logger = createLogger('AudioTools');

const MIN_VOLUME_PERCENT = 0;
const MAX_VOLUME_PERCENT = 200;
const SILENT_DB = -80;

function getSequence(sequenceId: string): Sequence | undefined {
  return useProjectStore.getState().sequences.get(sequenceId);
}

function getTrackClipIds(sequence: Sequence, trackId: string): string[] {
  const track = sequence.tracks.find((candidate) => candidate.id === trackId);
  if (!track) {
    return [];
  }

  return track.clips.map((clip) => clip.id);
}

function toVolumeDb(volumePercent: number): number {
  if (volumePercent <= 0) {
    return SILENT_DB;
  }

  return 20 * Math.log10(volumePercent / 100);
}

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
        const sequenceId = args.sequenceId as string;
        const trackId = args.trackId as string;
        const requestedClipId = args.clipId as string | undefined;
        const rawVolume = args.volume as number;

        if (!Number.isFinite(rawVolume)) {
          return { success: false, error: 'volume must be a finite number' };
        }

        const clampedVolume = Math.max(MIN_VOLUME_PERCENT, Math.min(MAX_VOLUME_PERCENT, rawVolume));
        const sequence = getSequence(sequenceId);
        if (!sequence) {
          return { success: false, error: `Sequence '${sequenceId}' not found` };
        }

        const targetClipIds = requestedClipId
          ? [requestedClipId]
          : getTrackClipIds(sequence, trackId);

        if (targetClipIds.length === 0) {
          return {
            success: false,
            error: requestedClipId
              ? `Clip '${requestedClipId}' not found on track '${trackId}'`
              : `Track '${trackId}' has no clips to adjust`,
          };
        }

        const volumeDb = toVolumeDb(clampedVolume);
        for (const clipId of targetClipIds) {
          await executeAgentCommand('SetClipAudio', {
            sequenceId,
            trackId,
            clipId,
            volumeDb,
            muted: clampedVolume <= 0,
          });
        }

        const result = {
          appliedCount: targetClipIds.length,
          clipIds: targetClipIds,
          volumePercent: clampedVolume,
          volumeDb,
        };

        logger.debug('adjust_volume executed', {
          trackId,
          appliedCount: result.appliedCount,
          volumeDb,
        });
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
        const result = await executeAgentCommand('SetClipAudio', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          fadeInSec: args.duration as number,
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
        const result = await executeAgentCommand('SetClipAudio', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          fadeOutSec: args.duration as number,
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
        const sequenceId = args.sequenceId as string;
        const trackId = args.trackId as string;
        const muted = args.muted as boolean;

        const sequence = getSequence(sequenceId);
        if (!sequence) {
          return { success: false, error: `Sequence '${sequenceId}' not found` };
        }

        const clipIds = getTrackClipIds(sequence, trackId);
        if (clipIds.length === 0) {
          return {
            success: true,
            result: {
              muted,
              affectedClipCount: 0,
              clipIds: [],
            },
          };
        }

        for (const clipId of clipIds) {
          await executeAgentCommand('SetClipMute', {
            sequenceId,
            trackId,
            clipId,
            muted,
          });
        }

        const result = {
          muted,
          affectedClipCount: clipIds.length,
          clipIds,
        };

        logger.debug('mute_track executed', {
          trackId,
          muted,
          affectedClipCount: clipIds.length,
        });
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
        const targetLevel = (args.targetLevel as number | undefined) ?? -3;

        const result = await executeAgentCommand('AddEffect', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          effectType: 'loudness_normalize',
          params: {
            target_lufs: targetLevel,
          },
        });

        logger.debug('normalize_audio executed', { opId: result.opId, targetLevel });
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

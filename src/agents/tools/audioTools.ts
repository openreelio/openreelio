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
const DEFAULT_TARGET_LUFS = -14;
const DEFAULT_TARGET_LRA = 11;
const DEFAULT_TRUE_PEAK_DBTP = -1;

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

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
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

        if (requestedClipId) {
          await executeAgentCommand('SetClipAudio', {
            sequenceId,
            trackId,
            clipId: requestedClipId,
            volumeDb: toVolumeDb(clampedVolume),
            muted: clampedVolume <= 0,
          });

          const volumeDb = toVolumeDb(clampedVolume);
          const result = {
            appliedCount: 1,
            clipIds: [requestedClipId],
            volumePercent: clampedVolume,
            volumeDb,
          };

          logger.debug('adjust_volume executed', {
            trackId,
            appliedCount: result.appliedCount,
            volumeDb,
          });
          return { success: true, result };
        }

        const sequence = getSequence(sequenceId);
        if (!sequence) {
          return { success: false, error: `Sequence '${sequenceId}' not found` };
        }

        const track = sequence.tracks.find((candidate) => candidate.id === trackId);
        if (!track) {
          return { success: false, error: `Track '${trackId}' not found` };
        }

        const trackVolume = clampedVolume / 100;
        await executeAgentCommand('SetTrackVolume', {
          sequenceId,
          trackId,
          volume: trackVolume,
        });

        const result = {
          appliedCount: 1,
          trackId,
          volumePercent: clampedVolume,
          trackVolume,
        };

        logger.debug('adjust_volume executed', {
          trackId,
          appliedCount: result.appliedCount,
          trackVolume,
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
    description: 'Normalize audio loudness of a clip to a LUFS target',
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
        targetLufs: {
          type: 'number',
          description: 'Target integrated loudness in LUFS (default: -14)',
        },
        targetLevel: {
          type: 'number',
          description: 'Legacy alias for targetLufs in LUFS',
        },
        targetLra: {
          type: 'number',
          description: 'Target loudness range in LU (default: 11)',
        },
        truePeak: {
          type: 'number',
          description: 'Target true peak in dBTP (default: -1)',
        },
        printFormat: {
          type: 'string',
          description: 'FFmpeg loudnorm stats output: summary, json, or none',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId'],
    },
    handler: async (args) => {
      try {
        const requestedTargetLufs =
          (args.targetLufs as number | undefined) ?? (args.targetLevel as number | undefined);
        const targetLufs = clampFinite(
          requestedTargetLufs ?? DEFAULT_TARGET_LUFS,
          -70,
          -5,
          DEFAULT_TARGET_LUFS,
        );
        const targetLra = clampFinite(
          (args.targetLra as number | undefined) ?? DEFAULT_TARGET_LRA,
          1,
          50,
          DEFAULT_TARGET_LRA,
        );
        const truePeak = clampFinite(
          (args.truePeak as number | undefined) ?? DEFAULT_TRUE_PEAK_DBTP,
          -9,
          0,
          DEFAULT_TRUE_PEAK_DBTP,
        );
        const requestedPrintFormat = args.printFormat as string | undefined;
        const printFormat =
          requestedPrintFormat === 'json' || requestedPrintFormat === 'none'
            ? requestedPrintFormat
            : 'summary';

        const result = await executeAgentCommand('AddEffect', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
          effectType: 'loudness_normalize',
          params: {
            target_lufs: targetLufs,
            target_lra: targetLra,
            target_tp: truePeak,
            print_format: printFormat,
          },
        });

        const response = {
          ...result,
          targetLufs,
          targetLra,
          truePeak,
          printFormat,
        };

        logger.debug('normalize_audio executed', { opId: result.opId, targetLufs });
        return { success: true, result: response };
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

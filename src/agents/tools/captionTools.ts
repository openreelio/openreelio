/**
 * Caption Tools
 *
 * Caption-related tools for creating, updating, and deleting caption clips.
 */

import { invoke } from '@tauri-apps/api/core';
import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { executeAgentCommand } from './commandExecutor';
import { useProjectStore } from '@/stores/projectStore';
import type { CaptionColor, CaptionPosition, Sequence } from '@/types';

const logger = createLogger('CaptionTools');

interface TranscriptionSegmentInput {
  startTime: number;
  endTime: number;
  text: string;
}

interface NormalizedTranscriptionSegments {
  segments: TranscriptionSegmentInput[];
  skippedCount: number;
}

function getSequence(sequenceId: string): Sequence | undefined {
  return useProjectStore.getState().sequences.get(sequenceId);
}

function resolveCaptionTrackId(
  sequence: Sequence,
  captionId: string,
  explicitTrackId?: string,
): string | null {
  if (explicitTrackId) {
    const explicitTrack = sequence.tracks.find((track) => track.id === explicitTrackId);
    if (!explicitTrack || explicitTrack.kind !== 'caption') {
      return null;
    }

    return explicitTrack.id;
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

function parseHexColorToRgba(color: string): CaptionColor | null {
  const trimmed = color.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }

  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((ch) => `${ch}${ch}`)
      .join('');
  }

  if (hex.length !== 6 && hex.length !== 8) {
    return null;
  }

  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255;

  return { r: red, g: green, b: blue, a: alpha };
}

function parseAgentCaptionPosition(value: unknown): CaptionPosition | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'top' || value === 'center' || value === 'bottom') {
    return {
      type: 'preset',
      vertical: value,
      marginPercent: 5,
    };
  }

  return undefined;
}

async function ensureCaptionTrack(sequenceId: string, explicitTrackId?: string): Promise<string> {
  const sequence = getSequence(sequenceId);
  if (!sequence) {
    throw new Error(`Sequence '${sequenceId}' not found`);
  }

  if (explicitTrackId) {
    const explicitTrack = sequence.tracks.find((track) => track.id === explicitTrackId);
    if (!explicitTrack) {
      throw new Error(`Track '${explicitTrackId}' not found in sequence '${sequenceId}'`);
    }

    if (explicitTrack.kind !== 'caption') {
      throw new Error(`Track '${explicitTrackId}' is not a caption track`);
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

function normalizeTranscriptionSegments(
  segments: TranscriptionSegmentInput[],
): NormalizedTranscriptionSegments {
  const normalized: TranscriptionSegmentInput[] = [];
  let skippedCount = 0;

  for (const segment of segments) {
    const trimmedText = segment.text?.trim();
    if (
      !trimmedText ||
      !Number.isFinite(segment.startTime) ||
      !Number.isFinite(segment.endTime) ||
      segment.startTime < 0 ||
      segment.endTime <= segment.startTime
    ) {
      skippedCount += 1;
      continue;
    }

    normalized.push({
      startTime: segment.startTime,
      endTime: segment.endTime,
      text: trimmedText,
    });
  }

  normalized.sort((left, right) => left.startTime - right.startTime);
  return {
    segments: normalized,
    skippedCount,
  };
}

async function rollbackCreatedCaptions(
  sequenceId: string,
  trackId: string,
  captions: Array<{ captionId: string; text: string }>,
): Promise<string[]> {
  const rollbackFailures: string[] = [];

  for (const caption of [...captions].reverse()) {
    try {
      await executeAgentCommand('DeleteCaption', {
        sequenceId,
        trackId,
        captionId: caption.captionId,
      });
    } catch (error) {
      rollbackFailures.push(error instanceof Error ? error.message : String(error));
    }
  }

  return rollbackFailures;
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
          return {
            success: false,
            error: `Could not resolve caption track for '${captionId}'. Ensure trackId points to a caption track.`,
          };
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
          return {
            success: false,
            error: `Could not resolve caption track for '${captionId}'. Ensure trackId points to a caption track.`,
          };
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
          return {
            success: false,
            error: `Could not resolve caption track for '${captionId}'. Ensure trackId points to a caption track.`,
          };
        }

        const style: Record<string, unknown> = {};
        if (args.fontSize !== undefined) style.fontSize = args.fontSize;
        if (args.fontFamily !== undefined) style.fontFamily = args.fontFamily;

        if (args.color !== undefined) {
          const parsedTextColor = parseHexColorToRgba(String(args.color));
          if (!parsedTextColor) {
            return {
              success: false,
              error: `Invalid caption color '${String(args.color)}'. Use #RRGGBB or #RRGGBBAA.`,
            };
          }
          style.color = parsedTextColor;
        }

        if (args.backgroundColor !== undefined) {
          const parsedBackgroundColor = parseHexColorToRgba(String(args.backgroundColor));
          if (!parsedBackgroundColor) {
            return {
              success: false,
              error: `Invalid caption backgroundColor '${String(args.backgroundColor)}'. Use #RRGGBB or #RRGGBBAA.`,
            };
          }
          style.backgroundColor = parsedBackgroundColor;
        }

        const position = parseAgentCaptionPosition(args.position);
        if (args.position !== undefined && !position) {
          return {
            success: false,
            error: `Invalid caption position '${String(args.position)}'. Use top, center, or bottom.`,
          };
        }

        const stylePayload = Object.keys(style).length > 0 ? style : undefined;

        const result = await executeAgentCommand('UpdateCaption', {
          sequenceId,
          trackId,
          captionId,
          style: stylePayload,
          position,
        });

        logger.debug('style_caption executed', {
          opId: result.opId,
          captionId,
          trackId,
          styleKeys: stylePayload ? Object.keys(stylePayload) : [],
          hasPosition: position !== undefined,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('style_caption failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'auto_transcribe',
    description:
      'Transcribe an asset using local speech-to-text (Whisper). Requires the whisper feature to be enabled at build time. ' +
      'If unavailable, use the query meta-tool with action "analyze_asset" and analysisTypes ["transcript"] with an external provider instead. ' +
      'For on-screen text/lyrics, use action "analyze_asset" with analysisTypes ["textOcr"].',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          description: 'The ID of the video or audio asset to transcribe',
        },
        language: {
          type: 'string',
          description: 'Language code (e.g., "en", "ko"). Auto-detected if omitted.',
        },
        model: {
          type: 'string',
          enum: ['tiny', 'base', 'small', 'medium', 'large'],
          description: 'Whisper model size (default: base)',
        },
        async: {
          type: 'boolean',
          description:
            'If true, submits to job queue and returns jobId instead of blocking (default: false)',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;

        // Check whisper availability before attempting transcription
        let whisperAvailable = false;
        try {
          whisperAvailable = await invoke<boolean>('is_transcription_available');
        } catch {
          // IPC call failed — treat as unavailable
        }

        if (!whisperAvailable) {
          logger.warn('auto_transcribe: whisper not available, returning alternatives', { assetId });
          return {
            success: false,
            error:
              'Local transcription (Whisper) is not available in this build. ' +
              'Use these alternatives instead: ' +
              '(1) Use the query meta-tool with action "analyze_asset", assetId, and analysisTypes ["transcript"] with an external provider (e.g., provider: "google_cloud") for speech-to-text. ' +
              '(2) For on-screen text or lyrics, use the query meta-tool with action "analyze_asset", assetId, and analysisTypes ["textOcr"]. ' +
              '(3) To enable local transcription, rebuild with --features whisper.',
          };
        }

        const options: Record<string, unknown> = {};
        if (args.language) options.language = args.language;
        if (args.model) options.model = args.model;

        if (args.async) {
          const jobId = await invoke<string>('submit_transcription_job', {
            assetId,
            options: Object.keys(options).length > 0 ? options : null,
          });
          logger.info('Transcription job submitted', { assetId, jobId });
          return {
            success: true,
            result: {
              mode: 'async',
              jobId,
              message: `Transcription job submitted. Monitor job "${jobId}" for progress.`,
            },
          };
        }

        const result = await invoke<{
          language: string;
          segments: Array<{ startTime: number; endTime: number; text: string }>;
          duration: number;
          fullText: string;
        }>('transcribe_asset', {
          assetId,
          options: Object.keys(options).length > 0 ? options : null,
        });

        logger.info('Transcription completed', {
          assetId,
          segmentCount: result.segments.length,
          duration: result.duration,
        });

        return {
          success: true,
          result: {
            mode: 'sync',
            language: result.language,
            segments: result.segments,
            segmentCount: result.segments.length,
            duration: result.duration,
            fullText: result.fullText,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('auto_transcribe failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'add_captions_from_transcription',
    description:
      'Create caption clips from transcription segments. Takes an array of timed text segments and adds them as captions on a caption track.',
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
        segments: {
          type: 'array',
          description: 'Array of { startTime, endTime, text } segments from transcription',
          items: {
            type: 'object',
            properties: {
              startTime: { type: 'number' },
              endTime: { type: 'number' },
              text: { type: 'string' },
            },
            required: ['startTime', 'endTime', 'text'],
          },
        },
      },
      required: ['sequenceId', 'segments'],
    },
    handler: async (args) => {
      try {
        const sequenceId = args.sequenceId as string;
        const segments = args.segments as Array<{
          startTime: number;
          endTime: number;
          text: string;
        }>;

        if (!Array.isArray(segments) || segments.length === 0) {
          return { success: false, error: 'No segments provided' };
        }

        const normalizedSegments = normalizeTranscriptionSegments(segments);
        if (normalizedSegments.segments.length === 0) {
          return { success: false, error: 'No valid segments provided' };
        }

        const trackId = await ensureCaptionTrack(sequenceId, args.trackId as string | undefined);

        const createdCaptions: Array<{ captionId: string; text: string }> = [];

        for (const segment of normalizedSegments.segments) {
          try {
            const result = await executeAgentCommand('CreateCaption', {
              sequenceId,
              trackId,
              text: segment.text,
              startSec: segment.startTime,
              endSec: segment.endTime,
            });

            const captionId = result.createdIds[0];
            if (!captionId) {
              throw new Error('CreateCaption did not return a caption id');
            }

            createdCaptions.push({
              captionId,
              text: segment.text,
            });
          } catch (error) {
            const rollbackFailures = await rollbackCreatedCaptions(
              sequenceId,
              trackId,
              createdCaptions,
            );

            const message = error instanceof Error ? error.message : String(error);
            if (rollbackFailures.length > 0) {
              logger.error('add_captions_from_transcription rollback failed', {
                error: message,
                rollbackFailures,
                sequenceId,
                trackId,
              });
              return {
                success: false,
                error: `Failed to create captions from transcription: ${message}. Rollback failed for ${rollbackFailures.length} caption(s).`,
              };
            }

            logger.warn('add_captions_from_transcription rolled back partial batch', {
              error: message,
              rolledBackCount: createdCaptions.length,
              sequenceId,
              trackId,
            });
            return {
              success: false,
              error: `Failed to create captions from transcription: ${message}. Rolled back ${createdCaptions.length} caption(s).`,
            };
          }
        }

        logger.info('Captions created from transcription', {
          sequenceId,
          trackId,
          count: createdCaptions.length,
          skippedCount: normalizedSegments.skippedCount,
        });

        return {
          success: true,
          result: {
            trackId,
            captionCount: createdCaptions.length,
            captions: createdCaptions,
            skippedSegmentCount: normalizedSegments.skippedCount,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('add_captions_from_transcription failed', { error: message });
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

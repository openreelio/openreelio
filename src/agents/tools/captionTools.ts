/**
 * Caption Tools
 *
 * Caption-related tools for creating, updating, and deleting caption clips.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  commands,
  type AnalysisProvider,
  type ProviderCapabilities,
  type TranscriptionStatusDto,
  type TranscriptSegment,
} from '@/bindings';
import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import { executeAgentCommand } from './commandExecutor';
import {
  parseCaptionDocument,
  detectCaptionDocumentFormat,
  type CaptionDocumentFormat,
} from './captionParsers';
import { readWorkspaceDocumentFromBackend } from '@/services/workspaceGateway';
import { useProjectStore } from '@/stores/projectStore';
import type { CaptionColor, CaptionPosition, Sequence } from '@/types';

const logger = createLogger('CaptionTools');

const AUTO_TRANSCRIBE_ALTERNATIVES =
  'Try analyze_asset with analysisTypes ["transcript"] for provider-based speech analysis, or analysisTypes ["textOcr"] for on-screen text.';
const WHISPER_MODEL_SELECTION_PREFERENCE = [
  'large-v3',
  'large-v3-turbo',
  'large',
  'medium',
  'small',
  'base',
  'tiny',
];

function selectDefaultWhisperModel(status: TranscriptionStatusDto | null): string {
  if (status?.defaultModel) {
    return status.defaultModel;
  }
  const installed = new Set(
    status?.models.filter((candidate) => candidate.installed).map((candidate) => candidate.id) ??
      [],
  );
  return (
    WHISPER_MODEL_SELECTION_PREFERENCE.find((candidate) => installed.has(candidate)) ??
    'large-v3-turbo'
  );
}

function normalizeWhisperModelArg(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'auto' || normalized === 'default' || normalized === 'best') {
    return fallback;
  }
  if (normalized === 'turbo' || normalized === 'largev3turbo') {
    return 'large-v3-turbo';
  }
  if (normalized === 'largev3') {
    return 'large-v3';
  }
  return normalized;
}

interface TranscriptionSegmentInput {
  startTime: number;
  endTime: number;
  text: string;
  speaker?: string;
  language?: string;
}

interface NormalizedTranscriptionSegments {
  segments: TranscriptionSegmentInput[];
  skippedCount: number;
}

interface AnalysisTranscriptionResult {
  provider: AnalysisProvider;
  segments: TranscriptionSegmentInput[];
  duration: number;
  fullText: string;
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

  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (candidate.type === 'preset') {
      const vertical =
        candidate.vertical === 'top' ||
        candidate.vertical === 'center' ||
        candidate.vertical === 'bottom'
          ? candidate.vertical
          : undefined;
      if (!vertical) {
        return undefined;
      }
      const marginPercent = Number(candidate.marginPercent ?? 5);
      return {
        type: 'preset',
        vertical,
        marginPercent: Number.isFinite(marginPercent)
          ? Math.max(0, Math.min(50, marginPercent))
          : 5,
      };
    }

    const xPercent = Number(candidate.xPercent ?? candidate.x);
    const yPercent = Number(candidate.yPercent ?? candidate.y);
    if (Number.isFinite(xPercent) && Number.isFinite(yPercent)) {
      return {
        type: 'custom',
        xPercent: Math.max(0, Math.min(100, xPercent)),
        yPercent: Math.max(0, Math.min(100, yPercent)),
      };
    }
  }

  return undefined;
}

function parseOptionalNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return { ok: false, error: `${field} must be a number between ${min} and ${max}.` };
  }

  return { ok: true, value: parsed };
}

function parseOptionalBoolean(
  value: unknown,
  field: string,
): { ok: true; value?: boolean } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }

  if (typeof value === 'boolean') {
    return { ok: true, value };
  }

  return { ok: false, error: `${field} must be a boolean.` };
}

function isTranscriptCapableProvider(provider: ProviderCapabilities): boolean {
  return provider.supportedTypes.includes('transcript');
}

function parseAnalysisProvider(value: unknown): AnalysisProvider | null {
  if (value && typeof value === 'object' && 'custom' in value) {
    const custom = (value as { custom?: unknown }).custom;
    if (typeof custom === 'string' && custom.trim().length > 0) {
      return { custom: custom.trim() };
    }
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const provider = value.trim();
  if (provider === 'ffmpeg' || provider === 'whisper' || provider === 'google_cloud') {
    return provider;
  }

  return { custom: provider };
}

function formatAnalysisProvider(provider: AnalysisProvider): string {
  return typeof provider === 'string' ? provider : provider.custom;
}

function convertTranscriptSegments(segments: TranscriptSegment[]): TranscriptionSegmentInput[] {
  return segments.map((segment) => ({
    startTime: segment.startSec,
    endTime: segment.endSec,
    text: segment.text,
  }));
}

async function resolveTranscriptAnalysisProvider(
  explicitProvider: unknown,
): Promise<AnalysisProvider | null> {
  const parsedProvider = parseAnalysisProvider(explicitProvider);
  if (parsedProvider) {
    return parsedProvider;
  }

  const providersResponse = await commands.getAvailableProviders();
  if (providersResponse.status === 'error') {
    throw new Error(providersResponse.error);
  }

  const providers = Array.isArray(providersResponse.data) ? providersResponse.data : [];
  return providers.find(isTranscriptCapableProvider)?.provider ?? null;
}

async function transcribeWithAnalysisProvider(
  assetId: string,
  explicitProvider: unknown,
): Promise<AnalysisTranscriptionResult> {
  const provider = await resolveTranscriptAnalysisProvider(explicitProvider);
  if (!provider) {
    throw new Error(
      'No transcript-capable analysis provider is configured. Configure a provider that supports transcript analysis or enable the whisper build feature.',
    );
  }

  const response = await commands.analyzeAsset({
    assetId,
    provider,
    analysisTypes: ['transcript'],
  });

  if (response.status === 'error') {
    throw new Error(response.error);
  }

  const transcriptSegments = response.data.response.transcript?.results ?? [];
  const segments = convertTranscriptSegments(transcriptSegments);
  const normalized = normalizeTranscriptionSegments(segments);
  if (normalized.segments.length === 0) {
    throw new Error(
      `Transcript provider '${formatAnalysisProvider(provider)}' returned no valid transcript segments.`,
    );
  }

  return {
    provider,
    segments: normalized.segments,
    duration: normalized.segments.reduce((maxEnd, segment) => Math.max(maxEnd, segment.endTime), 0),
    fullText: normalized.segments.map((segment) => segment.text).join(' '),
  };
}

async function ensureCaptionTrack(
  sequenceId: string,
  explicitTrackId?: string,
): Promise<{ trackId: string; createdTrack: boolean }> {
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

    return { trackId: explicitTrackId, createdTrack: false };
  }

  const existingCaptionTrack = sequence.tracks.find((track) => track.kind === 'caption');
  if (existingCaptionTrack) {
    return { trackId: existingCaptionTrack.id, createdTrack: false };
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

  return { trackId: createdTrackId, createdTrack: true };
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
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
      ...(segment.language ? { language: segment.language } : {}),
    });
  }

  normalized.sort((left, right) => left.startTime - right.startTime);
  return {
    segments: normalized,
    skippedCount,
  };
}

async function rollbackCreatedCaptionTrack(
  sequenceId: string,
  trackId: string,
): Promise<string | null> {
  try {
    await executeAgentCommand('DeleteTrack', {
      sequenceId,
      trackId,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function createCaptionsFromSegments(
  sequenceId: string,
  segments: TranscriptionSegmentInput[],
  explicitTrackId?: string,
  replaceExisting = false,
  language?: string,
): Promise<{
  trackId: string;
  createdTrack: boolean;
  captionCount: number;
  captions: Array<{ captionId: string; text: string }>;
  skippedSegmentCount: number;
}> {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('No segments provided');
  }

  const normalizedSegments = normalizeTranscriptionSegments(segments);
  if (normalizedSegments.segments.length === 0) {
    throw new Error('No valid segments provided');
  }

  const { trackId, createdTrack } = await ensureCaptionTrack(sequenceId, explicitTrackId);
  const normalizedLanguage =
    typeof language === 'string' && language.trim().length > 0
      ? language.trim().replace(/_/g, '-').toLowerCase()
      : undefined;
  try {
    const result = await executeAgentCommand('ImportGeneratedCaptions', {
      sequenceId,
      trackId,
      segments: normalizedSegments.segments.map((segment) => ({
        startSec: segment.startTime,
        endSec: segment.endTime,
        text: segment.text,
        ...(segment.speaker ? { speaker: segment.speaker } : {}),
        ...((segment.language ?? normalizedLanguage)
          ? { language: segment.language ?? normalizedLanguage }
          : {}),
      })),
      replaceExisting,
    });

    if (normalizedLanguage) {
      try {
        await executeAgentCommand('SetCaptionTrackLanguage', {
          sequenceId,
          trackId,
          language: normalizedLanguage,
        });
      } catch (error) {
        logger.warn('Caption import succeeded, but track language update failed', {
          sequenceId,
          trackId,
          language: normalizedLanguage,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const createdCaptions = result.createdIds.map((captionId, index) => ({
      captionId,
      text: normalizedSegments.segments[index]?.text ?? '',
    }));

    if (createdCaptions.length !== normalizedSegments.segments.length) {
      logger.warn('ImportGeneratedCaptions returned an unexpected created id count', {
        sequenceId,
        trackId,
        createdIdCount: createdCaptions.length,
        segmentCount: normalizedSegments.segments.length,
      });
    }

    return {
      trackId,
      createdTrack,
      captionCount: createdCaptions.length,
      captions: createdCaptions,
      skippedSegmentCount: normalizedSegments.skippedCount,
    };
  } catch (error) {
    const rollbackFailures: string[] = [];
    if (createdTrack) {
      const trackRollbackFailure = await rollbackCreatedCaptionTrack(sequenceId, trackId);
      if (trackRollbackFailure) {
        rollbackFailures.push(trackRollbackFailure);
      }
    }
    const message = error instanceof Error ? error.message : String(error);

    if (rollbackFailures.length > 0) {
      throw new Error(
        `Failed to create captions: ${message}. Rollback failed for ${rollbackFailures.length} operation(s).`,
      );
    }

    throw new Error(`Failed to create captions: ${message}.`);
  }
}

function resolveCaptionDocumentFormat(
  relativePath: string,
  explicitFormat: unknown,
  content: string,
): CaptionDocumentFormat {
  if (explicitFormat === 'srt' || explicitFormat === 'vtt') {
    return explicitFormat;
  }

  const detectedFormat = detectCaptionDocumentFormat(relativePath, content);
  if (!detectedFormat) {
    throw new Error(
      `Could not determine caption format for '${relativePath}'. Provide format: 'srt' or 'vtt'.`,
    );
  }

  return detectedFormat;
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
        const { trackId } = await ensureCaptionTrack(
          sequenceId,
          args.trackId as string | undefined,
        );

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
        fontWeight: {
          type: 'number',
          description: 'Font weight from 100 to 900',
        },
        bold: {
          type: 'boolean',
          description: 'Enable bold styling',
        },
        italic: {
          type: 'boolean',
          description: 'Enable italic styling',
        },
        underline: {
          type: 'boolean',
          description: 'Enable underline styling',
        },
        color: {
          type: 'string',
          description: 'Text color in hex format',
        },
        opacity: {
          type: 'number',
          description: 'Text opacity from 0 to 1',
        },
        backgroundColor: {
          type: 'string',
          description: 'Background color in hex format with optional alpha',
        },
        backgroundPadding: {
          type: 'number',
          description: 'Background padding in pixels',
        },
        outlineColor: {
          type: 'string',
          description: 'Outline color in hex format with optional alpha',
        },
        outlineWidth: {
          type: 'number',
          description: 'Outline width in pixels',
        },
        shadowColor: {
          type: 'string',
          description: 'Shadow color in hex format with optional alpha',
        },
        shadowOffsetX: {
          type: 'number',
          description: 'Shadow horizontal offset in pixels',
        },
        shadowOffsetY: {
          type: 'number',
          description: 'Shadow vertical offset in pixels',
        },
        shadowBlur: {
          type: 'number',
          description: 'Shadow blur radius metadata in pixels',
        },
        alignment: {
          type: 'string',
          description: 'Caption text alignment',
          enum: ['left', 'center', 'right'],
        },
        lineHeight: {
          type: 'number',
          description: 'Line height multiplier',
        },
        letterSpacing: {
          type: 'number',
          description: 'Letter spacing in pixels',
        },
        position: {
          type: 'string',
          description:
            'Caption position preset (top, center, bottom). Use xPercent and yPercent for custom placement.',
          enum: ['top', 'center', 'bottom'],
        },
        xPercent: {
          type: 'number',
          description: 'Custom caption X position as percent from the left',
        },
        yPercent: {
          type: 'number',
          description: 'Custom caption Y position as percent from the top',
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

        const numericFields: Array<[string, number, number]> = [
          ['fontWeight', 100, 900],
          ['opacity', 0, 1],
          ['backgroundPadding', 0, 500],
          ['outlineWidth', 0, 100],
          ['shadowOffsetX', -500, 500],
          ['shadowOffsetY', -500, 500],
          ['shadowBlur', 0, 500],
          ['lineHeight', 0.5, 5],
          ['letterSpacing', -100, 200],
        ];

        for (const [field, min, max] of numericFields) {
          const parsed = parseOptionalNumber(args[field], field, min, max);
          if (!parsed.ok) {
            return { success: false, error: parsed.error };
          }
          if (parsed.value !== undefined) {
            style[field] = parsed.value;
          }
        }

        for (const field of ['bold', 'italic', 'underline']) {
          const parsed = parseOptionalBoolean(args[field], field);
          if (!parsed.ok) {
            return { success: false, error: parsed.error };
          }
          if (parsed.value !== undefined) {
            style[field] = parsed.value;
          }
        }

        if (args.alignment !== undefined) {
          if (
            args.alignment !== 'left' &&
            args.alignment !== 'center' &&
            args.alignment !== 'right'
          ) {
            return {
              success: false,
              error: `Invalid caption alignment '${String(args.alignment)}'. Use left, center, or right.`,
            };
          }
          style.alignment = args.alignment;
        }

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

        if (args.outlineColor !== undefined) {
          const parsedOutlineColor = parseHexColorToRgba(String(args.outlineColor));
          if (!parsedOutlineColor) {
            return {
              success: false,
              error: `Invalid caption outlineColor '${String(args.outlineColor)}'. Use #RRGGBB or #RRGGBBAA.`,
            };
          }
          style.outlineColor = parsedOutlineColor;
        }

        if (args.shadowColor !== undefined) {
          const parsedShadowColor = parseHexColorToRgba(String(args.shadowColor));
          if (!parsedShadowColor) {
            return {
              success: false,
              error: `Invalid caption shadowColor '${String(args.shadowColor)}'. Use #RRGGBB or #RRGGBBAA.`,
            };
          }
          style.shadowColor = parsedShadowColor;
        }

        const positionInput =
          args.position ??
          (args.xPercent !== undefined || args.yPercent !== undefined
            ? { xPercent: args.xPercent, yPercent: args.yPercent }
            : undefined);
        const position = parseAgentCaptionPosition(positionInput);
        if (positionInput !== undefined && !position) {
          return {
            success: false,
            error: `Invalid caption position '${String(positionInput)}'. Use top, center, bottom, or numeric xPercent and yPercent.`,
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
    name: 'transcription_status',
    description:
      'Read local Whisper transcription readiness, model directory, and installed model inventory.',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const result = await commands.getTranscriptionStatus();
        if (result.status === 'error') {
          return { success: false, error: result.error };
        }
        return { success: true, result: result.data };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('transcription_status failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'install_whisper_model',
    description:
      'Download and install a local Whisper model for automatic captions. Use only after the user approves a model download.',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          enum: ['tiny', 'base', 'small', 'medium', 'large', 'large-v3', 'large-v3-turbo'],
          description: 'Whisper model to install (default: large-v3-turbo)',
        },
        force: {
          type: 'boolean',
          description: 'Replace an existing model file',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const model = normalizeWhisperModelArg(args.model, 'large-v3-turbo');
        const force = args.force === true;
        const result = await commands.downloadWhisperModel(model, force);
        if (result.status === 'error') {
          return { success: false, error: result.error };
        }
        return { success: true, result: result.data };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('install_whisper_model failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'auto_transcribe',
    description:
      'Transcribe an asset into timed text segments. Uses local Whisper when available, otherwise falls back to a configured transcript analysis provider. ' +
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
          enum: ['auto', 'tiny', 'base', 'small', 'medium', 'large', 'large-v3', 'large-v3-turbo'],
          description: 'Whisper model size (default: best installed model)',
        },
        provider: {
          type: 'string',
          description:
            'Optional transcript analysis provider fallback when local Whisper is unavailable',
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

        // Check local Whisper readiness before attempting transcription
        let whisperAvailable = false;
        let installedModels: string[] = [];
        let defaultModel = 'large-v3-turbo';
        try {
          const status = await commands.getTranscriptionStatus();
          if (status.status === 'ok') {
            whisperAvailable = status.data.ready;
            defaultModel = selectDefaultWhisperModel(status.data);
            installedModels = status.data.models
              .filter((candidate) => candidate.installed)
              .map((candidate) => candidate.id);
          }
        } catch {
          // IPC call failed — treat as unavailable
        }

        if (!whisperAvailable) {
          logger.warn('auto_transcribe: local whisper unavailable, trying analysis fallback', {
            assetId,
          });
          try {
            const fallbackResult = await transcribeWithAnalysisProvider(assetId, args.provider);
            logger.info('Transcription completed through analysis provider fallback', {
              assetId,
              provider: formatAnalysisProvider(fallbackResult.provider),
              segmentCount: fallbackResult.segments.length,
            });

            return {
              success: true,
              result: {
                mode: 'analysis',
                provider: fallbackResult.provider,
                language: args.language ?? 'unknown',
                segments: fallbackResult.segments,
                segmentCount: fallbackResult.segments.length,
                duration: fallbackResult.duration,
                fullText: fallbackResult.fullText,
              },
            };
          } catch (fallbackError) {
            const fallbackMessage =
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            const normalizedFallbackMessage = fallbackMessage.replace(/[.!?]\s*$/, '');
            return {
              success: false,
              error:
                'Local transcription (Whisper) is not available in this build, and provider fallback failed: ' +
                `${normalizedFallbackMessage}. ${AUTO_TRANSCRIBE_ALTERNATIVES}`,
            };
          }
        }

        const options: Record<string, unknown> = {};
        if (args.language) options.language = args.language;
        const requestedModel = normalizeWhisperModelArg(args.model, defaultModel);
        if (requestedModel) {
          if (installedModels.length > 0 && !installedModels.includes(requestedModel)) {
            return {
              success: false,
              error: `Whisper model '${requestedModel}' is not installed. Use transcription_status to inspect models or install_whisper_model after user approval.`,
            };
          }
          options.model = requestedModel;
        }

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
    name: 'auto_transcribe_sequence',
    description:
      'Transcribe the audible audio mix of an edited sequence into timeline-relative timed text segments.',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'Sequence ID. Uses the active sequence if omitted.',
        },
        language: {
          type: 'string',
          description: 'Language code (e.g., "en", "ko"). Auto-detected if omitted.',
        },
        model: {
          type: 'string',
          enum: ['auto', 'tiny', 'base', 'small', 'medium', 'large', 'large-v3', 'large-v3-turbo'],
          description: 'Installed Whisper model size (default: best installed model)',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        let defaultModel = 'large-v3-turbo';
        let installedModels: string[] = [];
        try {
          const status = await commands.getTranscriptionStatus();
          if (status.status === 'ok') {
            defaultModel = selectDefaultWhisperModel(status.data);
            installedModels = status.data.models
              .filter((candidate) => candidate.installed)
              .map((candidate) => candidate.id);
            if (!status.data.ready) {
              return {
                success: false,
                error:
                  'No installed Whisper model was found. Use transcription_status to inspect models or install_whisper_model after user approval.',
              };
            }
          }
        } catch {
          // Fall through to backend command; it will return the concrete availability error.
        }

        const model = normalizeWhisperModelArg(args.model, defaultModel);
        if (installedModels.length > 0 && !installedModels.includes(model)) {
          return {
            success: false,
            error: `Whisper model '${model}' is not installed. Use transcription_status to inspect models or install_whisper_model after user approval.`,
          };
        }

        const options = {
          language: typeof args.language === 'string' ? args.language : null,
          translate: null,
          model,
        };

        const result = await commands.transcribeSequence(
          typeof args.sequenceId === 'string' ? args.sequenceId : null,
          options,
        );
        if (result.status === 'error') {
          return { success: false, error: result.error };
        }

        return {
          success: true,
          result: {
            mode: 'sequence',
            language: result.data.language,
            segments: result.data.segments,
            segmentCount: result.data.segments.length,
            duration: result.data.duration,
            fullText: result.data.fullText,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('auto_transcribe_sequence failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
  {
    name: 'import_captions_from_file',
    description:
      'Import SRT or WebVTT captions from a workspace subtitle file and create caption clips on the timeline.',
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
        relativePath: {
          type: 'string',
          description: 'Workspace-relative subtitle file path (.srt or .vtt)',
        },
        format: {
          type: 'string',
          enum: ['srt', 'vtt'],
          description: 'Optional explicit subtitle format. Auto-detected from file path/content.',
        },
        language: {
          type: 'string',
          description: 'Optional language code to store on the caption track and imported cues.',
        },
      },
      required: ['sequenceId', 'relativePath'],
    },
    handler: async (args) => {
      try {
        const relativePath = args.relativePath as string;
        const document = await readWorkspaceDocumentFromBackend(relativePath);
        const format = resolveCaptionDocumentFormat(relativePath, args.format, document.content);
        const segments = parseCaptionDocument(document.content, format);

        const result = await createCaptionsFromSegments(
          args.sequenceId as string,
          segments,
          args.trackId as string | undefined,
          false,
          args.language as string | undefined,
        );

        logger.info('Captions imported from workspace file', {
          sequenceId: args.sequenceId,
          trackId: result.trackId,
          relativePath,
          format,
          count: result.captionCount,
        });

        return {
          success: true,
          result: {
            ...result,
            relativePath,
            format,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('import_captions_from_file failed', { error: message });
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
              speaker: { type: 'string' },
              language: { type: 'string' },
            },
            required: ['startTime', 'endTime', 'text'],
          },
        },
        replaceExisting: {
          type: 'boolean',
          description: 'Replace existing captions on the target caption track before inserting',
        },
        language: {
          type: 'string',
          description: 'Optional language code to store on the caption track and imported cues.',
        },
      },
      required: ['sequenceId', 'segments'],
    },
    handler: async (args) => {
      try {
        const result = await createCaptionsFromSegments(
          args.sequenceId as string,
          args.segments as TranscriptionSegmentInput[],
          args.trackId as string | undefined,
          args.replaceExisting === true,
          args.language as string | undefined,
        );

        logger.info('Captions created from transcription', {
          sequenceId: args.sequenceId,
          trackId: result.trackId,
          count: result.captionCount,
          skippedCount: result.skippedSegmentCount,
        });

        return {
          success: true,
          result,
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

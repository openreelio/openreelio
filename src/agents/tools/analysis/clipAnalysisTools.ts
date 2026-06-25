/**
 * Analysis Tools - Clip Analysis & Perception
 *
 * Clip-local analysis, perception, and semantic-edit planning tools plus their helpers.
 */

import { type ToolDefinition } from '../../ToolRegistry';
import { getToolOutputContract } from '../../toolOutputContracts';
import { createLogger } from '@/services/logger';
import { invoke } from '@tauri-apps/api/core';
import type {
  ClipEvidenceSearchHit,
  ClipPerceptionBundle,
  ClipPerceptionOptions,
  ClipPerceptionResponse,
  SemanticTemporalEditAction,
  SemanticTemporalEditPlan,
  SemanticTemporalEditPlanOptions,
} from '@/bindings';
import { getSelectionContext, getClipById } from '../storeAccessor';
import {
  type ClipAnalysisMode,
  type ClipAnalysisOptionsPayload,
  type ClipAnalysisBundleLike,
  type ClipAnalysisResponseLike,
  type ClipPerceptionDetail,
  type ClipSemanticObservationLike,
  readNestedOptions,
  readOptionalNumber,
  readOptionalBoolean,
  readOptionalString,
} from './shared';

const logger = createLogger('AnalysisTools');

function resolveClipAnalysisOptions(
  args: Record<string, unknown>,
  defaultMode: ClipAnalysisMode,
): ClipAnalysisOptionsPayload {
  const nestedOptions = readNestedOptions(args);
  const rawMode = nestedOptions.mode ?? args.mode;
  const mode: ClipAnalysisMode =
    rawMode === 'dense' || rawMode === 'representative' ? rawMode : defaultMode;
  const targetIntervalSec = readOptionalNumber(args, nestedOptions, [
    'targetIntervalSec',
    'intervalSec',
  ]);
  const maxSamples = readOptionalNumber(args, nestedOptions, ['maxSamples', 'sampleCount']);
  const rangeStartSec = readOptionalNumber(args, nestedOptions, [
    'rangeStartSec',
    'startSec',
    'startTime',
  ]);
  const rangeEndSec = readOptionalNumber(args, nestedOptions, ['rangeEndSec', 'endSec', 'endTime']);

  return {
    mode,
    ...(targetIntervalSec !== undefined ? { targetIntervalSec } : {}),
    ...(maxSamples !== undefined ? { maxSamples: Math.max(1, Math.floor(maxSamples)) } : {}),
    includeEdges: readOptionalBoolean(args, nestedOptions, 'includeEdges', true),
    ...(rangeStartSec !== undefined ? { rangeStartSec } : {}),
    ...(rangeEndSec !== undefined ? { rangeEndSec } : {}),
    forceRefresh: readOptionalBoolean(args, nestedOptions, 'forceRefresh', false),
  };
}

function resolveClipPerceptionOptions(args: Record<string, unknown>): ClipPerceptionOptions {
  const nestedOptions = readNestedOptions(args);
  const rawDetail = nestedOptions.detail ?? args.detail;
  const detail: ClipPerceptionDetail =
    rawDetail === 'auto' || rawDetail === 'high' || rawDetail === 'low' ? rawDetail : 'low';
  const maxFrames = readOptionalNumber(args, nestedOptions, ['maxFrames', 'perceptionMaxFrames']);
  const provider = readOptionalString(args, nestedOptions, 'provider');
  const model = readOptionalString(args, nestedOptions, 'model');

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    detail,
    ...(maxFrames !== undefined ? { maxFrames: Math.max(1, Math.floor(maxFrames)) } : {}),
    reuseSourceAnalysis: readOptionalBoolean(args, nestedOptions, 'reuseSourceAnalysis', true),
    allowCloud: readOptionalBoolean(args, nestedOptions, 'allowCloud', false),
    forceRefresh: readOptionalBoolean(args, nestedOptions, 'forceRefresh', false),
    includeContactSheet: readOptionalBoolean(args, nestedOptions, 'includeContactSheet', false),
  };
}

function resolveSemanticEditAction(value: unknown): SemanticTemporalEditAction {
  return value === 'highlight' ||
    value === 'remove' ||
    value === 'marker' ||
    value === 'addText' ||
    value === 'blur'
    ? value
    : 'blur';
}

function resolveSemanticEditPlanOptions(
  args: Record<string, unknown>,
): SemanticTemporalEditPlanOptions {
  const nestedOptions = readNestedOptions(args);
  const paddingSec = readOptionalNumber(args, nestedOptions, ['paddingSec', 'padding']);
  const mergeGapSec = readOptionalNumber(args, nestedOptions, ['mergeGapSec', 'mergeGap']);
  const minConfidence = readOptionalNumber(args, nestedOptions, ['minConfidence']);
  const maxRanges = readOptionalNumber(args, nestedOptions, ['maxRanges', 'limit']);
  const effectStrength = readOptionalNumber(args, nestedOptions, ['effectStrength', 'strength']);
  const spatialTimeToleranceSec = readOptionalNumber(args, nestedOptions, [
    'spatialTimeToleranceSec',
    'spatialToleranceSec',
  ]);
  const text = readOptionalString(args, nestedOptions, 'text');

  return {
    ...(paddingSec !== undefined ? { paddingSec } : {}),
    ...(mergeGapSec !== undefined ? { mergeGapSec } : {}),
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    ...(maxRanges !== undefined ? { maxRanges: Math.max(1, Math.floor(maxRanges)) } : {}),
    ...(text ? { text } : {}),
    ...(effectStrength !== undefined ? { effectStrength } : {}),
    includeCommandDrafts: readOptionalBoolean(args, nestedOptions, 'includeCommandDrafts', true),
    ...(spatialTimeToleranceSec !== undefined ? { spatialTimeToleranceSec } : {}),
    includeSpatialTargets: readOptionalBoolean(args, nestedOptions, 'includeSpatialTargets', true),
  };
}

function resolveTimelineClipTarget(args: Record<string, unknown>): {
  sequenceId: string;
  trackId: string;
  clipId: string;
} {
  const selection = getSelectionContext();
  const sequenceId =
    typeof args.sequenceId === 'string' && args.sequenceId.trim().length > 0
      ? args.sequenceId.trim()
      : selection.sequenceId;
  const explicitClipId =
    typeof args.clipId === 'string' && args.clipId.trim().length > 0 ? args.clipId.trim() : null;
  const clipId =
    explicitClipId ??
    (selection.selectedClipIds.length === 1 ? selection.selectedClipIds[0] : null);

  if (!sequenceId) {
    throw new Error('sequenceId is required because there is no active sequence');
  }
  if (!clipId) {
    throw new Error('clipId is required unless exactly one timeline clip is selected');
  }

  const clip = getClipById(clipId);
  const trackId =
    typeof args.trackId === 'string' && args.trackId.trim().length > 0
      ? args.trackId.trim()
      : clip?.trackId;

  if (!trackId) {
    throw new Error(`trackId is required because clip '${clipId}' was not found in the snapshot`);
  }

  return { sequenceId, trackId, clipId };
}

function resolveTimelineTimes(args: Record<string, unknown>): number[] {
  const nestedOptions = readNestedOptions(args);
  const rawTimes = nestedOptions.timelineTimes ?? args.timelineTimes;
  if (Array.isArray(rawTimes)) {
    return rawTimes.filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value),
    );
  }

  const singleTime = readOptionalNumber(args, nestedOptions, [
    'timelineTime',
    'timelineSec',
    'time',
  ]);
  if (singleTime !== undefined) {
    return [singleTime];
  }

  const selection = getSelectionContext();
  return [selection.playheadPosition];
}

function buildClipAnalysisToolResult(response: ClipAnalysisResponseLike): Record<string, unknown> {
  const { bundle } = response;
  const samples = Array.isArray(bundle.samples) ? bundle.samples : [];
  const readySampleCount = samples.filter((sample) => sample.extractionStatus === 'ready').length;
  const qualityStatus = bundle.quality?.status ?? 'unknown';
  const qualityScore = typeof bundle.quality?.score === 'number' ? bundle.quality.score : null;

  return {
    source: response.source,
    fingerprint: bundle.fingerprint,
    sequenceId: bundle.sequenceId,
    trackId: bundle.trackId,
    clipId: bundle.clipId,
    assetId: bundle.assetId,
    assetName: bundle.assetName ?? null,
    quality: bundle.quality ?? null,
    samplePolicy: bundle.samplePolicy ?? null,
    sampleCount: samples.length,
    readySampleCount,
    mappingCount: Array.isArray(bundle.mapping) ? bundle.mapping.length : 0,
    windows: bundle.windows ?? [],
    mapping: bundle.mapping ?? [],
    samples,
    errors: bundle.errors ?? [],
    analyzedAt: bundle.analyzedAt ?? null,
    bundle,
    summary: `Clip analysis ${response.source}: ${samples.length} sample(s), ${readySampleCount} ready, quality ${qualityStatus}${qualityScore === null ? '' : ` ${qualityScore}/100`}.`,
  };
}

function buildClipPerceptionToolResult(response: ClipPerceptionResponse): Record<string, unknown> {
  const { bundle } = response;
  const observations = Array.isArray(bundle.observations)
    ? (bundle.observations as ClipSemanticObservationLike[])
    : [];
  const qualityStatus = bundle.quality?.status ?? 'unknown';
  const semanticCoverage = bundle.quality?.semanticCoverage ?? 'missing';

  return {
    source: response.source,
    perceptionFingerprint: bundle.perceptionFingerprint,
    fingerprint: bundle.clipFingerprint,
    clipFingerprint: bundle.clipFingerprint,
    sequenceId: bundle.sequenceId,
    trackId: bundle.trackId,
    clipId: bundle.clipId,
    assetId: bundle.assetId,
    provider: bundle.provider ?? null,
    model: bundle.model ?? null,
    quality: bundle.quality ?? null,
    observationCount: observations.length,
    observations,
    errors: bundle.errors ?? [],
    createdAt: bundle.createdAt,
    bundle,
    summary: `Clip perception ${response.source}: ${observations.length} observation(s), quality ${qualityStatus}, coverage ${semanticCoverage}.`,
  };
}

export const CLIP_ANALYSIS_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Analyze Timeline Clip
  // ---------------------------------------------------------------------------
  {
    name: 'analyze_timeline_clip',
    description:
      'Build a clip-local analysis bundle for one timeline clip, including timeline-to-source mapping, indexed frame samples, image paths, cache fingerprint, and quality status. Use before precise visual edits on a small clip region.',
    category: 'analysis',
    outputContract: getToolOutputContract('analyze_timeline_clip') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'Sequence ID. Defaults to the active sequence when omitted.',
        },
        trackId: {
          type: 'string',
          description: 'Track ID. Defaults from clipId or the selected clip when omitted.',
        },
        clipId: {
          type: 'string',
          description: 'Clip ID. Defaults to the only selected timeline clip when omitted.',
        },
        mode: {
          type: 'string',
          description: 'Sampling mode: representative or dense. Default: representative.',
        },
        targetIntervalSec: {
          type: 'number',
          description: 'Dense sampling interval in timeline seconds. Default: 0.25.',
        },
        maxSamples: {
          type: 'number',
          description: 'Maximum frame samples to extract.',
        },
        includeEdges: {
          type: 'boolean',
          description: 'Include leading/trailing edge samples when possible.',
        },
        rangeStartSec: {
          type: 'number',
          description: 'Optional absolute timeline range start within the clip.',
        },
        rangeEndSec: {
          type: 'number',
          description: 'Optional absolute timeline range end within the clip.',
        },
        forceRefresh: {
          type: 'boolean',
          description: 'Ignore a compatible cached clip-analysis bundle.',
        },
        options: {
          type: 'object',
          description: 'Optional nested clip-analysis options using the same field names.',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const target = resolveTimelineClipTarget(args as Record<string, unknown>);
        const options = resolveClipAnalysisOptions(
          args as Record<string, unknown>,
          'representative',
        );
        const response = await invoke<ClipAnalysisResponseLike>('analyze_timeline_clip', {
          ...target,
          options,
        });

        logger.debug('analyze_timeline_clip completed', {
          clipId: target.clipId,
          fingerprint: response.bundle.fingerprint,
          source: response.source,
        });
        return { success: true, result: buildClipAnalysisToolResult(response) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('analyze_timeline_clip failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Read Clip Analysis
  // ---------------------------------------------------------------------------
  {
    name: 'read_clip_analysis',
    description:
      'Read a cached clip-local analysis bundle by fingerprint after analyze_timeline_clip/sample_clip_frames created it.',
    category: 'analysis',
    outputContract: getToolOutputContract('read_clip_analysis') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        fingerprint: {
          type: 'string',
          description: 'Clip analysis fingerprint returned by analyze_timeline_clip.',
        },
      },
      required: ['fingerprint'],
    },
    handler: async (args) => {
      try {
        const fingerprint = typeof args.fingerprint === 'string' ? args.fingerprint.trim() : '';
        if (!fingerprint) {
          return { success: false, error: 'fingerprint is required' };
        }

        const bundle = await invoke<ClipAnalysisBundleLike | null>('get_clip_analysis', {
          fingerprint,
        });
        if (!bundle) {
          return { success: false, error: `Clip analysis bundle not found: ${fingerprint}` };
        }

        return {
          success: true,
          result: buildClipAnalysisToolResult({ source: 'cached', bundle }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('read_clip_analysis failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Map Timeline to Source
  // ---------------------------------------------------------------------------
  {
    name: 'map_timeline_to_source',
    description:
      'Map one or more absolute timeline seconds inside a clip to source seconds and frame indices, respecting speed, reverse, freeze frame, and time remap.',
    category: 'analysis',
    outputContract: getToolOutputContract('map_timeline_to_source') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Sequence ID. Defaults to active sequence.' },
        trackId: { type: 'string', description: 'Track ID. Defaults from clipId when possible.' },
        clipId: {
          type: 'string',
          description: 'Clip ID. Defaults to the only selected timeline clip when omitted.',
        },
        timelineTimes: {
          type: 'array',
          description: 'Absolute timeline seconds to map.',
          items: { type: 'number' },
        },
        timelineTime: {
          type: 'number',
          description: 'Single absolute timeline second to map.',
        },
        time: {
          type: 'number',
          description: 'Single timeline-second alias. Defaults to playhead when omitted.',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const target = resolveTimelineClipTarget(args as Record<string, unknown>);
        const timelineTimes = resolveTimelineTimes(args as Record<string, unknown>);
        if (timelineTimes.length === 0) {
          return { success: false, error: 'timelineTimes must include at least one finite value' };
        }

        const mapping = await invoke<unknown[]>('map_timeline_to_source', {
          ...target,
          timelineTimes,
        });

        return {
          success: true,
          result: {
            ...target,
            count: mapping.length,
            mapping,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('map_timeline_to_source failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Sample Clip Frames
  // ---------------------------------------------------------------------------
  {
    name: 'sample_clip_frames',
    description:
      'Extract dense frame samples for a selected or specified timeline clip and return the indexed clip-analysis bundle. Defaults to dense sampling for close visual inspection.',
    category: 'analysis',
    outputContract: getToolOutputContract('sample_clip_frames') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Sequence ID. Defaults to active sequence.' },
        trackId: { type: 'string', description: 'Track ID. Defaults from clipId when possible.' },
        clipId: {
          type: 'string',
          description: 'Clip ID. Defaults to the only selected timeline clip when omitted.',
        },
        targetIntervalSec: {
          type: 'number',
          description: 'Dense sampling interval in timeline seconds. Default: 0.25.',
        },
        maxSamples: { type: 'number', description: 'Maximum frame samples to extract.' },
        includeEdges: { type: 'boolean', description: 'Include edge samples.' },
        rangeStartSec: { type: 'number', description: 'Optional absolute timeline range start.' },
        rangeEndSec: { type: 'number', description: 'Optional absolute timeline range end.' },
        forceRefresh: { type: 'boolean', description: 'Ignore compatible cached bundle.' },
        options: { type: 'object', description: 'Optional nested clip-analysis options.' },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const target = resolveTimelineClipTarget(args as Record<string, unknown>);
        const options = resolveClipAnalysisOptions(args as Record<string, unknown>, 'dense');
        const response = await invoke<ClipAnalysisResponseLike>('sample_clip_frames', {
          ...target,
          options,
        });

        logger.debug('sample_clip_frames completed', {
          clipId: target.clipId,
          sampleCount: response.bundle.samples?.length ?? 0,
        });
        return { success: true, result: buildClipAnalysisToolResult(response) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('sample_clip_frames failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Inspect Timeline Range
  // ---------------------------------------------------------------------------
  {
    name: 'inspect_timeline_range',
    description:
      'Analyze every visible video clip overlapping an absolute timeline range, returning clip-local bundles for range-level planning before precise edits.',
    category: 'analysis',
    outputContract: getToolOutputContract('inspect_timeline_range') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'Sequence ID. Defaults to the active sequence when omitted.',
        },
        startSec: { type: 'number', description: 'Absolute timeline range start in seconds.' },
        endSec: { type: 'number', description: 'Absolute timeline range end in seconds.' },
        trackId: { type: 'string', description: 'Optional track ID to restrict inspection.' },
        targetIntervalSec: {
          type: 'number',
          description: 'Dense sampling interval in timeline seconds. Default: 0.25.',
        },
        maxSamples: { type: 'number', description: 'Maximum samples per clip.' },
        includeEdges: { type: 'boolean', description: 'Include edge samples.' },
        forceRefresh: { type: 'boolean', description: 'Ignore compatible cached bundles.' },
        options: { type: 'object', description: 'Optional nested clip-analysis options.' },
      },
      required: ['startSec', 'endSec'],
    },
    handler: async (args) => {
      try {
        const selection = getSelectionContext();
        const sequenceId =
          typeof args.sequenceId === 'string' && args.sequenceId.trim().length > 0
            ? args.sequenceId.trim()
            : selection.sequenceId;
        const startSec = typeof args.startSec === 'number' ? args.startSec : NaN;
        const endSec = typeof args.endSec === 'number' ? args.endSec : NaN;
        if (!sequenceId) {
          return {
            success: false,
            error: 'sequenceId is required because there is no active sequence',
          };
        }
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
          return {
            success: false,
            error: 'startSec and endSec must define a valid timeline range',
          };
        }

        const options = resolveClipAnalysisOptions(args as Record<string, unknown>, 'dense');
        const responses = await invoke<ClipAnalysisResponseLike[]>('inspect_timeline_range', {
          sequenceId,
          startSec,
          endSec,
          trackId: typeof args.trackId === 'string' ? args.trackId : null,
          options,
        });

        return {
          success: true,
          result: {
            sequenceId,
            startSec,
            endSec,
            count: responses.length,
            clips: responses.map(buildClipAnalysisToolResult),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('inspect_timeline_range failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Describe Clip Frames
  // ---------------------------------------------------------------------------
  {
    name: 'describe_clip_frames',
    description:
      'Build semantic clip-local frame evidence for a selected/specified timeline clip or an existing clip-analysis fingerprint. Returns per-sample descriptions, subjects/actions/OCR/objects, confidence, provider/source labels, and quality status. Cloud vision is disabled unless allowCloud=true.',
    category: 'analysis',
    outputContract: getToolOutputContract('describe_clip_frames') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        sequenceId: { type: 'string', description: 'Sequence ID. Defaults to active sequence.' },
        trackId: { type: 'string', description: 'Track ID. Defaults from clipId when possible.' },
        clipId: {
          type: 'string',
          description: 'Clip ID. Defaults to the only selected timeline clip when omitted.',
        },
        fingerprint: {
          type: 'string',
          description:
            'Optional clip-analysis fingerprint. When provided, enriches that cached bundle instead of extracting frames again.',
        },
        targetIntervalSec: {
          type: 'number',
          description: 'Dense sampling interval in timeline seconds. Default: 0.25.',
        },
        maxSamples: { type: 'number', description: 'Maximum frame samples to extract.' },
        maxFrames: {
          type: 'number',
          description: 'Maximum ready frame samples to send to a semantic provider.',
        },
        detail: {
          type: 'string',
          description: 'Vision detail level: low, auto, or high. Default: low.',
        },
        provider: {
          type: 'string',
          description: 'Optional provider name. Currently openai when cloud is allowed.',
        },
        model: { type: 'string', description: 'Optional provider model override.' },
        reuseSourceAnalysis: {
          type: 'boolean',
          description:
            'Reuse existing source frame observations before provider calls. Default: true.',
        },
        allowCloud: {
          type: 'boolean',
          description: 'Allow configured cloud vision provider calls. Default: false.',
        },
        includeContactSheet: {
          type: 'boolean',
          description: 'Reserve compatibility with provider contact-sheet context. Default: false.',
        },
        includeEdges: { type: 'boolean', description: 'Include edge samples.' },
        rangeStartSec: { type: 'number', description: 'Optional absolute timeline range start.' },
        rangeEndSec: { type: 'number', description: 'Optional absolute timeline range end.' },
        forceRefresh: { type: 'boolean', description: 'Ignore compatible cached bundles.' },
        options: { type: 'object', description: 'Optional nested clip/perception options.' },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const normalizedArgs = args as Record<string, unknown>;
        const perceptionOptions = resolveClipPerceptionOptions(normalizedArgs);
        const fingerprint = readOptionalString(
          normalizedArgs,
          readNestedOptions(normalizedArgs),
          'fingerprint',
        );

        if (fingerprint) {
          const response = await invoke<ClipPerceptionResponse>('enrich_clip_perception', {
            fingerprint,
            options: perceptionOptions,
          });
          return { success: true, result: buildClipPerceptionToolResult(response) };
        }

        const target = resolveTimelineClipTarget(normalizedArgs);
        const analysisOptions = resolveClipAnalysisOptions(normalizedArgs, 'dense');
        const response = await invoke<ClipPerceptionResponse>('describe_timeline_clip', {
          ...target,
          analysisOptions,
          perceptionOptions,
        });

        logger.debug('describe_clip_frames completed', {
          clipId: target.clipId,
          perceptionFingerprint: response.bundle.perceptionFingerprint,
          source: response.source,
        });
        return { success: true, result: buildClipPerceptionToolResult(response) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('describe_clip_frames failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Read Clip Perception
  // ---------------------------------------------------------------------------
  {
    name: 'read_clip_perception',
    description:
      'Read a cached semantic clip-perception bundle by perceptionFingerprint after describe_clip_frames or describe_timeline_range created it.',
    category: 'analysis',
    outputContract: getToolOutputContract('read_clip_perception') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        perceptionFingerprint: {
          type: 'string',
          description: 'Perception fingerprint returned by describe_clip_frames.',
        },
        fingerprint: {
          type: 'string',
          description: 'Alias for perceptionFingerprint for cache reads.',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const normalizedArgs = args as Record<string, unknown>;
        const nestedOptions = readNestedOptions(normalizedArgs);
        const perceptionFingerprint =
          readOptionalString(normalizedArgs, nestedOptions, 'perceptionFingerprint') ??
          readOptionalString(normalizedArgs, nestedOptions, 'fingerprint') ??
          '';
        if (!perceptionFingerprint) {
          return { success: false, error: 'perceptionFingerprint is required' };
        }

        const bundle = await invoke<ClipPerceptionBundle | null>('get_clip_perception', {
          perceptionFingerprint,
        });
        if (!bundle) {
          return {
            success: false,
            error: `Clip perception bundle not found: ${perceptionFingerprint}`,
          };
        }

        return {
          success: true,
          result: buildClipPerceptionToolResult({ source: 'cached', bundle }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('read_clip_perception failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Describe Timeline Range
  // ---------------------------------------------------------------------------
  {
    name: 'describe_timeline_range',
    description:
      'Analyze and semantically describe every visible video clip overlapping a timeline range. Use when a requested edit depends on visual meaning across multiple small clips.',
    category: 'analysis',
    outputContract: getToolOutputContract('describe_timeline_range') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'Sequence ID. Defaults to the active sequence when omitted.',
        },
        startSec: { type: 'number', description: 'Absolute timeline range start in seconds.' },
        endSec: { type: 'number', description: 'Absolute timeline range end in seconds.' },
        trackId: { type: 'string', description: 'Optional track ID to restrict inspection.' },
        targetIntervalSec: {
          type: 'number',
          description: 'Dense sampling interval in timeline seconds. Default: 0.25.',
        },
        maxSamples: { type: 'number', description: 'Maximum samples per clip.' },
        maxFrames: {
          type: 'number',
          description: 'Maximum ready frame samples per clip to send to a semantic provider.',
        },
        detail: { type: 'string', description: 'Vision detail level: low, auto, or high.' },
        provider: { type: 'string', description: 'Optional provider name.' },
        model: { type: 'string', description: 'Optional provider model override.' },
        reuseSourceAnalysis: {
          type: 'boolean',
          description: 'Reuse cached source frame observations first. Default: true.',
        },
        allowCloud: { type: 'boolean', description: 'Allow cloud vision provider calls.' },
        includeEdges: { type: 'boolean', description: 'Include edge samples.' },
        forceRefresh: { type: 'boolean', description: 'Ignore compatible cached bundles.' },
        options: { type: 'object', description: 'Optional nested clip/perception options.' },
      },
      required: ['startSec', 'endSec'],
    },
    handler: async (args) => {
      try {
        const selection = getSelectionContext();
        const sequenceId =
          typeof args.sequenceId === 'string' && args.sequenceId.trim().length > 0
            ? args.sequenceId.trim()
            : selection.sequenceId;
        const startSec = typeof args.startSec === 'number' ? args.startSec : NaN;
        const endSec = typeof args.endSec === 'number' ? args.endSec : NaN;
        if (!sequenceId) {
          return {
            success: false,
            error: 'sequenceId is required because there is no active sequence',
          };
        }
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
          return {
            success: false,
            error: 'startSec and endSec must define a valid timeline range',
          };
        }

        const normalizedArgs = args as Record<string, unknown>;
        const analysisOptions = resolveClipAnalysisOptions(normalizedArgs, 'dense');
        const perceptionOptions = resolveClipPerceptionOptions(normalizedArgs);
        const responses = await invoke<ClipPerceptionResponse[]>('describe_timeline_range', {
          sequenceId,
          startSec,
          endSec,
          trackId: typeof args.trackId === 'string' ? args.trackId : null,
          analysisOptions,
          perceptionOptions,
        });

        return {
          success: true,
          result: {
            sequenceId,
            startSec,
            endSec,
            count: responses.length,
            clips: responses.map(buildClipPerceptionToolResult),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('describe_timeline_range failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Search Clip Evidence
  // ---------------------------------------------------------------------------
  {
    name: 'search_clip_evidence',
    description:
      'Search cached clip-local semantic observations by description, subjects, actions, visible text, objects, setting, or edit usefulness.',
    category: 'analysis',
    outputContract: getToolOutputContract('search_clip_evidence') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for cached clip evidence.' },
        limit: { type: 'number', description: 'Maximum number of matching observations.' },
        sequenceId: { type: 'string', description: 'Optional sequence ID filter.' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) {
          return { success: false, error: 'query is required' };
        }
        const limit =
          typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.max(1, Math.floor(args.limit))
            : 10;
        const sequenceId =
          typeof args.sequenceId === 'string' && args.sequenceId.trim().length > 0
            ? args.sequenceId.trim()
            : null;
        const hits = await invoke<ClipEvidenceSearchHit[]>('search_clip_evidence', {
          query,
          limit,
          sequenceId,
        });

        return {
          success: true,
          result: {
            query,
            count: hits.length,
            hits,
            summary: `Found ${hits.length} cached clip evidence match(es) for "${query}".`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('search_clip_evidence failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Plan Semantic Clip Edit
  // ---------------------------------------------------------------------------
  {
    name: 'plan_semantic_clip_edit',
    description:
      'Convert cached semantic clip evidence into timeline ranges and command drafts for blur, highlight, remove, marker, or addText edits. This is read-only and does not mutate the project; execute returned drafts only after reviewing warnings and unresolved IDs.',
    category: 'analysis',
    outputContract: getToolOutputContract('plan_semantic_clip_edit') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        perceptionFingerprint: {
          type: 'string',
          description: 'Perception fingerprint returned by describe_clip_frames.',
        },
        query: {
          type: 'string',
          description: 'Target semantic query, such as logo, license plate, chart, or text.',
        },
        action: {
          type: 'string',
          description: 'Planned action: blur, highlight, remove, marker, or addText.',
        },
        paddingSec: {
          type: 'number',
          description: 'Seconds to pad before/after each matched sample. Default: 0.2.',
        },
        mergeGapSec: {
          type: 'number',
          description: 'Merge ranges separated by this many seconds or less. Default: 0.35.',
        },
        minConfidence: {
          type: 'number',
          description: 'Minimum semantic evidence confidence from 0 to 1.',
        },
        maxRanges: { type: 'number', description: 'Maximum number of planned ranges.' },
        text: { type: 'string', description: 'Text content when action is addText.' },
        effectStrength: {
          type: 'number',
          description: 'Effect strength, such as blur radius or highlight amount.',
        },
        includeCommandDrafts: {
          type: 'boolean',
          description: 'Include command draft payloads. Default: true.',
        },
        spatialTimeToleranceSec: {
          type: 'number',
          description:
            'Source-time tolerance for matching annotation bounding boxes to semantic ranges.',
        },
        includeSpatialTargets: {
          type: 'boolean',
          description:
            'Include object/face/OCR bounding boxes from stored asset annotations when available.',
        },
        options: { type: 'object', description: 'Optional nested planning options.' },
      },
      required: ['perceptionFingerprint', 'query'],
    },
    handler: async (args) => {
      try {
        const normalizedArgs = args as Record<string, unknown>;
        const nestedOptions = readNestedOptions(normalizedArgs);
        const perceptionFingerprint =
          readOptionalString(normalizedArgs, nestedOptions, 'perceptionFingerprint') ?? '';
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!perceptionFingerprint) {
          return { success: false, error: 'perceptionFingerprint is required' };
        }
        if (!query) {
          return { success: false, error: 'query is required' };
        }

        const action = resolveSemanticEditAction(nestedOptions.action ?? args.action);
        const options = resolveSemanticEditPlanOptions(normalizedArgs);
        const plan = await invoke<SemanticTemporalEditPlan>('plan_semantic_clip_edit', {
          perceptionFingerprint,
          query,
          action,
          options,
        });

        return {
          success: true,
          result: plan,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('plan_semantic_clip_edit failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

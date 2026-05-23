/**
 * Generative Timeline Tools
 *
 * Provider-neutral orchestration tools that make generative work visible and
 * recoverable through OpenReelio's timeline and job lifecycle.
 */

import { invoke } from '@tauri-apps/api/core';
import { globalToolRegistry, type AgentContext, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';

const logger = createLogger('GenerativeTimelineTools');

type MediaType = 'video' | 'image' | 'music' | 'sfx';
type PlacementMode = 'pending' | 'import_only';
type LicensePolicyStatus = 'allowed' | 'warning' | 'blocked';

interface CandidateLike {
  id?: string;
  name?: string;
  assetType?: string;
  asset_type?: string;
  provider?: string;
  durationSec?: number | null;
  duration_sec?: number | null;
  tags?: string[];
  license?: Record<string, unknown>;
  licensePolicy?: {
    status?: LicensePolicyStatus;
    requiredActions?: string[];
    reasons?: string[];
  };
  metadata?: Record<string, unknown>;
}

interface PendingTimelinePlacement {
  sequenceId: string;
  trackId: string;
  timelineStart: number;
  markerId: string | null;
  markerLabel: string | null;
}

const SUPPORTED_VIDEO_PROVIDERS = new Set(['auto', 'seedance']);

const GENERATIVE_TIMELINE_TOOLS: ToolDefinition[] = [
  {
    name: 'generate_timeline_media',
    description:
      'Provider-neutral generative media orchestration. Submits generation, optionally creates a pending timeline marker, and stores placement intent so completed generated video can auto-place on the timeline.',
    category: 'generation',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Generation or search prompt.' },
        mediaType: {
          type: 'string',
          enum: ['video', 'image', 'music', 'sfx'],
          description: 'Media type to create or discover. Defaults to video.',
        },
        provider: {
          type: 'string',
          enum: ['auto', 'seedance', 'google', 'runway', 'pika', 'luma', 'openai', 'local'],
          description: 'Preferred provider. Unsupported providers return an explicit error.',
        },
        quality: {
          type: 'string',
          enum: ['basic', 'pro', 'cinema'],
          description: 'Video generation quality tier.',
        },
        durationSec: { type: 'number', description: 'Requested duration in seconds.' },
        referenceAssetIds: {
          type: 'array',
          description: 'Reference image/video/audio asset IDs.',
          items: { type: 'string' },
        },
        aspectRatio: { type: 'string', description: 'Video aspect ratio such as 16:9 or 9:16.' },
        sequenceId: { type: 'string', description: 'Target sequence for pending placement.' },
        trackId: { type: 'string', description: 'Target track for completed placement.' },
        timelineStart: { type: 'number', description: 'Timeline start in seconds.' },
        placementMode: {
          type: 'string',
          enum: ['pending', 'import_only'],
          description: 'pending creates timeline visualization; import_only only creates the job.',
        },
        autoPlaceWhenReady: {
          type: 'boolean',
          description: 'Whether the imported generated asset should be inserted automatically.',
        },
        markerLabel: { type: 'string', description: 'Optional label for the pending marker.' },
        mood: { type: 'string', description: 'Mood/style hint for sfx discovery.' },
        tags: {
          type: 'array',
          description: 'Optional search tags for sfx discovery.',
          items: { type: 'string' },
        },
      },
      required: ['prompt'],
    },
    handler: async (args, context) => generateTimelineMedia(args, context),
  },
  {
    name: 'resolve_generation_job',
    description:
      'Synchronize a generation job with the timeline. Pending provider states return success with pending status; completed jobs can place the imported asset when requested.',
    category: 'generation',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Local generation job ID.' },
        sequenceId: { type: 'string', description: 'Target sequence for manual placement.' },
        trackId: { type: 'string', description: 'Target track for manual placement.' },
        timelineStart: { type: 'number', description: 'Timeline start for manual placement.' },
        placeWhenComplete: {
          type: 'boolean',
          description: 'Insert the completed asset if the job has an assetId.',
        },
      },
      required: ['jobId'],
    },
    handler: async (args) => resolveGenerationJob(args),
  },
  {
    name: 'search_sound_for_scene',
    description:
      'Find sound-effect or ambient audio candidates for a scene through configured stock providers. Returns references and license policy only; it does not import or place media.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        sceneDescription: {
          type: 'string',
          description: 'Scene/action description to search sound effects for.',
        },
        mood: { type: 'string', description: 'Optional mood, e.g. tense, playful, cinematic.' },
        durationSec: { type: 'number', description: 'Preferred duration in seconds.' },
        count: { type: 'number', description: 'Maximum result count, 1-50.' },
        tags: {
          type: 'array',
          description: 'Additional audio tags such as whoosh, impact, ambience, foley.',
          items: { type: 'string' },
        },
      },
      required: ['sceneDescription'],
    },
    handler: async (args) => searchSoundForScene(args),
  },
  {
    name: 'import_asset_candidate',
    description:
      'Import an approved stock media candidate after license acknowledgement. Requires licenseAck=true and rejects blocked license-policy candidates.',
    category: 'generation',
    parameters: {
      type: 'object',
      properties: {
        candidate: { type: 'object', description: 'Candidate object returned by stock search.' },
        sourceUrl: { type: 'string', description: 'Direct media URL override.' },
        name: { type: 'string', description: 'Imported asset name.' },
        assetType: {
          type: 'string',
          enum: ['video', 'image', 'audio'],
          description: 'Candidate media type.',
        },
        provider: { type: 'string', description: 'Provider name.' },
        license: { type: 'object', description: 'Normalized LicenseInfo object.' },
        licenseAck: {
          type: 'boolean',
          description: 'Must be true after user/provider/license acknowledgement.',
        },
        durationSec: { type: 'number', description: 'Optional media duration.' },
        tags: {
          type: 'array',
          description: 'Optional imported asset tags.',
          items: { type: 'string' },
        },
        providerUrl: { type: 'string', description: 'Provider landing page URL.' },
      },
      required: ['licenseAck'],
    },
    handler: async (args) => importAssetCandidate(args),
  },
];

async function generateTimelineMedia(args: Record<string, unknown>, context: AgentContext) {
  const prompt = normalizeString(args.prompt);
  if (!prompt) {
    return { success: false, error: 'prompt cannot be empty' };
  }

  const mediaType = normalizeMediaType(args.mediaType);
  if (mediaType === 'sfx') {
    return searchSoundForScene({
      sceneDescription: prompt,
      mood: args.mood,
      durationSec: args.durationSec,
      count: args.count,
      tags: args.tags,
    });
  }

  if (mediaType !== 'video') {
    return {
      success: false,
      error: `Generative timeline ${mediaType} creation is not implemented yet. Use search_sound_for_scene for SFX or add a provider adapter for this media type.`,
    };
  }

  const provider = normalizeProvider(args.provider);
  if (!SUPPORTED_VIDEO_PROVIDERS.has(provider)) {
    return {
      success: false,
      error: `Video provider '${provider}' is not implemented for OpenReelio timeline orchestration yet. Configure a provider adapter or use provider 'auto'.`,
    };
  }

  if (!globalToolRegistry.has('generate_video')) {
    return {
      success: false,
      error:
        'Video generation tools are not registered. Enable USE_VIDEO_GENERATION and configure a supported provider.',
    };
  }

  const placementMode = normalizePlacementMode(args.placementMode);
  const placement = buildPlacement(args, context);
  let pendingTimeline: PendingTimelinePlacement | null = null;

  if (placementMode === 'pending' && !placement) {
    return {
      success: false,
      error:
        'Pending timeline generation requires sequenceId and trackId, either as arguments or active timeline context. Use placementMode="import_only" to submit without timeline visualization.',
    };
  }

  if (placementMode === 'pending' && placement) {
    if (!globalToolRegistry.has('add_marker')) {
      return {
        success: false,
        error: 'add_marker is not registered; pending timeline visualization is unavailable.',
      };
    }

    const label = normalizeString(args.markerLabel) || `Generating: ${truncateLabel(prompt)}`;
    const marker = await globalToolRegistry.execute('add_marker', {
      sequenceId: placement.sequenceId,
      time: placement.timelineStart,
      label,
      color: '#8B5CF6',
    });

    if (!marker.success) {
      return {
        success: false,
        error: `Failed to create pending generation marker: ${marker.error}`,
      };
    }

    const markerId = extractCreatedId(marker.result);
    placement.markerId = markerId;
    pendingTimeline = {
      sequenceId: placement.sequenceId,
      trackId: placement.trackId,
      timelineStart: placement.timelineStart,
      markerId,
      markerLabel: label,
    };
  }

  const shouldAttachPlacement =
    placementMode !== 'import_only' && args.autoPlaceWhenReady !== false && Boolean(placement);
  const generationArgs: Record<string, unknown> = {
    prompt,
    mode: 'text_to_video',
    quality: normalizeQuality(args.quality),
    durationSec: normalizeDuration(args.durationSec),
    referenceAssetIds: Array.isArray(args.referenceAssetIds) ? args.referenceAssetIds : undefined,
    aspectRatio: normalizeString(args.aspectRatio) || undefined,
  };
  if (shouldAttachPlacement && placement) {
    generationArgs.placement = {
      ...placement,
      removeMarkerOnPlace: true,
    };
  }

  const generation = await globalToolRegistry.execute('generate_video', generationArgs);

  if (!generation.success) {
    await removePendingMarkerBestEffort(pendingTimeline);
    return generation;
  }

  const generationResult = asRecord(generation.result);
  return {
    success: true,
    result: {
      status: 'submitted',
      mediaType,
      provider: provider === 'auto' ? 'seedance' : provider,
      jobId: getString(generationResult, 'jobId'),
      estimatedCostCents: getNumber(generationResult, 'estimatedCostCents'),
      pendingTimeline,
      autoPlaceWhenReady: shouldAttachPlacement,
      nextAction: 'resolve_generation_job',
    },
  };
}

async function resolveGenerationJob(args: Record<string, unknown>) {
  const jobId = normalizeString(args.jobId);
  if (!jobId) {
    return { success: false, error: 'jobId cannot be empty' };
  }

  const status = await globalToolRegistry.execute('check_generation_status', { jobId });
  if (!status.success) {
    return status;
  }

  const statusResult = asRecord(status.result);
  const jobStatus = getString(statusResult, 'status') ?? 'unknown';
  const assetId = getString(statusResult, 'assetId');
  const shouldPlace = args.placeWhenComplete === true;
  const statusError = getString(statusResult, 'error');

  if (jobStatus === 'failed' || jobStatus === 'cancelled') {
    return {
      success: false,
      error:
        jobStatus === 'failed'
          ? `Generation failed${statusError ? `: ${statusError}` : ''}`
          : 'Generation was cancelled',
      result: {
        status: jobStatus,
        pending: false,
        assetId,
        error: statusError,
      },
    };
  }

  if (jobStatus === 'completed' && !assetId) {
    return {
      success: false,
      error: 'Generation completed but no imported assetId is available.',
      result: {
        status: jobStatus,
        pending: false,
        assetId: null,
      },
    };
  }

  if (!assetId || jobStatus !== 'completed') {
    return {
      success: true,
      result: {
        status: jobStatus,
        pending: true,
        progress: getNumber(statusResult, 'progress'),
        assetId,
        message: 'Generation is not ready for final timeline placement yet.',
      },
    };
  }

  if (!shouldPlace) {
    return {
      success: true,
      result: {
        status: jobStatus,
        pending: false,
        assetId,
        message: 'Generation completed and asset is imported.',
      },
    };
  }

  const sequenceId = normalizeString(args.sequenceId);
  const trackId = normalizeString(args.trackId);
  if (!sequenceId || !trackId) {
    return {
      success: false,
      error: 'sequenceId and trackId are required when placeWhenComplete=true',
    };
  }

  const insert = await globalToolRegistry.execute('insert_clip', {
    sequenceId,
    trackId,
    assetId,
    timelineStart: normalizeTimelineStart(args.timelineStart),
  });

  if (!insert.success) {
    return insert;
  }

  return {
    success: true,
    result: {
      status: jobStatus,
      pending: false,
      assetId,
      placement: insert.result,
    },
  };
}

async function searchSoundForScene(args: Record<string, unknown>) {
  const sceneDescription = normalizeString(args.sceneDescription);
  if (!sceneDescription) {
    return { success: false, error: 'sceneDescription cannot be empty' };
  }

  if (!globalToolRegistry.has('search_stock_media')) {
    return {
      success: false,
      error: 'search_stock_media is not registered; configure asset discovery tools first.',
    };
  }

  const query = buildSoundQuery(sceneDescription, args.mood, args.tags);
  const result = await globalToolRegistry.execute('search_stock_media', {
    query,
    type: 'audio',
    count: normalizeCount(args.count),
  });

  if (!result.success) {
    return result;
  }

  const payload = asRecord(result.result) ?? {};
  const assets = Array.isArray(payload.assets) ? payload.assets.map(toCandidateLike) : [];
  const ranked = rankAudioCandidates(assets, getNumber(args, 'durationSec'));
  const usable = ranked.filter((candidate) => candidate.licensePolicy?.status !== 'blocked');
  const blocked = ranked.filter((candidate) => candidate.licensePolicy?.status === 'blocked');

  return {
    success: true,
    result: {
      query,
      count: ranked.length,
      recommendedCandidates: usable,
      blockedCandidates: blocked,
      policySummary: payload.policySummary ?? {},
      requiresImportApproval: true,
      nextAction: 'import_asset_candidate',
    },
  };
}

async function importAssetCandidate(args: Record<string, unknown>) {
  const candidate = toCandidateLike(args.candidate);
  const licensePolicy = candidate.licensePolicy;
  if (licensePolicy?.status === 'blocked') {
    return {
      success: false,
      error: `Candidate is blocked by license policy: ${(licensePolicy.reasons ?? []).join('; ')}`,
    };
  }

  if (args.licenseAck !== true) {
    return {
      success: false,
      error: 'import_asset_candidate requires licenseAck=true after provider/license review.',
    };
  }

  const sourceUrl =
    normalizeString(args.sourceUrl) ||
    getString(candidate.metadata, 'downloadUrl') ||
    getString(candidate.metadata, 'previewUrl') ||
    getString(candidate.metadata, 'sourceUrl');
  const name = normalizeString(args.name) || candidate.name || candidate.id || 'stock-media';
  const assetType = normalizeAssetType(args.assetType ?? candidate.assetType ?? candidate.asset_type);
  const provider =
    normalizeString(args.provider) || candidate.provider || getString(candidate.metadata, 'provider');
  const license = asRecord(args.license) ?? candidate.license;

  if (!sourceUrl) {
    return { success: false, error: 'Candidate does not include a downloadable media URL.' };
  }
  if (!provider) {
    return { success: false, error: 'Candidate provider is required.' };
  }
  if (!license) {
    return { success: false, error: 'Candidate license is required.' };
  }

  try {
    const result = await invoke('import_stock_media_asset', {
      sourceUrl,
      name,
      assetType,
      provider,
      license,
      licenseAck: true,
      durationSec: getNumber(args, 'durationSec') ?? candidate.durationSec ?? candidate.duration_sec ?? null,
      tags: Array.isArray(args.tags) ? args.tags : candidate.tags ?? null,
      providerUrl: normalizeString(args.providerUrl) || getString(candidate.metadata, 'providerUrl') || null,
    });

    return {
      success: true,
      result: {
        import: result,
        nextAction: 'insert_clip',
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('import_asset_candidate failed', { error: message });
    return { success: false, error: message };
  }
}

function normalizeMediaType(value: unknown): MediaType {
  return value === 'image' || value === 'music' || value === 'sfx' || value === 'video'
    ? value
    : 'video';
}

function normalizeProvider(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'auto';
}

function normalizePlacementMode(value: unknown): PlacementMode {
  return value === 'import_only' ? 'import_only' : 'pending';
}

function normalizeQuality(value: unknown): string {
  return value === 'basic' || value === 'cinema' || value === 'pro' ? value : 'pro';
}

function normalizeDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(120, Math.max(5, value))
    : 6;
}

function normalizeTimelineStart(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(50, Math.max(1, Math.trunc(value)))
    : 8;
}

function normalizeAssetType(value: unknown): 'video' | 'image' | 'audio' {
  return value === 'video' || value === 'image' || value === 'audio' ? value : 'audio';
}

function buildPlacement(
  args: Record<string, unknown>,
  context: AgentContext,
): PendingTimelinePlacement | null {
  const sequenceId = normalizeString(args.sequenceId) || context.sequenceId || '';
  const trackId =
    normalizeString(args.trackId) ||
    (Array.isArray(context.selectedTrackIds) ? context.selectedTrackIds[0] : '') ||
    '';

  if (!sequenceId || !trackId) {
    return null;
  }

  return {
    sequenceId,
    trackId,
    timelineStart:
      typeof args.timelineStart === 'number' && Number.isFinite(args.timelineStart)
        ? Math.max(0, args.timelineStart)
        : Math.max(0, context.playheadPosition ?? 0),
    markerId: null,
    markerLabel: null,
  };
}

function buildSoundQuery(sceneDescription: string, mood: unknown, tags: unknown): string {
  const parts = [sceneDescription, normalizeString(mood), 'sound effect'];
  if (Array.isArray(tags)) {
    parts.push(...tags.filter((tag): tag is string => typeof tag === 'string'));
  }
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

function rankAudioCandidates(candidates: CandidateLike[], preferredDuration?: number | null) {
  return [...candidates].sort((left, right) => {
    const leftBlocked = left.licensePolicy?.status === 'blocked' ? 1 : 0;
    const rightBlocked = right.licensePolicy?.status === 'blocked' ? 1 : 0;
    if (leftBlocked !== rightBlocked) return leftBlocked - rightBlocked;

    if (typeof preferredDuration === 'number' && Number.isFinite(preferredDuration)) {
      const leftDuration = left.durationSec ?? left.duration_sec;
      const rightDuration = right.durationSec ?? right.duration_sec;
      const leftDelta = typeof leftDuration === 'number' ? Math.abs(leftDuration - preferredDuration) : Infinity;
      const rightDelta =
        typeof rightDuration === 'number' ? Math.abs(rightDuration - preferredDuration) : Infinity;
      return leftDelta - rightDelta;
    }

    return 0;
  });
}

function toCandidateLike(value: unknown): CandidateLike {
  return (asRecord(value) ?? {}) as CandidateLike;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown, key: string): string | null {
  const record = asRecord(value);
  const raw = record?.[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function getNumber(value: unknown, key?: string): number | null {
  const raw = key ? asRecord(value)?.[key] : value;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateLabel(value: string): string {
  return value.length > 48 ? `${value.slice(0, 45)}...` : value;
}

function extractCreatedId(value: unknown): string | null {
  const record = asRecord(value);
  const createdIds = record?.createdIds;
  if (Array.isArray(createdIds)) {
    const id = createdIds.find((candidate): candidate is string => typeof candidate === 'string');
    if (id) return id;
  }

  const marker = asRecord(record?.marker);
  return getString(record, 'markerId') ?? getString(marker, 'id');
}

async function removePendingMarkerBestEffort(pendingTimeline: PendingTimelinePlacement | null) {
  if (!pendingTimeline?.markerId) return;
  try {
    await globalToolRegistry.execute('remove_marker', {
      sequenceId: pendingTimeline.sequenceId,
      markerId: pendingTimeline.markerId,
    });
  } catch (error) {
    logger.warn('Failed to remove pending marker after generation submission failure', {
      error: String(error),
    });
  }
}

export function registerGenerativeTimelineTools(): void {
  globalToolRegistry.registerMany(GENERATIVE_TIMELINE_TOOLS);
  logger.info('Generative timeline tools registered', {
    count: GENERATIVE_TIMELINE_TOOLS.length,
  });
}

export function unregisterGenerativeTimelineTools(): void {
  for (const tool of GENERATIVE_TIMELINE_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Generative timeline tools unregistered', {
    count: GENERATIVE_TIMELINE_TOOLS.length,
  });
}

export function getGenerativeTimelineToolNames(): string[] {
  return GENERATIVE_TIMELINE_TOOLS.map((tool) => tool.name);
}

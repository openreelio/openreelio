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
import { DEFAULT_CAPTION_POSITION, DEFAULT_CAPTION_STYLE, hasActiveTimeRemap } from '@/types';
import type { CaptionColor, CaptionPosition, CaptionStyle, Clip, Sequence } from '@/types';

const logger = createLogger('CaptionTools');

const AUTO_TRANSCRIBE_ALTERNATIVES =
  'Try analyze_asset with analysisTypes ["transcript"] for provider-based speech analysis, or analysisTypes ["textOcr"] for on-screen text.';
const WHISPER_MODEL_SELECTION_PREFERENCE = [
  'large-v3',
  'large-v3-q5_0',
  'large-v3-turbo',
  'large-v3-turbo-q8_0',
  'large-v3-turbo-q5_0',
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
    'large-v3-turbo-q5_0'
  );
}

// `small` is included because it remains weak at non-English speech and sung
// content (it silently produced garbage for Korean sung audio). `medium` and
// above are treated as adequate.
const WEAK_WHISPER_MODELS = new Set(['tiny', 'base', 'small']);

// Recommended high-accuracy model to install when only weak models are present.
// Quantized turbo balances near-large accuracy with low memory/disk footprint.
const RECOMMENDED_WHISPER_MODEL = 'large-v3-turbo-q5_0';

/**
 * Returns a non-fatal warning when a weak Whisper model (tiny/base/small) is
 * used. These small models hallucinate and are weak at non-English speech and
 * sung audio, so recommend a high-accuracy model instead. The warning is
 * language-agnostic because the spoken language is auto-detected and not known
 * up front. Returns null when no warning is warranted.
 */
function buildWeakModelWarning(resolvedModel: string): string | null {
  if (!WEAK_WHISPER_MODELS.has(resolvedModel.trim().toLowerCase())) {
    return null;
  }
  return (
    `Model '${resolvedModel}' is a small Whisper model and is weak at non-English speech and ` +
    `sung content; it may hallucinate or transcribe inaccurately. For higher accuracy, install ` +
    `or select 'large-v3' or 'large-v3-turbo' via install_whisper_model.`
  );
}

/**
 * Structured model-quality assessment derived from the transcription status and
 * the model that will actually be used for transcription. All fields are
 * additive and non-breaking so the agent/UI can react without depending on a
 * regenerated Rust binding.
 */
interface ModelQualityNotice {
  /** Resolved Whisper model id that will run the transcription. */
  resolvedModel: string;
  /** Recommended high-accuracy model id to install. */
  recommendedModel: string;
  /** Whether the recommended-quality model is currently installed. */
  recommendedInstalled: boolean;
  /** Consolidated non-fatal warning, or null when no concern was detected. */
  warning: string | null;
}

/**
 * Reads the backend-provided recommended model id when present. The Rust binding
 * may expose `recommendedModel` once regenerated; until then this reads it
 * defensively and falls back to the constant default.
 */
function resolveRecommendedModel(status: TranscriptionStatusDto): string {
  const candidate = (status as { recommendedModel?: unknown }).recommendedModel;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return RECOMMENDED_WHISPER_MODEL;
}

/**
 * Determines whether the recommended-quality model is installed. Prefers a
 * backend-provided `recommendedInstalled` flag (defensively typed for the
 * not-yet-regenerated binding); otherwise computes it from the model inventory
 * using the `installed && recommended` flags, falling back to an explicit id
 * match against the resolved recommended model.
 */
function resolveRecommendedInstalled(
  status: TranscriptionStatusDto,
  recommendedModel: string,
): boolean {
  const flag = (status as { recommendedInstalled?: unknown }).recommendedInstalled;
  if (typeof flag === 'boolean') {
    return flag;
  }
  const hasInstalledRecommended = status.models.some(
    (candidate) => candidate.installed && candidate.recommended,
  );
  if (hasInstalledRecommended) {
    return true;
  }
  return status.models.some(
    (candidate) => candidate.installed && candidate.id === recommendedModel,
  );
}

/**
 * Builds a consolidated, non-fatal model-quality notice for a transcription. A
 * warning is produced when EITHER the resolved model is weak OR no
 * recommended-quality model is installed. The notice names the recommended
 * model to install via `install_whisper_model` for accurate non-English/sung
 * transcription. Merges with `buildWeakModelWarning` into a single warning
 * string so guidance is not duplicated.
 */
function buildModelQualityNotice(
  status: TranscriptionStatusDto,
  resolvedModel: string,
): ModelQualityNotice {
  const recommendedModel = resolveRecommendedModel(status);
  const recommendedInstalled = resolveRecommendedInstalled(status, recommendedModel);
  const resolvedIsWeak = WEAK_WHISPER_MODELS.has(resolvedModel.trim().toLowerCase());

  let warning: string | null = null;
  if (resolvedIsWeak || !recommendedInstalled) {
    const weakClause = resolvedIsWeak
      ? `Model '${resolvedModel}' is a small Whisper model and is weak at non-English speech and ` +
        `sung content; it may hallucinate or transcribe inaccurately. `
      : '';
    const installClause = recommendedInstalled
      ? `For higher accuracy, select '${recommendedModel}' instead.`
      : `The recommended high-accuracy model '${recommendedModel}' is not installed; install it via ` +
        `install_whisper_model (one-time ~574MB download) for accurate non-English/sung transcription.`;
    warning = `${weakClause}${installClause}`;
  }

  return { resolvedModel, recommendedModel, recommendedInstalled, warning };
}

/**
 * Resolves the recommended high-accuracy model id from the status inventory.
 * Mirrors the pure derivation in `src/hooks/transcriptionModelGate.ts`
 * (`resolveRecommendedModel`) without importing a hook module into a tool file:
 * prefer the quantized turbo model when listed, otherwise the first non-weak
 * model flagged `recommended`. Returns null when no better model is available.
 */
function resolveRecommendedModelFromStatus(
  status: TranscriptionStatusDto,
): { id: string; installed: boolean } | null {
  const preferred = status.models.find(
    (candidate) => candidate.id === RECOMMENDED_WHISPER_MODEL,
  );
  if (preferred) {
    return { id: preferred.id, installed: preferred.installed };
  }

  const recommendedNonWeak = status.models.find(
    (candidate) =>
      candidate.recommended && !WEAK_WHISPER_MODELS.has(candidate.id.trim().toLowerCase()),
  );
  if (recommendedNonWeak) {
    return { id: recommendedNonWeak.id, installed: recommendedNonWeak.installed };
  }

  return null;
}

/**
 * Outcome of hard-enforced model provisioning. `model` is the model that should
 * actually run the transcription. `autoInstalledModel` is set only when a
 * download was performed in this call. `warning` carries a non-fatal message
 * when the recommended model could not be installed and we fell back to the
 * original weak model.
 */
interface ModelProvisioningResult {
  model: string;
  autoInstalledModel: string | null;
  warning: string | null;
}

/**
 * Hard-enforces use of the recommended high-accuracy model when the resolved
 * default is weak and the caller did not deliberately choose a model.
 *
 * - When the caller passed an explicit, non-`auto` model, the choice is honored
 *   as-is (returned unchanged) — even when that model is weak.
 * - When the effective model is weak and a better recommended model exists:
 *   - If the recommended model is already installed, switch to it.
 *   - If it is not installed, download it FIRST (one-time ~574MB), then use it.
 *   - On download failure, fall back to the original weak model and surface a
 *     non-fatal warning rather than failing the whole caption request.
 *
 * Only the recommended (quantized turbo) model is ever auto-downloaded; a large
 * f16 model is never auto-provisioned.
 */
async function provisionRecommendedModel(
  status: TranscriptionStatusDto,
  effectiveModel: string,
  callerSelectedExplicitModel: boolean,
): Promise<ModelProvisioningResult> {
  // Honor an explicit caller choice (even a weak one) — never override it.
  if (callerSelectedExplicitModel) {
    return { model: effectiveModel, autoInstalledModel: null, warning: null };
  }

  // Nothing to upgrade when the effective model is already adequate.
  if (!WEAK_WHISPER_MODELS.has(effectiveModel.trim().toLowerCase())) {
    return { model: effectiveModel, autoInstalledModel: null, warning: null };
  }

  const recommended = resolveRecommendedModelFromStatus(status);
  if (!recommended) {
    // No better model exists in the inventory; proceed with the weak model.
    return { model: effectiveModel, autoInstalledModel: null, warning: null };
  }

  if (recommended.installed) {
    // A better model is already installed — silently upgrade to it.
    return { model: recommended.id, autoInstalledModel: null, warning: null };
  }

  // Weak default + recommended model not installed: download it first, then use
  // it. On failure, fall back to the weak model with a clear warning.
  try {
    logger.info('Auto-provisioning recommended Whisper model before transcription', {
      weakModel: effectiveModel,
      recommendedModel: recommended.id,
    });
    const download = await commands.downloadWhisperModel(recommended.id, false);
    if (download.status === 'error') {
      throw new Error(download.error);
    }
    return { model: recommended.id, autoInstalledModel: recommended.id, warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Recommended Whisper model auto-install failed; falling back to weak model', {
      weakModel: effectiveModel,
      recommendedModel: recommended.id,
      error: message,
    });
    return {
      model: effectiveModel,
      autoInstalledModel: null,
      warning:
        `The recommended high-accuracy model '${recommended.id}' could not be installed automatically ` +
        `(${message}); transcription proceeded with '${effectiveModel}', which is weak at non-English ` +
        `speech and sung content. Install '${recommended.id}' via install_whisper_model and re-run for higher accuracy.`,
    };
  }
}

/**
 * Determines whether the caller deliberately selected a concrete Whisper model.
 * An unset value, or the sentinels `auto`/`default`/`best`/empty string, mean
 * "let the engine choose" and DO enable auto-provisioning.
 */
function callerSelectedExplicitModel(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length > 0 &&
    normalized !== 'auto' &&
    normalized !== 'default' &&
    normalized !== 'best'
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

/**
 * Find a clip by ID anywhere in the given sequence's tracks.
 * Uses the same track/clip traversal pattern as the rest of this module.
 */
function findClipInSequence(sequence: Sequence, clipId: string): Clip | undefined {
  for (const track of sequence.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) {
      return clip;
    }
  }
  return undefined;
}

interface SourceToTimelineMappingResult {
  segments: TranscriptionSegmentInput[];
  skippedOutOfRangeCount: number;
}

/**
 * Map source-relative transcription segment times onto timeline time using a
 * placed clip's range/place/speed. Segments whose source time falls outside the
 * clip's source range are dropped (reported via skippedOutOfRangeCount).
 *
 * Constant-speed mapping only. Clips with an active time remap curve must not be
 * mapped with this formula — callers must reject them before calling this.
 */
function mapSourceSegmentsToTimeline(
  segments: TranscriptionSegmentInput[],
  clip: Clip,
): SourceToTimelineMappingResult {
  const safeSpeed = clip.speed > 0 ? clip.speed : 1;
  const sourceIn = clip.range.sourceInSec;
  const sourceOut = clip.range.sourceOutSec;
  const timelineIn = clip.place.timelineInSec;

  const mapped: TranscriptionSegmentInput[] = [];
  let skippedOutOfRangeCount = 0;

  for (const segment of segments) {
    // Drop segments whose source window falls entirely outside the clip range.
    if (segment.startTime < sourceIn || segment.startTime >= sourceOut) {
      skippedOutOfRangeCount += 1;
      continue;
    }

    const startSource = segment.startTime;
    const endSource = Math.min(segment.endTime, sourceOut);
    if (!(endSource > startSource)) {
      skippedOutOfRangeCount += 1;
      continue;
    }

    const toTimeline = (sourceSec: number): number =>
      clip.reverse
        ? timelineIn + (sourceOut - sourceSec) / safeSpeed
        : timelineIn + (sourceSec - sourceIn) / safeSpeed;

    const startTimeline = clip.reverse ? toTimeline(endSource) : toTimeline(startSource);
    const endTimeline = clip.reverse ? toTimeline(startSource) : toTimeline(endSource);

    if (!(endTimeline > startTimeline)) {
      skippedOutOfRangeCount += 1;
      continue;
    }

    mapped.push({
      startTime: startTimeline,
      endTime: endTimeline,
      text: segment.text,
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
      ...(segment.language ? { language: segment.language } : {}),
    });
  }

  return { segments: mapped, skippedOutOfRangeCount };
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
  clipId?: string,
  style?: Record<string, unknown>,
  position?: CaptionPosition,
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

  // When clipId is provided, segment times are SOURCE-relative to the clip's
  // asset and must be mapped to timeline time before any further handling.
  // Without clipId, times are assumed to be timeline-relative (passthrough).
  let workingSegments = segments;
  let mappingSkippedCount = 0;
  if (clipId !== undefined) {
    const sequence = getSequence(sequenceId);
    if (!sequence) {
      throw new Error(`Sequence '${sequenceId}' not found`);
    }

    const clip = findClipInSequence(sequence, clipId);
    if (!clip) {
      throw new Error(`Clip '${clipId}' not found in sequence '${sequenceId}'`);
    }

    if (hasActiveTimeRemap(clip)) {
      throw new Error(
        `Clip '${clipId}' has an active time remap curve, so source times cannot be mapped with a constant-speed formula. ` +
          'Use auto_transcribe_sequence to obtain timeline-relative segments instead.',
      );
    }

    const mappingResult = mapSourceSegmentsToTimeline(segments, clip);
    if (mappingResult.segments.length === 0) {
      throw new Error(
        `No transcription segments fall within clip '${clipId}' source range. ` +
          'Verify the segments belong to this clip, or use auto_transcribe_sequence for timeline-relative segments.',
      );
    }

    workingSegments = mappingResult.segments;
    mappingSkippedCount = mappingResult.skippedOutOfRangeCount;
  }

  const normalizedSegments = normalizeTranscriptionSegments(workingSegments);
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
      // Optional style/position passthrough. The Rust ImportGeneratedCaptions
      // command applies these to every imported caption when present.
      ...(style ? { style } : {}),
      ...(position ? { position } : {}),
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
      skippedSegmentCount: normalizedSegments.skippedCount + mappingSkippedCount,
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
    description:
      'Change caption visual style metadata. Keep captions readable: high contrast (light text with a dark outline), ' +
      'about 32-42 characters per line, and at least ~1.5s of on-screen time per caption.',
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
            'Caption position preset. "bottom" places the caption in the standard subtitle safe area ' +
            '(5% margin from the bottom edge), "top" uses a 5% margin from the top edge, and "center" ' +
            'is vertically centered. The resolved point is the CENTER of the caption box, so the text ' +
            'stays inside the safe margin. Use xPercent and yPercent for custom placement instead.',
          enum: ['top', 'center', 'bottom'],
        },
        xPercent: {
          type: 'number',
          description:
            'Custom caption X position in percent (0-100, origin top-left). This marks the horizontal ' +
            'center of the caption box for center alignment (left/right alignment anchors the matching edge).',
        },
        yPercent: {
          type: 'number',
          description:
            'Custom caption Y position in percent (0-100, origin top-left). This marks the vertical ' +
            'center of the caption box. Preview and exported render use the same center anchor.',
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
    name: 'get_caption_style',
    description:
      'Read the caption track default style/position and an existing caption\'s style/position so new or appended ' +
      'captions can match the current look. Call this before styling or importing captions to keep them consistent.',
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
          description: 'Optional caption track ID (auto-resolves to a caption track when omitted)',
        },
        captionId: {
          type: 'string',
          description:
            'Optional caption ID to read. When omitted, the first caption on the track is used as the reference.',
        },
      },
      required: ['sequenceId'],
    },
    handler: async (args) => {
      try {
        const sequenceId = args.sequenceId as string;
        const captionId = args.captionId as string | undefined;

        const sequence = getSequence(sequenceId);
        if (!sequence) {
          return { success: false, error: `Sequence '${sequenceId}' not found` };
        }

        // Resolve the caption track. resolveCaptionTrackId handles explicit
        // trackId, lookup-by-caption, and first-caption-track fallback.
        const trackId = resolveCaptionTrackId(
          sequence,
          captionId ?? '',
          args.trackId as string | undefined,
        );
        if (!trackId) {
          return {
            success: false,
            error: `Could not resolve a caption track in sequence '${sequenceId}'.`,
          };
        }

        const track = sequence.tracks.find((candidate) => candidate.id === trackId);
        if (!track) {
          return { success: false, error: `Caption track '${trackId}' not found` };
        }

        // The frontend project store track does not carry the persisted
        // CaptionTrack defaultStyle/defaultPosition (those live on the core
        // CaptionTrack model). Surface the canonical defaults the engine uses
        // when no override is set, so the agent has a reliable baseline.
        const trackDefaultStyle: CaptionStyle = DEFAULT_CAPTION_STYLE;
        const trackDefaultPosition: CaptionPosition = DEFAULT_CAPTION_POSITION;

        // Pick the reference caption: the named one, else the first on the track.
        const referenceCaption: Clip | undefined = captionId
          ? track.clips.find((clip) => clip.id === captionId)
          : track.clips[0];

        if (captionId && !referenceCaption) {
          return {
            success: false,
            error: `Caption '${captionId}' not found on track '${trackId}'.`,
          };
        }

        const existingCaption = referenceCaption
          ? {
              captionId: referenceCaption.id,
              text: referenceCaption.label ?? '',
              // Per-clip overrides (undefined means the track default applies).
              styleOverride: referenceCaption.captionStyle,
              positionOverride: referenceCaption.captionPosition,
            }
          : null;

        return {
          success: true,
          result: {
            sequenceId,
            trackId,
            language: track.captionLanguage,
            // Track-level defaults are the canonical engine defaults; the
            // frontend store does not expose the persisted per-track defaults.
            trackDefaultStyle,
            trackDefaultPosition,
            trackDefaultsAreCanonical: true,
            existingCaption,
            captionCount: track.clips.length,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_caption_style failed', { error: message });
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
          enum: [
            'tiny',
            'base',
            'small',
            'medium',
            'large',
            'large-v3',
            'large-v3-turbo',
            'large-v3-q5_0',
            'large-v3-turbo-q8_0',
            'large-v3-turbo-q5_0',
          ],
          description: 'Whisper model to install (default: large-v3-turbo-q5_0)',
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
          description:
            'Optional BCP-47 language code (e.g. "ko", "en", "ja"). Leave unset for automatic ' +
            'detection (the engine performs robust multi-window detection). Provide it only if the ' +
            'user explicitly states the spoken language and wants to override auto-detection.',
        },
        model: {
          type: 'string',
          enum: [
            'auto',
            'tiny',
            'base',
            'small',
            'medium',
            'large',
            'large-v3',
            'large-v3-turbo',
            'large-v3-q5_0',
            'large-v3-turbo-q8_0',
            'large-v3-turbo-q5_0',
          ],
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
        let transcriptionStatus: TranscriptionStatusDto | null = null;
        try {
          const status = await commands.getTranscriptionStatus();
          if (status.status === 'ok') {
            transcriptionStatus = status.data;
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

        // Resolve the model the engine would use, then HARD-enforce provisioning
        // of the recommended high-accuracy model when the resolved default is
        // weak and the caller did not deliberately pick a model. This downloads
        // the recommended model first when missing (independent of LLM prompt
        // compliance) so weak models never silently transcribe non-English/sung
        // audio. An explicit caller choice is always honored as-is.
        const requestedModel = normalizeWhisperModelArg(args.model, defaultModel);
        const explicitModelChosen = callerSelectedExplicitModel(args.model);
        let provisioning: ModelProvisioningResult = {
          model: requestedModel,
          autoInstalledModel: null,
          warning: null,
        };
        if (transcriptionStatus) {
          provisioning = await provisionRecommendedModel(
            transcriptionStatus,
            requestedModel,
            explicitModelChosen,
          );
        }
        const effectiveModel = provisioning.model;
        if (effectiveModel) {
          // Only enforce the installed-model guard for caller-chosen models. An
          // auto-provisioned model was just downloaded (or confirmed installed),
          // so the stale `installedModels` snapshot must not block it.
          if (
            explicitModelChosen &&
            installedModels.length > 0 &&
            !installedModels.includes(effectiveModel)
          ) {
            return {
              success: false,
              error: `Whisper model '${effectiveModel}' is not installed. Use transcription_status to inspect models or install_whisper_model after user approval.`,
            };
          }
          options.model = effectiveModel;
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

        // Surface a consolidated, non-fatal model-quality notice as a fallback
        // signal. The provisioning above is the real fix; this still warns when
        // the actually-used model is weak (e.g. recommended download failed).
        const qualityNotice = transcriptionStatus
          ? buildModelQualityNotice(transcriptionStatus, effectiveModel)
          : { warning: buildWeakModelWarning(effectiveModel) };

        // Prefer the provisioning warning (download failed) over the generic
        // quality notice so the agent gets the most actionable message.
        const combinedWarning = provisioning.warning ?? qualityNotice.warning;

        return {
          success: true,
          result: {
            mode: 'sync',
            model: effectiveModel,
            language: result.language,
            segments: result.segments,
            segmentCount: result.segments.length,
            duration: result.duration,
            fullText: result.fullText,
            ...(provisioning.autoInstalledModel
              ? { autoInstalledModel: provisioning.autoInstalledModel }
              : {}),
            ...(transcriptionStatus
              ? {
                  recommendedModel: (qualityNotice as ModelQualityNotice).recommendedModel,
                  recommendedInstalled: (qualityNotice as ModelQualityNotice).recommendedInstalled,
                }
              : {}),
            ...(combinedWarning ? { warning: combinedWarning } : {}),
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
          description:
            'Optional BCP-47 language code (e.g. "ko", "en", "ja"). Leave unset for automatic ' +
            'detection (the engine performs robust multi-window detection). Provide it only if the ' +
            'user explicitly states the spoken language and wants to override auto-detection.',
        },
        model: {
          type: 'string',
          enum: [
            'auto',
            'tiny',
            'base',
            'small',
            'medium',
            'large',
            'large-v3',
            'large-v3-turbo',
            'large-v3-q5_0',
            'large-v3-turbo-q8_0',
            'large-v3-turbo-q5_0',
          ],
          description: 'Installed Whisper model size (default: best installed model)',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        let defaultModel = 'large-v3-turbo';
        let installedModels: string[] = [];
        let transcriptionStatus: TranscriptionStatusDto | null = null;
        try {
          const status = await commands.getTranscriptionStatus();
          if (status.status === 'ok') {
            transcriptionStatus = status.data;
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

        // Resolve the model the engine would use, then HARD-enforce provisioning
        // of the recommended high-accuracy model when the resolved default is
        // weak and the caller did not deliberately pick a model (see
        // provisionRecommendedModel). Honors an explicit caller choice as-is.
        const requestedModel = normalizeWhisperModelArg(args.model, defaultModel);
        const explicitModelChosen = callerSelectedExplicitModel(args.model);
        let provisioning: ModelProvisioningResult = {
          model: requestedModel,
          autoInstalledModel: null,
          warning: null,
        };
        if (transcriptionStatus) {
          provisioning = await provisionRecommendedModel(
            transcriptionStatus,
            requestedModel,
            explicitModelChosen,
          );
        }
        const model = provisioning.model;

        // Only block on the stale installed-model snapshot for caller-chosen
        // models; an auto-provisioned model was just downloaded or confirmed.
        if (
          explicitModelChosen &&
          installedModels.length > 0 &&
          !installedModels.includes(model)
        ) {
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

        // Surface a consolidated, non-fatal model-quality notice as a fallback
        // signal. The provisioning above is the real fix; this still warns when
        // the actually-used model is weak (e.g. recommended download failed).
        const qualityNotice = transcriptionStatus
          ? buildModelQualityNotice(transcriptionStatus, model)
          : { warning: buildWeakModelWarning(model) };

        // Prefer the provisioning warning (download failed) over the generic
        // quality notice so the agent gets the most actionable message.
        const combinedWarning = provisioning.warning ?? qualityNotice.warning;

        return {
          success: true,
          result: {
            mode: 'sequence',
            model,
            language: result.data.language,
            segments: result.data.segments,
            segmentCount: result.data.segments.length,
            duration: result.data.duration,
            fullText: result.data.fullText,
            ...(provisioning.autoInstalledModel
              ? { autoInstalledModel: provisioning.autoInstalledModel }
              : {}),
            ...(transcriptionStatus
              ? {
                  recommendedModel: (qualityNotice as ModelQualityNotice).recommendedModel,
                  recommendedInstalled: (qualityNotice as ModelQualityNotice).recommendedInstalled,
                }
              : {}),
            ...(combinedWarning ? { warning: combinedWarning } : {}),
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
        clipId: {
          type: 'string',
          description:
            "When provided, segment times are treated as SOURCE-relative to this clip's asset and mapped to timeline time. " +
            'Required to safely import source-asset transcription (auto_transcribe); omit when segments are already timeline-relative (auto_transcribe_sequence).',
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
        style: {
          type: 'object',
          description:
            'Optional caption style applied to every imported caption (matches the style_caption / track default style shape). Omit to use the track default for consistency.',
        },
        position: {
          type: ['string', 'object'],
          description:
            'Optional caption position applied to every imported caption: preset (top, center, bottom) or ' +
            '{ type: "custom", xPercent, yPercent }. Percentages are 0-100 with origin at the top-left; the ' +
            'resolved point is the center of the caption box. The "bottom" preset uses the 5% subtitle safe ' +
            'area. Omit to use the track default.',
        },
      },
      required: ['sequenceId', 'segments'],
    },
    handler: async (args) => {
      try {
        let position: CaptionPosition | undefined;
        if (args.position !== undefined) {
          position = parseAgentCaptionPosition(args.position);
          if (!position) {
            return {
              success: false,
              error: `Invalid caption position '${String(args.position)}'. Use top, center, bottom, or { type: "custom", xPercent, yPercent }.`,
            };
          }
        }

        const result = await createCaptionsFromSegments(
          args.sequenceId as string,
          args.segments as TranscriptionSegmentInput[],
          args.trackId as string | undefined,
          args.replaceExisting === true,
          args.language as string | undefined,
          args.clipId as string | undefined,
          args.style as Record<string, unknown> | undefined,
          position,
        );

        logger.info('Captions created from transcription', {
          sequenceId: args.sequenceId,
          trackId: result.trackId,
          clipId: args.clipId,
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

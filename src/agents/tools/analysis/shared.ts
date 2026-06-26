/**
 * Analysis Tools - Shared Foundation
 *
 * Cross-cutting types and utility helpers used by multiple analysis submodules.
 * Behavior-preserving extraction from analysisTools.ts.
 */

import type { AnalysisBundle, AnalysisOptions, ClipPerceptionOptions } from '@/bindings';

export type ClipAnalysisMode = 'representative' | 'dense';

export interface ClipAnalysisOptionsPayload {
  mode: ClipAnalysisMode;
  targetIntervalSec?: number;
  maxSamples?: number;
  includeEdges: boolean;
  rangeStartSec?: number;
  rangeEndSec?: number;
  forceRefresh: boolean;
}

export interface ClipAnalysisQualityLike {
  status?: string;
  score?: number;
}

export interface ClipAnalysisBundleLike {
  fingerprint: string;
  sequenceId: string;
  trackId: string;
  clipId: string;
  assetId: string;
  assetName?: string;
  quality?: ClipAnalysisQualityLike;
  samplePolicy?: Record<string, unknown>;
  mapping?: unknown[];
  samples?: Array<{ extractionStatus?: string; imagePath?: string }>;
  windows?: unknown[];
  errors?: string[];
  analyzedAt?: string;
}

export interface ClipAnalysisResponseLike {
  source: 'cached' | 'generated';
  bundle: ClipAnalysisBundleLike;
}

export type ClipPerceptionDetail = NonNullable<ClipPerceptionOptions['detail']>;

export interface ClipSemanticObservationLike {
  sampleId?: string;
  timelineSec?: number;
  sourceSec?: number;
  frameIndex?: number | null;
  imagePath?: string;
  description?: string;
  subjects?: string[];
  actions?: string[];
  visibleText?: string[];
  objects?: string[];
  setting?: string | null;
  editUsefulness?: string | null;
  confidence?: number;
  evidenceSource?: string;
  provider?: {
    provider?: string;
    model?: string;
    analyzedAt?: string;
  };
}

export type TimedRange = {
  startSec: number;
  endSec: number;
};

export type TimedPoint = {
  timeSec: number;
};

export type TranscriptLikeSegment = TimedRange & {
  text: string;
  speakerId?: string | null;
  speakerTurnId?: string | null;
};

export type FrameObservationLike = NonNullable<AnalysisBundle['frameObservations']>[number];

export type SegmentLike = TimedRange & {
  segmentType: string;
  confidence?: number;
};

export function readNestedOptions(args: Record<string, unknown>): Record<string, unknown> {
  return args.options && typeof args.options === 'object' && !Array.isArray(args.options)
    ? (args.options as Record<string, unknown>)
    : {};
}

export function resolveAnalysisOptions(args: Record<string, unknown>): AnalysisOptions {
  const nestedOptions = readNestedOptions(args);

  const readFlag = (key: keyof AnalysisOptions, fallback: boolean): boolean => {
    const value = nestedOptions[key] ?? args[key];
    return typeof value === 'boolean' ? value : fallback;
  };

  return {
    shots: readFlag('shots', true),
    transcript: readFlag('transcript', true),
    audio: readFlag('audio', true),
    segments: readFlag('segments', true),
    visual: readFlag('visual', true),
    localOnly: readFlag('localOnly', false),
  };
}

export function readOptionalNumber(
  args: Record<string, unknown>,
  nestedOptions: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = nestedOptions[key] ?? args[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

export function readOptionalBoolean(
  args: Record<string, unknown>,
  nestedOptions: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = nestedOptions[key] ?? args[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function readOptionalString(
  args: Record<string, unknown>,
  nestedOptions: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = nestedOptions[key] ?? args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function hasValue<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

export function roundTo(value: number | null | undefined, digits = 2): number | null {
  const numericValue = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (numericValue === null) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(numericValue * factor) / factor;
}

export function formatDurationLabel(durationSec: number | null | undefined): string {
  const numericDuration =
    typeof durationSec === 'number' && Number.isFinite(durationSec) ? durationSec : null;
  if (numericDuration === null || numericDuration < 0) {
    return 'unknown';
  }

  const totalSeconds = Math.round(numericDuration);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function formatTimecode(timeSec: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeSec));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function overlapDuration(
  leftStartSec: number,
  leftEndSec: number,
  rightStartSec: number,
  rightEndSec: number,
): number {
  return Math.max(0, Math.min(leftEndSec, rightEndSec) - Math.max(leftStartSec, rightStartSec));
}

export function countOverlappingRanges(
  ranges: TimedRange[],
  startSec: number,
  endSec: number,
): number {
  return ranges.filter(
    (range) => overlapDuration(range.startSec, range.endSec, startSec, endSec) > 0,
  ).length;
}

export function countTimedPointsInRange(
  points: TimedPoint[],
  startSec: number,
  endSec: number,
): number {
  return points.filter((point) => point.timeSec >= startSec && point.timeSec <= endSec).length;
}

export function deriveSpeechRegions(
  audioProfile:
    | {
        speechRegions?: TimedRange[] | null;
        silenceRegions?: TimedRange[] | null;
      }
    | null
    | undefined,
  durationSec: number,
): TimedRange[] {
  const explicitSpeechRegions = audioProfile?.speechRegions ?? [];
  if (explicitSpeechRegions.length > 0) {
    return explicitSpeechRegions;
  }

  const silenceRegions = [...(audioProfile?.silenceRegions ?? [])]
    .filter((region) => region.endSec > region.startSec)
    .sort((left, right) => left.startSec - right.startSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return [];
  }

  const speechRegions: TimedRange[] = [];
  let cursorSec = 0;

  for (const region of silenceRegions) {
    const startSec = Math.max(0, Math.min(region.startSec, durationSec));
    const endSec = Math.max(startSec, Math.min(region.endSec, durationSec));
    if (startSec > cursorSec) {
      speechRegions.push({ startSec: cursorSec, endSec: startSec });
    }
    cursorSec = Math.max(cursorSec, endSec);
  }

  if (cursorSec < durationSec) {
    speechRegions.push({ startSec: cursorSec, endSec: durationSec });
  }

  return speechRegions;
}

export function sumOverlapDuration(ranges: TimedRange[], startSec: number, endSec: number): number {
  return ranges.reduce(
    (sum, range) => sum + overlapDuration(range.startSec, range.endSec, startSec, endSec),
    0,
  );
}

export function buildAudioCue(
  speechRegions: TimedRange[],
  silenceRegions: TimedRange[],
  startSec: number,
  endSec: number,
): string | null {
  const windowDurationSec = Math.max(0, endSec - startSec);
  if (windowDurationSec <= 0) {
    return null;
  }

  const speechDurationSec = sumOverlapDuration(speechRegions, startSec, endSec);
  const silenceDurationSec = sumOverlapDuration(silenceRegions, startSec, endSec);
  const speechShare = speechDurationSec / windowDurationSec;
  const silenceShare = silenceDurationSec / windowDurationSec;

  if (speechShare >= 0.75) {
    return 'speech-heavy';
  }

  if (silenceShare >= 0.5) {
    return 'long pause';
  }

  if (speechShare > 0.15) {
    return 'spoken content';
  }

  if (silenceShare > 0.15) {
    return 'quiet gap';
  }

  return null;
}

export function uniqueStrings(
  values: Array<string | null | undefined>,
  limit = Number.POSITIVE_INFINITY,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalized = normalizeText(value);
    if (!normalized) {
      continue;
    }

    const lookup = normalized.toLowerCase();
    if (seen.has(lookup)) {
      continue;
    }

    seen.add(lookup);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

export function formatNaturalList(values: string[], limit = 3): string {
  const unique = uniqueStrings(values, limit);
  if (unique.length === 0) {
    return '';
  }

  if (unique.length === 1) {
    return unique[0];
  }

  if (unique.length === 2) {
    return `${unique[0]} and ${unique[1]}`;
  }

  return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}

export function ensureSentence(text: string | null | undefined): string | null {
  const normalized = typeof text === 'string' ? normalizeText(text) : '';
  if (!normalized) {
    return null;
  }

  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

export function quoteSnippet(text: string | null | undefined, maxLength = 96): string | null {
  const normalized = typeof text === 'string' ? normalizeText(text) : '';
  if (!normalized) {
    return null;
  }

  const excerpt =
    normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  return `"${excerpt}"`;
}

export function normalizeLookupValues(values: Array<string | null | undefined>): string[] {
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean);
}

export function includesAnyLookupValue(values: string[], keywords: string[]): boolean {
  return values.some((value) => keywords.some((keyword) => value.includes(keyword)));
}

export function humanizeSegmentType(segmentType: string | null | undefined): string | null {
  switch (segmentType) {
    case 'talk':
      return 'spoken dialogue or presentation';
    case 'performance':
      return 'performance or music-led section';
    case 'reaction':
      return 'reaction or cutaway section';
    case 'transition':
      return 'transition section';
    case 'establishing':
      return 'establishing scene';
    case 'montage':
      return 'montage sequence';
    default:
      return segmentType ? `${segmentType} section` : null;
  }
}

export function collectTopCounts(
  values: Iterable<string | null | undefined>,
  limit = 5,
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();

  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalized = value.trim();
    if (!normalized) {
      continue;
    }

    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

export function buildTranscriptExcerpt(
  segments: Array<{ text: string }>,
  maxLength = 240,
): string | null {
  const joined = segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!joined) {
    return null;
  }

  if (joined.length <= maxLength) {
    return joined;
  }

  return `${joined.slice(0, maxLength - 3).trimEnd()}...`;
}

export function buildFullTranscriptText(segments: Array<{ text: string }>): string | null {
  const joined = segments
    .map((segment) => normalizeText(segment.text))
    .filter(Boolean)
    .join(' ')
    .trim();

  return joined.length > 0 ? joined : null;
}

export function buildTranscriptLines(
  segments: Array<
    TranscriptLikeSegment & {
      confidence?: number | null;
      language?: string | null;
    }
  >,
): Array<{
  index: number;
  startSec: number;
  endSec: number;
  speakerId: string | null;
  speakerTurnId: string | null;
  language: string | null;
  confidence: number | null;
  text: string;
}> {
  return segments.map((segment, index) => ({
    index,
    startSec: roundTo(segment.startSec) ?? 0,
    endSec: roundTo(segment.endSec) ?? 0,
    speakerId: segment.speakerId ?? null,
    speakerTurnId: segment.speakerTurnId ?? null,
    language:
      typeof segment.language === 'string' && segment.language.length > 0 ? segment.language : null,
    confidence: roundTo(segment.confidence, 3),
    text: normalizeText(segment.text),
  }));
}

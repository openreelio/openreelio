/**
 * Analysis Tools
 *
 * Timeline analysis tools for the AI agent system.
 * Provides read-only operations to query timeline state.
 *
 * These tools read from Zustand stores (frontend state) instead of calling
 * backend IPC handlers. The data is already available in projectStore,
 * timelineStore, and playbackStore.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { getToolOutputContract } from '../toolOutputContracts';
import { createLogger } from '@/services/logger';
import { invoke } from '@tauri-apps/api/core';
import type {
  AnalysisBundle,
  AnalysisOptions,
  AssetAnnotation,
  EditingStyleDocument,
  EsdSummary,
  GetAnnotationResponse,
} from '@/bindings';
import {
  getAssetCatalogSnapshot,
  getAssetSnapshotById,
  getUnusedAssets,
  getTimelineSnapshot,
  getClipById,
  getTrackById,
  getAllClipsOnTrack,
  getClipsAtTime,
  findClipsByAsset,
  findGaps,
  findOverlaps,
  getWorkspaceFiles,
  getUnregisteredWorkspaceFiles,
  findWorkspaceFile,
} from './storeAccessor';
import { calculatePearsonCorrelation, getPrimaryTrackClips } from '@/utils/referenceComparison';
import { getClipTimelineEndSec } from '@/utils/clipTiming';
import { useProjectStore } from '@/stores/projectStore';
import { executeAgentCommand } from './commandExecutor';
import {
  readWorkspaceDocumentFromBackend,
  writeWorkspaceDocumentToBackend,
} from '@/services/workspaceGateway';
import { resolveWorkspaceAsset } from './mediaAnalysisTools';

const logger = createLogger('AnalysisTools');

function resolveAnalysisOptions(args: Record<string, unknown>): AnalysisOptions {
  const nestedOptions =
    args.options && typeof args.options === 'object' && !Array.isArray(args.options)
      ? (args.options as Record<string, unknown>)
      : {};

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

async function findExistingEsdForAsset(assetId: string): Promise<EditingStyleDocument | null> {
  try {
    const summaries = await invoke<EsdSummary[]>('list_esds');
    const latestSummary = summaries
      .filter((summary) => summary.sourceAssetId === assetId)
      .sort((left, right) => {
        const leftTime = Date.parse(left.createdAt);
        const rightTime = Date.parse(right.createdAt);

        if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
          return right.createdAt.localeCompare(left.createdAt);
        }

        return rightTime - leftTime;
      })[0];

    if (!latestSummary) {
      return null;
    }

    return await invoke<EditingStyleDocument | null>('get_esd', {
      esdId: latestSummary.id,
    });
  } catch (error) {
    logger.warn('Unable to reuse existing style document; falling back to regeneration', {
      assetId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function buildStyleDocumentResult(
  esd: EditingStyleDocument,
  analysisSource: 'cached' | 'generated' | 'existing_esd',
): {
  esdId: string;
  name: string;
  assetId: string;
  analysisSource: 'cached' | 'generated' | 'existing_esd';
  tempoClassification: string;
  shotCount: number;
  pacingPointCount: number;
  summary: string;
} {
  const reuseNotice =
    analysisSource === 'existing_esd' ? ' Reused the latest existing ESD for this asset.' : '';

  return {
    esdId: esd.id,
    name: esd.name,
    assetId: esd.sourceAssetId,
    analysisSource,
    tempoClassification: esd.rhythmProfile.tempoClassification,
    shotCount: esd.rhythmProfile.shotDurations.length,
    pacingPointCount: esd.pacingCurve.length,
    summary: `Created ESD "${esd.name}" - ${esd.rhythmProfile.tempoClassification} tempo, ${esd.rhythmProfile.shotDurations.length} shots.${reuseNotice}`,
  };
}

function hasValue<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function roundTo(value: number | null | undefined, digits = 2): number | null {
  const numericValue = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (numericValue === null) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(numericValue * factor) / factor;
}

function formatDurationLabel(durationSec: number | null | undefined): string {
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

function collectTopCounts(
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

function buildTranscriptExcerpt(segments: Array<{ text: string }>, maxLength = 240): string | null {
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

function buildFullTranscriptText(segments: Array<{ text: string }>): string | null {
  const joined = segments
    .map((segment) => normalizeText(segment.text))
    .filter(Boolean)
    .join(' ')
    .trim();

  return joined.length > 0 ? joined : null;
}

function buildTranscriptLines(
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

type TimedRange = {
  startSec: number;
  endSec: number;
};

type TimedPoint = {
  timeSec: number;
};

type TranscriptLikeSegment = TimedRange & {
  text: string;
  speakerId?: string | null;
  speakerTurnId?: string | null;
};

type FrameObservationLike = NonNullable<AnalysisBundle['frameObservations']>[number];

type SegmentLike = TimedRange & {
  segmentType: string;
  confidence?: number;
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function formatTimecode(timeSec: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeSec));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function overlapDuration(
  leftStartSec: number,
  leftEndSec: number,
  rightStartSec: number,
  rightEndSec: number,
): number {
  return Math.max(0, Math.min(leftEndSec, rightEndSec) - Math.max(leftStartSec, rightStartSec));
}

function countOverlappingRanges(ranges: TimedRange[], startSec: number, endSec: number): number {
  return ranges.filter(
    (range) => overlapDuration(range.startSec, range.endSec, startSec, endSec) > 0,
  ).length;
}

function countTimedPointsInRange(points: TimedPoint[], startSec: number, endSec: number): number {
  return points.filter((point) => point.timeSec >= startSec && point.timeSec <= endSec).length;
}

function deriveSpeechRegions(
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

function sumOverlapDuration(ranges: TimedRange[], startSec: number, endSec: number): number {
  return ranges.reduce(
    (sum, range) => sum + overlapDuration(range.startSec, range.endSec, startSec, endSec),
    0,
  );
}

function buildAudioCue(
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

function uniqueStrings(
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

function formatNaturalList(values: string[], limit = 3): string {
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

function ensureSentence(text: string | null | undefined): string | null {
  const normalized = typeof text === 'string' ? normalizeText(text) : '';
  if (!normalized) {
    return null;
  }

  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function quoteSnippet(text: string | null | undefined, maxLength = 96): string | null {
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

function normalizeLookupValues(values: Array<string | null | undefined>): string[] {
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean);
}

function includesAnyLookupValue(values: string[], keywords: string[]): boolean {
  return values.some((value) => keywords.some((keyword) => value.includes(keyword)));
}

function humanizeSegmentType(segmentType: string | null | undefined): string | null {
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

function buildPeopleSummary(args: {
  topObjectLabels: string[];
  faceDetections: Array<{ faceId?: string | null; emotions?: string[] }>;
}): string | null {
  const objectLookups = normalizeLookupValues(args.topObjectLabels);
  const distinctFaceIds = uniqueStrings(args.faceDetections.map((entry) => entry.faceId ?? null));
  const emotionCues = uniqueStrings(
    args.faceDetections.flatMap((entry) => entry.emotions ?? []).map((emotion) => emotion),
    2,
  );
  const hasAudienceCue = includesAnyLookupValue(objectLookups, ['audience', 'crowd', 'spectator']);
  const hasPersonCue = includesAnyLookupValue(objectLookups, [
    'person',
    'people',
    'speaker',
    'singer',
    'performer',
    'man',
    'woman',
    'child',
    'host',
  ]);
  const parts: string[] = [];

  if (hasAudienceCue) {
    parts.push('a crowd or audience is visible');
  }

  if (distinctFaceIds.length > 1) {
    parts.push(`${distinctFaceIds.length} recurring faces are visible`);
  } else if (distinctFaceIds.length === 1) {
    parts.push('at least one recurring face is visible');
  } else if (args.faceDetections.length > 1) {
    parts.push('one or more faces are visible');
  } else if (args.faceDetections.length === 1) {
    parts.push('at least one face is visible');
  } else if (hasPersonCue) {
    parts.push('a person is visible on screen');
  }

  if (emotionCues.length > 0 && args.faceDetections.length > 0) {
    parts.push(`facial emotion cues include ${formatNaturalList(emotionCues, 2)}`);
  }

  return parts.length > 0 ? parts.slice(0, 2).join('; ') : null;
}

function buildTextSummary(ocrTexts: string[]): string | null {
  const uniqueTexts = uniqueStrings(ocrTexts, 3);
  if (uniqueTexts.length === 0) {
    return null;
  }

  if (uniqueTexts.length === 1) {
    return `on-screen text reads ${quoteSnippet(uniqueTexts[0], 80)}`;
  }

  return `on-screen text includes ${uniqueTexts
    .map((text) => quoteSnippet(text, 48))
    .filter((value): value is string => Boolean(value))
    .join(', ')}`;
}

function buildVisualCueSummary(args: {
  cameraAngle?: string | null;
  subjectPosition?: string | null;
  motionDirection?: string | null;
  visualComplexity?: number | null;
}): string | null {
  const parts: string[] = [];

  if (args.cameraAngle && args.cameraAngle !== 'unknown') {
    parts.push(`${args.cameraAngle} framing`);
  }

  if (args.subjectPosition && args.subjectPosition !== 'unknown') {
    parts.push(`${args.subjectPosition} subject placement`);
  }

  if (args.motionDirection && args.motionDirection !== 'unknown') {
    parts.push(
      args.motionDirection === 'static' ? 'mostly static camera' : `${args.motionDirection} motion`,
    );
  }

  if (typeof args.visualComplexity === 'number' && Number.isFinite(args.visualComplexity)) {
    if (args.visualComplexity >= 0.7) {
      parts.push('visually busy frame');
    } else if (args.visualComplexity <= 0.25) {
      parts.push('simple, uncluttered frame');
    }
  }

  return parts.length > 0 ? parts.join(', ') : null;
}

function deriveSettingHints(args: {
  dominantSegmentType: string | null;
  topObjectLabels: string[];
  ocrTexts: string[];
  transcriptExcerpt: string | null;
  visualCueSummary: string | null;
}): string[] {
  const lookups = normalizeLookupValues([
    ...args.topObjectLabels,
    ...args.ocrTexts,
    args.transcriptExcerpt,
    args.visualCueSummary,
  ]);
  const hints: string[] = [];

  if (
    args.dominantSegmentType === 'performance' ||
    includesAnyLookupValue(lookups, [
      'microphone',
      'stage',
      'concert',
      'audience',
      'crowd',
      'guitar',
      'drum',
      'performer',
      'podium',
      'live',
    ])
  ) {
    hints.push('stage or live event setting');
  }

  if (
    args.dominantSegmentType === 'talk' &&
    (includesAnyLookupValue(lookups, [
      'office',
      'desk',
      'computer',
      'monitor',
      'presentation',
      'podium',
      'studio',
      'host',
      'interview',
    ]) ||
      lookups.some((value) => value.includes('center') || value.includes('static')))
  ) {
    hints.push('interview, presentation, or studio-style setup');
  }

  if (
    includesAnyLookupValue(lookups, [
      'tree',
      'sky',
      'road',
      'street',
      'car',
      'mountain',
      'grass',
      'water',
      'outdoor',
      'nature',
    ])
  ) {
    hints.push('outdoor or location-based setting');
  }

  if (
    args.ocrTexts.length >= 2 ||
    includesAnyLookupValue(lookups, ['screen', 'display', 'monitor', 'phone', 'tablet', 'sign'])
  ) {
    hints.push('screen, signage, or graphic-led frame');
  }

  if (includesAnyLookupValue(lookups, ['sofa', 'couch', 'bed', 'kitchen', 'room', 'table'])) {
    hints.push('indoor room or home-like setting');
  }

  if (args.dominantSegmentType === 'establishing' || args.dominantSegmentType === 'montage') {
    hints.push('environment or b-roll coverage');
  }

  return uniqueStrings(hints, 2);
}

function buildAudioSummary(args: {
  dominantSegmentType: string | null;
  transcriptExcerpt: string | null;
  audioCue: string | null;
  speakerIds: string[];
}): string | null {
  const quotedExcerpt = quoteSnippet(args.transcriptExcerpt, 96);
  if (quotedExcerpt) {
    if (args.dominantSegmentType === 'performance') {
      return `audio suggests a performance, with lyrics or stage banter such as ${quotedExcerpt}`;
    }

    if (args.speakerIds.length === 1) {
      return `${args.speakerIds[0]} is heard saying ${quotedExcerpt}`;
    }

    return `spoken audio includes ${quotedExcerpt}`;
  }

  if (args.dominantSegmentType === 'performance') {
    return 'audio suggests music or a live performance';
  }

  if (args.audioCue === 'speech-heavy') {
    return 'continuous speech is present';
  }

  if (args.audioCue === 'spoken content') {
    return 'some spoken audio is present';
  }

  if (args.audioCue === 'long pause') {
    return 'the moment contains a noticeable quiet pause';
  }

  if (args.audioCue === 'quiet gap') {
    return 'there is a brief quiet gap in the audio';
  }

  return null;
}

function buildSceneLabel(args: {
  dominantSegmentType: string | null;
  transcriptExcerpt: string | null;
  topObjectLabels: string[];
  textSummary: string | null;
}): string {
  if (args.transcriptExcerpt && args.dominantSegmentType === 'performance') {
    return 'Performance moment';
  }

  if (args.transcriptExcerpt && args.dominantSegmentType === 'talk') {
    return 'Spoken moment';
  }

  if (args.transcriptExcerpt) {
    return 'Transcript-led moment';
  }

  if (args.textSummary) {
    return 'Text-led shot';
  }

  if (args.dominantSegmentType === 'establishing') {
    return 'Establishing shot';
  }

  if (args.dominantSegmentType === 'reaction') {
    return 'Reaction shot';
  }

  if (args.dominantSegmentType === 'performance') {
    return 'Performance moment';
  }

  if (args.dominantSegmentType === 'montage') {
    return 'Montage beat';
  }

  if (args.topObjectLabels.length > 0) {
    return `${args.topObjectLabels[0]}-led visual moment`;
  }

  return 'Visual moment';
}

function buildSemanticMomentSummary(args: {
  dominantSegmentType: string | null;
  transcriptExcerpt: string | null;
  topObjectLabels: string[];
  peopleSummary: string | null;
  audioSummary: string | null;
  textSummary: string | null;
  visualCueSummary: string | null;
  settingHints: string[];
}): string {
  const quotedExcerpt = quoteSnippet(args.transcriptExcerpt, 96);
  let primary = '';

  if (quotedExcerpt) {
    if (args.dominantSegmentType === 'performance') {
      primary = `Performance or stage moment with captured lyrics or banter: ${quotedExcerpt}`;
    } else if (args.dominantSegmentType === 'talk') {
      primary = `Spoken moment: ${quotedExcerpt}`;
    } else {
      primary = `Transcript indicates: ${quotedExcerpt}`;
    }
  } else if (args.dominantSegmentType === 'performance') {
    primary =
      args.topObjectLabels.length > 0
        ? `Performance-oriented moment featuring ${formatNaturalList(args.topObjectLabels, 3)}`
        : 'Performance-oriented moment';
  } else if (args.dominantSegmentType === 'reaction') {
    primary = 'Reaction or cutaway moment';
  } else if (args.dominantSegmentType === 'establishing') {
    primary = 'Establishing shot of the scene';
  } else if (args.dominantSegmentType === 'montage') {
    primary = 'Montage or quick-cut sequence';
  } else if (args.topObjectLabels.length > 0) {
    primary = `Visual moment featuring ${formatNaturalList(args.topObjectLabels, 3)}`;
  } else if (args.textSummary) {
    primary = 'Text-led shot with visible graphics or signage';
  } else {
    primary =
      humanizeSegmentType(args.dominantSegmentType) ?? 'Visual moment with limited semantic cues';
  }

  const sentences = [ensureSentence(primary)];

  if (args.peopleSummary) {
    sentences.push(ensureSentence(`People: ${args.peopleSummary}`));
  }

  if (!quotedExcerpt && args.audioSummary) {
    sentences.push(ensureSentence(`Audio: ${args.audioSummary}`));
  }

  if (args.textSummary) {
    sentences.push(ensureSentence(`Text: ${args.textSummary}`));
  }

  if (args.settingHints.length > 0) {
    sentences.push(ensureSentence(`Likely setting: ${formatNaturalList(args.settingHints, 2)}`));
  }

  if (args.visualCueSummary) {
    sentences.push(ensureSentence(`Framing: ${args.visualCueSummary}`));
  }

  return sentences.filter((value): value is string => Boolean(value)).join(' ');
}

function buildSourceReportChunks(report: SourceAnalysisReport): SourceReportChunk[] {
  return [
    ...report.moments.items.map((moment) => ({
      id: `${report.assetId}:moments:${moment.index}`,
      sectionType: 'moments' as const,
      sectionIndex: moment.index,
      startSec: moment.startSec,
      endSec: moment.endSec,
      searchText: [
        moment.sceneLabel,
        moment.summary,
        moment.transcriptExcerpt,
        moment.audioSummary,
        moment.peopleSummary,
        moment.textSummary,
        moment.visualSummary,
        moment.audioCue,
        moment.dominantSegmentType,
        moment.settingHints.join(' '),
        moment.topObjectLabels.join(' '),
        moment.ocrTextPreview.join(' '),
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' '),
      metadata: {
        preview: moment.summary,
        keyframePath: moment.keyframePath,
        audioCue: moment.audioCue,
        durationSec: moment.durationSec,
        dominantSegmentType: moment.dominantSegmentType,
        peopleSummary: moment.peopleSummary,
        textSummary: moment.textSummary,
        visualSummary: moment.visualSummary,
        settingHints: moment.settingHints,
        topObjectLabels: moment.topObjectLabels,
        ocrTextPreview: moment.ocrTextPreview,
      },
    })),
    ...report.chapters.items.map((chapter) => ({
      id: `${report.assetId}:chapters:${chapter.index}`,
      sectionType: 'chapters' as const,
      sectionIndex: chapter.index,
      startSec: chapter.startSec,
      endSec: chapter.endSec,
      searchText: [chapter.title, chapter.summary, chapter.dominantSegmentType]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' '),
      metadata: {
        preview: `${chapter.title} - ${chapter.summary}`,
        durationSec: chapter.durationSec,
        dominantSegmentType: chapter.dominantSegmentType,
      },
    })),
    ...report.highlights.items.map((highlight) => ({
      id: `${report.assetId}:highlights:${highlight.index}`,
      sectionType: 'highlights' as const,
      sectionIndex: highlight.index,
      startSec: highlight.startSec,
      endSec: highlight.endSec,
      searchText: [highlight.reason, highlight.quote]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' '),
      metadata: {
        preview: highlight.quote ?? highlight.reason,
        durationSec: roundTo(highlight.endSec - highlight.startSec) ?? 0,
      },
    })),
    ...report.speakerTurns.items.map((turn) => ({
      id: `${report.assetId}:speakerTurns:${turn.index}`,
      sectionType: 'speakerTurns' as const,
      sectionIndex: turn.index,
      startSec: turn.startSec,
      endSec: turn.endSec,
      searchText: [
        turn.label,
        turn.speakerId,
        turn.excerpt,
        turn.audioCue,
        turn.dominantSegmentType,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' '),
      metadata: {
        preview: `${turn.label} - ${turn.excerpt}`,
        audioCue: turn.audioCue,
        durationSec: turn.durationSec,
        speakerId: turn.speakerId,
        wordCount: turn.wordCount,
        segmentCount: turn.segmentCount,
        dominantSegmentType: turn.dominantSegmentType,
      },
    })),
    ...report.visual.items.map((item) => ({
      id: `${report.assetId}:visual:${item.shotIndex}`,
      sectionType: 'visual' as const,
      sectionIndex: item.shotIndex,
      startSec: item.startSec,
      endSec: item.endSec,
      searchText: [
        item.summary,
        item.cameraAngle,
        item.subjectPosition,
        item.motionDirection,
        `complexity ${item.visualComplexity}`,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' '),
      metadata: {
        preview: item.summary,
        keyframePath: item.keyframePath,
        durationSec: item.durationSec,
        cameraAngle: item.cameraAngle,
        subjectPosition: item.subjectPosition,
        motionDirection: item.motionDirection,
        visualComplexity: item.visualComplexity,
      },
    })),
    ...report.visual.observations.map((observation) => ({
      id: `${report.assetId}:visualObservation:${observation.observationIndex}`,
      sectionType: 'visual' as const,
      sectionIndex: observation.observationIndex,
      startSec: observation.startSec,
      endSec: observation.endSec,
      searchText: [
        observation.description,
        observation.subjects.join(' '),
        observation.actions.join(' '),
        observation.setting,
        observation.visibleText.join(' '),
        observation.objects.join(' '),
        observation.editUsefulness,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' '),
      metadata: {
        preview: observation.description,
        keyframePath: observation.imagePath,
        durationSec: observation.endSec - observation.startSec,
        shotIndex: observation.shotIndex,
        description: observation.description,
        subjects: observation.subjects,
        actions: observation.actions,
        setting: observation.setting,
        visibleText: observation.visibleText,
        objects: observation.objects,
        editUsefulness: observation.editUsefulness,
        confidence: observation.confidence,
        provider: observation.provider,
      },
    })),
  ];
}

async function indexSourceReportChunks(report: SourceAnalysisReport): Promise<void> {
  const chunks = buildSourceReportChunks(report);
  if (chunks.length === 0) {
    return;
  }

  await invoke('index_source_report_chunks', {
    assetId: report.assetId,
    chunks,
  });
}

function getCurrentProjectId(): string | null {
  const meta = useProjectStore.getState().meta;
  return meta?.id ?? meta?.path ?? 'current-project';
}

async function loadRetrievalMemoryEntries(): Promise<RetrievalMemoryEntry[]> {
  const projectId = getCurrentProjectId();
  if (!projectId) {
    return [];
  }

  try {
    const entries = await invoke<Array<{ key: string; value: string; updatedAt: number | string }>>(
      'get_agent_memory',
      {
        projectId,
        category: 'source_retrieval',
      },
    );

    return entries
      .map((entry) => {
        try {
          return JSON.parse(entry.value) as RetrievalMemoryEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is RetrievalMemoryEntry => entry !== null);
  } catch (error) {
    logger.warn('Failed to load retrieval memory', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function saveRetrievalMemoryEntries(
  query: string,
  selects: Array<{
    assetId: string;
    sectionType: SourceAnalysisSection;
    index: number;
    sourceInSec: number;
    sourceOutSec: number;
  }>,
): Promise<void> {
  const projectId = getCurrentProjectId();
  if (!projectId) {
    return;
  }

  const now = new Date().toISOString();
  await Promise.all(
    selects.map((select) => {
      const key = `${select.assetId}:${select.sectionType}:${select.index}`;
      const value: RetrievalMemoryEntry = {
        assetId: select.assetId,
        sectionType: select.sectionType,
        sectionIndex: select.index,
        startSec: select.sourceInSec,
        endSec: select.sourceOutSec,
        query,
        selectedAt: now,
      };

      return invoke('save_agent_memory', {
        id: `source-retrieval:${key}`,
        projectId,
        category: 'source_retrieval',
        key,
        value: JSON.stringify(value),
        ttlSeconds: 60 * 60 * 24 * 30,
      });
    }),
  ).catch((error) => {
    logger.warn('Failed to persist retrieval memory entries', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function applyRetrievalMemoryBoosts(
  matches: SourceLibraryMatch[],
  memoryEntries: RetrievalMemoryEntry[],
): SourceLibraryMatch[] {
  if (memoryEntries.length === 0) {
    return matches;
  }

  const nowMs = Date.now();

  return matches
    .map((match) => {
      const relevantEntries = memoryEntries.filter(
        (entry) => entry.assetId === match.assetId && entry.sectionType === match.sectionType,
      );
      if (relevantEntries.length === 0) {
        return match;
      }

      let score = match.score;
      const rankingNotes = [...(match.rankingNotes ?? [])];

      for (const entry of relevantEntries) {
        const ageDays = Math.max(
          0,
          (nowMs - new Date(entry.selectedAt).getTime()) / (1000 * 60 * 60 * 24),
        );
        const freshness = Math.max(0.15, 1 - ageDays / 30);
        const exactChunkMatch = entry.sectionIndex === match.index;
        const overlap = overlapDuration(entry.startSec, entry.endSec, match.startSec, match.endSec);

        if (exactChunkMatch) {
          score += 1.5 * freshness;
          rankingNotes.push('memory boost: exact chunk selected before');
        } else if (overlap > 0.5) {
          score += 1.0 * freshness;
          rankingNotes.push('memory boost: overlapping chunk selected before');
        } else {
          score += 0.35 * freshness;
          rankingNotes.push('memory boost: same asset/section used before');
        }
      }

      return {
        ...match,
        score: roundTo(score, 3) ?? score,
        rankingNotes: Array.from(new Set(rankingNotes)),
      };
    })
    .sort((left, right) => right.score - left.score);
}

function endsSentence(text: string): boolean {
  return /[.!?]["')\]\u201d\u2019}]*$/.test(text.trimEnd());
}

function dominantSpeechRegionIndex(
  speechRegions: TimedRange[],
  startSec: number,
  endSec: number,
): number | null {
  const match = speechRegions
    .map((region, index) => ({
      index,
      overlap: overlapDuration(region.startSec, region.endSec, startSec, endSec),
    }))
    .filter((entry) => entry.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap)[0];

  return match?.index ?? null;
}

function buildSpeakerTurns(
  transcriptSegments: TranscriptLikeSegment[],
  speechRegions: TimedRange[],
  silenceRegions: TimedRange[],
  segments: SegmentLike[],
): Array<{
  index: number;
  turnId: string;
  label: string;
  speakerId: string | null;
  startSec: number;
  endSec: number;
  durationSec: number;
  segmentCount: number;
  wordCount: number;
  excerpt: string;
  audioCue: string | null;
  dominantSegmentType: string | null;
}> {
  if (transcriptSegments.length === 0) {
    return [];
  }

  const sortedSegments = [...transcriptSegments].sort(
    (left, right) => left.startSec - right.startSec,
  );
  const groups: TranscriptLikeSegment[][] = [];
  let currentGroup: TranscriptLikeSegment[] = [];
  let previousSpeechRegionIndex: number | null = null;

  for (const segment of sortedSegments) {
    const currentSpeechRegionIndex = dominantSpeechRegionIndex(
      speechRegions,
      segment.startSec,
      segment.endSec,
    );

    if (currentGroup.length === 0) {
      currentGroup.push(segment);
      previousSpeechRegionIndex = currentSpeechRegionIndex;
      continue;
    }

    const previous = currentGroup[currentGroup.length - 1];
    const gapSec = Math.max(0, segment.startSec - previous.endSec);
    const explicitTurnChanged =
      previous.speakerTurnId && segment.speakerTurnId
        ? previous.speakerTurnId !== segment.speakerTurnId
        : null;
    const speechRegionChanged =
      previousSpeechRegionIndex !== null &&
      currentSpeechRegionIndex !== null &&
      previousSpeechRegionIndex !== currentSpeechRegionIndex &&
      gapSec > 0.2;
    const shouldSplit =
      explicitTurnChanged ??
      (gapSec > 1 || speechRegionChanged || (gapSec > 0.35 && endsSentence(previous.text)));

    if (shouldSplit) {
      groups.push(currentGroup);
      currentGroup = [segment];
    } else {
      currentGroup.push(segment);
    }

    previousSpeechRegionIndex = currentSpeechRegionIndex;
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups.map((group, index) => {
    const startSec = group[0].startSec;
    const endSec = group[group.length - 1].endSec;
    const dominantSegmentType = resolveDominantSegmentType(segments, startSec, endSec);
    const audioCue = buildAudioCue(speechRegions, silenceRegions, startSec, endSec);
    const explicitSpeakerIds = Array.from(
      new Set(
        group
          .map((segment) => segment.speakerId)
          .filter(
            (speakerId): speakerId is string =>
              typeof speakerId === 'string' && speakerId.length > 0,
          ),
      ),
    );
    const wordCount = group.reduce(
      (count, segment) => count + normalizeText(segment.text).split(' ').filter(Boolean).length,
      0,
    );
    const excerpt = buildTranscriptExcerpt(group, 180) ?? 'No transcript excerpt available.';
    const speakerId = explicitSpeakerIds.length === 1 ? explicitSpeakerIds[0] : null;
    const turnId = group[0].speakerTurnId ?? `turn_${String(index + 1).padStart(3, '0')}`;

    return {
      index,
      turnId,
      label: speakerId ?? `Turn ${index + 1}`,
      speakerId,
      startSec: roundTo(startSec) ?? 0,
      endSec: roundTo(endSec) ?? 0,
      durationSec: roundTo(endSec - startSec) ?? 0,
      segmentCount: group.length,
      wordCount,
      excerpt,
      audioCue,
      dominantSegmentType,
    };
  });
}

function buildLabelFromText(text: string, fallback: string, maxWords = 8): string {
  const normalized = normalizeText(text);
  if (!normalized) {
    return fallback;
  }

  const words = normalized.split(' ').filter(Boolean);
  if (words.length <= maxWords) {
    return normalized;
  }

  return `${words.slice(0, maxWords).join(' ')}...`;
}

function resolveDominantSegmentType(
  segments: SegmentLike[],
  startSec: number,
  endSec: number,
): string | null {
  const durations = new Map<string, number>();

  for (const segment of segments) {
    const overlap = overlapDuration(segment.startSec, segment.endSec, startSec, endSec);
    if (overlap <= 0) {
      continue;
    }

    durations.set(segment.segmentType, (durations.get(segment.segmentType) ?? 0) + overlap);
  }

  return Array.from(durations.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function buildTranscriptChapters(
  transcriptSegments: TranscriptLikeSegment[],
  shots: TimedRange[],
  segments: SegmentLike[],
): Array<{
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  title: string;
  summary: string;
  shotCount: number;
  dominantSegmentType: string | null;
}> {
  if (transcriptSegments.length === 0) {
    return [];
  }

  const sortedSegments = [...transcriptSegments].sort(
    (left, right) => left.startSec - right.startSec,
  );
  const groupedSegments: TranscriptLikeSegment[][] = [];
  let currentGroup: TranscriptLikeSegment[] = [];

  for (const segment of sortedSegments) {
    if (currentGroup.length === 0) {
      currentGroup.push(segment);
      continue;
    }

    const previous = currentGroup[currentGroup.length - 1];
    const groupStartSec = currentGroup[0].startSec;
    const gapSec = Math.max(0, segment.startSec - previous.endSec);
    const chapterDurationSec = segment.endSec - groupStartSec;
    const currentType = resolveDominantSegmentType(segments, groupStartSec, previous.endSec);
    const nextType = resolveDominantSegmentType(segments, segment.startSec, segment.endSec);
    const shouldSplit =
      gapSec > 6 ||
      chapterDurationSec > 45 ||
      (gapSec > 1.5 && currentType !== null && nextType !== null && currentType !== nextType);

    if (shouldSplit) {
      groupedSegments.push(currentGroup);
      currentGroup = [segment];
      continue;
    }

    currentGroup.push(segment);
  }

  if (currentGroup.length > 0) {
    groupedSegments.push(currentGroup);
  }

  return groupedSegments.map((group, index) => {
    const startSec = group[0].startSec;
    const endSec = group[group.length - 1].endSec;
    const dominantSegmentType = resolveDominantSegmentType(segments, startSec, endSec);
    const summary = buildTranscriptExcerpt(group, 180) ?? 'No transcript summary available.';

    return {
      index,
      startSec: roundTo(startSec) ?? 0,
      endSec: roundTo(endSec) ?? 0,
      durationSec: roundTo(endSec - startSec) ?? 0,
      title: buildLabelFromText(
        group[0].text,
        dominantSegmentType
          ? `${dominantSegmentType} section ${index + 1}`
          : `Section ${index + 1}`,
      ),
      summary,
      shotCount: countOverlappingRanges(shots, startSec, endSec),
      dominantSegmentType,
    };
  });
}

function buildSegmentChapters(
  shots: TimedRange[],
  segments: SegmentLike[],
): Array<{
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  title: string;
  summary: string;
  shotCount: number;
  dominantSegmentType: string | null;
}> {
  return segments.slice(0, 12).map((segment, index) => ({
    index,
    startSec: roundTo(segment.startSec) ?? 0,
    endSec: roundTo(segment.endSec) ?? 0,
    durationSec: roundTo(segment.endSec - segment.startSec) ?? 0,
    title: `${segment.segmentType} section ${index + 1}`,
    summary: `${segment.segmentType} segment lasting ${formatDurationLabel(segment.endSec - segment.startSec)}.`,
    shotCount: countOverlappingRanges(shots, segment.startSec, segment.endSec),
    dominantSegmentType: segment.segmentType,
  }));
}

function buildShotChapters(shots: TimedRange[]): Array<{
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  title: string;
  summary: string;
  shotCount: number;
  dominantSegmentType: string | null;
}> {
  const chapters: Array<{
    index: number;
    startSec: number;
    endSec: number;
    durationSec: number;
    title: string;
    summary: string;
    shotCount: number;
    dominantSegmentType: string | null;
  }> = [];

  for (let index = 0; index < shots.length; index += 5) {
    const group = shots.slice(index, index + 5);
    if (group.length === 0) {
      continue;
    }

    const startSec = group[0].startSec;
    const endSec = group[group.length - 1].endSec;
    chapters.push({
      index: chapters.length,
      startSec: roundTo(startSec) ?? 0,
      endSec: roundTo(endSec) ?? 0,
      durationSec: roundTo(endSec - startSec) ?? 0,
      title: `Shot block ${chapters.length + 1}`,
      summary: `${group.length} shots grouped into one structural chapter.`,
      shotCount: group.length,
      dominantSegmentType: null,
    });
  }

  return chapters;
}

function buildReportChapters(
  shots: TimedRange[],
  transcriptSegments: TranscriptLikeSegment[],
  segments: SegmentLike[],
): Array<{
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  title: string;
  summary: string;
  shotCount: number;
  dominantSegmentType: string | null;
}> {
  const transcriptChapters = buildTranscriptChapters(transcriptSegments, shots, segments);
  if (transcriptChapters.length > 0) {
    return transcriptChapters;
  }

  const segmentChapters = buildSegmentChapters(shots, segments);
  if (segmentChapters.length > 0) {
    return segmentChapters;
  }

  return buildShotChapters(shots);
}

function buildReportHighlights(
  transcriptSegments: TranscriptLikeSegment[],
  shots: TimedRange[],
  segments: SegmentLike[],
  objectDetections: TimedPoint[],
  textDetections: TimedPoint[],
  chapters: Array<{
    startSec: number;
    endSec: number;
    title: string;
    summary: string;
    shotCount: number;
    dominantSegmentType: string | null;
  }>,
): Array<{
  index: number;
  startSec: number;
  endSec: number;
  reason: string;
  quote: string | null;
  score: number;
}> {
  const sortedSegments = [...transcriptSegments].sort(
    (left, right) => left.startSec - right.startSec,
  );
  const blocks: TranscriptLikeSegment[][] = [];
  let currentBlock: TranscriptLikeSegment[] = [];

  for (const segment of sortedSegments) {
    if (currentBlock.length === 0) {
      currentBlock.push(segment);
      continue;
    }

    const previous = currentBlock[currentBlock.length - 1];
    const blockStartSec = currentBlock[0].startSec;
    const gapSec = Math.max(0, segment.startSec - previous.endSec);
    const nextDurationSec = segment.endSec - blockStartSec;
    const shouldSplit = gapSec > 1.25 || nextDurationSec > 14;

    if (shouldSplit) {
      blocks.push(currentBlock);
      currentBlock = [segment];
      continue;
    }

    currentBlock.push(segment);
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  const transcriptCandidates = blocks
    .map((block) => {
      const startSec = block[0].startSec;
      const endSec = block[block.length - 1].endSec;
      const durationSec = Math.max(0.5, endSec - startSec);
      const wordCount = block.reduce(
        (count, segment) => count + normalizeText(segment.text).split(' ').filter(Boolean).length,
        0,
      );
      const shotCount = countOverlappingRanges(shots, startSec, endSec);
      const objectCount = countTimedPointsInRange(objectDetections, startSec, endSec);
      const ocrCount = countTimedPointsInRange(textDetections, startSec, endSec);
      const dominantSegmentType = resolveDominantSegmentType(segments, startSec, endSec);
      const quote = buildTranscriptExcerpt(block, 120);
      const dialogueDensity = wordCount / durationSec;
      let score = Math.min(wordCount, 24) * 0.45 + Math.min(dialogueDensity, 6) * 1.6;
      score += Math.min(shotCount, 5) * 0.75;
      score += Math.min(objectCount, 3) * 0.75;
      score += Math.min(ocrCount, 2) * 0.75;
      if (durationSec >= 2 && durationSec <= 12) {
        score += 1;
      }
      if (dominantSegmentType === 'talk' || dominantSegmentType === 'performance') {
        score += 1.2;
      }

      const reasonParts = ['dense spoken content'];
      if (shotCount >= 2) {
        reasonParts.push(`${shotCount} overlapping shots`);
      }
      if (objectCount > 0) {
        reasonParts.push('object activity');
      }
      if (ocrCount > 0) {
        reasonParts.push('on-screen text');
      }
      if (dominantSegmentType) {
        reasonParts.push(`${dominantSegmentType} section`);
      }

      return {
        startSec,
        endSec,
        reason: reasonParts.join(', '),
        quote,
        score: roundTo(score) ?? 0,
      };
    })
    .sort((left, right) => right.score - left.score);

  const selectedHighlights: Array<{
    startSec: number;
    endSec: number;
    reason: string;
    quote: string | null;
    score: number;
  }> = [];

  for (const candidate of transcriptCandidates) {
    const overlapsExisting = selectedHighlights.some(
      (existing) =>
        overlapDuration(existing.startSec, existing.endSec, candidate.startSec, candidate.endSec) >
        1,
    );
    if (overlapsExisting) {
      continue;
    }

    selectedHighlights.push(candidate);
    if (selectedHighlights.length >= 5) {
      break;
    }
  }

  if (selectedHighlights.length === 0) {
    selectedHighlights.push(
      ...chapters.slice(0, 3).map((chapter) => ({
        startSec: chapter.startSec,
        endSec: chapter.endSec,
        reason: chapter.dominantSegmentType
          ? `${chapter.dominantSegmentType} structural chapter`
          : 'structural chapter',
        quote: chapter.summary,
        score: roundTo(3 + chapter.shotCount * 0.5) ?? 3,
      })),
    );
  }

  return selectedHighlights.map((highlight, index) => ({
    index,
    startSec: roundTo(highlight.startSec) ?? 0,
    endSec: roundTo(highlight.endSec) ?? 0,
    reason: highlight.reason,
    quote: highlight.quote,
    score: highlight.score,
  }));
}

function buildReportMoments(
  shots: Array<TimedRange & { keyframePath?: string | null }>,
  transcriptSegments: TranscriptLikeSegment[],
  segments: SegmentLike[],
  speechRegions: TimedRange[],
  silenceRegions: TimedRange[],
  objectDetections: Array<TimedPoint & { labels: string[] }>,
  faceDetections: Array<TimedPoint & { faceId?: string | null; emotions?: string[] }>,
  textDetections: Array<TimedPoint & { text: string }>,
  frameAnalysis: Array<{
    shotIndex: number;
    cameraAngle: string;
    subjectPosition: string;
    motionDirection: string;
    visualComplexity: number;
  }>,
): Array<{
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  keyframePath: string | null;
  transcriptExcerpt: string | null;
  dominantSegmentType: string | null;
  topObjectLabels: string[];
  ocrTextPreview: string[];
  audioCue: string | null;
  speechRegionCount: number;
  silenceRegionCount: number;
  faceCount: number;
  objectCount: number;
  sceneLabel: string;
  audioSummary: string | null;
  peopleSummary: string | null;
  textSummary: string | null;
  visualSummary: string | null;
  settingHints: string[];
  summary: string;
}> {
  return shots.map((shot, index) => {
    const overlappingTranscript = transcriptSegments.filter(
      (segment) =>
        overlapDuration(segment.startSec, segment.endSec, shot.startSec, shot.endSec) > 0,
    );
    const overlappingObjects = objectDetections.filter(
      (entry) => entry.timeSec >= shot.startSec && entry.timeSec <= shot.endSec,
    );
    const overlappingFaces = faceDetections.filter(
      (entry) => entry.timeSec >= shot.startSec && entry.timeSec <= shot.endSec,
    );
    const overlappingText = textDetections.filter(
      (entry) => entry.timeSec >= shot.startSec && entry.timeSec <= shot.endSec,
    );
    const transcriptExcerpt = buildTranscriptExcerpt(overlappingTranscript, 120);
    const dominantSegmentType = resolveDominantSegmentType(segments, shot.startSec, shot.endSec);
    const overlappingSpeechRegions = speechRegions.filter(
      (region) => overlapDuration(region.startSec, region.endSec, shot.startSec, shot.endSec) > 0,
    );
    const overlappingSilenceRegions = silenceRegions.filter(
      (region) => overlapDuration(region.startSec, region.endSec, shot.startSec, shot.endSec) > 0,
    );
    const audioCue = buildAudioCue(speechRegions, silenceRegions, shot.startSec, shot.endSec);
    const topObjectLabels = collectTopCounts(
      overlappingObjects.flatMap((entry) => entry.labels),
      4,
    ).map((entry) => entry.label);
    const ocrTextPreview = overlappingText
      .map((entry) => normalizeText(entry.text))
      .filter(Boolean)
      .slice(0, 3);
    const speakerIds = uniqueStrings(
      overlappingTranscript.map((segment) => segment.speakerId ?? null),
    );
    const visualEntry = frameAnalysis.find((entry) => entry.shotIndex === index) ?? null;
    const peopleSummary = buildPeopleSummary({
      topObjectLabels,
      faceDetections: overlappingFaces,
    });
    const textSummary = buildTextSummary(ocrTextPreview);
    const visualSummary = buildVisualCueSummary({
      cameraAngle: visualEntry?.cameraAngle ?? null,
      subjectPosition: visualEntry?.subjectPosition ?? null,
      motionDirection: visualEntry?.motionDirection ?? null,
      visualComplexity: visualEntry?.visualComplexity ?? null,
    });
    const settingHints = deriveSettingHints({
      dominantSegmentType,
      topObjectLabels,
      ocrTexts: ocrTextPreview,
      transcriptExcerpt,
      visualCueSummary: visualSummary,
    });
    const audioSummary = buildAudioSummary({
      dominantSegmentType,
      transcriptExcerpt,
      audioCue,
      speakerIds,
    });
    const sceneLabel = buildSceneLabel({
      dominantSegmentType,
      transcriptExcerpt,
      topObjectLabels,
      textSummary,
    });
    const summary = buildSemanticMomentSummary({
      dominantSegmentType,
      transcriptExcerpt,
      topObjectLabels,
      peopleSummary,
      audioSummary,
      textSummary,
      visualCueSummary: visualSummary,
      settingHints,
    });

    return {
      index,
      startSec: roundTo(shot.startSec) ?? 0,
      endSec: roundTo(shot.endSec) ?? 0,
      durationSec: roundTo(shot.endSec - shot.startSec) ?? 0,
      keyframePath: shot.keyframePath ?? null,
      transcriptExcerpt,
      dominantSegmentType,
      topObjectLabels,
      ocrTextPreview,
      audioCue,
      speechRegionCount: overlappingSpeechRegions.length,
      silenceRegionCount: overlappingSilenceRegions.length,
      faceCount: overlappingFaces.length,
      objectCount: overlappingObjects.length,
      sceneLabel,
      audioSummary,
      peopleSummary,
      textSummary,
      visualSummary,
      settingHints,
      summary,
    };
  });
}

function buildVisualDetailSummary(item: {
  shotIndex: number;
  cameraAngle: string;
  subjectPosition: string;
  motionDirection: string;
  visualComplexity: number;
}): string {
  const parts = [`Shot ${item.shotIndex + 1}`];

  if (item.cameraAngle !== 'unknown') {
    parts.push(`${item.cameraAngle} angle`);
  }

  if (item.subjectPosition !== 'unknown') {
    parts.push(`${item.subjectPosition} subject`);
  }

  if (item.motionDirection !== 'unknown') {
    parts.push(`${item.motionDirection} motion`);
  }

  parts.push(`complexity ${item.visualComplexity}`);
  return parts.join(' | ');
}

function buildReportVisualItems(
  shots: Array<
    TimedRange & {
      keyframePath?: string | null;
      keyframeSelectionMethod?: string | null;
    }
  >,
  frameAnalysis: Array<{
    shotIndex: number;
    cameraAngle: string;
    subjectPosition: string;
    motionDirection: string;
    visualComplexity: number;
  }>,
): Array<{
  shotIndex: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  keyframePath: string | null;
  keyframeSelectionMethod: string | null;
  cameraAngle: string;
  subjectPosition: string;
  motionDirection: string;
  visualComplexity: number;
  summary: string;
}> {
  return frameAnalysis.flatMap((entry, fallbackIndex) => {
    const resolvedShotIndex = shots[entry.shotIndex] ? entry.shotIndex : fallbackIndex;
    const shot = shots[resolvedShotIndex];
    if (!shot) {
      return [];
    }

    const startSec = roundTo(shot.startSec) ?? 0;
    const endSec = roundTo(shot.endSec) ?? startSec;
    const visualComplexity = roundTo(entry.visualComplexity) ?? 0;
    const item = {
      shotIndex: resolvedShotIndex,
      startSec,
      endSec,
      durationSec: roundTo(Math.max(0, endSec - startSec)) ?? 0,
      keyframePath: shot.keyframePath ?? null,
      keyframeSelectionMethod: shot.keyframeSelectionMethod ?? null,
      cameraAngle: entry.cameraAngle,
      subjectPosition: entry.subjectPosition,
      motionDirection: entry.motionDirection,
      visualComplexity,
    };

    return [
      {
        ...item,
        summary: buildVisualDetailSummary(item),
      },
    ];
  });
}

function buildFrameObservationItems(
  observations: FrameObservationLike[],
  shots: Array<
    TimedRange & {
      keyframePath?: string | null;
    }
  >,
): Array<{
  observationIndex: number;
  shotIndex: number;
  startSec: number;
  endSec: number;
  timeSec: number;
  imagePath: string | null;
  description: string;
  subjects: string[];
  actions: string[];
  setting: string | null;
  visibleText: string[];
  objects: string[];
  editUsefulness: string | null;
  confidence: number | null;
  provider: {
    provider: string;
    model: string;
    analyzedAt: string;
  } | null;
}> {
  return observations.flatMap((observation, fallbackIndex) => {
    const resolvedShotIndex = shots[observation.shotIndex] ? observation.shotIndex : fallbackIndex;
    const shot = shots[resolvedShotIndex] ?? null;
    const timeSec =
      roundTo(observation.timeSec) ??
      (shot ? (roundTo((shot.startSec + shot.endSec) / 2) ?? 0) : 0);
    const description = normalizeText(observation.description);

    if (!description && !shot) {
      return [];
    }

    const provider = observation.provider
      ? {
          provider: normalizeText(observation.provider.provider) || 'unknown',
          model: normalizeText(observation.provider.model) || 'unknown',
          analyzedAt: normalizeText(observation.provider.analyzedAt) || 'unknown',
        }
      : null;

    return [
      {
        observationIndex: fallbackIndex,
        shotIndex: resolvedShotIndex,
        startSec: shot ? (roundTo(shot.startSec) ?? timeSec) : timeSec,
        endSec: shot ? (roundTo(shot.endSec) ?? timeSec) : timeSec,
        timeSec,
        imagePath: observation.imagePath || shot?.keyframePath || null,
        description,
        subjects: uniqueStrings(observation.subjects ?? [], 8),
        actions: uniqueStrings(observation.actions ?? [], 8),
        setting:
          typeof observation.setting === 'string' && observation.setting.trim().length > 0
            ? normalizeText(observation.setting)
            : null,
        visibleText: uniqueStrings(observation.visibleText ?? [], 8),
        objects: uniqueStrings(observation.objects ?? [], 10),
        editUsefulness:
          typeof observation.editUsefulness === 'string' &&
          observation.editUsefulness.trim().length > 0
            ? normalizeText(observation.editUsefulness)
            : null,
        confidence: roundTo(observation.confidence, 3),
        provider,
      },
    ];
  });
}

function isLocalVisualFallbackOnly(
  frameAnalysis: Array<{
    cameraAngle?: string | null;
    subjectPosition?: string | null;
    motionDirection?: string | null;
  }>,
): boolean {
  return frameAnalysis.length > 0;
}

function resolveVisualSemanticCoverage(
  frameAnalysis: Array<{
    cameraAngle?: string | null;
    subjectPosition?: string | null;
    motionDirection?: string | null;
  }>,
  frameObservations: unknown[] = [],
): 'semantic' | 'local_fallback' | 'missing' {
  if (frameObservations.length > 0) {
    return 'semantic';
  }

  return isLocalVisualFallbackOnly(frameAnalysis) ? 'local_fallback' : 'missing';
}

function buildKeyframeGallery(
  shots: Array<
    TimedRange & {
      keyframePath?: string | null;
      keyframeSelectionMethod?: string | null;
    }
  >,
): Array<{
  shotIndex: number;
  startSec: number;
  endSec: number;
  keyframePath: string;
  keyframeSelectionMethod: string | null;
  label: string;
}> {
  return shots.flatMap((shot, index) => {
    if (!shot.keyframePath) {
      return [];
    }

    return [
      {
        shotIndex: index,
        startSec: roundTo(shot.startSec) ?? 0,
        endSec: roundTo(shot.endSec) ?? 0,
        keyframePath: shot.keyframePath,
        keyframeSelectionMethod: shot.keyframeSelectionMethod ?? null,
        label: `Shot ${index + 1} keyframe`,
      },
    ];
  });
}

function buildSourceReportQuality(report: {
  coverage: {
    shots: boolean;
    transcript: boolean;
    audio: boolean;
    segments: boolean;
    visual: boolean;
    annotation: boolean;
  };
  metadata: {
    hasAudioStream: boolean;
  };
  visual: {
    semanticCoverage: 'semantic' | 'local_fallback' | 'missing';
    keyframes: unknown[];
    contactSheet: unknown | null;
  };
  transcript: {
    segmentCount: number;
  };
  annotations: {
    objectDetectionCount: number;
    faceDetectionCount: number;
    ocrTextCount: number;
  };
  errors: Record<string, string>;
}): {
  status: 'ready' | 'partial' | 'insufficient';
  score: number;
  criticalSignals: string[];
  missingSignals: string[];
  degradedSignals: string[];
  recommendedActions: string[];
} {
  let score = 100;
  const criticalSignals: string[] = [];
  const missingSignals: string[] = [];
  const degradedSignals: string[] = [];
  const recommendedActions: string[] = [];

  const requireSignal = (
    available: boolean,
    signal: string,
    penalty: number,
    recommendation: string,
  ) => {
    if (available) {
      criticalSignals.push(signal);
      return;
    }

    score -= penalty;
    missingSignals.push(signal);
    recommendedActions.push(recommendation);
  };

  requireSignal(
    report.coverage.shots,
    'shot boundaries',
    20,
    'Run shot detection so the report can align transcript and visuals to edit-ready ranges.',
  );
  if (report.metadata.hasAudioStream) {
    requireSignal(
      report.coverage.transcript,
      'timed transcript',
      25,
      'Run transcription so dialogue, searchable quotes, and subtitles are available.',
    );
    requireSignal(
      report.coverage.audio,
      'audio profile',
      12,
      'Run audio profiling so speech, silence, loudness, and pacing cues are available.',
    );
  }
  requireSignal(
    report.coverage.visual,
    'visual frame analysis',
    20,
    'Run visual analysis so keyframe-level framing and motion cues are available.',
  );

  if (report.visual.semanticCoverage === 'local_fallback') {
    score -= 12;
    degradedSignals.push('semantic visual descriptions');
    recommendedActions.push(
      'Run a vision-capable provider over the extracted keyframes/contact sheet for actual scene descriptions.',
    );
  } else if (report.visual.semanticCoverage === 'semantic') {
    criticalSignals.push('semantic visual cues');
  }

  if (!report.coverage.annotation) {
    score -= 8;
    missingSignals.push('object, face, and OCR annotations');
    recommendedActions.push(
      'Run object/OCR/face annotation if the edit depends on people, props, screens, or visible text.',
    );
  } else if (
    report.annotations.objectDetectionCount +
      report.annotations.faceDetectionCount +
      report.annotations.ocrTextCount >
    0
  ) {
    criticalSignals.push('annotation cues');
  }

  if (report.visual.keyframes.length === 0) {
    score -= 8;
    degradedSignals.push('keyframe gallery');
    recommendedActions.push(
      'Regenerate shot keyframes so agents can inspect representative stills.',
    );
  }

  if (!report.visual.contactSheet) {
    score -= 4;
    degradedSignals.push('contact sheet');
  }

  const errorCount = Object.keys(report.errors).length;
  if (errorCount > 0) {
    score -= Math.min(20, errorCount * 6);
    degradedSignals.push('failed analysis sub-jobs');
  }

  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
  const status =
    normalizedScore >= 80 ? 'ready' : normalizedScore >= 50 ? 'partial' : 'insufficient';

  return {
    status,
    score: normalizedScore,
    criticalSignals: uniqueStrings(criticalSignals),
    missingSignals: uniqueStrings(missingSignals),
    degradedSignals: uniqueStrings(degradedSignals),
    recommendedActions: uniqueStrings(recommendedActions),
  };
}

function formatProviderLabel(provider: unknown): string {
  if (typeof provider === 'string') {
    return provider;
  }

  if (provider && typeof provider === 'object' && 'custom' in provider) {
    const custom = (provider as { custom?: unknown }).custom;
    if (typeof custom === 'string' && custom.trim().length > 0) {
      return custom;
    }
  }

  return 'unknown';
}

function bundleSatisfiesOptions(bundle: AnalysisBundle, options: AnalysisOptions): boolean {
  const frameObservations = bundle.frameObservations ?? [];
  const hasFrameAnalysis = (bundle.frameAnalysis?.length ?? 0) > 0;
  const hasVisualSignals = hasFrameAnalysis || frameObservations.length > 0;

  return (
    (!options.shots || hasValue(bundle.shots)) &&
    (!options.transcript || hasValue(bundle.transcript)) &&
    (!options.audio || hasValue(bundle.audioProfile)) &&
    (!options.segments || hasValue(bundle.segments)) &&
    (!options.visual ||
      (hasVisualSignals &&
        (options.localOnly ||
          !isLocalVisualFallbackOnly(bundle.frameAnalysis ?? []) ||
          frameObservations.length > 0)))
  );
}

type SourceAnalysisReport = ReturnType<typeof buildSourceAnalysisReportPayload>;
type SourceAnalysisSection = 'moments' | 'chapters' | 'highlights' | 'speakerTurns' | 'visual';
type SourceAnalysisReportDocument = {
  relativePath: string;
  content: string;
  sizeBytes: number;
  modifiedAtUnixSec: number | null;
  persisted: boolean;
  persistenceError: string | null;
};
type SourceReportChunk = {
  id: string;
  sectionType: SourceAnalysisSection;
  sectionIndex: number;
  startSec: number;
  endSec: number;
  searchText: string;
  metadata: Record<string, unknown>;
};
type IndexedSourceReportChunkResult = {
  chunkId: string;
  assetId: string;
  sectionType: SourceAnalysisSection;
  sectionIndex: number;
  startSec: number;
  endSec: number;
  score: number;
  searchText: string;
  metadata: Record<string, unknown>;
};
type IndexedSourceReportSearchResponse = {
  results: IndexedSourceReportChunkResult[];
  total: number;
  processingTimeMs: number;
};

const SOURCE_ANALYSIS_REPORT_SUFFIX = '.analysis.md';
const VISUAL_BREAKDOWN_MARKDOWN_LIMIT = 12;
const SEMANTIC_SCENE_TIMELINE_LIMIT = 10;
const SEMANTIC_USEFUL_MOMENT_LIMIT = 6;
const SEMANTIC_OVERVIEW_LIMIT = 3;
type RetrievalMemoryEntry = {
  assetId: string;
  sectionType: SourceAnalysisSection;
  sectionIndex: number;
  startSec: number;
  endSec: number;
  query: string;
  selectedAt: string;
};
type SourceLibraryMatch = {
  assetId: string;
  assetName: string;
  onTimeline: boolean;
  timelineClipCount: number;
  sectionType: SourceAnalysisSection;
  index: number;
  startSec: number;
  endSec: number;
  score: number;
  whyMatched: string[];
  preview: string;
  keyframePath: string | null;
  rawScore?: number;
  rankingNotes?: string[];
  metadata?: {
    audioCue?: string | null;
    durationSec?: number;
    speakerId?: string | null;
    wordCount?: number;
    segmentCount?: number;
    dominantSegmentType?: string | null;
    sceneLabel?: string | null;
    peopleSummary?: string | null;
    textSummary?: string | null;
    visualSummary?: string | null;
    settingHints?: string[];
    cameraAngle?: string | null;
    subjectPosition?: string | null;
    motionDirection?: string | null;
    visualComplexity?: number;
    shotIndex?: number;
    description?: string;
    subjects?: string[];
    actions?: string[];
    setting?: string | null;
    visibleText?: string[];
    objects?: string[];
    editUsefulness?: string | null;
    confidence?: number | null;
    provider?: Record<string, unknown> | null;
  };
};

type SourceLibrarySkip = {
  assetId: string;
  assetName: string;
  reason: string;
};

type SemanticUsefulMomentKind = 'quote' | 'action' | 'text' | 'reaction' | 'establishing' | 'pause';

type ReportMoment = ReturnType<typeof buildReportMoments>[number];
type ReportChapter = ReturnType<typeof buildReportChapters>[number];
type ReportHighlight = ReturnType<typeof buildReportHighlights>[number];
type ReportSpeakerTurn = ReturnType<typeof buildSpeakerTurns>[number];

type SemanticReportInput = {
  assetName: string;
  transcript: {
    excerpt: string | null;
  };
  audio: {
    speechSharePercent: number;
    silenceSharePercent: number;
  };
  segments: {
    distribution: Array<{ label: string; sharePercent: number }>;
  };
  visual: {
    topCameraAngles: Array<{ label: string; count: number }>;
    observations: Array<{
      description: string;
      subjects: string[];
      actions: string[];
      setting: string | null;
      visibleText: string[];
      objects: string[];
      editUsefulness: string | null;
    }>;
  };
  speakerTurns: {
    items: ReportSpeakerTurn[];
  };
  annotations: {
    ocrPreview: string[];
    topObjectLabels: Array<{ label: string; count: number }>;
  };
  moments: {
    items: ReportMoment[];
  };
  chapters: {
    items: ReportChapter[];
  };
  highlights: {
    items: ReportHighlight[];
  };
};

type SemanticSceneTimelineItem = {
  index: number;
  startSec: number;
  endSec: number;
  title: string;
  summary: string;
  keyframePath: string | null;
};

type SemanticUsefulMoment = {
  index: number;
  kind: SemanticUsefulMomentKind;
  startSec: number;
  endSec: number;
  summary: string;
  reason: string;
  keyframePath: string | null;
};

type SemanticReportData = {
  summaryLine: string;
  whatIsHappening: string[];
  whoIsPresent: string[];
  whatIsHeard: string[];
  onScreenText: string[];
  likelySetting: string[];
  sceneTimeline: SemanticSceneTimelineItem[];
  usefulMoments: SemanticUsefulMoment[];
};

function truncateText(text: string, maxLength = 220): string {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function buildSceneTimelineTitle(chapter: ReportChapter, moment?: ReportMoment): string {
  if (moment?.sceneLabel) {
    return moment.sceneLabel;
  }

  const humanizedSegmentType = humanizeSegmentType(chapter.dominantSegmentType);
  if (humanizedSegmentType) {
    return buildLabelFromText(humanizedSegmentType, chapter.title, 6);
  }

  return chapter.title;
}

function buildSceneTimelineSummary(
  chapter: ReportChapter,
  overlappingMoments: ReportMoment[],
): string {
  const primaryMoment = overlappingMoments[0];
  if (primaryMoment?.summary) {
    return truncateText(primaryMoment.summary, 260);
  }

  return truncateText(chapter.summary, 260);
}

function classifyUsefulMomentKind(args: {
  highlight: ReportHighlight;
  overlappingMoment: ReportMoment | null;
}): SemanticUsefulMomentKind {
  const { highlight, overlappingMoment } = args;

  if (overlappingMoment?.textSummary || overlappingMoment?.ocrTextPreview.length) {
    return 'text';
  }

  if (highlight.quote || overlappingMoment?.transcriptExcerpt) {
    return 'quote';
  }

  if (overlappingMoment?.audioCue === 'long pause' || overlappingMoment?.audioCue === 'quiet gap') {
    return overlappingMoment.faceCount > 0 ? 'reaction' : 'pause';
  }

  if (overlappingMoment?.dominantSegmentType === 'reaction') {
    return 'reaction';
  }

  if (
    overlappingMoment?.dominantSegmentType === 'establishing' ||
    overlappingMoment?.settingHints.includes('outdoor or location-based setting') ||
    overlappingMoment?.sceneLabel === 'Establishing shot'
  ) {
    return 'establishing';
  }

  return 'action';
}

function buildUsefulMomentSummary(args: {
  kind: SemanticUsefulMomentKind;
  highlight: ReportHighlight;
  overlappingMoment: ReportMoment | null;
}): string {
  const { kind, highlight, overlappingMoment } = args;

  switch (kind) {
    case 'quote': {
      const quote = quoteSnippet(
        highlight.quote ?? overlappingMoment?.transcriptExcerpt ?? null,
        96,
      );
      return quote
        ? `Strong spoken line: ${quote}`
        : (overlappingMoment?.summary ?? highlight.reason);
    }
    case 'text':
      return overlappingMoment?.textSummary
        ? `Text-bearing moment: ${overlappingMoment.textSummary}`
        : (overlappingMoment?.summary ?? highlight.reason);
    case 'reaction':
      return overlappingMoment?.peopleSummary
        ? `Reaction-friendly visual: ${overlappingMoment.peopleSummary}`
        : (overlappingMoment?.summary ?? highlight.reason);
    case 'establishing':
      return overlappingMoment?.summary ?? highlight.reason;
    case 'pause':
      return overlappingMoment?.audioSummary
        ? `Quiet gap useful for transitions: ${overlappingMoment.audioSummary}`
        : 'Quiet gap or pause useful for resets and cutaways';
    case 'action':
    default:
      return overlappingMoment?.summary ?? highlight.reason;
  }
}

function buildSemanticReportData(report: SemanticReportInput): SemanticReportData {
  const sceneTimeline = report.chapters.items
    .slice(0, SEMANTIC_SCENE_TIMELINE_LIMIT)
    .map((chapter) => {
      const overlappingMoments = report.moments.items.filter(
        (moment) =>
          overlapDuration(moment.startSec, moment.endSec, chapter.startSec, chapter.endSec) > 0,
      );
      const primaryMoment = overlappingMoments[0];

      return {
        index: chapter.index,
        startSec: chapter.startSec,
        endSec: chapter.endSec,
        title: buildSceneTimelineTitle(chapter, primaryMoment),
        summary: buildSceneTimelineSummary(chapter, overlappingMoments),
        keyframePath: primaryMoment?.keyframePath ?? null,
      };
    });

  const usefulMoments = report.highlights.items
    .slice(0, SEMANTIC_USEFUL_MOMENT_LIMIT)
    .map((highlight, index) => {
      const overlappingMoment =
        report.moments.items.find(
          (moment) =>
            overlapDuration(moment.startSec, moment.endSec, highlight.startSec, highlight.endSec) >
            0,
        ) ?? null;
      const kind = classifyUsefulMomentKind({ highlight, overlappingMoment });

      return {
        index,
        kind,
        startSec: highlight.startSec,
        endSec: highlight.endSec,
        summary: truncateText(
          buildUsefulMomentSummary({ kind, highlight, overlappingMoment }),
          220,
        ),
        reason: highlight.reason,
        keyframePath: overlappingMoment?.keyframePath ?? null,
      };
    });

  const observationDescriptions = report.visual.observations
    .map((observation) => observation.description)
    .filter((value) => value.length > 0);
  const whatIsHappening = uniqueStrings(
    [...observationDescriptions, ...sceneTimeline.map((item) => item.summary)],
    SEMANTIC_OVERVIEW_LIMIT,
  );
  const likelySetting = uniqueStrings(
    [
      ...report.visual.observations
        .map((observation) => observation.setting)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ...report.moments.items.flatMap((moment) => moment.settingHints),
    ],
    SEMANTIC_OVERVIEW_LIMIT,
  );
  const whoIsPresent = uniqueStrings(
    [
      report.speakerTurns.items.length > 0
        ? `Detected speaking voices or turns include ${formatNaturalList(
            report.speakerTurns.items.slice(0, 3).map((turn) => turn.label),
            3,
          )}.`
        : null,
      ...report.moments.items
        .map((moment) => moment.peopleSummary)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ...report.visual.observations
        .flatMap((observation) => observation.subjects)
        .map((subject) => `Visible subject: ${subject}.`),
      report.annotations.topObjectLabels.length > 0
        ? `Recurring visible cues include ${formatNaturalList(
            report.annotations.topObjectLabels.slice(0, 4).map((entry) => entry.label),
            4,
          )}.`
        : null,
    ],
    SEMANTIC_OVERVIEW_LIMIT,
  );
  const whatIsHeard = uniqueStrings(
    [
      report.transcript.excerpt
        ? `Transcript captures spoken content such as ${quoteSnippet(report.transcript.excerpt, 120)}.`
        : null,
      report.audio.speechSharePercent > 60
        ? `Speech is present through about ${report.audio.speechSharePercent}% of the source.`
        : report.audio.speechSharePercent > 15
          ? `The source mixes speech with non-speech audio across about ${report.audio.speechSharePercent}% of runtime.`
          : null,
      report.audio.silenceSharePercent > 20
        ? `Quiet pauses or low-activity gaps cover about ${report.audio.silenceSharePercent}% of runtime.`
        : null,
      report.segments.distribution[0]
        ? `The dominant structural mode is ${humanizeSegmentType(report.segments.distribution[0].label) ?? report.segments.distribution[0].label}.`
        : null,
    ],
    SEMANTIC_OVERVIEW_LIMIT,
  );
  const onScreenText = uniqueStrings(
    [
      report.annotations.ocrPreview.length > 0
        ? `Detected text includes ${report.annotations.ocrPreview
            .slice(0, 3)
            .map((entry) => quoteSnippet(entry, 48))
            .filter((value): value is string => Boolean(value))
            .join(', ')}.`
        : null,
      ...report.moments.items
        .map((moment) => moment.textSummary)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ...report.visual.observations
        .flatMap((observation) => observation.visibleText)
        .map((text) => `Vision-visible text reads ${quoteSnippet(text, 64)}.`),
    ],
    SEMANTIC_OVERVIEW_LIMIT,
  );

  const summaryParts = [whatIsHappening[0], likelySetting[0], whatIsHeard[0]]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.replace(/[.]$/, ''));

  return {
    summaryLine:
      summaryParts.length > 0
        ? truncateText(summaryParts.join(' | '), 220)
        : `Semantic source report for ${report.assetName}.`,
    whatIsHappening,
    whoIsPresent,
    whatIsHeard,
    onScreenText,
    likelySetting,
    sceneTimeline,
    usefulMoments,
  };
}

function normalizeSearchQuery(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeSearchQuery(text: string): string[] {
  return normalizeSearchQuery(text)
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreSearchTextFields(
  query: string,
  queryTokens: string[],
  fields: Array<{ field: string; value: string | string[] | null | undefined; weight: number }>,
): { score: number; whyMatched: string[] } {
  let score = 0;
  const whyMatched: string[] = [];

  for (const field of fields) {
    const values = (Array.isArray(field.value) ? field.value : [field.value])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => normalizeSearchQuery(value));

    if (values.length === 0) {
      continue;
    }

    let fieldScore = 0;
    if (query && values.some((value) => value.includes(query))) {
      fieldScore += field.weight * 4;
    }

    const matchedTokens = queryTokens.filter((token) =>
      values.some((value) => value.includes(token)),
    );
    if (matchedTokens.length > 0) {
      fieldScore += matchedTokens.length * field.weight;
    }

    if (fieldScore > 0) {
      score += fieldScore;
      whyMatched.push(field.field);
    }
  }

  return {
    score,
    whyMatched: Array.from(new Set(whyMatched)),
  };
}

function searchSourceAnalysisReport(
  report: SourceAnalysisReport,
  query: string,
  sections: SourceAnalysisSection[],
  limit: number,
) {
  const normalizedQuery = normalizeSearchQuery(query);
  const queryTokens = tokenizeSearchQuery(query);
  const candidates: Array<{
    sectionType: SourceAnalysisSection;
    index: number;
    startSec: number;
    endSec: number;
    score: number;
    whyMatched: string[];
    preview: string;
    keyframePath: string | null;
    metadata?: SourceLibraryMatch['metadata'];
  }> = [];

  if (sections.includes('moments')) {
    for (const moment of report.moments.items) {
      const match = scoreSearchTextFields(normalizedQuery, queryTokens, [
        { field: 'sceneLabel', value: moment.sceneLabel, weight: 2 },
        { field: 'summary', value: moment.summary, weight: 3 },
        { field: 'transcriptExcerpt', value: moment.transcriptExcerpt, weight: 3 },
        { field: 'audioSummary', value: moment.audioSummary, weight: 2 },
        { field: 'peopleSummary', value: moment.peopleSummary, weight: 2 },
        { field: 'textSummary', value: moment.textSummary, weight: 2 },
        { field: 'visualSummary', value: moment.visualSummary, weight: 1 },
        { field: 'settingHints', value: moment.settingHints, weight: 2 },
        { field: 'audioCue', value: moment.audioCue, weight: 2 },
        { field: 'topObjectLabels', value: moment.topObjectLabels, weight: 2 },
        { field: 'ocrTextPreview', value: moment.ocrTextPreview, weight: 2 },
        { field: 'dominantSegmentType', value: moment.dominantSegmentType, weight: 1 },
      ]);
      if (match.score <= 0) {
        continue;
      }

      candidates.push({
        sectionType: 'moments',
        index: moment.index,
        startSec: moment.startSec,
        endSec: moment.endSec,
        score: match.score,
        whyMatched: match.whyMatched,
        preview: moment.summary,
        keyframePath: moment.keyframePath,
        metadata: {
          audioCue: moment.audioCue,
          durationSec: moment.durationSec,
          dominantSegmentType: moment.dominantSegmentType,
          sceneLabel: moment.sceneLabel,
          peopleSummary: moment.peopleSummary,
          textSummary: moment.textSummary,
          visualSummary: moment.visualSummary,
          settingHints: moment.settingHints,
        },
      });
    }
  }

  if (sections.includes('chapters')) {
    for (const chapter of report.chapters.items) {
      const match = scoreSearchTextFields(normalizedQuery, queryTokens, [
        { field: 'title', value: chapter.title, weight: 3 },
        { field: 'summary', value: chapter.summary, weight: 2 },
        { field: 'dominantSegmentType', value: chapter.dominantSegmentType, weight: 1 },
      ]);
      if (match.score <= 0) {
        continue;
      }

      candidates.push({
        sectionType: 'chapters',
        index: chapter.index,
        startSec: chapter.startSec,
        endSec: chapter.endSec,
        score: match.score,
        whyMatched: match.whyMatched,
        preview: `${chapter.title} - ${chapter.summary}`,
        keyframePath: null,
        metadata: {
          durationSec: chapter.durationSec,
          dominantSegmentType: chapter.dominantSegmentType,
        },
      });
    }
  }

  if (sections.includes('highlights')) {
    for (const highlight of report.highlights.items) {
      const match = scoreSearchTextFields(normalizedQuery, queryTokens, [
        { field: 'reason', value: highlight.reason, weight: 2 },
        { field: 'quote', value: highlight.quote, weight: 3 },
      ]);
      if (match.score <= 0) {
        continue;
      }

      candidates.push({
        sectionType: 'highlights',
        index: highlight.index,
        startSec: highlight.startSec,
        endSec: highlight.endSec,
        score: match.score,
        whyMatched: match.whyMatched,
        preview: highlight.quote ?? highlight.reason,
        keyframePath: null,
        metadata: {
          durationSec: roundTo(highlight.endSec - highlight.startSec) ?? 0,
        },
      });
    }
  }

  if (sections.includes('speakerTurns')) {
    for (const turn of report.speakerTurns.items) {
      const match = scoreSearchTextFields(normalizedQuery, queryTokens, [
        { field: 'label', value: turn.label, weight: 2 },
        { field: 'excerpt', value: turn.excerpt, weight: 3 },
        { field: 'audioCue', value: turn.audioCue, weight: 2 },
        { field: 'speakerId', value: turn.speakerId, weight: 2 },
        { field: 'dominantSegmentType', value: turn.dominantSegmentType, weight: 1 },
      ]);
      if (match.score <= 0) {
        continue;
      }

      candidates.push({
        sectionType: 'speakerTurns',
        index: turn.index,
        startSec: turn.startSec,
        endSec: turn.endSec,
        score: match.score,
        whyMatched: match.whyMatched,
        preview: `${turn.label} - ${turn.excerpt}`,
        keyframePath: null,
        metadata: {
          audioCue: turn.audioCue,
          durationSec: turn.durationSec,
          speakerId: turn.speakerId,
          wordCount: turn.wordCount,
          segmentCount: turn.segmentCount,
          dominantSegmentType: turn.dominantSegmentType,
        },
      });
    }
  }

  if (sections.includes('visual')) {
    for (const item of report.visual.items) {
      const match = scoreSearchTextFields(normalizedQuery, queryTokens, [
        { field: 'summary', value: item.summary, weight: 3 },
        { field: 'cameraAngle', value: item.cameraAngle, weight: 3 },
        { field: 'subjectPosition', value: item.subjectPosition, weight: 2 },
        { field: 'motionDirection', value: item.motionDirection, weight: 2 },
        { field: 'visualComplexity', value: String(item.visualComplexity), weight: 1 },
      ]);
      if (match.score <= 0) {
        continue;
      }

      candidates.push({
        sectionType: 'visual',
        index: item.shotIndex,
        startSec: item.startSec,
        endSec: item.endSec,
        score: match.score,
        whyMatched: match.whyMatched,
        preview: item.summary,
        keyframePath: item.keyframePath,
        metadata: {
          durationSec: item.durationSec,
          cameraAngle: item.cameraAngle,
          subjectPosition: item.subjectPosition,
          motionDirection: item.motionDirection,
          visualComplexity: item.visualComplexity,
        },
      });
    }

    for (const observation of report.visual.observations) {
      const match = scoreSearchTextFields(normalizedQuery, queryTokens, [
        { field: 'description', value: observation.description, weight: 4 },
        { field: 'subjects', value: observation.subjects, weight: 3 },
        { field: 'actions', value: observation.actions, weight: 3 },
        { field: 'setting', value: observation.setting, weight: 2 },
        { field: 'visibleText', value: observation.visibleText, weight: 3 },
        { field: 'objects', value: observation.objects, weight: 2 },
        { field: 'editUsefulness', value: observation.editUsefulness, weight: 2 },
      ]);
      if (match.score <= 0) {
        continue;
      }

      candidates.push({
        sectionType: 'visual',
        index: observation.observationIndex,
        startSec: observation.startSec,
        endSec: observation.endSec,
        score: match.score,
        whyMatched: match.whyMatched,
        preview: observation.description,
        keyframePath: observation.imagePath,
        metadata: {
          durationSec: roundTo(observation.endSec - observation.startSec) ?? 0,
          shotIndex: observation.shotIndex,
          description: observation.description,
          subjects: observation.subjects,
          actions: observation.actions,
          setting: observation.setting,
          visibleText: observation.visibleText,
          objects: observation.objects,
          editUsefulness: observation.editUsefulness,
          confidence: observation.confidence,
          provider: observation.provider,
        },
      });
    }
  }

  return candidates.sort((left, right) => right.score - left.score).slice(0, limit);
}

async function generateSourceAnalysisReportPayloadFromArgs(args: Record<string, unknown>) {
  return generateSourceAnalysisReportPayloadFromArgsWithOptions(args, { allowAnalyze: true });
}

async function generateSourceAnalysisReportPayloadFromArgsWithOptions(
  args: Record<string, unknown>,
  executionOptions: { allowAnalyze: boolean },
) {
  const assetId = args.assetId as string;
  if (!assetId) {
    throw new Error('assetId is required');
  }

  const asset = getAssetSnapshotById(assetId);
  if (!asset) {
    throw new Error(`Asset '${assetId}' not found`);
  }

  if (asset.kind !== 'video' || !asset.hasVideoStream) {
    throw new Error(
      'source analysis report tools currently support video assets with a video stream only.',
    );
  }

  const options = resolveAnalysisOptions(args);
  const refresh = args.refresh === true;
  const includeAnnotation = args.includeAnnotation !== false;
  const cachedBundle = refresh
    ? null
    : await invoke<AnalysisBundle | null>('get_analysis_bundle', { assetId });
  const reuseCached = cachedBundle ? bundleSatisfiesOptions(cachedBundle, options) : false;
  const fallbackBundle: AnalysisBundle = {
    assetId,
    shots: null,
    transcript: null,
    audioProfile: null,
    segments: null,
    frameAnalysis: null,
    contactSheet: null,
    metadata: {
      durationSec: asset.durationSec ?? 0,
      width: asset.videoWidth ?? null,
      height: asset.videoHeight ?? null,
      fps: asset.videoFps ?? null,
      codec: asset.videoCodec ?? null,
      hasAudio: asset.hasAudioStream,
    },
    analyzedAt: 'unknown',
    errors: {},
  };
  const bundle = cachedBundle
    ? reuseCached || !executionOptions.allowAnalyze
      ? cachedBundle
      : await invoke<AnalysisBundle>('analyze_video_full', { assetId, options })
    : executionOptions.allowAnalyze
      ? await invoke<AnalysisBundle>('analyze_video_full', { assetId, options })
      : fallbackBundle;

  let annotation: AssetAnnotation | null = null;
  if (includeAnnotation) {
    try {
      const annotationResponse = await invoke<GetAnnotationResponse>('get_annotation', { assetId });
      annotation = annotationResponse.annotation;
    } catch (error) {
      logger.warn('generate_source_analysis_report could not load annotation', {
        assetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return buildSourceAnalysisReportPayload({
    asset,
    bundle,
    annotation,
    bundleSource:
      !executionOptions.allowAnalyze ||
      (cachedBundle && (reuseCached || !executionOptions.allowAnalyze))
        ? 'cached'
        : 'generated',
  });
}

async function searchSourceLibraryMatches(args: Record<string, unknown>) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    throw new Error('query is required');
  }

  const rawSections = Array.isArray(args.sections)
    ? args.sections.filter(
        (value): value is SourceAnalysisSection =>
          value === 'moments' ||
          value === 'chapters' ||
          value === 'highlights' ||
          value === 'speakerTurns' ||
          value === 'visual',
      )
    : [];
  const sections: SourceAnalysisSection[] =
    rawSections.length > 0
      ? rawSections
      : ['moments', 'chapters', 'highlights', 'speakerTurns', 'visual'];
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
      ? Math.min(Math.floor(args.limit), 50)
      : 8;
  const assetLimit =
    typeof args.assetLimit === 'number' && Number.isFinite(args.assetLimit) && args.assetLimit > 0
      ? Math.min(Math.floor(args.assetLimit), 100)
      : 20;
  const analyzeMissing = args.analyzeMissing === true;
  const candidateAssets = getCandidateSourceAssets(args, assetLimit);
  let skippedAssetCount = 0;
  const skippedAssets: SourceLibrarySkip[] = [];

  const allMatches: SourceLibraryMatch[] = [];

  for (const asset of candidateAssets) {
    try {
      const report = await generateSourceAnalysisReportPayloadFromArgsWithOptions(
        {
          ...args,
          assetId: asset.id,
          refresh: analyzeMissing ? args.refresh : false,
        } as Record<string, unknown>,
        { allowAnalyze: analyzeMissing },
      );
      const matches = searchSourceAnalysisReport(report, query, sections, limit);
      for (const match of matches) {
        allMatches.push({
          assetId: asset.id,
          assetName: asset.name,
          onTimeline: asset.onTimeline,
          timelineClipCount: asset.timelineClipCount,
          ...match,
        });
      }
    } catch (error) {
      skippedAssetCount += 1;
      const reason = error instanceof Error ? error.message : String(error);
      skippedAssets.push({
        assetId: asset.id,
        assetName: asset.name,
        reason,
      });
      logger.warn('search_source_library skipped asset', {
        assetId: asset.id,
        error: reason,
      });
    }
  }

  const matches = rerankSourceLibraryMatches(allMatches, query).slice(0, limit);

  return {
    query,
    sections,
    searchedAssetCount: candidateAssets.length,
    skippedAssetCount,
    skippedAssets,
    count: matches.length,
    matches,
  };
}

function getCandidateSourceAssets(args: Record<string, unknown>, assetLimit: number) {
  const requestedAssetIds = Array.isArray(args.assetIds)
    ? new Set(args.assetIds.filter((value): value is string => typeof value === 'string'))
    : null;

  return getAssetCatalogSnapshot()
    .assets.filter((asset) => asset.kind === 'video' && asset.hasVideoStream)
    .filter((asset) => (requestedAssetIds ? requestedAssetIds.has(asset.id) : true))
    .filter((asset) => (args.unusedOnly === true ? !asset.onTimeline : true))
    .slice(0, assetLimit);
}

async function searchIndexedSourceLibraryMatches(args: Record<string, unknown>) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    throw new Error('query is required');
  }

  const rawSections = Array.isArray(args.sections)
    ? args.sections.filter(
        (value): value is SourceAnalysisSection =>
          value === 'moments' ||
          value === 'chapters' ||
          value === 'highlights' ||
          value === 'speakerTurns' ||
          value === 'visual',
      )
    : [];
  const sections: SourceAnalysisSection[] =
    rawSections.length > 0
      ? rawSections
      : ['moments', 'chapters', 'highlights', 'speakerTurns', 'visual'];
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
      ? Math.min(Math.floor(args.limit), 50)
      : 8;
  const assetLimit =
    typeof args.assetLimit === 'number' && Number.isFinite(args.assetLimit) && args.assetLimit > 0
      ? Math.min(Math.floor(args.assetLimit), 100)
      : 20;
  const analyzeMissing = args.analyzeMissing === true;
  const useSemantic = args.useSemantic === true;
  const candidateAssets = getCandidateSourceAssets(args, assetLimit);
  const skippedAssets: SourceLibrarySkip[] = [];

  for (const asset of candidateAssets) {
    try {
      const report = await generateSourceAnalysisReportPayloadFromArgsWithOptions(
        {
          ...args,
          assetId: asset.id,
          refresh: analyzeMissing ? args.refresh : false,
        } as Record<string, unknown>,
        { allowAnalyze: analyzeMissing },
      );
      await indexSourceReportChunks(report);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skippedAssets.push({ assetId: asset.id, assetName: asset.name, reason });
      logger.warn('search_indexed_source_library skipped asset', {
        assetId: asset.id,
        error: reason,
      });
    }
  }

  const searchResponse = await invoke<IndexedSourceReportSearchResponse>(
    'search_source_report_chunks',
    {
      query: {
        query,
        assetIds: candidateAssets
          .map((asset) => asset.id)
          .filter((assetId) => !skippedAssets.some((skipped) => skipped.assetId === assetId)),
        sections,
        limit: Math.min(limit * 5, 100),
        useSemantic,
      },
    },
  );

  const catalogById = new Map(getAssetCatalogSnapshot().assets.map((asset) => [asset.id, asset]));
  const rawMatches: SourceLibraryMatch[] = searchResponse.results
    .map((result) => {
      const asset = catalogById.get(result.assetId);
      return {
        assetId: result.assetId,
        assetName: asset?.name ?? result.assetId,
        onTimeline: asset?.onTimeline ?? false,
        timelineClipCount: asset?.timelineClipCount ?? 0,
        sectionType: result.sectionType,
        index: result.sectionIndex,
        startSec: result.startSec,
        endSec: result.endSec,
        score: result.score,
        whyMatched: ['indexed report chunk match'],
        preview:
          typeof result.metadata.preview === 'string' && result.metadata.preview.length > 0
            ? result.metadata.preview
            : result.searchText,
        keyframePath:
          typeof result.metadata.keyframePath === 'string' ? result.metadata.keyframePath : null,
        metadata: result.metadata,
      };
    })
    .filter((match) => match.assetId.length > 0);

  const memoryEntries = await loadRetrievalMemoryEntries();
  const matches = applyRetrievalMemoryBoosts(
    rerankSourceLibraryMatches(rawMatches, query),
    memoryEntries,
  ).slice(0, limit);

  return {
    query,
    sections,
    searchedAssetCount: candidateAssets.length,
    skippedAssetCount: skippedAssets.length,
    skippedAssets,
    totalIndexedMatches: searchResponse.total,
    memoryEntryCount: memoryEntries.length,
    count: matches.length,
    matches,
    retrievalMode: (useSemantic ? 'indexedChunksHybrid' : 'indexedChunks') as
      | 'indexedChunks'
      | 'indexedChunksHybrid',
  };
}

function dedupeSourceLibraryMatches(
  matches: SourceLibraryMatch[],
  minimumSeparationSec: number,
): SourceLibraryMatch[] {
  const deduped: SourceLibraryMatch[] = [];

  for (const match of matches) {
    const overlapsExisting = deduped.some(
      (existing) =>
        existing.assetId === match.assetId &&
        overlapDuration(existing.startSec, existing.endSec, match.startSec, match.endSec) >
          minimumSeparationSec,
    );
    if (!overlapsExisting) {
      deduped.push(match);
    }
  }

  return deduped;
}

function deriveSelectQueryIntent(query: string): {
  dialogue: boolean;
  pause: boolean;
  visual: boolean;
  quote: boolean;
} {
  const normalized = normalizeSearchQuery(query);
  const tokens = tokenizeSearchQuery(query);
  const containsAny = (terms: string[]) =>
    terms.some((term) => normalized.includes(term) || tokens.includes(term));

  return {
    dialogue: containsAny([
      'interview',
      'question',
      'answer',
      'quote',
      'dialogue',
      'conversation',
      'spoken',
      'speech',
      'host',
      'guest',
      'narration',
      'talk',
    ]),
    pause: containsAny(['pause', 'silent', 'silence', 'quiet', 'breath', 'beat', 'gap']),
    visual: containsAny(['b-roll', 'broll', 'visual', 'shot', 'crowd', 'reaction shot']),
    quote: containsAny(['quote', 'line', 'soundbite', 'sound bite', 'statement']),
  };
}

function rerankSourceLibraryMatches(
  matches: SourceLibraryMatch[],
  query: string,
): SourceLibraryMatch[] {
  const intent = deriveSelectQueryIntent(query);

  return matches
    .map((match) => {
      let score = match.score;
      const rankingNotes: string[] = [];
      const durationSec = match.metadata?.durationSec ?? Math.max(0, match.endSec - match.startSec);
      const audioCue = match.metadata?.audioCue ?? null;

      if (intent.dialogue) {
        if (match.sectionType === 'speakerTurns') {
          score += 4.5;
          rankingNotes.push('dialogue query prefers speaker turns');
        } else if (match.sectionType === 'moments') {
          score -= 1;
          rankingNotes.push('dialogue query de-emphasizes broader moment summaries');
        }
        if (audioCue === 'speech-heavy') {
          score += 1.5;
          rankingNotes.push('speech-heavy moment');
        } else if (audioCue === 'spoken content') {
          score += 1;
          rankingNotes.push('spoken content moment');
        }
      }

      if (intent.quote && match.sectionType === 'speakerTurns') {
        score += 1.5;
        rankingNotes.push('quote query prefers coherent speaker turns');
      }

      if (intent.pause) {
        if (audioCue === 'long pause') {
          score += 3;
          rankingNotes.push('pause query prefers long pauses');
        } else if (audioCue === 'quiet gap') {
          score += 2.5;
          rankingNotes.push('pause query prefers quiet gaps');
        }
      } else {
        if (audioCue === 'long pause') {
          score -= 1.5;
          rankingNotes.push('long pause de-emphasized');
        } else if (audioCue === 'quiet gap') {
          score -= 1;
          rankingNotes.push('quiet gap de-emphasized');
        }
      }

      if (
        !intent.dialogue &&
        !intent.pause &&
        intent.visual &&
        match.sectionType === 'speakerTurns'
      ) {
        score -= 0.75;
        rankingNotes.push('visual query slightly de-emphasizes speaker turns');
      }

      if (intent.visual && match.sectionType === 'visual') {
        score += 2.5;
        rankingNotes.push('visual query prefers visual breakdown');
      }

      if (durationSec >= 3 && durationSec <= 12) {
        score += 1;
        rankingNotes.push('usable select duration');
      } else if (durationSec < 1) {
        score -= 1;
        rankingNotes.push('too short for most selects');
      } else if (durationSec > 20) {
        score -= 1;
        rankingNotes.push('too long for most selects');
      }

      if (!match.onTimeline) {
        score += 0.5;
        rankingNotes.push('unused asset diversity bonus');
      }
      if (match.timelineClipCount > 0) {
        score -= Math.min(match.timelineClipCount * 0.15, 0.75);
      }

      return {
        ...match,
        rawScore: match.score,
        score: roundTo(score, 3) ?? score,
        rankingNotes,
      };
    })
    .sort((left, right) => right.score - left.score);
}

function clampSelectRange(
  assetDurationSec: number | undefined,
  startSec: number,
  endSec: number,
): { sourceInSec: number; sourceOutSec: number; durationSec: number } {
  const boundedStart = Math.max(0, startSec);
  const boundedEnd = Math.max(
    boundedStart,
    assetDurationSec ? Math.min(endSec, assetDurationSec) : endSec,
  );
  return {
    sourceInSec: roundTo(boundedStart) ?? 0,
    sourceOutSec: roundTo(boundedEnd) ?? 0,
    durationSec: roundTo(boundedEnd - boundedStart) ?? 0,
  };
}

function buildSourceSelectSegments(
  matches: SourceLibraryMatch[],
  options: { paddingSec: number; gapSec: number },
) {
  const assetCatalog = getAssetCatalogSnapshot();
  const dedupedMatches = dedupeSourceLibraryMatches(matches, 0.25);
  let cursorSec = 0;

  return dedupedMatches.map((match, index) => {
    const asset = assetCatalog.assets.find((entry) => entry.id === match.assetId);
    const clampedRange = clampSelectRange(
      asset?.durationSec,
      match.startSec - options.paddingSec,
      match.endSec + options.paddingSec,
    );
    const select = {
      index,
      assetId: match.assetId,
      assetName: match.assetName,
      sectionType: match.sectionType,
      score: match.score,
      whyMatched: match.whyMatched,
      preview: match.preview,
      keyframePath: match.keyframePath,
      onTimeline: match.onTimeline,
      timelineClipCount: match.timelineClipCount,
      rawScore: match.rawScore ?? match.score,
      rankingNotes: match.rankingNotes ?? [],
      metadata: match.metadata,
      sourceInSec: clampedRange.sourceInSec,
      sourceOutSec: clampedRange.sourceOutSec,
      durationSec: clampedRange.durationSec,
      timelineStartSec: roundTo(cursorSec) ?? 0,
    };
    cursorSec += clampedRange.durationSec + options.gapSec;
    return select;
  });
}

function resolveSelectsSequence(sequenceId?: string) {
  const project = useProjectStore.getState();
  const resolvedSequenceId = sequenceId ?? getTimelineSnapshot().sequenceId ?? null;
  if (!resolvedSequenceId) {
    throw new Error('No active sequence found. Provide sequenceId to build or apply selects.');
  }

  const sequence = project.sequences.get(resolvedSequenceId);
  if (!sequence) {
    throw new Error(`Sequence '${resolvedSequenceId}' not found`);
  }

  return { sequenceId: resolvedSequenceId, sequence };
}

function resolveExistingSelectsTrack(options: {
  sequence: ReturnType<typeof resolveSelectsSequence>['sequence'];
  trackId?: string;
  trackName: string;
}) {
  if (options.trackId) {
    const track = options.sequence.tracks.find((entry) => entry.id === options.trackId);
    if (!track) {
      throw new Error(`Track '${options.trackId}' not found`);
    }
    if (track.kind !== 'video') {
      throw new Error('Selects can currently be applied to video tracks only.');
    }
    return track;
  }

  return (
    options.sequence.tracks.find(
      (entry) => entry.kind === 'video' && entry.name.trim() === options.trackName.trim(),
    ) ?? null
  );
}

async function ensureSelectsTrack(options: {
  sequenceId: string;
  trackId?: string;
  trackName: string;
}): Promise<{ trackId: string; createdTrack: boolean }> {
  const project = useProjectStore.getState();
  const sequence = project.sequences.get(options.sequenceId);
  if (!sequence) {
    throw new Error(`Sequence '${options.sequenceId}' not found`);
  }

  if (options.trackId) {
    const track = sequence.tracks.find((entry) => entry.id === options.trackId);
    if (!track) {
      throw new Error(`Track '${options.trackId}' not found`);
    }
    if (track.kind !== 'video') {
      throw new Error('Selects can currently be applied to video tracks only.');
    }

    return { trackId: track.id, createdTrack: false };
  }

  const existingTrack = sequence.tracks.find(
    (entry) => entry.kind === 'video' && entry.name.trim() === options.trackName.trim(),
  );
  if (existingTrack) {
    return { trackId: existingTrack.id, createdTrack: false };
  }

  const result = await executeAgentCommand('CreateTrack', {
    sequenceId: options.sequenceId,
    kind: 'video',
    name: options.trackName,
  });
  const createdTrackId = result.createdIds[0];
  if (!createdTrackId) {
    throw new Error('CreateTrack did not return a created track id');
  }

  return { trackId: createdTrackId, createdTrack: true };
}

async function rollbackInsertedSelectClips(
  sequenceId: string,
  trackId: string,
  clipIds: string[],
): Promise<string[]> {
  const rollbackFailures: string[] = [];

  for (const clipId of [...clipIds].reverse()) {
    try {
      await executeAgentCommand('RemoveClip', {
        sequenceId,
        trackId,
        clipId,
      });
    } catch (error) {
      rollbackFailures.push(error instanceof Error ? error.message : String(error));
    }
  }

  return rollbackFailures;
}

async function rollbackCreatedSelectsTrack(
  sequenceId: string,
  trackId: string,
): Promise<string | null> {
  try {
    await executeAgentCommand('RemoveTrack', {
      sequenceId,
      trackId,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function buildSourceAnalysisReportPayload({
  asset,
  bundle,
  annotation,
  bundleSource,
}: {
  asset: ReturnType<typeof getAssetSnapshotById>;
  bundle: AnalysisBundle;
  annotation: AssetAnnotation | null;
  bundleSource: 'cached' | 'generated';
}) {
  const annotationAnalysis = annotation?.analysis;
  const shots = hasValue(bundle.shots) ? bundle.shots : (annotationAnalysis?.shots?.results ?? []);
  const transcriptSegments = hasValue(bundle.transcript)
    ? bundle.transcript
    : (annotationAnalysis?.transcript?.results ?? []);
  const segments = bundle.segments ?? [];
  const frameAnalysis = bundle.frameAnalysis ?? [];
  const frameObservationItems = buildFrameObservationItems(bundle.frameObservations ?? [], shots);
  const visualItems = buildReportVisualItems(shots, frameAnalysis);
  const visualSemanticCoverage = resolveVisualSemanticCoverage(frameAnalysis, frameObservationItems);
  const keyframes = buildKeyframeGallery(shots);
  const audioProfile = bundle.audioProfile;
  const transcriptDetail = bundle.transcriptDetail ?? null;
  const transcriptDetailWords = transcriptDetail?.words ?? [];
  const transcriptDetailSpeakerSegments = (transcriptDetail?.speakerSegments ?? []).map(
    (segment, index) => ({
      index,
      startSec: roundTo(segment.startSec) ?? 0,
      endSec: roundTo(segment.endSec) ?? 0,
      speakerId: normalizeText(segment.speakerId),
      text: normalizeText(segment.text),
      confidence: roundTo(segment.confidence, 3),
    }),
  );
  const objectDetections = annotationAnalysis?.objects?.results ?? [];
  const faceDetections = annotationAnalysis?.faces?.results ?? [];
  const textDetections = annotationAnalysis?.textOcr?.results ?? [];
  const durationSec = Number.isFinite(bundle.metadata.durationSec)
    ? bundle.metadata.durationSec
    : (asset?.durationSec ?? 0);
  const width = bundle.metadata.width ?? asset?.videoWidth ?? null;
  const height = bundle.metadata.height ?? asset?.videoHeight ?? null;
  const fps = roundTo(bundle.metadata.fps ?? asset?.videoFps ?? null);
  const codec = bundle.metadata.codec ?? asset?.videoCodec ?? null;
  const shotDurations = shots.map((shot) => Math.max(0, shot.endSec - shot.startSec));
  const totalShotDuration = shotDurations.reduce((sum, value) => sum + value, 0);
  const silenceDurationSec =
    audioProfile?.silenceRegions.reduce(
      (sum, region) => sum + (region.endSec - region.startSec),
      0,
    ) ?? 0;
  const silenceRegions = audioProfile?.silenceRegions ?? [];
  const speechRegions = deriveSpeechRegions(audioProfile ?? null, durationSec);
  const speechDurationSec = speechRegions.reduce(
    (sum, region) => sum + (region.endSec - region.startSec),
    0,
  );
  const transcriptWordCountFromSegments = transcriptSegments.reduce((count, segment) => {
    const words = segment.text.trim().split(/\s+/).filter(Boolean).length;
    return count + words;
  }, 0);
  const transcriptFullText =
    typeof transcriptDetail?.full === 'string' && transcriptDetail.full.trim().length > 0
      ? normalizeText(transcriptDetail.full)
      : buildFullTranscriptText(transcriptSegments);
  const transcriptWordCount =
    transcriptDetailWords.length > 0
      ? transcriptDetailWords.length
      : transcriptWordCountFromSegments ||
        (transcriptFullText?.split(/\s+/).filter(Boolean).length ?? 0);
  const transcriptLanguages = Array.from(
    new Set(
      transcriptSegments
        .map((segment) => segment.language)
        .filter(
          (language): language is string => typeof language === 'string' && language.length > 0,
        ),
    ),
  );
  const transcriptLines = buildTranscriptLines(transcriptSegments);
  const speakerCount = new Set(
    [
      ...transcriptSegments.map((segment) => segment.speakerId),
      ...transcriptDetailSpeakerSegments.map((segment) => segment.speakerId),
    ]
      .filter(
        (speakerId): speakerId is string => typeof speakerId === 'string' && speakerId.length > 0,
      ),
  ).size;
  const speakerTurns = buildSpeakerTurns(
    transcriptSegments,
    speechRegions,
    silenceRegions,
    segments,
  );
  const segmentStats = new Map<string, { count: number; durationSec: number }>();

  for (const segment of segments) {
    const key = segment.segmentType;
    const current = segmentStats.get(key) ?? { count: 0, durationSec: 0 };
    current.count += 1;
    current.durationSec += Math.max(0, segment.endSec - segment.startSec);
    segmentStats.set(key, current);
  }

  const segmentDistribution = Array.from(segmentStats.entries())
    .map(([label, stats]) => ({
      label,
      count: stats.count,
      durationSec: roundTo(stats.durationSec) ?? 0,
      sharePercent: durationSec > 0 ? (roundTo((stats.durationSec / durationSec) * 100) ?? 0) : 0,
    }))
    .sort((left, right) => right.durationSec - left.durationSec);

  const topCameraAngles = collectTopCounts(
    frameAnalysis.map((entry) => entry.cameraAngle),
    4,
  );
  const topMotionDirections = collectTopCounts(
    frameAnalysis.map((entry) => entry.motionDirection),
    4,
  );
  const topObjectLabels = collectTopCounts(
    objectDetections.flatMap((entry) => entry.labels),
    6,
  );
  const ocrPreview = textDetections
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .slice(0, 5);
  const annotationProviders = Array.from(
    new Set(
      [
        annotationAnalysis?.shots?.provider,
        annotationAnalysis?.transcript?.provider,
        annotationAnalysis?.objects?.provider,
        annotationAnalysis?.faces?.provider,
        annotationAnalysis?.textOcr?.provider,
      ]
        .filter(hasValue)
        .map((provider) => formatProviderLabel(provider)),
    ),
  );
  const availableAnnotationTypes = [
    annotationAnalysis?.shots ? 'shots' : null,
    annotationAnalysis?.transcript ? 'transcript' : null,
    annotationAnalysis?.objects ? 'objects' : null,
    annotationAnalysis?.faces ? 'faces' : null,
    annotationAnalysis?.textOcr ? 'textOcr' : null,
  ].filter((value): value is string => typeof value === 'string');
  const chapters = buildReportChapters(shots, transcriptSegments, segments);
  const highlights = buildReportHighlights(
    transcriptSegments,
    shots,
    segments,
    objectDetections,
    textDetections,
    chapters,
  );
  const moments = buildReportMoments(
    shots,
    transcriptSegments,
    segments,
    speechRegions,
    silenceRegions,
    objectDetections,
    faceDetections,
    textDetections,
    frameAnalysis,
  );
  const warnings = Object.entries(bundle.errors ?? {}).map(
    ([analysisType, message]) => `${analysisType}: ${message}`,
  );

  if (transcriptSegments.length === 0 && !transcriptFullText) {
    warnings.push(
      'Transcript data is missing. Enable transcript analysis for searchable dialogue.',
    );
  }

  if (frameAnalysis.length === 0 && frameObservationItems.length === 0) {
    warnings.push(
      'Visual composition analysis is missing. Enable visual analysis for framing and motion cues.',
    );
  } else if (visualSemanticCoverage === 'local_fallback') {
    warnings.push(
      'Visual semantic analysis is local fallback only. Frame descriptions contain composition metrics, not true scene understanding.',
    );
  }

  if (!annotation) {
    warnings.push('Annotation data is missing. Object, face, and OCR summaries may be incomplete.');
  }

  const coverage = {
    shots: shots.length > 0,
    transcript: transcriptSegments.length > 0 || Boolean(transcriptFullText),
    audio: hasValue(audioProfile),
    segments: segments.length > 0,
    visual: frameAnalysis.length > 0 || frameObservationItems.length > 0,
    annotation: Boolean(annotation),
  };
  const report = {
    reportVersion: '1.0',
    assetId: bundle.assetId,
    assetName: asset?.name ?? bundle.assetId,
    assetKind: asset?.kind ?? 'video',
    assetUri: asset?.uri ?? '',
    assetRelativePath: asset?.relativePath ?? null,
    generatedAt: new Date().toISOString(),
    analyzedAt: bundle.analyzedAt,
    bundleSource,
    summary: '',
    coverage,
    metadata: {
      durationSec: roundTo(durationSec),
      durationLabel: formatDurationLabel(durationSec),
      width,
      height,
      fps,
      codec,
      hasAudio: bundle.metadata.hasAudio,
      hasVideoStream: asset?.hasVideoStream ?? width !== null,
      hasAudioStream: bundle.metadata.hasAudio || (asset?.hasAudioStream ?? false),
      onTimeline: asset?.onTimeline ?? false,
      timelineClipCount: asset?.timelineClipCount ?? 0,
    },
    shots: {
      count: shots.length,
      averageDurationSec:
        shotDurations.length > 0 ? roundTo(totalShotDuration / shotDurations.length) : null,
      minDurationSec: shotDurations.length > 0 ? roundTo(Math.min(...shotDurations)) : null,
      maxDurationSec: shotDurations.length > 0 ? roundTo(Math.max(...shotDurations)) : null,
      firstShots: shots.slice(0, 8).map((shot, index) => ({
        index,
        startSec: roundTo(shot.startSec),
        endSec: roundTo(shot.endSec),
        durationSec: roundTo(shot.endSec - shot.startSec),
        confidence: roundTo(shot.confidence, 3),
        keyframePath: shot.keyframePath ?? null,
        keyframeSelectionMethod: shot.keyframeSelectionMethod ?? null,
      })),
    },
    transcript: {
      segmentCount: transcriptSegments.length,
      wordCount: transcriptWordCount,
      speakerCount,
      speakerTurnCount: speakerTurns.length,
      speakerSegmentCount: transcriptDetailSpeakerSegments.length,
      wordTimingCount: transcriptDetailWords.length,
      provider: transcriptDetail?.provider ?? null,
      languages: transcriptLanguages,
      excerpt: buildTranscriptExcerpt(transcriptSegments),
      fullText: transcriptFullText,
      segments: transcriptLines,
      speakerSegments: transcriptDetailSpeakerSegments,
      firstSegments: transcriptSegments.slice(0, 8).map((segment, index) => ({
        index,
        startSec: roundTo(segment.startSec),
        endSec: roundTo(segment.endSec),
        text: segment.text,
        confidence: roundTo(segment.confidence, 3),
        speakerId: segment.speakerId ?? null,
        speakerTurnId: segment.speakerTurnId ?? null,
      })),
    },
    audio: {
      hasAudioProfile: hasValue(audioProfile),
      bpm: roundTo(audioProfile?.bpm),
      peakDb: roundTo(audioProfile?.peakDb),
      spectralCentroidHz: roundTo(audioProfile?.spectralCentroidHz),
      silenceRegionCount: silenceRegions.length,
      silenceDurationSec: roundTo(silenceDurationSec) ?? 0,
      silenceSharePercent:
        durationSec > 0 ? (roundTo((silenceDurationSec / durationSec) * 100) ?? 0) : 0,
      speechRegionCount: speechRegions.length,
      speechDurationSec: roundTo(speechDurationSec) ?? 0,
      speechSharePercent:
        durationSec > 0 ? (roundTo((speechDurationSec / durationSec) * 100) ?? 0) : 0,
      longestSpeechRegionSec:
        speechRegions.length > 0
          ? roundTo(Math.max(...speechRegions.map((region) => region.endSec - region.startSec)))
          : null,
      longestSilenceRegionSec:
        silenceRegions.length > 0
          ? roundTo(Math.max(...silenceRegions.map((region) => region.endSec - region.startSec)))
          : null,
      firstSpeechRegions: speechRegions.slice(0, 6).map((region, index) => ({
        index,
        startSec: roundTo(region.startSec),
        endSec: roundTo(region.endSec),
        durationSec: roundTo(region.endSec - region.startSec),
      })),
      loudnessSampleCount: audioProfile?.loudnessProfile.length ?? 0,
    },
    segments: {
      count: segments.length,
      distribution: segmentDistribution,
      firstSegments: segments.slice(0, 8).map((segment, index) => ({
        index,
        type: segment.segmentType,
        startSec: roundTo(segment.startSec),
        endSec: roundTo(segment.endSec),
        durationSec: roundTo(segment.endSec - segment.startSec),
        confidence: roundTo(segment.confidence, 3),
      })),
    },
    visual: {
      sampleCount: frameAnalysis.length,
      observationCount: frameObservationItems.length,
      averageComplexity:
        frameAnalysis.length > 0
          ? roundTo(
              frameAnalysis.reduce((sum, entry) => sum + entry.visualComplexity, 0) /
                frameAnalysis.length,
            )
          : null,
      topCameraAngles,
      topMotionDirections,
      contactSheet: bundle.contactSheet ?? null,
      semanticCoverage: visualSemanticCoverage,
      keyframes,
      items: visualItems,
      observations: frameObservationItems,
    },
    moments: {
      count: moments.length,
      items: moments,
    },
    chapters: {
      count: chapters.length,
      items: chapters,
    },
    highlights: {
      count: highlights.length,
      items: highlights,
    },
    speakerTurns: {
      count: speakerTurns.length,
      items: speakerTurns,
    },
    annotations: {
      availableTypes: availableAnnotationTypes,
      providers: annotationProviders,
      objectDetectionCount: objectDetections.length,
      faceDetectionCount: faceDetections.length,
      ocrTextCount: textDetections.length,
      topObjectLabels,
      ocrPreview,
      updatedAt: annotation?.updatedAt ?? null,
    },
    warnings,
    errors: bundle.errors ?? {},
  };

  const reportWithQuality = {
    ...report,
    quality: buildSourceReportQuality(report),
  };
  const semantic = buildSemanticReportData(report);
  return {
    ...reportWithQuality,
    summary: semantic.summaryLine,
    semantic,
  };
}

function buildSourceAnalysisMarkdown(
  report: ReturnType<typeof buildSourceAnalysisReportPayload>,
): string {
  const lines = [
    `# Source Analysis Report: ${report.assetName}`,
    '',
    `- Asset ID: ${report.assetId}`,
    `- Bundle source: ${report.bundleSource}`,
    `- Generated at: ${report.generatedAt}`,
    `- Summary: ${report.summary}`,
  ];

  const semantic = report.semantic;
  const quality = report.quality;

  lines.push(
    '',
    '## Analysis Quality',
    '',
    `- Status: ${quality.status}`,
    `- Score: ${quality.score}/100`,
    `- Critical signals: ${
      quality.criticalSignals.length > 0 ? quality.criticalSignals.join(', ') : 'none'
    }`,
    `- Missing signals: ${
      quality.missingSignals.length > 0 ? quality.missingSignals.join(', ') : 'none'
    }`,
    `- Degraded signals: ${
      quality.degradedSignals.length > 0 ? quality.degradedSignals.join(', ') : 'none'
    }`,
  );

  if (quality.recommendedActions.length > 0) {
    lines.push('', '### Recommended Follow-Up', '');
    for (const action of quality.recommendedActions) {
      lines.push(`- ${action}`);
    }
  }

  if (
    semantic.whatIsHappening.length > 0 ||
    semantic.whoIsPresent.length > 0 ||
    semantic.whatIsHeard.length > 0 ||
    semantic.onScreenText.length > 0 ||
    semantic.likelySetting.length > 0 ||
    semantic.usefulMoments.length > 0
  ) {
    lines.push('', '## Executive Summary', '');

    for (const bullet of semantic.whatIsHappening) {
      lines.push(`- What is happening: ${bullet}`);
    }

    for (const bullet of semantic.whoIsPresent) {
      lines.push(`- Who is present: ${bullet}`);
    }

    for (const bullet of semantic.whatIsHeard) {
      lines.push(`- What is heard: ${bullet}`);
    }

    for (const bullet of semantic.onScreenText) {
      lines.push(`- On-screen text: ${bullet}`);
    }

    for (const bullet of semantic.likelySetting) {
      lines.push(`- Likely setting: ${bullet}`);
    }

    for (const moment of semantic.usefulMoments.slice(0, 3)) {
      lines.push(
        `- Best usable moment: ${formatTimecode(moment.startSec)}-${formatTimecode(moment.endSec)} | ${moment.kind} | ${moment.summary}`,
      );
    }
  }

  if (semantic.sceneTimeline.length > 0) {
    lines.push('', '## Scene Timeline', '');
    for (const scene of semantic.sceneTimeline) {
      lines.push(
        `- ${formatTimecode(scene.startSec)}-${formatTimecode(scene.endSec)} | ${scene.title} | ${scene.summary}`,
      );
      if (scene.keyframePath) {
        lines.push(`- Keyframe: ${scene.keyframePath}`);
        lines.push(formatMarkdownImage(`${scene.title} keyframe`, scene.keyframePath));
      }
    }
  }

  if (semantic.usefulMoments.length > 0) {
    lines.push('', '## Useful Moments', '');
    for (const moment of semantic.usefulMoments) {
      lines.push(
        `- ${formatTimecode(moment.startSec)}-${formatTimecode(moment.endSec)} | ${moment.kind} | ${moment.summary}`,
      );
      if (moment.keyframePath) {
        lines.push(`- Keyframe: ${moment.keyframePath}`);
        lines.push(formatMarkdownImage(`${moment.kind} moment keyframe`, moment.keyframePath));
      }
      lines.push(`- Why it stands out: ${moment.reason}`);
    }
  }

  if (semantic.whoIsPresent.length > 0 || report.speakerTurns.count > 0) {
    lines.push('', '## Who Is Present', '');
    for (const bullet of semantic.whoIsPresent) {
      lines.push(`- ${bullet}`);
    }
    for (const turn of report.speakerTurns.items.slice(0, 4)) {
      lines.push(
        `- ${formatTimecode(turn.startSec)}-${formatTimecode(turn.endSec)} | ${turn.label} | ${turn.excerpt}`,
      );
    }
  }

  if (semantic.whatIsHeard.length > 0 || report.speakerTurns.count > 0) {
    lines.push('', '## What Is Heard', '');
    for (const bullet of semantic.whatIsHeard) {
      lines.push(`- ${bullet}`);
    }
  }

  if (semantic.onScreenText.length > 0) {
    lines.push('', '## On-Screen Text', '');
    for (const bullet of semantic.onScreenText) {
      lines.push(`- ${bullet}`);
    }
  }

  if (semantic.likelySetting.length > 0) {
    lines.push('', '## Visual / Setting Cues', '');
    for (const bullet of semantic.likelySetting) {
      lines.push(`- ${bullet}`);
    }
  }

  lines.push(
    '',
    '## File Info',
    '',
    `- Kind: ${report.assetKind}`,
    `- Duration: ${report.metadata.durationLabel}`,
    `- Resolution: ${report.metadata.width ?? 'unknown'} x ${report.metadata.height ?? 'unknown'}`,
    `- FPS: ${report.metadata.fps ?? 'unknown'}`,
    `- Codec: ${report.metadata.codec ?? 'unknown'}`,
    `- Audio stream: ${report.metadata.hasAudio ? 'yes' : 'no'}`,
    '',
    '## Coverage',
    '',
    `- Shots: ${report.coverage.shots ? 'available' : 'missing'}`,
    `- Transcript: ${report.coverage.transcript ? 'available' : 'missing'}`,
    `- Audio profile: ${report.coverage.audio ? 'available' : 'missing'}`,
    `- Segments: ${report.coverage.segments ? 'available' : 'missing'}`,
    `- Visual analysis: ${report.coverage.visual ? 'available' : 'missing'}`,
    `- Annotations: ${report.coverage.annotation ? 'available' : 'missing'}`,
    '',
    '## Shot Summary',
    '',
    `- Shot count: ${report.shots.count}`,
    `- Average duration: ${report.shots.averageDurationSec ?? 'unknown'}s`,
    `- Fastest shot: ${report.shots.minDurationSec ?? 'unknown'}s`,
    `- Longest shot: ${report.shots.maxDurationSec ?? 'unknown'}s`,
  );

  if (report.transcript.segmentCount > 0 || report.transcript.fullText) {
    lines.push('', '## Transcript Summary', '');
    const providerLabel = formatPerceptionProvider(report.transcript.provider);
    if (providerLabel) {
      lines.push(`- Provider: ${providerLabel}`);
    }
    lines.push(`- Segment count: ${report.transcript.segmentCount}`);
    lines.push(`- Estimated word count: ${report.transcript.wordCount}`);
    lines.push(`- Word timings: ${report.transcript.wordTimingCount}`);
    lines.push(`- Speakers detected: ${report.transcript.speakerCount}`);
    lines.push(`- Speaker turns: ${report.transcript.speakerTurnCount}`);
    lines.push(`- Speaker segments: ${report.transcript.speakerSegmentCount}`);
    lines.push(
      `- Languages: ${report.transcript.languages.length > 0 ? report.transcript.languages.join(', ') : 'unknown'}`,
    );
    if (report.transcript.excerpt) {
      lines.push(`- Excerpt: ${report.transcript.excerpt}`);
    }
  }

  if (report.transcript.segments.length > 0) {
    lines.push('', '## Full Transcript', '');
    for (const line of report.transcript.segments) {
      lines.push(
        `- ${formatTimecode(line.startSec)}-${formatTimecode(line.endSec)} | ${formatTranscriptSpeaker(line)} | ${line.text}`,
      );
    }
  } else if (report.transcript.fullText) {
    lines.push('', '## Full Transcript', '', report.transcript.fullText);
  }

  if (report.transcript.speakerSegments.length > 0) {
    lines.push('', '## Speaker-Aware Transcript Segments', '');
    for (const segment of report.transcript.speakerSegments.slice(0, 24)) {
      lines.push(
        `- ${formatTimecode(segment.startSec)}-${formatTimecode(segment.endSec)} | ${segment.speakerId || 'unknown speaker'} | ${segment.text}`,
      );
    }
    if (report.transcript.speakerSegments.length > 24) {
      lines.push(
        `- ... ${report.transcript.speakerSegments.length - 24} more speaker-aware transcript segments omitted from Markdown preview`,
      );
    }
  }

  if (report.moments.count > 0) {
    lines.push('', '## Moments', '');
    for (const moment of report.moments.items.slice(0, 12)) {
      lines.push(
        `- ${formatTimecode(moment.startSec)}-${formatTimecode(moment.endSec)} | ${moment.summary}`,
      );
      if (moment.keyframePath) {
        lines.push(`- Keyframe: ${moment.keyframePath}`);
      }
    }
    if (report.moments.count > 12) {
      lines.push(`- ... ${report.moments.count - 12} more moments omitted from Markdown preview`);
    }
  }

  if (report.coverage.audio) {
    lines.push('', '## Audio Summary', '');
    lines.push(`- BPM: ${report.audio.bpm ?? 'unknown'}`);
    lines.push(`- Peak dB: ${report.audio.peakDb ?? 'unknown'}`);
    lines.push(`- Spectral centroid: ${report.audio.spectralCentroidHz ?? 'unknown'} Hz`);
    lines.push(`- Silence regions: ${report.audio.silenceRegionCount}`);
    lines.push(`- Silence duration: ${report.audio.silenceDurationSec}s`);
    lines.push(`- Silence share: ${report.audio.silenceSharePercent}%`);
    lines.push(`- Speech regions: ${report.audio.speechRegionCount}`);
    lines.push(`- Speech duration: ${report.audio.speechDurationSec}s`);
    lines.push(`- Speech share: ${report.audio.speechSharePercent}%`);
    lines.push(`- Longest speech region: ${report.audio.longestSpeechRegionSec ?? 'unknown'}s`);
    lines.push(`- Longest silence region: ${report.audio.longestSilenceRegionSec ?? 'unknown'}s`);
  }

  if (report.speakerTurns.count > 0) {
    lines.push('', '## Speaker Turns', '');
    for (const turn of report.speakerTurns.items.slice(0, 8)) {
      lines.push(
        `- ${formatTimecode(turn.startSec)}-${formatTimecode(turn.endSec)} | ${turn.label} | ${turn.segmentCount} segments | ${turn.wordCount} words${turn.audioCue ? ` | ${turn.audioCue}` : ''}`,
      );
      lines.push(`- Excerpt: ${turn.excerpt}`);
    }
    if (report.speakerTurns.count > 8) {
      lines.push(
        `- ... ${report.speakerTurns.count - 8} more speaker turns omitted from Markdown preview`,
      );
    }
  }

  if (report.segments.distribution.length > 0) {
    lines.push('', '## Segment Mix', '');
    for (const segment of report.segments.distribution.slice(0, 6)) {
      lines.push(
        `- ${segment.label}: ${segment.count} segments, ${segment.durationSec}s (${segment.sharePercent}%)`,
      );
    }
  }

  if (report.visual.sampleCount > 0) {
    lines.push('', '## Visual Cues', '');
    lines.push(`- Frame samples analyzed: ${report.visual.sampleCount}`);
    lines.push(`- Average complexity: ${report.visual.averageComplexity ?? 'unknown'}`);
    if (report.visual.topCameraAngles.length > 0) {
      lines.push(
        `- Dominant camera angles: ${report.visual.topCameraAngles.map((entry) => `${entry.label} (${entry.count})`).join(', ')}`,
      );
    }
    if (report.visual.topMotionDirections.length > 0) {
      lines.push(
        `- Dominant motion: ${report.visual.topMotionDirections.map((entry) => `${entry.label} (${entry.count})`).join(', ')}`,
      );
    }
  }

  if (report.visual.items.length > 0) {
    lines.push('', '## Visual Breakdown', '');
    for (const item of report.visual.items.slice(0, VISUAL_BREAKDOWN_MARKDOWN_LIMIT)) {
      lines.push(
        `- ${formatTimecode(item.startSec)}-${formatTimecode(item.endSec)} | ${item.summary}`,
      );
      if (item.keyframePath) {
        lines.push(`- Keyframe: ${item.keyframePath}`);
        lines.push(formatMarkdownImage(`Shot ${item.shotIndex + 1} keyframe`, item.keyframePath));
      }
    }
    if (report.visual.items.length > VISUAL_BREAKDOWN_MARKDOWN_LIMIT) {
      lines.push(
        `- ... ${report.visual.items.length - VISUAL_BREAKDOWN_MARKDOWN_LIMIT} more visual entries omitted from Markdown preview`,
      );
    }
  }

  if (report.visual.observations.length > 0) {
    lines.push('', '## Frame Observations', '');
    for (const observation of report.visual.observations.slice(0, 24)) {
      lines.push(
        `- ${formatTimecode(observation.startSec)}-${formatTimecode(observation.endSec)} | Shot ${observation.shotIndex + 1} | ${observation.description || 'No description available'}`,
      );
      if (observation.subjects.length > 0) {
        lines.push(`- Subjects: ${observation.subjects.join(', ')}`);
      }
      if (observation.actions.length > 0) {
        lines.push(`- Actions: ${observation.actions.join(', ')}`);
      }
      if (observation.setting) {
        lines.push(`- Setting: ${observation.setting}`);
      }
      if (observation.visibleText.length > 0) {
        lines.push(`- Visible text: ${observation.visibleText.join(' | ')}`);
      }
      if (observation.objects.length > 0) {
        lines.push(`- Objects: ${observation.objects.join(', ')}`);
      }
      if (observation.editUsefulness) {
        lines.push(`- Edit usefulness: ${observation.editUsefulness}`);
      }
      const providerLabel = formatPerceptionProvider(observation.provider);
      if (providerLabel) {
        lines.push(
          `- Provider: ${providerLabel}${observation.confidence !== null ? ` | confidence ${observation.confidence}` : ''}`,
        );
      }
      if (observation.imagePath) {
        lines.push(`- Image: ${observation.imagePath}`);
        lines.push(
          formatMarkdownImage(`Shot ${observation.shotIndex + 1} observation`, observation.imagePath),
        );
      }
    }
    if (report.visual.observations.length > 24) {
      lines.push(
        `- ... ${report.visual.observations.length - 24} more frame observations omitted from Markdown preview`,
      );
    }
  }

  if (report.visual.contactSheet) {
    lines.push('', '## Visual Artifacts', '');
    lines.push(`- Contact sheet: ${report.visual.contactSheet.path}`);
    lines.push(formatMarkdownImage('Contact sheet', report.visual.contactSheet.path));
    lines.push(
      `- Layout: ${report.visual.contactSheet.frameCount} frames in ${report.visual.contactSheet.columns}x${report.visual.contactSheet.rows} grid`,
    );
  }

  if (report.visual.keyframes.length > 0) {
    lines.push('', '## Keyframe Gallery', '');
    for (const keyframe of report.visual.keyframes.slice(0, 24)) {
      lines.push(
        `- ${formatTimecode(keyframe.startSec)}-${formatTimecode(keyframe.endSec)} | ${keyframe.label}${keyframe.keyframeSelectionMethod ? ` | ${keyframe.keyframeSelectionMethod}` : ''}`,
      );
      lines.push(formatMarkdownImage(keyframe.label, keyframe.keyframePath));
    }
    if (report.visual.keyframes.length > 24) {
      lines.push(
        `- ... ${report.visual.keyframes.length - 24} more keyframes omitted from Markdown preview`,
      );
    }
  }

  if (report.chapters.count > 0) {
    lines.push('', '## Chapters', '');
    for (const chapter of report.chapters.items) {
      lines.push(
        `- ${formatTimecode(chapter.startSec)}-${formatTimecode(chapter.endSec)} | ${chapter.title} | ${chapter.shotCount} shots${chapter.dominantSegmentType ? ` | ${chapter.dominantSegmentType}` : ''}`,
      );
      lines.push(`- Summary: ${chapter.summary}`);
    }
  }

  if (report.highlights.count > 0) {
    lines.push('', '## Candidate Highlights', '');
    for (const highlight of report.highlights.items) {
      lines.push(
        `- ${formatTimecode(highlight.startSec)}-${formatTimecode(highlight.endSec)} | score ${highlight.score} | ${highlight.reason}`,
      );
      if (highlight.quote) {
        lines.push(`- Quote: ${highlight.quote}`);
      }
    }
  }

  if (report.annotations.availableTypes.length > 0 || report.annotations.objectDetectionCount > 0) {
    lines.push('', '## Annotation Signals', '');
    lines.push(
      `- Available types: ${report.annotations.availableTypes.length > 0 ? report.annotations.availableTypes.join(', ') : 'none'}`,
    );
    lines.push(
      `- Providers: ${report.annotations.providers.length > 0 ? report.annotations.providers.join(', ') : 'unknown'}`,
    );
    lines.push(`- Object detections: ${report.annotations.objectDetectionCount}`);
    lines.push(`- Face detections: ${report.annotations.faceDetectionCount}`);
    lines.push(`- OCR detections: ${report.annotations.ocrTextCount}`);
    if (report.annotations.topObjectLabels.length > 0) {
      lines.push(
        `- Top object labels: ${report.annotations.topObjectLabels.map((entry) => `${entry.label} (${entry.count})`).join(', ')}`,
      );
    }
    if (report.annotations.ocrPreview.length > 0) {
      lines.push(`- OCR preview: ${report.annotations.ocrPreview.join(' | ')}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join('\n');
}

function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function sanitizeReportFileStem(value: string): string {
  const sanitized = stripFileExtension(value)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return sanitized.length > 0 ? sanitized : 'source-analysis-report';
}

function normalizeWorkspaceRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').trim().replace(/^\.\//, '');
}

function buildSiblingSourceAnalysisReportRelativePath(relativePath: string): string {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  const fileName = segments.pop() ?? normalized;
  const stem = sanitizeReportFileStem(fileName);
  const reportFileName = `${stem}${SOURCE_ANALYSIS_REPORT_SUFFIX}`;
  return segments.length > 0 ? `${segments.join('/')}/${reportFileName}` : reportFileName;
}

function buildDefaultSourceAnalysisReportRelativePath(report: SourceAnalysisReport): string {
  if (typeof report.assetRelativePath === 'string' && report.assetRelativePath.trim().length > 0) {
    return buildSiblingSourceAnalysisReportRelativePath(report.assetRelativePath);
  }

  return `analysis-reports/${sanitizeReportFileStem(report.assetName || report.assetId)}${SOURCE_ANALYSIS_REPORT_SUFFIX}`;
}

function formatMarkdownImagePath(path: string): string {
  const normalized = path.trim();
  if (/[\s()]/.test(normalized)) {
    return `<${normalized.replace(/>/g, '%3E')}>`;
  }

  return normalized;
}

function formatMarkdownImage(alt: string, path: string): string {
  return `![${alt.replace(/\[|\]/g, '')}](${formatMarkdownImagePath(path)})`;
}

function formatTranscriptSpeaker(line: {
  speakerId: string | null;
  speakerTurnId: string | null;
}): string {
  if (line.speakerId) {
    return line.speakerId;
  }

  if (line.speakerTurnId) {
    return line.speakerTurnId;
  }

  return 'unknown speaker';
}

function formatPerceptionProvider(
  provider:
    | {
        provider?: string;
        model?: string;
        analyzedAt?: string;
      }
    | null
    | undefined,
): string | null {
  if (!provider) {
    return null;
  }

  const providerName =
    typeof provider.provider === 'string' && provider.provider.trim().length > 0
      ? provider.provider.trim()
      : 'unknown';
  const model =
    typeof provider.model === 'string' && provider.model.trim().length > 0
      ? provider.model.trim()
      : 'unknown';
  const analyzedAt =
    typeof provider.analyzedAt === 'string' && provider.analyzedAt.trim().length > 0
      ? provider.analyzedAt.trim()
      : null;

  return analyzedAt ? `${providerName}/${model} at ${analyzedAt}` : `${providerName}/${model}`;
}

async function persistSourceAnalysisMarkdownReport(
  report: SourceAnalysisReport,
  requestedOutputPath?: string | null,
): Promise<SourceAnalysisReportDocument> {
  const relativePath =
    typeof requestedOutputPath === 'string' && requestedOutputPath.trim().length > 0
      ? requestedOutputPath.trim()
      : buildDefaultSourceAnalysisReportRelativePath(report);
  const assetRelativePath =
    typeof report.assetRelativePath === 'string' && report.assetRelativePath.trim().length > 0
      ? report.assetRelativePath
      : null;

  if (
    assetRelativePath &&
    normalizeWorkspaceRelativePath(relativePath).toLowerCase() ===
      normalizeWorkspaceRelativePath(assetRelativePath).toLowerCase()
  ) {
    throw new Error('outputPath cannot overwrite the source asset');
  }

  const content = buildSourceAnalysisMarkdown(report);

  try {
    await writeWorkspaceDocumentToBackend(relativePath, content, true);

    try {
      const document = await readWorkspaceDocumentFromBackend(relativePath, {
        failureLogLevel: 'debug',
      });

      return {
        relativePath: document.relativePath,
        content: document.content,
        sizeBytes: document.sizeBytes,
        modifiedAtUnixSec: document.modifiedAtUnixSec,
        persisted: true,
        persistenceError: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Source analysis Markdown report was written but could not be re-read', {
        assetId: report.assetId,
        relativePath,
        error: message,
      });

      return {
        relativePath,
        content,
        sizeBytes: content.length,
        modifiedAtUnixSec: null,
        persisted: true,
        persistenceError: message,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to persist source analysis Markdown report', {
      assetId: report.assetId,
      relativePath,
      error: message,
    });

    return {
      relativePath,
      content,
      sizeBytes: content.length,
      modifiedAtUnixSec: null,
      persisted: false,
      persistenceError: message,
    };
  }
}

async function prepareSourceAnalysisReportArtifacts(
  args: Record<string, unknown>,
): Promise<{ report: SourceAnalysisReport; document: SourceAnalysisReportDocument }> {
  const report = await generateSourceAnalysisReportPayloadFromArgs(args);

  try {
    await indexSourceReportChunks(report);
  } catch (error) {
    logger.warn('source analysis report could not index report chunks', {
      assetId: report.assetId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const requestedOutputPath =
    typeof args.outputPath === 'string' && args.outputPath.trim().length > 0
      ? args.outputPath.trim()
      : null;
  const document = await persistSourceAnalysisMarkdownReport(report, requestedOutputPath);
  return { report, document };
}

async function resolveSourceAnalysisArgs(
  args: Record<string, unknown>,
): Promise<{ resolvedArgs: Record<string, unknown>; requestedFile: string | null }> {
  const assetId = typeof args.assetId === 'string' ? args.assetId.trim() : '';
  if (assetId.length > 0) {
    return { resolvedArgs: args, requestedFile: null };
  }

  const file = typeof args.file === 'string' ? args.file.trim() : '';
  if (file.length === 0) {
    throw new Error('assetId or file is required');
  }

  const resolved = await resolveWorkspaceAsset(file);
  return {
    resolvedArgs: {
      ...args,
      assetId: resolved.assetId,
    },
    requestedFile: resolved.relativePath,
  };
}

// =============================================================================
// Tool Definitions
// =============================================================================

const ANALYSIS_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Get Asset Catalog
  // ---------------------------------------------------------------------------
  {
    name: 'get_asset_catalog',
    description:
      'Get imported project assets with timeline usage status to discover source media not yet used on the timeline',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const result = getAssetCatalogSnapshot();
        logger.debug('get_asset_catalog executed', {
          totalAssetCount: result.totalAssetCount,
          unusedAssetCount: result.unusedAssetCount,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_asset_catalog failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Unused Assets
  // ---------------------------------------------------------------------------
  {
    name: 'get_unused_assets',
    description:
      'List imported assets that are currently unused on the active timeline, optionally filtered by media kind',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Optional asset kind filter: video, audio, or image',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const result = getUnusedAssets(args.kind as 'video' | 'audio' | 'image' | undefined);

        logger.debug('get_unused_assets executed', {
          kind: args.kind,
          count: result.length,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_unused_assets failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Asset Info
  // ---------------------------------------------------------------------------
  {
    name: 'get_asset_info',
    description:
      'Get detailed information about a single imported asset and whether it is currently used on timeline',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          description: 'The ID of the asset',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const result = getAssetSnapshotById(args.assetId as string);

        if (!result) {
          return { success: false, error: `Asset '${args.assetId}' not found` };
        }

        logger.debug('get_asset_info executed', { assetId: args.assetId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_asset_info failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Timeline Info
  // ---------------------------------------------------------------------------
  {
    name: 'get_timeline_info',
    description:
      'Get general information about the current timeline/sequence including duration, track count, clip count, and playhead position',
    category: 'analysis',
    outputContract: getToolOutputContract('get_timeline_info') ?? undefined,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const snapshot = getTimelineSnapshot();

        const result = {
          stateVersion: snapshot.stateVersion,
          sequenceId: snapshot.sequenceId,
          name: snapshot.sequenceName,
          duration: snapshot.duration,
          trackCount: snapshot.trackCount,
          clipCount: snapshot.clipCount,
          playheadPosition: snapshot.playheadPosition,
          selectedClipIds: snapshot.selectedClipIds,
          selectedTrackIds: snapshot.selectedTrackIds,
        };

        logger.debug('get_timeline_info executed', {
          sequenceId: snapshot.sequenceId,
          trackCount: snapshot.trackCount,
          clipCount: snapshot.clipCount,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_timeline_info failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Find Clips by Asset
  // ---------------------------------------------------------------------------
  {
    name: 'find_clips_by_asset',
    description: 'Find all clips in the timeline that use a specific asset',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          description: 'The ID of the asset to search for',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const result = findClipsByAsset(args.assetId as string);

        logger.debug('find_clips_by_asset executed', {
          assetId: args.assetId,
          found: result.length,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('find_clips_by_asset failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Find Gaps
  // ---------------------------------------------------------------------------
  {
    name: 'find_gaps',
    description: 'Find empty gaps in the timeline between clips',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        trackId: {
          type: 'string',
          description: 'The ID of the track to search (optional, searches all tracks if omitted)',
        },
        minDuration: {
          type: 'number',
          description: 'Minimum gap duration in seconds to report (default: 0)',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const result = findGaps(
          args.trackId as string | undefined,
          (args.minDuration as number | undefined) ?? 0,
        );

        logger.debug('find_gaps executed', { found: result.length });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('find_gaps failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Find Overlaps
  // ---------------------------------------------------------------------------
  {
    name: 'find_overlaps',
    description: 'Find overlapping clips in the timeline on the same track',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        trackId: {
          type: 'string',
          description: 'The ID of the track to search (optional, searches all tracks if omitted)',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const result = findOverlaps(args.trackId as string | undefined);

        logger.debug('find_overlaps executed', { found: result.length });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('find_overlaps failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Clip Info
  // ---------------------------------------------------------------------------
  {
    name: 'get_clip_info',
    description: 'Get detailed information about a specific clip',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        clipId: {
          type: 'string',
          description: 'The ID of the clip',
        },
      },
      required: ['clipId'],
    },
    handler: async (args) => {
      try {
        const result = getClipById(args.clipId as string);

        if (!result) {
          return { success: false, error: `Clip '${args.clipId}' not found` };
        }

        logger.debug('get_clip_info executed', { clipId: args.clipId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_clip_info failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // List All Clips
  // ---------------------------------------------------------------------------
  {
    name: 'list_all_clips',
    description: 'List all clips across all tracks with their positions and durations',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const snapshot = getTimelineSnapshot();

        logger.debug('list_all_clips executed', { clipCount: snapshot.clips.length });
        return { success: true, result: snapshot.clips };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('list_all_clips failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // List Tracks
  // ---------------------------------------------------------------------------
  {
    name: 'list_tracks',
    description: 'List all tracks with their type, clip count, and status',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const snapshot = getTimelineSnapshot();

        logger.debug('list_tracks executed', { trackCount: snapshot.tracks.length });
        return { success: true, result: snapshot.tracks };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('list_tracks failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Clips at Time
  // ---------------------------------------------------------------------------
  {
    name: 'get_clips_at_time',
    description: 'Find all clips that span a specific time point on the timeline',
    category: 'analysis',
    outputContract: getToolOutputContract('get_clips_at_time') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        time: {
          type: 'number',
          description: 'The time point in seconds to query',
        },
      },
      required: ['time'],
    },
    handler: async (args) => {
      try {
        const result = getClipsAtTime(args.time as number);

        logger.debug('get_clips_at_time executed', {
          time: args.time,
          found: result.length,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_clips_at_time failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Selected Clips
  // ---------------------------------------------------------------------------
  {
    name: 'get_selected_clips',
    description: 'Get full details of all currently selected clips',
    category: 'analysis',
    outputContract: getToolOutputContract('get_selected_clips') ?? undefined,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const snapshot = getTimelineSnapshot();
        const selectedSet = new Set(snapshot.selectedClipIds);
        const selectedClips = snapshot.clips.filter((c) => selectedSet.has(c.id));

        logger.debug('get_selected_clips executed', {
          selectedCount: selectedClips.length,
        });
        return { success: true, result: selectedClips };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_selected_clips failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Playhead Position
  // ---------------------------------------------------------------------------
  {
    name: 'get_playhead_position',
    description: 'Get the current playhead time position in seconds',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const snapshot = getTimelineSnapshot();

        logger.debug('get_playhead_position executed', {
          position: snapshot.playheadPosition,
        });
        return {
          success: true,
          result: {
            position: snapshot.playheadPosition,
            duration: snapshot.duration,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_playhead_position failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Track Clips
  // ---------------------------------------------------------------------------
  {
    name: 'get_track_clips',
    description: 'Get all clips on a specific track',
    category: 'analysis',
    outputContract: getToolOutputContract('get_track_clips') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        trackId: {
          type: 'string',
          description: 'The ID of the track',
        },
      },
      required: ['trackId'],
    },
    handler: async (args) => {
      try {
        const track = getTrackById(args.trackId as string);
        if (!track) {
          return { success: false, error: `Track '${args.trackId}' not found` };
        }

        const clips = getAllClipsOnTrack(args.trackId as string);

        logger.debug('get_track_clips executed', {
          trackId: args.trackId,
          clipCount: clips.length,
        });
        return { success: true, result: { track, clips } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_track_clips failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Workspace Files
  // ---------------------------------------------------------------------------
  {
    name: 'get_workspace_files',
    description:
      'List all media files in the project workspace folder. Returns files with their registration status (whether they are already imported as project assets). Use this to discover available media.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Optional filter: video, audio, or image',
        },
      },
      required: [],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const kind = args.kind as string | undefined;
        const validKinds = ['video', 'audio', 'image'];
        const filterKind =
          kind && validKinds.includes(kind) ? (kind as 'video' | 'audio' | 'image') : undefined;

        const files = getWorkspaceFiles(filterKind);
        logger.debug('get_workspace_files executed', { count: files.length });
        return { success: true, result: { files, count: files.length } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_workspace_files failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Find Workspace File
  // ---------------------------------------------------------------------------
  {
    name: 'find_workspace_file',
    description:
      'Find a specific file in the workspace by name or path pattern (case-insensitive substring match). Searches both file names and relative paths.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (file name or path substring)',
        },
      },
      required: ['query'],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const query = args.query as string;
        if (!query || typeof query !== 'string') {
          return { success: false, error: 'query parameter is required' };
        }

        const files = findWorkspaceFile(query);
        logger.debug('find_workspace_file executed', {
          query,
          resultCount: files.length,
        });
        return { success: true, result: { files, count: files.length } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('find_workspace_file failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Unregistered Files
  // ---------------------------------------------------------------------------
  {
    name: 'get_unregistered_files',
    description:
      'List workspace files that are NOT yet registered as project assets. These files exist in the project folder but have not been imported. Useful to discover new media to add to the timeline.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Optional filter: video, audio, or image',
        },
      },
      required: [],
    },
    handler: async (args: Record<string, unknown>) => {
      try {
        const kind = args.kind as string | undefined;
        const validKinds = ['video', 'audio', 'image'];
        const filterKind =
          kind && validKinds.includes(kind) ? (kind as 'video' | 'audio' | 'image') : undefined;

        const files = getUnregisteredWorkspaceFiles(filterKind);
        logger.debug('get_unregistered_files executed', { count: files.length });
        return { success: true, result: { files, count: files.length } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_unregistered_files failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Analyze Reference Video
  // ---------------------------------------------------------------------------
  {
    name: 'analyze_reference_video',
    description:
      'Run full analysis on a reference video (shots, audio, segments, visual) and return a summary bundle',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the reference video to analyze' },
        options: {
          type: 'object',
          description: 'Optional analysis flags passed to the backend pipeline',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual frame analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        if (!assetId) {
          return { success: false, error: 'assetId is required' };
        }
        const options = resolveAnalysisOptions(args as Record<string, unknown>);
        const bundle = await invoke<AnalysisBundle>('analyze_video_full', { assetId, options });
        const shotCount = bundle.shots?.length ?? 0;
        const segmentCount = bundle.segments?.length ?? 0;
        const hasAudio = bundle.audioProfile !== null;
        const hasTranscript = bundle.transcript !== null;
        const errorCount = Object.keys(bundle.errors ?? {}).length;
        logger.debug('analyze_reference_video completed', { assetId, shotCount });
        return {
          success: true,
          result: {
            assetId,
            shotCount,
            segmentCount,
            hasAudioProfile: hasAudio,
            hasTranscript,
            errorCount,
            analyzedAt: bundle.analyzedAt,
            summary: `Analyzed ${shotCount} shots, ${segmentCount} segments. Audio: ${hasAudio ? 'yes' : 'no'}, Transcript: ${hasTranscript ? 'yes' : 'no'}.${errorCount > 0 ? ` Partial failures: ${errorCount}.` : ''}`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('analyze_reference_video failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Read Source Analysis Report
  // ---------------------------------------------------------------------------
  {
    name: 'read_source_analysis_report',
    description:
      'Read the canonical Markdown source-analysis report for a video asset. If needed, generate or refresh the underlying analysis first and persist the report beside the asset by default (or to outputPath when provided)',
    category: 'analysis',
    outputContract: getToolOutputContract('read_source_analysis_report') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          description: 'Asset ID of the source video to inspect',
        },
        file: {
          type: 'string',
          description: 'Workspace-relative media path or filename to resolve into an asset',
        },
        outputPath: {
          type: 'string',
          description:
            'Optional workspace-relative Markdown output path. When omitted, the report is created next to the asset as <asset-name>.analysis.md',
        },
        refresh: {
          type: 'boolean',
          description: 'Force regeneration instead of reusing a compatible cached bundle',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
        options: {
          type: 'object',
          description: 'Optional analysis flags used if a new bundle must be generated',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const { resolvedArgs, requestedFile } = await resolveSourceAnalysisArgs(
          args as Record<string, unknown>,
        );
        const { report, document } = await prepareSourceAnalysisReportArtifacts(resolvedArgs);

        logger.debug('read_source_analysis_report completed', {
          assetId: report.assetId,
          requestedFile,
          persisted: document.persisted,
        });

        return {
          success: true,
          result: {
            assetId: report.assetId,
            assetName: report.assetName,
            requestedFile,
            content: document.content,
            relativePath: document.relativePath,
            reportPath: document.relativePath,
            sizeBytes: document.sizeBytes,
            modifiedAtUnixSec: document.modifiedAtUnixSec,
            persisted: document.persisted,
            persistenceError: document.persistenceError,
            bundleSource: report.bundleSource,
            generatedAt: report.generatedAt,
            summary: report.summary,
            metadata: report.metadata,
            coverage: report.coverage,
            quality: report.quality,
            sectionCounts: {
              moments: report.moments.count,
              chapters: report.chapters.count,
              highlights: report.highlights.count,
              speakerTurns: report.speakerTurns.count,
              visual: report.visual.items.length + report.visual.observations.length,
            },
            warnings: report.warnings,
            errors: report.errors,
            document,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('read_source_analysis_report failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Generate Source Analysis Report
  // ---------------------------------------------------------------------------
  {
    name: 'generate_source_analysis_report',
    description:
      'Build a rich source-footage analysis report for one asset by combining bundle, annotation, and asset metadata into JSON plus Markdown with moments, chapters, and candidate highlights. Also persists the Markdown report beside the asset by default.',
    category: 'analysis',
    outputContract: getToolOutputContract('generate_source_analysis_report') ?? undefined,
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the source video to inspect' },
        outputPath: {
          type: 'string',
          description:
            'Optional workspace-relative Markdown output path. When omitted, the report is created next to the asset as <asset-name>.analysis.md',
        },
        refresh: {
          type: 'boolean',
          description: 'Force regeneration instead of reusing a compatible cached bundle',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
        options: {
          type: 'object',
          description: 'Optional analysis flags used if a new bundle must be generated',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual frame analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const { report, document } = await prepareSourceAnalysisReportArtifacts(
          args as Record<string, unknown>,
        );

        logger.debug('generate_source_analysis_report completed', {
          assetId: report.assetId,
          bundleSource: report.bundleSource,
          shotCount: report.shots.count,
          transcriptSegments: report.transcript.segmentCount,
        });

        return {
          success: true,
          result: {
            ...report,
            content: document.content,
            relativePath: document.relativePath,
            markdown: document.content,
            reportPath: document.relativePath,
            sizeBytes: document.sizeBytes,
            modifiedAtUnixSec: document.modifiedAtUnixSec,
            persisted: document.persisted,
            persistenceError: document.persistenceError,
            document,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('generate_source_analysis_report failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Import External Diarization
  // ---------------------------------------------------------------------------
  {
    name: 'import_external_diarization',
    description:
      'Import external diarization JSON for a source asset and merge speaker IDs into the cached transcript bundle',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the source video to update' },
        inputPath: {
          type: 'string',
          description: 'Path to the diarization JSON file (absolute or project-relative)',
        },
      },
      required: ['assetId', 'inputPath'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        const inputPath = args.inputPath as string;
        if (!assetId) {
          return { success: false, error: 'assetId is required' };
        }
        if (!inputPath) {
          return { success: false, error: 'inputPath is required' };
        }

        const result = await invoke<{
          assetId: string;
          transcriptSegmentCount: number;
          speakerCount: number;
          speakerTurnCount: number;
        }>('import_diarization_json', {
          assetId,
          inputPath,
        });

        logger.debug('import_external_diarization completed', {
          assetId: result.assetId,
          speakerCount: result.speakerCount,
          speakerTurnCount: result.speakerTurnCount,
        });

        return {
          success: true,
          result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('import_external_diarization failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Run External Diarization
  // ---------------------------------------------------------------------------
  {
    name: 'run_external_diarization',
    description:
      'Run an external diarization executable against normalized source audio, then import the resulting diarization JSON into the cached transcript bundle',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the source video to update' },
        executable: {
          type: 'string',
          description: 'Executable path for the external diarization runner',
        },
        args: {
          type: 'array',
          description: 'Runner arguments. Supported placeholders: {audioPath} and {outputPath}',
          items: { type: 'string' },
        },
      },
      required: ['assetId', 'executable', 'args'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        const executable = args.executable as string;
        const runnerArgs = Array.isArray(args.args)
          ? args.args.filter((value): value is string => typeof value === 'string')
          : [];
        if (!assetId) {
          return { success: false, error: 'assetId is required' };
        }
        if (!executable) {
          return { success: false, error: 'executable is required' };
        }
        if (runnerArgs.length === 0) {
          return { success: false, error: 'args is required' };
        }

        const result = await invoke<{
          assetId: string;
          inputAudioPath: string;
          outputJsonPath: string;
          transcriptSegmentCount: number;
          speakerCount: number;
          speakerTurnCount: number;
        }>('run_external_diarization', {
          assetId,
          executable,
          args: runnerArgs,
        });

        logger.debug('run_external_diarization completed', {
          assetId: result.assetId,
          speakerCount: result.speakerCount,
          speakerTurnCount: result.speakerTurnCount,
        });

        return {
          success: true,
          result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('run_external_diarization failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Search Source Analysis Report
  // ---------------------------------------------------------------------------
  {
    name: 'search_source_analysis_report',
    description:
      'Search moments, chapters, highlights, speaker turns, and visual breakdown entries within a source analysis report to find the most relevant time ranges for a query',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the source video to inspect' },
        query: { type: 'string', description: 'Search text to match against report sections' },
        sections: {
          type: 'array',
          description:
            'Optional sections to search: moments, chapters, highlights, speakerTurns, visual',
          items: { type: 'string' },
        },
        limit: { type: 'number', description: 'Maximum number of matches to return (default: 5)' },
        refresh: {
          type: 'boolean',
          description: 'Force regeneration instead of reusing a compatible cached bundle',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
        options: {
          type: 'object',
          description: 'Optional analysis flags used if a new bundle must be generated',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual frame analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: ['assetId', 'query'],
    },
    handler: async (args) => {
      try {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) {
          return { success: false, error: 'query is required' };
        }

        const report = await generateSourceAnalysisReportPayloadFromArgs(
          args as Record<string, unknown>,
        );
        const rawSections = Array.isArray(args.sections)
          ? args.sections.filter(
              (value): value is SourceAnalysisSection =>
                value === 'moments' ||
                value === 'chapters' ||
                value === 'highlights' ||
                value === 'speakerTurns' ||
                value === 'visual',
            )
          : [];
        const sections: SourceAnalysisSection[] =
          rawSections.length > 0
            ? rawSections
            : ['moments', 'chapters', 'highlights', 'speakerTurns', 'visual'];
        const limit =
          typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.min(Math.floor(args.limit), 50)
            : 5;
        const matches = searchSourceAnalysisReport(report, query, sections, limit);

        logger.debug('search_source_analysis_report completed', {
          assetId: report.assetId,
          query,
          sections,
          matchCount: matches.length,
        });

        return {
          success: true,
          result: {
            assetId: report.assetId,
            assetName: report.assetName,
            query,
            sections,
            count: matches.length,
            matches,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('search_source_analysis_report failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Search Source Library
  // ---------------------------------------------------------------------------
  {
    name: 'search_source_library',
    description:
      'Search moments, chapters, highlights, speaker turns, and visual breakdown entries across multiple video assets to find the best source ranges for a query',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text to match against source analysis sections',
        },
        assetIds: {
          type: 'array',
          description: 'Optional asset IDs to restrict search scope',
          items: { type: 'string' },
        },
        unusedOnly: {
          type: 'boolean',
          description: 'Restrict search to assets not currently used on any timeline',
        },
        sections: {
          type: 'array',
          description:
            'Optional sections to search: moments, chapters, highlights, speakerTurns, visual',
          items: { type: 'string' },
        },
        limit: { type: 'number', description: 'Maximum number of matches to return (default: 8)' },
        assetLimit: {
          type: 'number',
          description: 'Maximum number of candidate assets to inspect (default: 20)',
        },
        analyzeMissing: {
          type: 'boolean',
          description:
            'Generate fresh analysis for assets without cached bundle data (default: false)',
        },
        useSemantic: {
          type: 'boolean',
          description: 'Use embedding-backed hybrid reranking on top of indexed report chunks',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
        options: {
          type: 'object',
          description: 'Optional analysis flags used if a new bundle must be generated',
        },
        shots: { type: 'boolean', description: 'Include shot detection (default: true)' },
        transcript: { type: 'boolean', description: 'Include transcript (default: true)' },
        audio: { type: 'boolean', description: 'Include audio profiling (default: true)' },
        segments: { type: 'boolean', description: 'Include content segmentation (default: true)' },
        visual: { type: 'boolean', description: 'Include visual frame analysis (default: true)' },
        localOnly: {
          type: 'boolean',
          description: 'Skip Vision API work and use local analysis where supported',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const result = await searchSourceLibraryMatches(args as Record<string, unknown>);

        logger.debug('search_source_library completed', {
          query: result.query,
          sections: result.sections,
          candidateAssetCount: result.searchedAssetCount,
          matchCount: result.count,
        });

        return {
          success: true,
          result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('search_source_library failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Search Indexed Source Library
  // ---------------------------------------------------------------------------
  {
    name: 'search_indexed_source_library',
    description:
      'Index source report chunks and search them through a backend hybrid lexical retrieval layer for faster library-wide source discovery',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text to match against indexed source report chunks',
        },
        assetIds: {
          type: 'array',
          description: 'Optional asset IDs to restrict search scope',
          items: { type: 'string' },
        },
        unusedOnly: {
          type: 'boolean',
          description: 'Restrict search to assets not currently used on any timeline',
        },
        sections: {
          type: 'array',
          description:
            'Optional sections to search: moments, chapters, highlights, speakerTurns, visual',
          items: { type: 'string' },
        },
        limit: { type: 'number', description: 'Maximum number of matches to return (default: 8)' },
        assetLimit: {
          type: 'number',
          description: 'Maximum number of candidate assets to inspect (default: 20)',
        },
        analyzeMissing: {
          type: 'boolean',
          description:
            'Generate fresh analysis for assets without cached bundle data (default: false)',
        },
        useSemantic: {
          type: 'boolean',
          description: 'Use embedding-backed hybrid reranking on top of indexed report chunks',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const result = await searchIndexedSourceLibraryMatches(args as Record<string, unknown>);

        logger.debug('search_indexed_source_library completed', {
          query: result.query,
          sections: result.sections,
          candidateAssetCount: result.searchedAssetCount,
          matchCount: result.count,
        });

        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('search_indexed_source_library failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Build Source Selects
  // ---------------------------------------------------------------------------
  {
    name: 'build_source_selects',
    description:
      'Turn ranked source matches, including speaker turns when relevant, into a timeline-ready selects stringout plan, and optionally apply it to a video track',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text used to find source candidates across the library',
        },
        sequenceId: {
          type: 'string',
          description: 'Optional target sequence ID for the selects plan',
        },
        trackId: {
          type: 'string',
          description: 'Optional target video track ID for applying selects',
        },
        trackName: {
          type: 'string',
          description: 'Target video track name when creating or reusing a selects track',
        },
        timelineStart: {
          type: 'number',
          description: 'Optional timeline start position for the first selects clip',
        },
        unusedOnly: {
          type: 'boolean',
          description: 'Restrict source search to assets not currently used on any timeline',
        },
        assetIds: {
          type: 'array',
          description: 'Optional asset IDs to restrict search scope',
          items: { type: 'string' },
        },
        sections: {
          type: 'array',
          description:
            'Optional sections to search: moments, chapters, highlights, speakerTurns, visual',
          items: { type: 'string' },
        },
        limit: {
          type: 'number',
          description: 'Number of selects to keep after dedupe (default: 6)',
        },
        assetLimit: {
          type: 'number',
          description: 'Maximum number of candidate assets to inspect (default: 20)',
        },
        paddingSec: {
          type: 'number',
          description:
            'Extra source padding to add before and after each matched range (default: 0.25)',
        },
        gapSec: {
          type: 'number',
          description: 'Gap between planned selects clips on the timeline (default: 0.25)',
        },
        analyzeMissing: {
          type: 'boolean',
          description:
            'Generate fresh analysis for assets without cached bundle data (default: false)',
        },
        useIndexedSearch: {
          type: 'boolean',
          description: 'Use indexed report-chunk retrieval instead of direct report scanning',
        },
        includeAnnotation: {
          type: 'boolean',
          description:
            'Include stored annotation/OCR/object summaries when available (default: true)',
        },
        apply: {
          type: 'boolean',
          description: 'Apply the selects stringout directly to the target sequence and track',
        },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const requestedSelectCount =
          typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.min(Math.floor(args.limit), 24)
            : 6;
        const paddingSec =
          typeof args.paddingSec === 'number' &&
          Number.isFinite(args.paddingSec) &&
          args.paddingSec >= 0
            ? args.paddingSec
            : 0.25;
        const gapSec =
          typeof args.gapSec === 'number' && Number.isFinite(args.gapSec) && args.gapSec >= 0
            ? args.gapSec
            : 0.25;
        const sourceSearchArgs = {
          ...args,
          analyzeMissing: args.analyzeMissing === true,
          limit: Math.min(requestedSelectCount * 3, 50),
        } as Record<string, unknown>;
        const searchResult =
          args.useIndexedSearch === true
            ? await searchIndexedSourceLibraryMatches(sourceSearchArgs)
            : await searchSourceLibraryMatches(sourceSearchArgs);
        const selects = buildSourceSelectSegments(searchResult.matches, {
          paddingSec,
          gapSec,
        }).slice(0, requestedSelectCount);

        const { sequenceId, sequence } = resolveSelectsSequence(
          typeof args.sequenceId === 'string' ? args.sequenceId : undefined,
        );
        const requestedTrackName =
          typeof args.trackName === 'string' && args.trackName.trim().length > 0
            ? args.trackName.trim()
            : 'Source Selects';
        const existingTrack = resolveExistingSelectsTrack({
          sequence,
          trackId: typeof args.trackId === 'string' ? args.trackId : undefined,
          trackName: requestedTrackName,
        });

        const timelinePlan: {
          sequenceId: string;
          targetTrackId: string | null;
          targetTrackName: string;
          timelineStartSec: number;
          gapSec: number;
          steps: Array<{
            action: string;
            assetId?: string;
            assetName?: string;
            timelineStartSec?: number;
            sourceInSec?: number;
            sourceOutSec?: number;
            trackId?: string | null;
            trackName?: string;
          }>;
        } = (() => {
          const timelineStart =
            typeof args.timelineStart === 'number' &&
            Number.isFinite(args.timelineStart) &&
            args.timelineStart >= 0
              ? args.timelineStart
              : existingTrack
                ? Math.max(
                    0,
                    ...existingTrack.clips.map(
                      (clip) => getClipTimelineEndSec(clip),
                    ),
                  )
                : 0;

          return {
            sequenceId,
            targetTrackId: existingTrack?.id ?? null,
            targetTrackName: requestedTrackName,
            timelineStartSec: roundTo(timelineStart) ?? 0,
            gapSec,
            steps: [
              ...(existingTrack ? [] : [{ action: 'add_track', trackName: requestedTrackName }]),
              ...selects.map((select) => ({
                action: 'insert_clip',
                assetId: select.assetId,
                assetName: select.assetName,
                timelineStartSec: select.timelineStartSec + timelineStart,
                sourceInSec: select.sourceInSec,
                sourceOutSec: select.sourceOutSec,
                trackId: existingTrack?.id ?? null,
                trackName: requestedTrackName,
              })),
            ],
          };
        })();

        let applied: {
          sequenceId: string;
          trackId: string | null;
          createdTrack: boolean;
          insertedClipCount: number;
        } | null = null;

        await saveRetrievalMemoryEntries(
          searchResult.query,
          selects.map((select) => ({
            assetId: select.assetId,
            sectionType: select.sectionType,
            index: select.index,
            sourceInSec: select.sourceInSec,
            sourceOutSec: select.sourceOutSec,
          })),
        );

        if (args.apply === true) {
          const { sequence } = resolveSelectsSequence(
            typeof args.sequenceId === 'string' ? args.sequenceId : undefined,
          );
          if (selects.length === 0) {
            applied = {
              sequenceId,
              trackId: existingTrack?.id ?? null,
              createdTrack: false,
              insertedClipCount: 0,
            };
          } else {
            const ensuredTrack = await ensureSelectsTrack({
              sequenceId,
              trackId: typeof args.trackId === 'string' ? args.trackId : undefined,
              trackName: requestedTrackName,
            });
            const refreshedSequence =
              useProjectStore.getState().sequences.get(sequenceId) ?? sequence;
            const targetTrack = refreshedSequence.tracks.find(
              (track) => track.id === ensuredTrack.trackId,
            );
            const baseTimelineStart =
              typeof args.timelineStart === 'number' &&
              Number.isFinite(args.timelineStart) &&
              args.timelineStart >= 0
                ? args.timelineStart
                : targetTrack
                  ? Math.max(
                      0,
                      ...targetTrack.clips.map(
                        (clip) => getClipTimelineEndSec(clip),
                      ),
                    )
                  : 0;
            const createdClipIds: string[] = [];

            try {
              for (const select of selects) {
                const result = await executeAgentCommand('InsertClip', {
                  sequenceId,
                  trackId: ensuredTrack.trackId,
                  assetId: select.assetId,
                  timelineStart: baseTimelineStart + select.timelineStartSec,
                  sourceIn: select.sourceInSec,
                  sourceOut: select.sourceOutSec,
                });
                const createdClipId = result.createdIds[0];
                if (!createdClipId) {
                  throw new Error('InsertClip did not return a created clip id');
                }
                createdClipIds.push(createdClipId);
              }
            } catch (error) {
              const rollbackFailures = await rollbackInsertedSelectClips(
                sequenceId,
                ensuredTrack.trackId,
                createdClipIds,
              );
              if (ensuredTrack.createdTrack) {
                const trackRollbackFailure = await rollbackCreatedSelectsTrack(
                  sequenceId,
                  ensuredTrack.trackId,
                );
                if (trackRollbackFailure) {
                  rollbackFailures.push(trackRollbackFailure);
                }
              }
              const message = error instanceof Error ? error.message : String(error);
              if (rollbackFailures.length > 0) {
                throw new Error(
                  `Failed to apply source selects: ${message}. Rollback failed for ${rollbackFailures.length} operation(s).`,
                );
              }
              throw new Error(
                `Failed to apply source selects: ${message}. Rolled back ${createdClipIds.length} clip(s).`,
              );
            }

            applied = {
              sequenceId,
              trackId: ensuredTrack.trackId,
              createdTrack: ensuredTrack.createdTrack,
              insertedClipCount: selects.length,
            };
          }
        }

        return {
          success: true,
          result: {
            query: searchResult.query,
            sections: searchResult.sections,
            searchedAssetCount: searchResult.searchedAssetCount,
            skippedAssetCount: searchResult.skippedAssetCount,
            skippedAssets: searchResult.skippedAssets,
            count: selects.length,
            selects,
            timelinePlan,
            applied,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('build_source_selects failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Generate Style Document
  // ---------------------------------------------------------------------------
  {
    name: 'generate_style_document',
    description:
      'Generate an Editing Style Document (ESD) from a previously analyzed reference video',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset ID of the analyzed reference video' },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const assetId = args.assetId as string;
        if (!assetId) {
          return { success: false, error: 'assetId is required' };
        }
        const existingEsd = await findExistingEsdForAsset(assetId);
        if (existingEsd) {
          logger.debug('generate_style_document reused existing ESD', {
            assetId,
            esdId: existingEsd.id,
          });
          return {
            success: true,
            result: buildStyleDocumentResult(existingEsd, 'existing_esd'),
          };
        }
        const cachedBundle = await invoke<AnalysisBundle | null>('get_analysis_bundle', {
          assetId,
        });
        const bundle =
          cachedBundle ??
          (await invoke<AnalysisBundle>('analyze_video_full', {
            assetId,
            options: resolveAnalysisOptions({}),
          }));
        const esd = await invoke<EditingStyleDocument>('generate_esd', { bundle });
        logger.debug('generate_style_document completed', { assetId, esdId: esd.id });
        return {
          success: true,
          result: buildStyleDocumentResult(esd, cachedBundle ? 'cached' : 'generated'),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('generate_style_document failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Compare Edit Structure
  // ---------------------------------------------------------------------------
  {
    name: 'compare_edit_structure',
    description:
      'Compare an ESD pacing curve with the current timeline to show structural similarity and differences',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        esdId: {
          type: 'string',
          description: 'ID of the Editing Style Document to compare against',
        },
      },
      required: ['esdId'],
    },
    handler: async (args) => {
      try {
        const esdId = args.esdId as string;
        if (!esdId) {
          return { success: false, error: 'esdId is required' };
        }
        const esd = await invoke<EditingStyleDocument | null>('get_esd', { esdId });
        if (!esd) {
          return { success: false, error: `ESD not found: ${esdId}` };
        }
        const snapshot = getTimelineSnapshot();
        if (!snapshot.sequenceId) {
          return { success: false, error: 'No active timeline found' };
        }

        const primaryTrackClips = getPrimaryTrackClips(
          snapshot.tracks.map((track) => ({
            id: track.id,
            kind: track.kind,
            visible: track.visible,
          })),
          snapshot.clips.map((clip) => ({
            trackId: clip.trackId,
            timelineInSec: clip.timelineIn,
            durationSec: clip.duration,
          })),
        );
        const outputDurations = primaryTrackClips.map((clip) => clip.durationSec);
        const refDurations = esd.rhythmProfile.shotDurations;
        const correlation = calculatePearsonCorrelation(refDurations, outputDurations);

        logger.debug('compare_edit_structure completed', { esdId, correlation });
        return {
          success: true,
          result: {
            esdId,
            esdName: esd.name,
            referenceShots: refDurations.length,
            outputShots: outputDurations.length,
            primaryTrackId: primaryTrackClips[0]?.trackId ?? null,
            correlation: Math.round(correlation * 1000) / 1000,
            correlationPercent: `${Math.round(correlation * 100)}%`,
            shotCountDiff: outputDurations.length - refDurations.length,
            summary: `Pacing correlation: ${Math.round(correlation * 100)}% — Reference: ${refDurations.length} shots, Output: ${outputDurations.length} shots on the primary video track.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('compare_edit_structure failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register all analysis tools with the global registry.
 */
export function registerAnalysisTools(): void {
  globalToolRegistry.registerMany(ANALYSIS_TOOLS);
  logger.info('Analysis tools registered', { count: ANALYSIS_TOOLS.length });
}

/**
 * Unregister all analysis tools from the global registry.
 */
export function unregisterAnalysisTools(): void {
  for (const tool of ANALYSIS_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Analysis tools unregistered', { count: ANALYSIS_TOOLS.length });
}

/**
 * Get the list of analysis tool names.
 */
export function getAnalysisToolNames(): string[] {
  return ANALYSIS_TOOLS.map((t) => t.name);
}

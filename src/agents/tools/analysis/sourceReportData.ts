/**
 * Analysis Tools - Source Report Data
 *
 * Source analysis report data model: content summaries, chapters, highlights,
 * moments, visual breakdowns, semantic report assembly, and the report payload builder.
 */

import { createLogger } from '@/services/logger';
import { invoke } from '@tauri-apps/api/core';
import type { AnalysisBundle, AnalysisOptions, AssetAnnotation } from '@/bindings';
import { useProjectStore } from '@/stores/projectStore';
import { getAssetSnapshotById } from '../storeAccessor';
import {
  type TimedRange,
  type TimedPoint,
  type TranscriptLikeSegment,
  type FrameObservationLike,
  type SegmentLike,
  roundTo,
  hasValue,
  normalizeText,
  formatDurationLabel,
  overlapDuration,
  countOverlappingRanges,
  countTimedPointsInRange,
  deriveSpeechRegions,
  buildAudioCue,
  uniqueStrings,
  formatNaturalList,
  quoteSnippet,
  humanizeSegmentType,
  collectTopCounts,
  buildTranscriptExcerpt,
  buildFullTranscriptText,
  buildTranscriptLines,
} from './shared';

import {
  buildPeopleSummary,
  buildTextSummary,
  buildVisualCueSummary,
  deriveSettingHints,
  buildAudioSummary,
  buildSceneLabel,
  buildSemanticMomentSummary,
} from './sourceContentSummary';

const logger = createLogger('AnalysisTools');

export type SourceAnalysisReport = ReturnType<typeof buildSourceAnalysisReportPayload>;

export type SourceAnalysisSection =
  | 'moments'
  | 'chapters'
  | 'highlights'
  | 'speakerTurns'
  | 'visual';

export type SourceAnalysisReportDocument = {
  relativePath: string;
  content: string;
  sizeBytes: number;
  modifiedAtUnixSec: number | null;
  persisted: boolean;
  persistenceError: string | null;
};

export type SourceReportChunk = {
  id: string;
  sectionType: SourceAnalysisSection;
  sectionIndex: number;
  startSec: number;
  endSec: number;
  searchText: string;
  metadata: Record<string, unknown>;
};

export type IndexedSourceReportChunkResult = {
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

export type IndexedSourceReportSearchResponse = {
  results: IndexedSourceReportChunkResult[];
  total: number;
  processingTimeMs: number;
};

export const SOURCE_ANALYSIS_REPORT_SUFFIX = '.analysis.md';

export const VISUAL_BREAKDOWN_MARKDOWN_LIMIT = 12;

export const SEMANTIC_SCENE_TIMELINE_LIMIT = 10;

export const SEMANTIC_USEFUL_MOMENT_LIMIT = 6;

export const SEMANTIC_OVERVIEW_LIMIT = 3;

export type RetrievalMemoryEntry = {
  assetId: string;
  sectionType: SourceAnalysisSection;
  sectionIndex: number;
  startSec: number;
  endSec: number;
  query: string;
  selectedAt: string;
};

export type SourceLibraryMatch = {
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

export type SourceLibrarySkip = {
  assetId: string;
  assetName: string;
  reason: string;
};

export type SemanticUsefulMomentKind =
  | 'quote'
  | 'action'
  | 'text'
  | 'reaction'
  | 'establishing'
  | 'pause';

export type ReportMoment = ReturnType<typeof buildReportMoments>[number];

export type ReportChapter = ReturnType<typeof buildReportChapters>[number];

export type ReportHighlight = ReturnType<typeof buildReportHighlights>[number];

export type ReportSpeakerTurn = ReturnType<typeof buildSpeakerTurns>[number];

export type SemanticReportInput = {
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

export type SemanticSceneTimelineItem = {
  index: number;
  startSec: number;
  endSec: number;
  title: string;
  summary: string;
  keyframePath: string | null;
};

export type SemanticUsefulMoment = {
  index: number;
  kind: SemanticUsefulMomentKind;
  startSec: number;
  endSec: number;
  summary: string;
  reason: string;
  keyframePath: string | null;
};

export type SemanticReportData = {
  summaryLine: string;
  whatIsHappening: string[];
  whoIsPresent: string[];
  whatIsHeard: string[];
  onScreenText: string[];
  likelySetting: string[];
  sceneTimeline: SemanticSceneTimelineItem[];
  usefulMoments: SemanticUsefulMoment[];
};

export function buildSourceReportChunks(report: SourceAnalysisReport): SourceReportChunk[] {
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

export async function indexSourceReportChunks(report: SourceAnalysisReport): Promise<void> {
  const chunks = buildSourceReportChunks(report);
  if (chunks.length === 0) {
    return;
  }

  await invoke('index_source_report_chunks', {
    assetId: report.assetId,
    chunks,
  });
}

export function getCurrentProjectId(): string | null {
  const meta = useProjectStore.getState().meta;
  return meta?.id ?? meta?.path ?? 'current-project';
}

export async function loadRetrievalMemoryEntries(): Promise<RetrievalMemoryEntry[]> {
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

export async function saveRetrievalMemoryEntries(
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

export function applyRetrievalMemoryBoosts(
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

export function endsSentence(text: string): boolean {
  return /[.!?]["')\]\u201d\u2019}]*$/.test(text.trimEnd());
}

export function dominantSpeechRegionIndex(
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

export function buildSpeakerTurns(
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

export function buildLabelFromText(text: string, fallback: string, maxWords = 8): string {
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

export function resolveDominantSegmentType(
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

export function buildTranscriptChapters(
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

export function buildSegmentChapters(
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

export function buildShotChapters(shots: TimedRange[]): Array<{
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

export function buildReportChapters(
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

export function buildReportHighlights(
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

export function buildReportMoments(
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

export function buildVisualDetailSummary(item: {
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

export function buildReportVisualItems(
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

export function buildFrameObservationItems(
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

export function isLocalVisualFallbackOnly(
  frameAnalysis: Array<{
    cameraAngle?: string | null;
    subjectPosition?: string | null;
    motionDirection?: string | null;
  }>,
): boolean {
  return frameAnalysis.length > 0;
}

export function resolveVisualSemanticCoverage(
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

export function buildKeyframeGallery(
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

export function buildSourceReportQuality(report: {
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

export function formatProviderLabel(provider: unknown): string {
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

export function bundleSatisfiesOptions(bundle: AnalysisBundle, options: AnalysisOptions): boolean {
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

export function truncateText(text: string, maxLength = 220): string {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

export function buildSceneTimelineTitle(chapter: ReportChapter, moment?: ReportMoment): string {
  if (moment?.sceneLabel) {
    return moment.sceneLabel;
  }

  const humanizedSegmentType = humanizeSegmentType(chapter.dominantSegmentType);
  if (humanizedSegmentType) {
    return buildLabelFromText(humanizedSegmentType, chapter.title, 6);
  }

  return chapter.title;
}

export function buildSceneTimelineSummary(
  chapter: ReportChapter,
  overlappingMoments: ReportMoment[],
): string {
  const primaryMoment = overlappingMoments[0];
  if (primaryMoment?.summary) {
    return truncateText(primaryMoment.summary, 260);
  }

  return truncateText(chapter.summary, 260);
}

export function classifyUsefulMomentKind(args: {
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

export function buildUsefulMomentSummary(args: {
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

export function buildSemanticReportData(report: SemanticReportInput): SemanticReportData {
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

export function buildSourceAnalysisReportPayload({
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
  const visualSemanticCoverage = resolveVisualSemanticCoverage(
    frameAnalysis,
    frameObservationItems,
  );
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
    ].filter(
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

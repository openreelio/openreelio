/**
 * Analysis Tools - Source Search & Selects
 *
 * Full-text search over source analysis reports, source library ranking/retrieval,
 * and selects (stringout) planning helpers.
 */

import { createLogger } from '@/services/logger';
import { invoke } from '@tauri-apps/api/core';
import type { AnalysisBundle, AssetAnnotation, GetAnnotationResponse } from '@/bindings';
import { useProjectStore } from '@/stores/projectStore';
import {
  getAssetCatalogSnapshot,
  getAssetSnapshotById,
  getTimelineSnapshot,
} from '../storeAccessor';
import { executeAgentCommand } from '../commandExecutor';
import { roundTo, overlapDuration, resolveAnalysisOptions } from './shared';
import {
  type SourceAnalysisReport,
  type SourceAnalysisSection,
  type SourceLibraryMatch,
  type SourceLibrarySkip,
  type IndexedSourceReportSearchResponse,
  buildSourceAnalysisReportPayload,
  bundleSatisfiesOptions,
  indexSourceReportChunks,
  loadRetrievalMemoryEntries,
  applyRetrievalMemoryBoosts,
} from './sourceReportData';

const logger = createLogger('AnalysisTools');

export function normalizeSearchQuery(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function tokenizeSearchQuery(text: string): string[] {
  return normalizeSearchQuery(text)
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function scoreSearchTextFields(
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

export function searchSourceAnalysisReport(
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

export async function generateSourceAnalysisReportPayloadFromArgs(args: Record<string, unknown>) {
  return generateSourceAnalysisReportPayloadFromArgsWithOptions(args, { allowAnalyze: true });
}

export async function generateSourceAnalysisReportPayloadFromArgsWithOptions(
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

export async function searchSourceLibraryMatches(args: Record<string, unknown>) {
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

export function getCandidateSourceAssets(args: Record<string, unknown>, assetLimit: number) {
  const requestedAssetIds = Array.isArray(args.assetIds)
    ? new Set(args.assetIds.filter((value): value is string => typeof value === 'string'))
    : null;

  return getAssetCatalogSnapshot()
    .assets.filter((asset) => asset.kind === 'video' && asset.hasVideoStream)
    .filter((asset) => (requestedAssetIds ? requestedAssetIds.has(asset.id) : true))
    .filter((asset) => (args.unusedOnly === true ? !asset.onTimeline : true))
    .slice(0, assetLimit);
}

export async function searchIndexedSourceLibraryMatches(args: Record<string, unknown>) {
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

export function dedupeSourceLibraryMatches(
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

export function deriveSelectQueryIntent(query: string): {
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

export function rerankSourceLibraryMatches(
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

export function clampSelectRange(
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

type SourceSelectSegment = {
  index: number;
  assetId: string;
  assetName: string;
  sectionType: SourceLibraryMatch['sectionType'];
  score: number;
  whyMatched: string[];
  preview: string;
  keyframePath: string | null;
  onTimeline: boolean;
  timelineClipCount: number;
  rawScore: number;
  rankingNotes: string[];
  metadata: SourceLibraryMatch['metadata'];
  sourceInSec: number;
  sourceOutSec: number;
  durationSec: number;
  timelineStartSec: number;
};

export function buildSourceSelectSegments(
  matches: SourceLibraryMatch[],
  options: { paddingSec: number; gapSec: number },
) {
  const assetCatalog = getAssetCatalogSnapshot();
  const dedupedMatches = dedupeSourceLibraryMatches(matches, 0.25);
  let cursorSec = 0;

  const selects: SourceSelectSegment[] = [];

  for (const match of dedupedMatches) {
    const asset = assetCatalog.assets.find((entry) => entry.id === match.assetId);
    const clampedRange = clampSelectRange(
      asset?.durationSec,
      match.startSec - options.paddingSec,
      match.endSec + options.paddingSec,
    );
    if (clampedRange.durationSec <= 0) {
      continue;
    }

    const select = {
      index: selects.length,
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
    selects.push(select);
  }

  return selects;
}

export function resolveSelectsSequence(sequenceId?: string) {
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

export function resolveExistingSelectsTrack(options: {
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

export async function ensureSelectsTrack(options: {
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

export async function rollbackInsertedSelectClips(
  sequenceId: string,
  clipRefs: Array<{ trackId: string; clipId: string }>,
): Promise<string[]> {
  const rollbackFailures: string[] = [];

  for (const { trackId, clipId } of [...clipRefs].reverse()) {
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

export async function rollbackCreatedSelectsTrack(
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

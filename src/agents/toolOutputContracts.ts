export interface ToolOutputContract {
  summary: string;
  examples: string[];
  validatePath?: (path: string) => boolean;
}

const CLIP_OUTPUT_FIELDS = [
  'id',
  'assetId',
  'trackId',
  'timelineIn',
  'duration',
  'sourceIn',
  'sourceOut',
  'speed',
  'opacity',
  'hasEffects',
  'effectCount',
  'label',
] as const;

const TRACK_OUTPUT_FIELDS = [
  'id',
  'name',
  'kind',
  'clipCount',
  'muted',
  'locked',
  'visible',
  'volume',
] as const;

const TIMELINE_INFO_FIELDS = [
  'stateVersion',
  'sequenceId',
  'name',
  'duration',
  'trackCount',
  'clipCount',
  'playheadPosition',
] as const;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesArrayItemPath(
  path: string,
  base: string,
  allowedFields: readonly string[],
): boolean {
  const fieldPattern = allowedFields.join('|');
  return new RegExp(`^${escapeRegex(base)}(?:\\[\\d+\\])?(?:\\.(?:${fieldPattern}))?$`).test(path);
}

function matchesTrackClipsPath(path: string): boolean {
  const trackFieldPattern = TRACK_OUTPUT_FIELDS.join('|');
  const clipFieldPattern = CLIP_OUTPUT_FIELDS.join('|');

  return (
    path === 'data' ||
    path === 'data.track' ||
    path === 'data.clips' ||
    new RegExp(`^data\\.track\\.(?:${trackFieldPattern})$`).test(path) ||
    new RegExp(`^data\\.clips\\[\\d+\\](?:\\.(?:${clipFieldPattern}))?$`).test(path)
  );
}

function matchesTimelineInfoPath(path: string): boolean {
  const infoFieldPattern = TIMELINE_INFO_FIELDS.join('|');
  return (
    path === 'data' ||
    new RegExp(`^data\\.(?:${infoFieldPattern})$`).test(path) ||
    /^data\.selectedClipIds(?:\[\d+\])?$/.test(path) ||
    /^data\.selectedTrackIds(?:\[\d+\])?$/.test(path)
  );
}

function matchesInsertClipPath(path: string): boolean {
  return (
    path === 'data' ||
    path === 'data.clipId' ||
    path === 'data.linkedAudio' ||
    path === 'data.linkedAudio.trackId' ||
    path === 'data.linkedAudio.clipId' ||
    path === 'data.linkedAudio.createdTrack' ||
    path === 'data.sourceIn' ||
    path === 'data.sourceOut' ||
    path === 'data.durationSec' ||
    path === 'data.operationId' ||
    path === 'data.createdIds' ||
    /^data\.createdIds\[\d+\]$/.test(path)
  );
}

function matchesSplitClipPath(path: string): boolean {
  return (
    matchesInsertClipPath(path) ||
    path === 'data.newClipId' ||
    path === 'data.sourceClipId' ||
    path === 'data.deletedIds' ||
    /^data\.deletedIds\[\d+\]$/.test(path)
  );
}

function matchesReadSourceAnalysisReportPath(path: string): boolean {
  const matchesObjectPath = (base: string): boolean => path === base || path.startsWith(`${base}.`);

  return (
    path === 'data' ||
    path === 'data.content' ||
    path === 'data.relativePath' ||
    path === 'data.reportPath' ||
    path === 'data.assetId' ||
    path === 'data.assetName' ||
    path === 'data.requestedFile' ||
    path === 'data.generatedAt' ||
    path === 'data.summary' ||
    path === 'data.persisted' ||
    path === 'data.persistenceError' ||
    path === 'data.sizeBytes' ||
    path === 'data.modifiedAtUnixSec' ||
    path === 'data.bundleSource' ||
    matchesObjectPath('data.metadata') ||
    matchesObjectPath('data.coverage') ||
    matchesObjectPath('data.quality') ||
    matchesObjectPath('data.sectionCounts') ||
    matchesObjectPath('data.document') ||
    path === 'data.warnings' ||
    /^data\.warnings\[\d+\]$/.test(path) ||
    path === 'data.errors' ||
    /^data\.errors\.[^.]+$/.test(path)
  );
}

function matchesGenerateSourceAnalysisReportPath(path: string): boolean {
  return (
    matchesReadSourceAnalysisReportPath(path) ||
    path === 'data.markdown' ||
    path === 'data.semantic' ||
    path.startsWith('data.semantic.') ||
    path === 'data.transcript' ||
    path.startsWith('data.transcript.') ||
    path === 'data.visual' ||
    path.startsWith('data.visual.')
  );
}

function matchesClipAnalysisPath(path: string): boolean {
  return (
    path === 'data' ||
    path === 'data.source' ||
    path === 'data.fingerprint' ||
    path === 'data.sequenceId' ||
    path === 'data.trackId' ||
    path === 'data.clipId' ||
    path === 'data.assetId' ||
    path === 'data.assetName' ||
    path === 'data.quality' ||
    path.startsWith('data.quality.') ||
    path === 'data.samplePolicy' ||
    path.startsWith('data.samplePolicy.') ||
    path === 'data.sampleCount' ||
    path === 'data.readySampleCount' ||
    path === 'data.mappingCount' ||
    path === 'data.mapping' ||
    /^data\.mapping\[\d+\](?:\.(?:timelineSec|timelineOffsetSec|sourceSec|frameIndex|insideClip|reason))?$/.test(
      path,
    ) ||
    path === 'data.samples' ||
    /^data\.samples\[\d+\](?:\.(?:sampleId|index|timelineSec|timelineOffsetSec|sourceSec|frameIndex|imagePath|width|height|samplingReason|extractionStatus|error|signals))?$/.test(
      path,
    ) ||
    (path.startsWith('data.samples[') && path.includes('.signals.')) ||
    path === 'data.windows' ||
    path.startsWith('data.windows[') ||
    path === 'data.errors' ||
    /^data\.errors\[\d+\]$/.test(path) ||
    path === 'data.analyzedAt' ||
    path === 'data.summary' ||
    path === 'data.bundle' ||
    path.startsWith('data.bundle.')
  );
}

function matchesClipPerceptionPath(path: string): boolean {
  const observationFieldPattern =
    'sampleId|timelineSec|sourceSec|frameIndex|imagePath|description|subjects|actions|visibleText|objects|setting|editUsefulness|confidence|evidenceSource|provider';

  return (
    path === 'data' ||
    path === 'data.source' ||
    path === 'data.perceptionFingerprint' ||
    path === 'data.fingerprint' ||
    path === 'data.clipFingerprint' ||
    path === 'data.sequenceId' ||
    path === 'data.trackId' ||
    path === 'data.clipId' ||
    path === 'data.assetId' ||
    path === 'data.provider' ||
    path === 'data.model' ||
    path === 'data.quality' ||
    path.startsWith('data.quality.') ||
    path === 'data.observationCount' ||
    path === 'data.observations' ||
    new RegExp(`^data\\.observations\\[\\d+\\](?:\\.(?:${observationFieldPattern}))?$`).test(
      path,
    ) ||
    (path.startsWith('data.observations[') && path.includes('.provider.')) ||
    /^data\.observations\[\d+\]\.(?:subjects|actions|visibleText|objects)\[\d+\]$/.test(path) ||
    path === 'data.errors' ||
    /^data\.errors\[\d+\]$/.test(path) ||
    path === 'data.createdAt' ||
    path === 'data.summary' ||
    path === 'data.bundle' ||
    path.startsWith('data.bundle.')
  );
}

function matchesTimelineSourceMappingPath(path: string): boolean {
  return (
    path === 'data' ||
    path === 'data.sequenceId' ||
    path === 'data.trackId' ||
    path === 'data.clipId' ||
    path === 'data.count' ||
    path === 'data.mapping' ||
    /^data\.mapping\[\d+\](?:\.(?:timelineSec|timelineOffsetSec|sourceSec|frameIndex|insideClip|reason))?$/.test(
      path,
    )
  );
}

function matchesTimelineRangeInspectionPath(path: string): boolean {
  return (
    path === 'data' ||
    path === 'data.sequenceId' ||
    path === 'data.startSec' ||
    path === 'data.endSec' ||
    path === 'data.count' ||
    path === 'data.clips' ||
    /^data\.clips\[\d+\]$/.test(path) ||
    path.startsWith('data.clips[')
  );
}

function matchesTimelineRangePerceptionPath(path: string): boolean {
  return (
    path === 'data' ||
    path === 'data.sequenceId' ||
    path === 'data.startSec' ||
    path === 'data.endSec' ||
    path === 'data.count' ||
    path === 'data.clips' ||
    /^data\.clips\[\d+\]$/.test(path) ||
    (path.startsWith('data.clips[') &&
      matchesClipPerceptionPath(path.replace(/^data\.clips\[\d+\]/, 'data')))
  );
}

function matchesClipEvidenceSearchPath(path: string): boolean {
  const hitFieldPattern =
    'perceptionFingerprint|clipFingerprint|sequenceId|trackId|clipId|assetId|sampleId|timelineSec|sourceSec|frameIndex|imagePath|description|confidence|evidenceSource|matchedFields';

  return (
    path === 'data' ||
    path === 'data.query' ||
    path === 'data.count' ||
    path === 'data.hits' ||
    new RegExp(`^data\\.hits\\[\\d+\\](?:\\.(?:${hitFieldPattern}))?$`).test(path) ||
    /^data\.hits\[\d+\]\.matchedFields\[\d+\]$/.test(path) ||
    path === 'data.summary'
  );
}

function matchesSemanticEditPlanPath(path: string): boolean {
  const rangeFieldPattern =
    'rangeId|timelineStartSec|timelineEndSec|sourceStartSec|sourceEndSec|sampleIds|confidence|matchedFields|evidence|spatialTargets|commandDrafts|warnings';
  const evidenceFieldPattern =
    'sampleId|timelineSec|sourceSec|frameIndex|imagePath|description|confidence|evidenceSource|matchedFields';
  const spatialTargetFieldPattern =
    'targetId|kind|label|sourceSec|timeDeltaSec|confidence|boundingBox|maskShape';
  const draftFieldPattern = 'commandType|payload|reason|requiresResolution|risk';

  return (
    path === 'data' ||
    path === 'data.planId' ||
    path === 'data.perceptionFingerprint' ||
    path === 'data.clipFingerprint' ||
    path === 'data.sequenceId' ||
    path === 'data.trackId' ||
    path === 'data.clipId' ||
    path === 'data.assetId' ||
    path === 'data.query' ||
    path === 'data.action' ||
    path === 'data.ranges' ||
    new RegExp(`^data\\.ranges\\[\\d+\\](?:\\.(?:${rangeFieldPattern}))?$`).test(path) ||
    /^data\.ranges\[\d+\]\.sampleIds\[\d+\]$/.test(path) ||
    /^data\.ranges\[\d+\]\.matchedFields\[\d+\]$/.test(path) ||
    /^data\.ranges\[\d+\]\.warnings\[\d+\]$/.test(path) ||
    new RegExp(
      `^data\\.ranges\\[\\d+\\]\\.evidence\\[\\d+\\](?:\\.(?:${evidenceFieldPattern}))?$`,
    ).test(path) ||
    /^data\.ranges\[\d+\]\.evidence\[\d+\]\.matchedFields\[\d+\]$/.test(path) ||
    new RegExp(
      `^data\\.ranges\\[\\d+\\]\\.spatialTargets\\[\\d+\\](?:\\.(?:${spatialTargetFieldPattern}))?$`,
    ).test(path) ||
    (path.startsWith('data.ranges[') &&
      path.includes('.spatialTargets[') &&
      (path.includes('.boundingBox.') || path.includes('.maskShape'))) ||
    new RegExp(
      `^data\\.ranges\\[\\d+\\]\\.commandDrafts\\[\\d+\\](?:\\.(?:${draftFieldPattern}))?$`,
    ).test(path) ||
    (path.startsWith('data.ranges[') &&
      path.includes('.commandDrafts[') &&
      path.includes('.payload')) ||
    /^data\.ranges\[\d+\]\.commandDrafts\[\d+\]\.requiresResolution\[\d+\]$/.test(path) ||
    path === 'data.quality' ||
    path.startsWith('data.quality.') ||
    path === 'data.summary' ||
    path === 'data.createdAt'
  );
}

function matchesGenerateTimelineMediaPath(path: string): boolean {
  return (
    path === 'data' ||
    path === 'data.jobId' ||
    path === 'data.status' ||
    path === 'data.mediaType' ||
    path === 'data.provider' ||
    path === 'data.estimatedCostCents' ||
    path === 'data.autoPlaceWhenReady' ||
    path === 'data.nextAction' ||
    path === 'data.pendingTimeline' ||
    path.startsWith('data.pendingTimeline.')
  );
}

function matchesResolveGenerationJobPath(path: string): boolean {
  return (
    path === 'data' ||
    path === 'data.status' ||
    path === 'data.pending' ||
    path === 'data.progress' ||
    path === 'data.assetId' ||
    path === 'data.message' ||
    path === 'data.placement' ||
    path.startsWith('data.placement.')
  );
}

export const TOOL_OUTPUT_CONTRACTS: Record<string, ToolOutputContract> = {
  get_timeline_info: {
    summary:
      'returns timeline metadata under data.* including sequenceId, duration, trackCount, clipCount, playheadPosition, selectedClipIds[n], and selectedTrackIds[n]',
    examples: ['data.sequenceId', 'data.duration', 'data.selectedTrackIds[0]'],
    validatePath: matchesTimelineInfoPath,
  },
  get_track_clips: {
    summary:
      'returns one track summary under data.track.* and track-scoped clips under data.clips[n].*',
    examples: ['data.track.id', 'data.clips[0].id', 'data.clips[0].timelineIn'],
    validatePath: matchesTrackClipsPath,
  },
  get_clips_at_time: {
    summary: 'returns clips across tracks under data[n].*',
    examples: ['data[0].id', 'data[0].trackId', 'data[0].timelineIn'],
    validatePath: (path) => matchesArrayItemPath(path, 'data', CLIP_OUTPUT_FIELDS),
  },
  get_selected_clips: {
    summary: 'returns selected clips under data[n].*',
    examples: ['data[0].id', 'data[0].trackId', 'data[0].timelineIn'],
    validatePath: (path) => matchesArrayItemPath(path, 'data', CLIP_OUTPUT_FIELDS),
  },
  insert_clip: {
    summary:
      'returns newly created timeline clip identifiers under data.clipId and data.createdIds[0]',
    examples: ['data.clipId', 'data.createdIds[0]'],
    validatePath: matchesInsertClipPath,
  },
  insert_clip_from_file: {
    summary:
      'returns newly created timeline clip identifiers under data.clipId and data.createdIds[0]',
    examples: ['data.clipId', 'data.createdIds[0]'],
    validatePath: matchesInsertClipPath,
  },
  split_clip: {
    summary:
      'returns split result fields under data.* including data.newClipId for the newly created right-hand segment',
    examples: ['data.newClipId', 'data.sourceClipId', 'data.createdIds[0]'],
    validatePath: matchesSplitClipPath,
  },
  read_source_analysis_report: {
    summary:
      'returns the persisted Markdown report under data.content with its saved workspace path under data.relativePath/data.reportPath; nested mirror is also available at data.document.*',
    examples: ['data.content', 'data.relativePath', 'data.document.content'],
    validatePath: matchesReadSourceAnalysisReportPath,
  },
  generate_source_analysis_report: {
    summary:
      'returns structured report fields plus semantic overview/timeline fields and the persisted Markdown report under data.content/data.markdown with its saved workspace path under data.relativePath/data.reportPath',
    examples: ['data.content', 'data.reportPath', 'data.semantic.sceneTimeline[0].summary'],
    validatePath: matchesGenerateSourceAnalysisReportPath,
  },
  analyze_timeline_clip: {
    summary:
      'returns clip-local analysis under data.* including data.fingerprint, data.quality.*, data.mapping[n].*, data.samples[n].imagePath, and the full data.bundle',
    examples: ['data.fingerprint', 'data.samples[0].imagePath', 'data.mapping[0].sourceSec'],
    validatePath: matchesClipAnalysisPath,
  },
  read_clip_analysis: {
    summary:
      'returns a cached clip-local analysis bundle with the same shape as analyze_timeline_clip',
    examples: ['data.fingerprint', 'data.quality.status', 'data.bundle.samples[0].imagePath'],
    validatePath: matchesClipAnalysisPath,
  },
  sample_clip_frames: {
    summary:
      'returns dense clip frame samples plus mapping and cache fingerprint in the same bundle shape as analyze_timeline_clip',
    examples: ['data.readySampleCount', 'data.samples[0].timelineSec', 'data.samples[0].imagePath'],
    validatePath: matchesClipAnalysisPath,
  },
  map_timeline_to_source: {
    summary:
      'returns timeline-to-source mappings under data.mapping[n].* including sourceSec and frameIndex',
    examples: ['data.mapping[0].sourceSec', 'data.mapping[0].frameIndex'],
    validatePath: matchesTimelineSourceMappingPath,
  },
  inspect_timeline_range: {
    summary:
      'returns clip-local analysis bundles for all visible clips overlapping the requested timeline range under data.clips[n].*',
    examples: ['data.clips[0].fingerprint', 'data.clips[0].samples[0].imagePath'],
    validatePath: matchesTimelineRangeInspectionPath,
  },
  describe_clip_frames: {
    summary:
      'returns semantic clip-local frame evidence under data.observations[n].* including descriptions, subjects/actions/OCR/objects, confidence, source/provider labels, and data.perceptionFingerprint',
    examples: [
      'data.perceptionFingerprint',
      'data.observations[0].description',
      'data.observations[0].visibleText[0]',
    ],
    validatePath: matchesClipPerceptionPath,
  },
  read_clip_perception: {
    summary:
      'returns a cached semantic clip-perception bundle with the same shape as describe_clip_frames',
    examples: [
      'data.perceptionFingerprint',
      'data.quality.semanticCoverage',
      'data.bundle.observations[0].description',
    ],
    validatePath: matchesClipPerceptionPath,
  },
  describe_timeline_range: {
    summary:
      'returns semantic clip-local perception bundles for all visible clips overlapping a requested timeline range under data.clips[n].observations[n].*',
    examples: ['data.clips[0].perceptionFingerprint', 'data.clips[0].observations[0].description'],
    validatePath: matchesTimelineRangePerceptionPath,
  },
  search_clip_evidence: {
    summary:
      'returns cached semantic clip evidence matches under data.hits[n].* including description, source/timeline seconds, confidence, and matchedFields',
    examples: [
      'data.hits[0].description',
      'data.hits[0].timelineSec',
      'data.hits[0].matchedFields[0]',
    ],
    validatePath: matchesClipEvidenceSearchPath,
  },
  plan_semantic_clip_edit: {
    summary:
      'returns semantic temporal edit plan ranges under data.ranges[n].* with evidence, warnings, commandDrafts, unresolved IDs, and quality',
    examples: [
      'data.ranges[0].timelineStartSec',
      'data.ranges[0].evidence[0].description',
      'data.ranges[0].commandDrafts[0].commandType',
    ],
    validatePath: matchesSemanticEditPlanPath,
  },
  generate_timeline_media: {
    summary:
      'returns submitted generation metadata under data.* including data.jobId, data.pendingTimeline.*, and data.nextAction',
    examples: ['data.jobId', 'data.pendingTimeline.markerId', 'data.nextAction'],
    validatePath: matchesGenerateTimelineMediaPath,
  },
  resolve_generation_job: {
    summary:
      'returns generation sync state under data.* including data.status, data.pending, data.assetId, and optional data.placement',
    examples: ['data.status', 'data.assetId', 'data.placement.clipId'],
    validatePath: matchesResolveGenerationJobPath,
  },
};

export function getToolOutputContract(toolName: string): ToolOutputContract | null {
  return TOOL_OUTPUT_CONTRACTS[toolName.trim().toLowerCase()] ?? null;
}

export function buildToolOutputContractSection(toolNames: string[]): string {
  const lines = toolNames
    .map((toolName) => {
      const contract = getToolOutputContract(toolName);
      if (!contract) {
        return null;
      }

      return `- ${toolName} -> ${contract.summary}; examples: ${contract.examples.join(', ')}`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return '';
  }

  return ['## Tool Output Contracts', ...lines].join('\n');
}

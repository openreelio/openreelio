import type { IToolExecutor } from '../ports/IToolExecutor';
import type { AgentContext, Plan, PlanStep, Thought } from './types';
import type { StepValueReference } from './stepReferences';

export type OrchestrationPlaybookId =
  | 'broll_music_subtitles'
  | 'generate_and_place'
  | 'stock_media_search'
  | 'auto_caption'
  | 'music_bed'
  | 'reference_style_transfer';

export interface OrchestrationPlaybookMatch {
  id: OrchestrationPlaybookId;
  confidence: number;
  plan: Plan;
}

interface PlaybookContext {
  text: string;
  thought: Thought;
  context: AgentContext;
  toolExecutor: IToolExecutor;
}

const BROLL_KEYWORDS = [
  /\bb-?roll\b/i,
  /\bcutaway\b/i,
  /\binsert\s+shot\b/i,
  /브롤/i,
  /삽입\s*영상/i,
];

const MUSIC_KEYWORDS = [
  /\bmusic\b/i,
  /\bbgm\b/i,
  /background\s+music/i,
  /배경\s*음악/i,
  /음악\s*베드/i,
];

const SUBTITLE_KEYWORDS = [/\bsubtitle(s)?\b/i, /\bcaption(s)?\b/i, /자막/i];

const GENERATE_KEYWORDS = [/\bgenerate\b/i, /\bcreate\b/i, /생성/i, /만들/i];
const VIDEO_KEYWORDS = [
  /\bvideo\b/i,
  /\bclip\b/i,
  /\bshorts?\b/i,
  /\btext[-\s]?to[-\s]?video\b/i,
  /영상/i,
  /비디오/i,
  /쇼츠/i,
];
const PLACE_KEYWORDS = [
  /\bplace\b/i,
  /\binsert\b/i,
  /timeline/i,
  /타임라인/i,
  /삽입/i,
  /추가/i,
  /배치/i,
];

const STOCK_KEYWORDS = [
  /\bstock\b/i,
  /\bfootage\b/i,
  /\broyalty[-\s]?free\b/i,
  /\bpexels\b/i,
  /\bpixabay\b/i,
  /스톡/i,
  /무료\s*영상/i,
];

const SEARCH_KEYWORDS = [
  /\bfind\b/i,
  /\bsearch\b/i,
  /\bbrowse\b/i,
  /\blook\s+for\b/i,
  /찾/i,
  /검색/i,
];

const MUSIC_BED_KEYWORDS = [
  /\bbackground\s+music\b/i,
  /\bmusic\s+bed\b/i,
  /\baudio\s+bed\b/i,
  /\badd\s+music\b/i,
  /\binsert\s+music\b/i,
  /\badd\s+background\s+audio\b/i,
  /\badd\s+bgm\b/i,
  /배경\s*음악\s*(?:추가|삽입)/i,
  /음악\s*(?:추가|넣|삽입)/i,
];

const AUTO_CAPTION_KEYWORDS = [
  /\bauto[-\s]?caption/i,
  /\bauto[-\s]?subtitle/i,
  /\btranscri(?:be|ption)/i,
  /\bspeech[-\s]?to[-\s]?text\b/i,
  /\bgenerate\s+(?:captions?|subtitles?)\b/i,
  /\badd\s+(?:captions?|subtitles?)\b/i,
  /자동\s*자막/i,
  /음성\s*인식/i,
];

/**
 * Patterns that fall within the scope of the auto_caption playbook
 * (audio transcription + adding caption clips to the timeline).
 * When a Thought has requirements that match NONE of these patterns,
 * the request is broader than what the 2-step playbook can handle.
 */
const CAPTION_SCOPE_PATTERNS = [
  /caption/i,
  /subtitle/i,
  /transcri/i,
  /speech/i,
  /audio/i,
  /자막/i,
  /음성/i,
];

/**
 * Returns true when the Thought contains requirements beyond audio
 * transcription + captioning — e.g., visual analysis, OCR, content
 * identification, multi-modal extraction. In such cases the narrow
 * auto_caption playbook would leave requirements unmet, so we let the
 * LLM plan freely instead.
 */
function hasRequirementsBeyondCaptioning(thought: Thought): boolean {
  if (thought.requirements.length <= 1) {
    return false;
  }

  return thought.requirements.some(
    (req) => !CAPTION_SCOPE_PATTERNS.some((pattern) => pattern.test(req)),
  );
}

const REFERENCE_STYLE_KEYWORDS = [
  /\bedit\s+like\b/i,
  /\bmatch\s+the\s+style\b/i,
  /\bsame\s+editing\s+as\b/i,
  /\bapply\s+editing\s+from\b/i,
  /\breference\s+style\b/i,
  /\bstyle\s+transfer\b/i,
  /\bediting\s+style\b/i,
  /참조\s*편집/i,
  /편집\s*스타일/i,
];

const REUSE_REFERENCE_STYLE_KEYWORDS = [
  /\blast\s+analysis\b/i,
  /\bexisting\s+esd\b/i,
  /\bexisting\s+style\b/i,
  /\bprevious\s+analysis\b/i,
  /\breuse\s+(?:the\s+)?(?:existing\s+)?(?:style|esd)\b/i,
  /마지막\s*분석/i,
  /기존\s*esd/i,
  /기존\s*스타일/i,
  /이전\s*분석/i,
];

export function buildOrchestrationPlaybook(
  thought: Thought,
  context: AgentContext,
  toolExecutor: IToolExecutor,
): OrchestrationPlaybookMatch | null {
  if (!context.sequenceId) {
    return null;
  }

  const text = buildSearchText(thought);
  const playbookContext: PlaybookContext = {
    text,
    thought,
    context,
    toolExecutor,
  };

  const generateAndPlace = buildGenerateAndPlacePlaybook(playbookContext);
  if (generateAndPlace) {
    return generateAndPlace;
  }

  const brollMusicSubtitles = buildBrollMusicSubtitlesPlaybook(playbookContext);
  if (brollMusicSubtitles) {
    return brollMusicSubtitles;
  }

  const autoCaption = buildAutoCaptionPlaybook(playbookContext);
  if (autoCaption) {
    return autoCaption;
  }

  const musicBed = buildMusicBedPlaybook(playbookContext);
  if (musicBed) {
    return musicBed;
  }

  const referenceStyleTransfer = buildReferenceStyleTransferPlaybook(playbookContext);
  if (referenceStyleTransfer) {
    return referenceStyleTransfer;
  }

  const stockMediaSearch = buildStockMediaSearchPlaybook(playbookContext);
  if (stockMediaSearch) {
    return stockMediaSearch;
  }

  return null;
}

function buildMusicBedPlaybook(
  playbookContext: PlaybookContext,
): OrchestrationPlaybookMatch | null {
  const { text, context, toolExecutor } = playbookContext;

  if (!matchesAny(text, MUSIC_BED_KEYWORDS)) {
    return null;
  }

  // Defer to the full broll_music_subtitles playbook if all three keywords present
  if (matchesAll(text, [BROLL_KEYWORDS, MUSIC_KEYWORDS, SUBTITLE_KEYWORDS])) {
    return null;
  }

  if (!hasTools(toolExecutor, ['get_unused_assets', 'insert_clip', 'adjust_volume'])) {
    return null;
  }

  const sequenceId = context.sequenceId;
  const audioTrackId = pickTrackId(context, 'audio');
  const fallbackAudioAsset = pickAssetId(context, 'audio');

  if (!sequenceId || !audioTrackId || !fallbackAudioAsset) {
    return null;
  }

  // Background music level: ~25% (-12dB equivalent)
  const BACKGROUND_VOLUME = 25;

  const steps: PlanStep[] = [
    {
      id: 'playbook_find_music',
      tool: 'get_unused_assets',
      args: { kind: 'audio' },
      description: 'Discover available audio assets for music bed',
      riskLevel: 'low',
      estimatedDuration: 120,
    },
    {
      id: 'playbook_insert_music',
      tool: 'insert_clip',
      args: {
        sequenceId,
        trackId: audioTrackId,
        assetId: makeReference('playbook_find_music', 'data[0].id', fallbackAudioAsset),
        timelineStart: 0,
      },
      description: 'Insert music bed at the start of the timeline',
      riskLevel: 'low',
      estimatedDuration: 250,
      dependsOn: ['playbook_find_music'],
    },
    {
      id: 'playbook_set_volume',
      tool: 'adjust_volume',
      args: {
        sequenceId,
        trackId: audioTrackId,
        clipId: makeReference('playbook_insert_music', 'data.clipId'),
        volume: BACKGROUND_VOLUME,
      },
      description: 'Lower music bed volume to background level (-12dB)',
      riskLevel: 'low',
      estimatedDuration: 120,
      dependsOn: ['playbook_insert_music'],
    },
  ];

  return {
    id: 'music_bed',
    confidence: 0.89,
    plan: {
      goal: 'Add background music bed at reduced volume',
      steps,
      estimatedTotalDuration: estimateTotalDuration(steps),
      requiresApproval: false,
      rollbackStrategy: 'Remove inserted music clip and restore previous volume level.',
    },
  };
}

function matchesReferenceStyleKeywords(text: string): boolean {
  return REFERENCE_STYLE_KEYWORDS.some((re) => re.test(text));
}

function buildReferenceStyleTransferPlaybook(
  playbookContext: PlaybookContext,
): OrchestrationPlaybookMatch | null {
  const { text, context, toolExecutor } = playbookContext;

  if (!matchesReferenceStyleKeywords(text)) {
    return null;
  }

  if (
    !hasTools(toolExecutor, [
      'analyze_reference_video',
      'generate_style_document',
      'apply_editing_style',
    ])
  ) {
    return null;
  }

  const sequenceId = context.sequenceId;
  if (!sequenceId) {
    return null;
  }

  const selectedAssets = pickReferenceStyleAssets(text, context);
  if (!selectedAssets) {
    return null;
  }

  const { referenceAssetId, sourceAssetId } = selectedAssets;
  const shouldReuseExistingStyle = matchesAny(text, REUSE_REFERENCE_STYLE_KEYWORDS);

  const steps: PlanStep[] = shouldReuseExistingStyle
    ? [
        {
          id: 'playbook_generate_esd',
          tool: 'generate_style_document',
          args: {
            assetId: referenceAssetId,
          },
          description: 'Reuse the latest existing style document for the reference video',
          riskLevel: 'low',
          estimatedDuration: 1200,
        },
        {
          id: 'playbook_apply_style',
          tool: 'apply_editing_style',
          args: {
            esdId: makeReference('playbook_generate_esd', 'data.esdId', ''),
            sourceAssetId,
          },
          description: 'Apply the reused reference editing style to source footage',
          riskLevel: 'medium',
          estimatedDuration: 2000,
          dependsOn: ['playbook_generate_esd'],
        },
      ]
    : [
        {
          id: 'playbook_analyze_reference',
          tool: 'analyze_reference_video',
          args: {
            assetId: referenceAssetId,
          },
          description: 'Analyze reference video for editing style patterns',
          riskLevel: 'low',
          estimatedDuration: 5000,
        },
        {
          id: 'playbook_generate_esd',
          tool: 'generate_style_document',
          args: {
            assetId: makeReference('playbook_analyze_reference', 'data.assetId', referenceAssetId),
          },
          description: 'Generate Editing Style Document from analysis results',
          riskLevel: 'low',
          estimatedDuration: 3000,
          dependsOn: ['playbook_analyze_reference'],
        },
        {
          id: 'playbook_apply_style',
          tool: 'apply_editing_style',
          args: {
            esdId: makeReference('playbook_generate_esd', 'data.esdId', ''),
            sourceAssetId,
          },
          description: 'Apply reference editing style to source footage with DTW-aligned cuts',
          riskLevel: 'medium',
          estimatedDuration: 2000,
          dependsOn: ['playbook_generate_esd'],
        },
      ];

  return {
    id: 'reference_style_transfer',
    confidence: 0.88,
    plan: {
      goal: 'Analyze reference video style and apply it to source footage',
      steps,
      estimatedTotalDuration: estimateTotalDuration(steps),
      requiresApproval: false,
      rollbackStrategy:
        'Undo applied style edits in reverse order; ESD and analysis artifacts are retained for reuse.',
    },
  };
}

function buildAutoCaptionPlaybook(
  playbookContext: PlaybookContext,
): OrchestrationPlaybookMatch | null {
  const { text, thought, context, toolExecutor } = playbookContext;

  if (!matchesAny(text, AUTO_CAPTION_KEYWORDS)) {
    return null;
  }

  // The auto_caption playbook only covers 2 steps: audio transcription + caption
  // creation. If the Thought has requirements that fall outside this scope
  // (e.g., visual analysis, OCR, content identification, multi-modal tasks),
  // the playbook would leave those requirements unmet. Let the LLM plan freely.
  if (hasRequirementsBeyondCaptioning(thought)) {
    return null;
  }

  if (!hasTools(toolExecutor, ['auto_transcribe', 'add_captions_from_transcription'])) {
    return null;
  }

  const sequenceId = context.sequenceId;
  if (!sequenceId) {
    return null;
  }

  // Find a target asset to transcribe: prefer selected clips' assets, then any video asset
  const targetAssetId = pickAssetId(context, 'video') ?? pickAssetId(context, 'audio');
  if (!targetAssetId) {
    return null;
  }

  const steps: PlanStep[] = [
    {
      id: 'playbook_auto_transcribe',
      tool: 'auto_transcribe',
      args: {
        assetId: targetAssetId,
      },
      description: 'Transcribe audio from asset using speech-to-text',
      riskLevel: 'low',
      estimatedDuration: 5000,
    },
    {
      id: 'playbook_add_captions',
      tool: 'add_captions_from_transcription',
      args: {
        sequenceId,
        segments: makeReference('playbook_auto_transcribe', 'data.segments'),
      },
      description: 'Create caption clips from transcription segments',
      riskLevel: 'low',
      estimatedDuration: 500,
      dependsOn: ['playbook_auto_transcribe'],
    },
  ];

  return {
    id: 'auto_caption',
    confidence: 0.91,
    plan: {
      goal: 'Automatically transcribe audio and add captions to timeline',
      steps,
      estimatedTotalDuration: estimateTotalDuration(steps),
      requiresApproval: false,
      rollbackStrategy: 'Remove all added caption clips in reverse order.',
    },
  };
}

function buildStockMediaSearchPlaybook(
  playbookContext: PlaybookContext,
): OrchestrationPlaybookMatch | null {
  const { text, thought, toolExecutor } = playbookContext;
  const explicitIntent = thought.understanding.toLowerCase();

  // Match: (stock/footage keywords OR b-roll keywords) + explicit search keywords
  // But NOT when all three b-roll+music+subtitle keywords match (defer to broll_music_subtitles)
  const hasStockIntent = matchesAny(text, STOCK_KEYWORDS) || matchesAny(text, BROLL_KEYWORDS);
  const hasSearchIntent = matchesAny(explicitIntent, SEARCH_KEYWORDS);

  if (!hasStockIntent || !hasSearchIntent) {
    return null;
  }

  // If all three b-roll+music+subtitles match, let the more specific playbook handle it
  if (matchesAll(text, [BROLL_KEYWORDS, MUSIC_KEYWORDS, SUBTITLE_KEYWORDS])) {
    return null;
  }

  if (!hasTools(toolExecutor, ['search_stock_media'])) {
    return null;
  }

  // Extract search query from user intent
  const searchQuery = extractSearchQuery(thought) || 'cinematic footage';
  const assetType = text.match(/\bimage\b|\bphoto\b|\b사진\b/i) ? 'image' : 'video';

  const steps: PlanStep[] = [
    {
      id: 'playbook_search_stock',
      tool: 'search_stock_media',
      args: {
        query: searchQuery,
        type: assetType,
        count: 5,
      },
      description: `Search stock media for "${searchQuery}"`,
      riskLevel: 'low',
      estimatedDuration: 200,
    },
  ];

  return {
    id: 'stock_media_search',
    confidence: 0.84,
    plan: {
      goal: `Find stock ${assetType} references matching "${searchQuery}"`,
      steps,
      estimatedTotalDuration: estimateTotalDuration(steps),
      requiresApproval: false,
      rollbackStrategy: 'No timeline changes are applied during stock search.',
    },
  };
}

function buildBrollMusicSubtitlesPlaybook(
  playbookContext: PlaybookContext,
): OrchestrationPlaybookMatch | null {
  const { text, context, thought, toolExecutor } = playbookContext;

  if (
    !matchesAll(text, [BROLL_KEYWORDS, MUSIC_KEYWORDS, SUBTITLE_KEYWORDS]) ||
    !hasTools(toolExecutor, ['get_unused_assets', 'insert_clip', 'add_caption'])
  ) {
    return null;
  }

  const sequenceId = context.sequenceId;
  const primaryVideoTrack = pickTrackId(context, 'video');
  const fallbackVideoAsset = pickAssetId(context, 'video');

  if (!sequenceId || !primaryVideoTrack || !fallbackVideoAsset) {
    return null;
  }

  const steps: PlanStep[] = [
    {
      id: 'playbook_get_unused_video',
      tool: 'get_unused_assets',
      args: { kind: 'video' },
      description: 'Discover candidate B-roll assets not used on timeline',
      riskLevel: 'low',
      estimatedDuration: 120,
    },
    {
      id: 'playbook_insert_broll_clip',
      tool: 'insert_clip',
      args: {
        sequenceId,
        trackId: primaryVideoTrack,
        assetId: makeReference('playbook_get_unused_video', 'data[0].id', fallbackVideoAsset),
        timelineStart: clampTimelineStart(context.playheadPosition, context.timelineDuration),
      },
      description: 'Insert the primary B-roll clip near the current playhead',
      riskLevel: 'low',
      estimatedDuration: 250,
      dependsOn: ['playbook_get_unused_video'],
    },
  ];

  const primaryAudioTrack = pickTrackId(context, 'audio');
  const fallbackAudioAsset = pickAssetId(context, 'audio');
  const hasAudioTools =
    !!primaryAudioTrack &&
    !!fallbackAudioAsset &&
    hasTools(toolExecutor, ['get_unused_assets', 'insert_clip', 'adjust_volume']);

  if (hasAudioTools) {
    steps.push(
      {
        id: 'playbook_get_unused_audio',
        tool: 'get_unused_assets',
        args: { kind: 'audio' },
        description: 'Discover music bed candidates from unused audio assets',
        riskLevel: 'low',
        estimatedDuration: 120,
      },
      {
        id: 'playbook_insert_music_bed',
        tool: 'insert_clip',
        args: {
          sequenceId,
          trackId: primaryAudioTrack,
          assetId: makeReference('playbook_get_unused_audio', 'data[0].id', fallbackAudioAsset),
          timelineStart: clampTimelineStart(context.playheadPosition, context.timelineDuration),
        },
        description: 'Insert a music bed under the B-roll segment',
        riskLevel: 'low',
        estimatedDuration: 250,
        dependsOn: ['playbook_get_unused_audio'],
      },
      {
        id: 'playbook_duck_music_bed',
        tool: 'adjust_volume',
        args: {
          sequenceId,
          trackId: primaryAudioTrack,
          clipId: makeReference('playbook_insert_music_bed', 'data.clipId'),
          volume: 55,
        },
        description: 'Lower music bed volume for dialog-safe mix',
        riskLevel: 'low',
        estimatedDuration: 120,
        dependsOn: ['playbook_insert_music_bed'],
      },
    );
  }

  const captionWindow = createCaptionWindow(context.playheadPosition, context.timelineDuration);
  steps.push({
    id: 'playbook_add_supporting_subtitle',
    tool: 'add_caption',
    args: {
      sequenceId,
      text: extractQuotedText(thought) ?? 'Draft subtitle',
      startTime: captionWindow.startTime,
      endTime: captionWindow.endTime,
    },
    description: 'Add a subtitle placeholder aligned with the inserted segment',
    riskLevel: 'low',
    estimatedDuration: 180,
    dependsOn: ['playbook_insert_broll_clip'],
  });

  return {
    id: 'broll_music_subtitles',
    confidence: 0.9,
    plan: {
      goal: 'Orchestrate B-roll, music bed, and subtitle pass in one flow',
      steps,
      estimatedTotalDuration: estimateTotalDuration(steps),
      requiresApproval: false,
      rollbackStrategy:
        'Undo inserted clips and caption in reverse order; restore previous audio mix level if changed.',
    },
  };
}

function buildGenerateAndPlacePlaybook(
  playbookContext: PlaybookContext,
): OrchestrationPlaybookMatch | null {
  const { text, context, thought, toolExecutor } = playbookContext;

  if (
    !matchesAll(text, [GENERATE_KEYWORDS, VIDEO_KEYWORDS, PLACE_KEYWORDS]) ||
    !hasTools(toolExecutor, ['generate_video', 'check_generation_status', 'insert_clip'])
  ) {
    return null;
  }

  // Disambiguation: words like "create"/"만들", "video"/"영상", "timeline"/"추가"
  // appear naturally in caption/subtitle requests. When the Thought's requirements
  // are entirely within caption scope and caption keywords are present, yield to
  // the auto_caption playbook instead.
  if (matchesAny(text, AUTO_CAPTION_KEYWORDS) && !hasRequirementsBeyondCaptioning(thought)) {
    return null;
  }

  const sequenceId = context.sequenceId;
  const targetTrackId = pickTrackId(context, 'video');
  if (!sequenceId || !targetTrackId) {
    return null;
  }

  const generationPrompt = sanitizePrompt(thought.understanding) || 'Create a cinematic short clip';
  const durationSec = parseDurationSeconds(text) ?? 6;

  const steps: PlanStep[] = [
    {
      id: 'playbook_generate_video',
      tool: 'generate_video',
      args: {
        prompt: generationPrompt,
        mode: 'text_to_video',
        quality: 'pro',
        durationSec,
      },
      description: 'Submit AI video generation job for requested shot',
      riskLevel: 'high',
      estimatedDuration: 600,
    },
    {
      id: 'playbook_check_generation_status',
      tool: 'check_generation_status',
      args: {
        jobId: makeReference('playbook_generate_video', 'data.jobId'),
      },
      description: 'Fetch generation result and retrieve produced asset ID',
      riskLevel: 'medium',
      estimatedDuration: 200,
      dependsOn: ['playbook_generate_video'],
    },
    {
      id: 'playbook_insert_generated_clip',
      tool: 'insert_clip',
      args: {
        sequenceId,
        trackId: targetTrackId,
        assetId: makeReference('playbook_check_generation_status', 'data.assetId'),
        timelineStart: clampTimelineStart(context.playheadPosition, context.timelineDuration),
      },
      description: 'Insert generated asset into the active timeline',
      riskLevel: 'low',
      estimatedDuration: 220,
      dependsOn: ['playbook_check_generation_status'],
    },
  ];

  return {
    id: 'generate_and_place',
    confidence: 0.89,
    plan: {
      goal: 'Generate a new video asset and place it on timeline',
      steps,
      estimatedTotalDuration: estimateTotalDuration(steps),
      requiresApproval: true,
      rollbackStrategy:
        'Cancel generation if still running; if insertion already happened, undo inserted clip from timeline.',
    },
  };
}

function matchesAll(text: string, groups: RegExp[][]): boolean {
  return groups.every((group) => group.some((pattern) => pattern.test(text)));
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasTools(toolExecutor: IToolExecutor, toolNames: string[]): boolean {
  return toolNames.every((name) => toolExecutor.hasTool(name));
}

function pickTrackId(context: AgentContext, type: 'video' | 'audio'): string | null {
  for (const selectedTrackId of context.selectedTracks) {
    const selectedTrack = context.availableTracks.find((track) => track.id === selectedTrackId);
    if (selectedTrack?.type === type) {
      return selectedTrack.id;
    }
  }

  const firstTrack = context.availableTracks.find((track) => track.type === type);
  return firstTrack?.id ?? null;
}

function pickAssetId(context: AgentContext, type: 'video' | 'audio'): string | null {
  const firstAsset = context.availableAssets.find((asset) => asset.type === type);
  return firstAsset?.id ?? null;
}

function pickReferenceStyleAssets(
  text: string,
  context: AgentContext,
): { referenceAssetId: string; sourceAssetId: string } | null {
  const videoAssets = context.availableAssets.filter((asset) => asset.type === 'video');
  if (videoAssets.length === 0) {
    return null;
  }

  const mentionedAssets = videoAssets
    .map((asset) => ({
      asset,
      matchIndex: getAssetMentionIndex(text, asset.name),
    }))
    .filter(
      (entry): entry is { asset: (typeof videoAssets)[number]; matchIndex: number } =>
        entry.matchIndex !== null,
    )
    .sort((left, right) => left.matchIndex - right.matchIndex)
    .map((entry) => entry.asset);

  const referenceAsset = mentionedAssets[0] ?? videoAssets[0];
  const sourceAsset =
    mentionedAssets.find((asset) => asset.id !== referenceAsset.id) ??
    videoAssets.find((asset) => asset.id !== referenceAsset.id) ??
    referenceAsset;

  return {
    referenceAssetId: referenceAsset.id,
    sourceAssetId: sourceAsset.id,
  };
}

function getAssetMentionIndex(text: string, assetName: string): number | null {
  const normalizedAssetName = assetName.trim().toLowerCase();
  if (!normalizedAssetName) {
    return null;
  }

  const candidates = [normalizedAssetName, normalizedAssetName.replace(/\.[a-z0-9]+$/i, '')].filter(
    (candidate, index, all) => candidate.length >= 3 && all.indexOf(candidate) === index,
  );

  const matches = candidates
    .map((candidate) => text.indexOf(candidate))
    .filter((matchIndex) => matchIndex >= 0)
    .sort((left, right) => left - right);

  return matches[0] ?? null;
}

function clampTimelineStart(playhead: number, timelineDuration: number): number {
  if (!Number.isFinite(playhead) || playhead < 0) {
    return 0;
  }

  if (!Number.isFinite(timelineDuration) || timelineDuration <= 0) {
    return playhead;
  }

  return Math.min(playhead, timelineDuration);
}

function createCaptionWindow(
  playhead: number,
  timelineDuration: number,
): { startTime: number; endTime: number } {
  const startTime = clampTimelineStart(playhead, timelineDuration);
  const unconstrainedEnd = startTime + 3;

  if (!Number.isFinite(timelineDuration) || timelineDuration <= 0) {
    return { startTime, endTime: unconstrainedEnd };
  }

  const cappedEnd = Math.min(unconstrainedEnd, timelineDuration);
  if (cappedEnd <= startTime) {
    return { startTime, endTime: startTime + 1 };
  }

  return {
    startTime,
    endTime: cappedEnd,
  };
}

function sanitizePrompt(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseDurationSeconds(text: string): number | null {
  const secondMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:sec|secs|second|seconds|s|초)\b/i);
  if (secondMatch) {
    return clampDuration(Number.parseFloat(secondMatch[1]));
  }

  const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes|분)\b/i);
  if (minuteMatch) {
    return clampDuration(Number.parseFloat(minuteMatch[1]) * 60);
  }

  return null;
}

function clampDuration(durationSec: number): number {
  if (!Number.isFinite(durationSec)) {
    return 6;
  }

  if (durationSec < 5) {
    return 5;
  }

  if (durationSec > 120) {
    return 120;
  }

  return durationSec;
}

function makeReference(fromStep: string, path: string, defaultValue?: unknown): StepValueReference {
  const reference: StepValueReference = {
    $fromStep: fromStep,
    $path: path,
  };

  if (defaultValue !== undefined) {
    reference.$default = defaultValue;
  }

  return reference;
}

function buildSearchText(thought: Thought): string {
  return [
    thought.understanding,
    thought.approach,
    ...thought.requirements,
    ...thought.uncertainties,
  ]
    .filter((value) => value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

function estimateTotalDuration(steps: PlanStep[]): number {
  return steps.reduce((acc, step) => acc + step.estimatedDuration, 0);
}

function extractSearchQuery(thought: Thought): string | null {
  // Try quoted text first
  const quoted = extractQuotedText(thought);
  if (quoted) return quoted;

  // Try to extract topic from "find [topic] b-roll/footage/stock" patterns
  const source = `${thought.understanding} ${thought.approach}`;
  const topicMatch = source.match(
    /(?:find|search|add|get|browse|look\s+for)\s+(.+?)\s+(?:b-?roll|footage|stock|clip|video)/i,
  );
  if (topicMatch) {
    return topicMatch[1].trim();
  }

  // Try "b-roll/footage of/about [topic]" patterns
  const ofMatch = source.match(
    /(?:b-?roll|footage|stock|clip)\s+(?:of|about|for|with)\s+(.+?)(?:\.|$)/i,
  );
  if (ofMatch) {
    return ofMatch[1].trim();
  }

  return null;
}

function extractQuotedText(thought: Thought): string | null {
  const source = `${thought.understanding} ${thought.approach}`;
  const quoted = source.match(/["']([^"']+)["']/);
  if (!quoted) {
    return null;
  }

  const text = quoted[1].trim();
  return text.length > 0 ? text : null;
}

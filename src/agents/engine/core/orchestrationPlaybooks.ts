import type { IToolExecutor } from '../ports/IToolExecutor';
import type { AgentContext, Plan, PlanStep, Thought } from './types';
import type { StepValueReference } from './stepReferences';

export type OrchestrationPlaybookId = 'broll_music_subtitles' | 'generate_and_place';

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

  return buildBrollMusicSubtitlesPlaybook(playbookContext);
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

function extractQuotedText(thought: Thought): string | null {
  const source = `${thought.understanding} ${thought.approach}`;
  const quoted = source.match(/["']([^"']+)["']/);
  if (!quoted) {
    return null;
  }

  const text = quoted[1].trim();
  return text.length > 0 ? text : null;
}

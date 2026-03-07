import { describe, expect, it } from 'vitest';
import { createEmptyContext, type AgentContext, type Thought } from './types';
import { buildOrchestrationPlaybook } from './orchestrationPlaybooks';
import type { IToolExecutor } from '../ports/IToolExecutor';
import type { ValidationResult } from './types';

function createToolExecutor(toolNames: string[]): IToolExecutor {
  const hasTool = (name: string): boolean => toolNames.includes(name);

  return {
    execute: async () => ({ success: true, duration: 1, undoable: false }),
    executeBatch: async () => ({
      success: true,
      results: [],
      totalDuration: 1,
      successCount: 0,
      failureCount: 0,
    }),
    getAvailableTools: () =>
      toolNames.map((name) => ({
        name,
        description: name,
        category: 'utility',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      })),
    getToolDefinition: () => null,
    validateArgs: (): ValidationResult => ({ valid: true, errors: [] }),
    hasTool,
    getToolsByCategory: () => new Map(),
    getToolsByRisk: () => [],
  };
}

function createContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    ...createEmptyContext('project-1'),
    sequenceId: 'sequence-1',
    playheadPosition: 12,
    timelineDuration: 90,
    availableTracks: [
      {
        id: 'track-video-1',
        name: 'Video 1',
        type: 'video',
        clipCount: 0,
      },
      {
        id: 'track-audio-1',
        name: 'Audio 1',
        type: 'audio',
        clipCount: 0,
      },
    ],
    availableAssets: [
      {
        id: 'asset-video-fallback',
        name: 'broll.mp4',
        type: 'video',
        duration: 8,
      },
      {
        id: 'asset-audio-fallback',
        name: 'bed.mp3',
        type: 'audio',
        duration: 30,
      },
    ],
    ...overrides,
  };
}

describe('buildOrchestrationPlaybook', () => {
  it('creates B-roll/music/subtitles playbook with step references', () => {
    const thought: Thought = {
      understanding: 'Please add B-roll with background music and subtitles',
      requirements: ['B-roll', 'music', 'subtitles'],
      uncertainties: [],
      approach: 'Use one orchestration flow',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'get_unused_assets',
      'insert_clip',
      'add_caption',
      'adjust_volume',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('broll_music_subtitles');
    expect(match?.plan.steps.map((step) => step.id)).toContain('playbook_insert_broll_clip');

    const insertBrollStep = match?.plan.steps.find(
      (step) => step.id === 'playbook_insert_broll_clip',
    );
    expect(insertBrollStep?.args.assetId).toMatchObject({
      $fromStep: 'playbook_get_unused_video',
      $path: 'data[0].id',
      $default: 'asset-video-fallback',
    });
  });

  it('creates generate-and-place playbook with approval requirement', () => {
    const thought: Thought = {
      understanding: 'Generate a video and insert it on timeline at playhead',
      requirements: ['ai generation', 'timeline insertion'],
      uncertainties: [],
      approach: 'Generate then place',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'generate_video',
      'check_generation_status',
      'insert_clip',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('generate_and_place');
    expect(match?.plan.requiresApproval).toBe(true);

    const statusStep = match?.plan.steps.find(
      (step) => step.id === 'playbook_check_generation_status',
    );
    expect(statusStep?.args.jobId).toMatchObject({
      $fromStep: 'playbook_generate_video',
      $path: 'data.jobId',
    });
  });

  it('returns null when required tracks/tools are missing', () => {
    const thought: Thought = {
      understanding: 'Add B-roll, music, and subtitles',
      requirements: [],
      uncertainties: [],
      approach: 'Orchestrate',
      needsMoreInfo: false,
    };

    const context = createContext({
      availableTracks: [],
    });
    const toolExecutor = createToolExecutor(['get_unused_assets', 'insert_clip', 'add_caption']);
    const match = buildOrchestrationPlaybook(thought, context, toolExecutor);

    expect(match).toBeNull();
  });

  it('should match stock media search playbook for "find stock footage"', () => {
    const thought: Thought = {
      understanding: 'Find stock footage of nature landscapes',
      requirements: ['stock footage', 'nature'],
      uncertainties: [],
      approach: 'Search stock media references',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['search_stock_media']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('stock_media_search');
    expect(match?.confidence).toBe(0.84);
    expect(match?.plan.steps).toHaveLength(1);
    expect(match?.plan.steps[0].tool).toBe('search_stock_media');
  });

  it('should not auto-match stock media search for "add b-roll" without explicit search intent', () => {
    const thought: Thought = {
      understanding: 'Add b-roll of city skyline',
      requirements: ['b-roll'],
      uncertainties: [],
      approach: 'Search and add b-roll footage of city skyline',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['search_stock_media']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).toBeNull();
  });

  it('should return a search-only playbook for stock media discovery', () => {
    const thought: Thought = {
      understanding: 'Search for stock video of ocean waves',
      requirements: ['stock video'],
      uncertainties: [],
      approach: 'Find stock footage of ocean waves',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['search_stock_media']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('stock_media_search');
    expect(match?.plan.goal).toContain('Find stock video references');
    expect(match?.plan.rollbackStrategy).toContain('No timeline changes');
  });

  it('should not match stock media playbook when search_stock_media tool is missing', () => {
    const thought: Thought = {
      understanding: 'Find stock footage of nature',
      requirements: ['stock footage'],
      uncertainties: [],
      approach: 'Search and insert',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['insert_clip']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match?.id).not.toBe('stock_media_search');
  });

  it('should match auto-caption playbook for "add captions"', () => {
    const thought: Thought = {
      understanding: 'Add captions to the timeline',
      requirements: ['captions', 'transcription'],
      uncertainties: [],
      approach: 'Auto-caption using speech-to-text',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['auto_transcribe', 'add_captions_from_transcription']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('auto_caption');
    expect(match?.confidence).toBe(0.91);
    expect(match?.plan.steps).toHaveLength(2);
    expect(match?.plan.steps[0].tool).toBe('auto_transcribe');
    expect(match?.plan.steps[1].tool).toBe('add_captions_from_transcription');
  });

  it('should chain auto-caption steps with step references for segments', () => {
    const thought: Thought = {
      understanding: 'Generate subtitles for this video',
      requirements: ['subtitles'],
      uncertainties: [],
      approach: 'Transcribe audio then create subtitle clips',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['auto_transcribe', 'add_captions_from_transcription']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();

    const captionStep = match?.plan.steps.find((step) => step.id === 'playbook_add_captions');
    expect(captionStep?.args.segments).toMatchObject({
      $fromStep: 'playbook_auto_transcribe',
      $path: 'data.segments',
    });
    expect(captionStep?.dependsOn).toContain('playbook_auto_transcribe');
  });

  it('should match auto-caption for "auto-caption" keyword', () => {
    const thought: Thought = {
      understanding: 'Auto-caption this clip',
      requirements: ['auto-caption'],
      uncertainties: [],
      approach: 'Use auto-captioning',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['auto_transcribe', 'add_captions_from_transcription']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('auto_caption');
  });

  it('should not match auto-caption when tools are missing', () => {
    const thought: Thought = {
      understanding: 'Add captions to the timeline',
      requirements: ['captions'],
      uncertainties: [],
      approach: 'Transcribe and add',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['add_caption']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match?.id).not.toBe('auto_caption');
  });

  it('should match music bed playbook for "add background music"', () => {
    const thought: Thought = {
      understanding: 'Add background music to the timeline',
      requirements: ['background music'],
      uncertainties: [],
      approach: 'Insert music bed and adjust volume',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['get_unused_assets', 'insert_clip', 'adjust_volume']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('music_bed');
    expect(match?.confidence).toBe(0.89);
    expect(match?.plan.steps).toHaveLength(3);
    expect(match?.plan.steps[0].tool).toBe('get_unused_assets');
    expect(match?.plan.steps[1].tool).toBe('insert_clip');
    expect(match?.plan.steps[2].tool).toBe('adjust_volume');
  });

  it('should set music bed volume to background level', () => {
    const thought: Thought = {
      understanding: 'Add music bed',
      requirements: ['music'],
      uncertainties: [],
      approach: 'Insert music bed audio',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor(['get_unused_assets', 'insert_clip', 'adjust_volume']);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    const volumeStep = match?.plan.steps.find((step) => step.id === 'playbook_set_volume');
    expect(volumeStep?.args.volume).toBe(25);
    expect(volumeStep?.args.clipId).toMatchObject({
      $fromStep: 'playbook_insert_music',
      $path: 'data.clipId',
    });
    expect(volumeStep?.dependsOn).toContain('playbook_insert_music');
  });

  it('should duck only the inserted music clip in the combined b-roll playbook', () => {
    const thought: Thought = {
      understanding: 'Add b-roll with background music and subtitles',
      requirements: ['b-roll', 'music', 'subtitles'],
      uncertainties: [],
      approach: 'Full orchestration',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'get_unused_assets',
      'insert_clip',
      'add_caption',
      'adjust_volume',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    const duckStep = match?.plan.steps.find((step) => step.id === 'playbook_duck_music_bed');
    expect(duckStep?.args.clipId).toMatchObject({
      $fromStep: 'playbook_insert_music_bed',
      $path: 'data.clipId',
    });
  });

  it('should not match music bed when no audio track available', () => {
    const thought: Thought = {
      understanding: 'Add background music',
      requirements: ['background music'],
      uncertainties: [],
      approach: 'Insert music',
      needsMoreInfo: false,
    };

    const context = createContext({
      availableTracks: [{ id: 'track-video-1', name: 'Video 1', type: 'video', clipCount: 0 }],
      availableAssets: [],
    });
    const toolExecutor = createToolExecutor(['get_unused_assets', 'insert_clip', 'adjust_volume']);
    const match = buildOrchestrationPlaybook(thought, context, toolExecutor);

    expect(match?.id).not.toBe('music_bed');
  });

  it('should prefer broll_music_subtitles over stock_media when all three keywords match', () => {
    const thought: Thought = {
      understanding: 'Add stock b-roll with background music and subtitles',
      requirements: ['b-roll', 'music', 'subtitles'],
      uncertainties: [],
      approach: 'Full orchestration',
      needsMoreInfo: false,
    };

    const toolExecutor = createToolExecutor([
      'search_stock_media',
      'get_unused_assets',
      'insert_clip',
      'add_caption',
      'adjust_volume',
    ]);
    const match = buildOrchestrationPlaybook(thought, createContext(), toolExecutor);

    expect(match).not.toBeNull();
    expect(match?.id).toBe('broll_music_subtitles');
  });
});

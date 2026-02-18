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
});

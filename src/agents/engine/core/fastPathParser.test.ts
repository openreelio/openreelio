import { describe, it, expect } from 'vitest';
import type { AgentContext, ValidationResult } from './types';
import { createEmptyContext } from './types';
import { parseFastPathPlan } from './fastPathParser';
import type { IToolExecutor } from '../ports/IToolExecutor';

function createMockToolExecutor(validTools: string[]): IToolExecutor {
  const hasTool = (name: string): boolean => validTools.includes(name);

  const validateArgs = (toolName: string): ValidationResult => ({
    valid: hasTool(toolName),
    errors: hasTool(toolName) ? [] : ['tool not found'],
  });

  return {
    execute: async () => ({ success: true, duration: 0, undoable: false }),
    executeBatch: async () => ({
      success: true,
      results: [],
      totalDuration: 0,
      successCount: 0,
      failureCount: 0,
    }),
    getAvailableTools: () => [],
    getToolDefinition: () => null,
    validateArgs,
    hasTool,
    getToolsByCategory: () => new Map(),
    getToolsByRisk: () => [],
  };
}

function createContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    ...createEmptyContext('project-1'),
    sequenceId: 'seq-1',
    selectedClips: ['clip-1'],
    selectedTracks: ['track-1'],
    ...overrides,
  };
}

describe('parseFastPathPlan', () => {
  const allTools = createMockToolExecutor([
    'split_clip',
    'trim_clip',
    'move_clip',
    'add_caption',
    'delete_clips_in_range',
  ]);

  it('Given a split command, When parser runs, Then it produces split_clip fast path', () => {
    const match = parseFastPathPlan('Split the selected clip at 00:15', createContext(), allTools);

    expect(match).not.toBeNull();
    expect(match?.strategy).toBe('split');
    expect(match?.plan.steps[0]?.tool).toBe('split_clip');
    expect(match?.plan.steps[0]?.args).toMatchObject({ splitTime: 15 });
  });

  it('Given a Korean trim command, When parser runs, Then it resolves one-minute trim target', () => {
    const match = parseFastPathPlan('컷편집 1분까지', createContext(), allTools);

    expect(match).not.toBeNull();
    expect(match?.strategy).toBe('trim');
    expect(match?.plan.steps[0]?.tool).toBe('trim_clip');
    expect(match?.plan.steps[0]?.args).toMatchObject({ newSourceOut: 60 });
  });

  it('Given a move command, When parser runs, Then it extracts destination timeline time', () => {
    const match = parseFastPathPlan('Move selected clip to 12.5s', createContext(), allTools);

    expect(match).not.toBeNull();
    expect(match?.strategy).toBe('move');
    expect(match?.plan.steps[0]?.tool).toBe('move_clip');
    expect(match?.plan.steps[0]?.args).toMatchObject({ newTimelineIn: 12.5 });
  });

  it('Given an add-caption command with range, When parser runs, Then it produces add_caption arguments', () => {
    const match = parseFastPathPlan(
      'Add caption "Hello world" from 00:03 to 00:06',
      createContext(),
      allTools,
    );

    expect(match).not.toBeNull();
    expect(match?.strategy).toBe('add_caption');
    expect(match?.plan.steps[0]?.tool).toBe('add_caption');
    expect(match?.plan.steps[0]?.args).toMatchObject({
      text: 'Hello world',
      startTime: 3,
      endTime: 6,
    });
  });

  it('Given a delete-range command, When parser runs, Then it produces delete_clips_in_range arguments', () => {
    const match = parseFastPathPlan(
      'Delete from 00:10 to 00:20',
      createContext({ selectedTracks: ['track-3'] }),
      allTools,
    );

    expect(match).not.toBeNull();
    expect(match?.strategy).toBe('delete_range');
    expect(match?.plan.steps[0]?.tool).toBe('delete_clips_in_range');
    expect(match?.plan.steps[0]?.args).toMatchObject({
      startTime: 10,
      endTime: 20,
      trackId: 'track-3',
    });
  });

  it('Given missing selected clip context, When parser runs, Then it returns null for safe fallback', () => {
    const match = parseFastPathPlan(
      'Split the selected clip at 5s',
      createContext({ selectedClips: [], selectedTracks: [] }),
      allTools,
    );

    expect(match).toBeNull();
  });

  it('Given unavailable required tool, When parser runs, Then it returns null for safe fallback', () => {
    const limitedTools = createMockToolExecutor(['split_clip']);
    const match = parseFastPathPlan(
      'Add caption "Hello" from 0s to 2s',
      createContext(),
      limitedTools,
    );

    expect(match).toBeNull();
  });

  it('Given stricter confidence threshold, When parser confidence is lower, Then it returns null', () => {
    const match = parseFastPathPlan('Delete from 10s to 15s', createContext(), allTools, {
      minConfidence: 0.95,
    });

    expect(match).toBeNull();
  });

  it.each([
    {
      input: 'Split selected clip at playhead',
      context: createContext({ playheadPosition: 22.5 }),
      strategy: 'split',
      tool: 'split_clip',
      args: { splitTime: 22.5 },
    },
    {
      input: 'Move selected clip to 00:12',
      context: createContext(),
      strategy: 'move',
      tool: 'move_clip',
      args: { newTimelineIn: 12 },
    },
    {
      input: 'Add caption "안녕하세요" from 0초 to 3초',
      context: createContext(),
      strategy: 'add_caption',
      tool: 'add_caption',
      args: { text: '안녕하세요', startTime: 0, endTime: 3 },
    },
    {
      input: 'Delete 00:05-00:08',
      context: createContext(),
      strategy: 'delete_range',
      tool: 'delete_clips_in_range',
      args: { startTime: 5, endTime: 8 },
    },
  ])(
    'Given multilingual fixture "$input", When parser runs, Then strategy is $strategy',
    ({ input, context, strategy, tool, args }) => {
      const match = parseFastPathPlan(input, context, allTools);

      expect(match).not.toBeNull();
      expect(match?.strategy).toBe(strategy);
      expect(match?.plan.steps[0]?.tool).toBe(tool);
      expect(match?.plan.steps[0]?.args).toMatchObject(args);
    },
  );
});

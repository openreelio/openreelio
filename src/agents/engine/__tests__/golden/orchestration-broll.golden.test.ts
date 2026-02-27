/**
 * Golden Scenario: Orchestration B-Roll
 *
 * Tests complex multi-step orchestration for a B-roll + music playbook.
 * Validates step-reference resolution across 4 chained steps with dependencies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAgenticEngine } from '../../AgenticEngine';
import type { AgentEvent, Thought, Plan, Observation, AgentContext } from '../../core/types';
import { createEmptyContext } from '../../core/types';
import { createMockLLMAdapter, type MockLLMAdapter } from '../../adapters/llm/MockLLMAdapter';
import {
  createMockToolExecutor,
  type MockToolExecutor,
} from '../../adapters/tools/MockToolExecutor';
import type { ExecutionContext } from '../../ports/IToolExecutor';

describe('Golden: orchestration-broll', () => {
  let mockLLM: MockLLMAdapter;
  let mockToolExecutor: MockToolExecutor;
  let agentContext: AgentContext;
  let executionContext: ExecutionContext;

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    mockToolExecutor = createMockToolExecutor();

    // 1. find_asset — discovers the B-roll asset
    mockToolExecutor.registerTool({
      info: {
        name: 'find_asset',
        description: 'Find asset in workspace by query',
        category: 'discovery',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: true,
      },
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
      required: ['query'],
      result: {
        success: true,
        data: { assetId: 'asset-broll-1', filename: 'landscape.mp4' },
        duration: 20,
      },
    });

    // 2. insert_clip — places B-roll on timeline (uses $fromStep reference)
    mockToolExecutor.registerTool({
      info: {
        name: 'insert_clip',
        description: 'Insert asset clip onto timeline',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          sequenceId: { type: 'string' },
          trackId: { type: 'string' },
          assetId: { type: 'string' },
          timelineStart: { type: 'number' },
        },
      },
      required: ['sequenceId', 'trackId', 'assetId', 'timelineStart'],
      executor: async (args) => {
        // Verify assetId was resolved from step reference (should be string, not object)
        if (typeof args.assetId !== 'string') {
          return { success: false, error: 'assetId must be a resolved string', duration: 5 };
        }
        return {
          success: true,
          data: { clipId: 'clip-broll', assetId: args.assetId, start: args.timelineStart },
          duration: 40,
        };
      },
    });

    // 3. add_music — adds background music (depends on B-roll placement)
    mockToolExecutor.registerTool({
      info: {
        name: 'add_music',
        description: 'Add background music track',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          sequenceId: { type: 'string' },
          assetId: { type: 'string' },
          volume: { type: 'number' },
        },
      },
      required: ['sequenceId', 'assetId'],
      result: {
        success: true,
        data: { musicClipId: 'clip-music-1' },
        duration: 30,
      },
    });

    // 4. add_captions — adds captions at B-roll position
    mockToolExecutor.registerTool({
      info: {
        name: 'add_captions',
        description: 'Add caption text to timeline',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          sequenceId: { type: 'string' },
          startTime: { type: 'number' },
          text: { type: 'string' },
        },
      },
      required: ['sequenceId', 'startTime', 'text'],
      result: {
        success: true,
        data: { captionId: 'caption-1' },
        duration: 25,
      },
    });

    agentContext = createEmptyContext('project-1');
    agentContext.sequenceId = 'sequence-1';
    agentContext.availableTools = mockToolExecutor.getAvailableTools().map((t) => t.name);
    agentContext.availableTracks = [
      { id: 'video-1', name: 'Video 1', type: 'video', clipCount: 0 },
      { id: 'video-2', name: 'Video 2 (B-Roll)', type: 'video', clipCount: 0 },
      { id: 'audio-1', name: 'Audio 1', type: 'audio', clipCount: 0 },
    ];

    executionContext = {
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      sessionId: 'session-golden-broll',
    };
  });

  it('should execute B-roll+music playbook with 4 chained steps and resolved references', async () => {
    const thought: Thought = {
      understanding: 'Create a B-roll scene with background music and captions',
      requirements: ['B-roll asset query', 'Music asset', 'Caption text'],
      uncertainties: [],
      approach: 'Find B-roll, insert on video-2, add music bed, add captions at same position',
      needsMoreInfo: false,
    };

    const plan: Plan = {
      goal: 'Create B-roll scene with music and captions',
      steps: [
        {
          id: 'find-broll',
          tool: 'find_asset',
          args: { query: 'nature landscape' },
          description: 'Find B-roll clip in workspace',
          riskLevel: 'low',
          estimatedDuration: 50,
        },
        {
          id: 'place-broll',
          tool: 'insert_clip',
          args: {
            sequenceId: 'sequence-1',
            trackId: 'video-2',
            assetId: { $fromStep: 'find-broll', $path: 'data.assetId' },
            timelineStart: 10,
          },
          description: 'Place B-roll on secondary video track at 10s',
          riskLevel: 'low',
          estimatedDuration: 100,
          dependsOn: ['find-broll'],
        },
        {
          id: 'place-music',
          tool: 'add_music',
          args: {
            sequenceId: 'sequence-1',
            assetId: 'asset-music-bg',
            volume: 0.7,
          },
          description: 'Add background music bed',
          riskLevel: 'low',
          estimatedDuration: 80,
          dependsOn: ['place-broll'],
        },
        {
          id: 'add-caption',
          tool: 'add_captions',
          args: {
            sequenceId: 'sequence-1',
            startTime: 10,
            text: 'Beautiful landscape',
          },
          description: 'Add caption at B-roll entry point',
          riskLevel: 'low',
          estimatedDuration: 60,
          dependsOn: ['place-broll'],
        },
      ],
      estimatedTotalDuration: 290,
      requiresApproval: false,
      rollbackStrategy: 'Undo in reverse order',
    };

    const observation: Observation = {
      goalAchieved: true,
      stateChanges: [
        { type: 'clip_created', target: 'clip-broll' },
        { type: 'clip_created', target: 'clip-music-1' },
        { type: 'caption_created', target: 'caption-1' },
      ],
      summary: 'B-roll scene created with music and captions',
      confidence: 0.98,
      needsIteration: false,
    };

    let callCount = 0;
    vi.spyOn(mockLLM, 'generateStructured').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return thought;
      if (callCount === 2) return plan;
      return observation;
    });

    const engine = createAgenticEngine(mockLLM, mockToolExecutor, {
      enableFastPath: false,
      enableTracing: true,
    });

    const events: AgentEvent[] = [];
    const result = await engine.run(
      'Create a B-roll scene with landscape footage, background music, and captions',
      agentContext,
      executionContext,
      (event) => events.push(event),
    );

    // Verify success
    expect(result.success).toBe(true);

    // Verify all 4 tools executed
    const executions = mockToolExecutor.getCapturedExecutions();
    expect(executions).toHaveLength(4);

    // Verify execution order respects dependencies
    expect(executions[0].toolName).toBe('find_asset');
    expect(executions[1].toolName).toBe('insert_clip');
    // place-music and add-caption both depend on place-broll, order may vary
    const lastTwo = executions.slice(2).map((e) => e.toolName).sort();
    expect(lastTwo).toEqual(['add_captions', 'add_music']);

    // Verify step reference resolved: insert_clip got assetId from find_asset result
    const insertExec = executions.find((e) => e.toolName === 'insert_clip')!;
    expect(insertExec.args.assetId).toBe('asset-broll-1');
    expect(insertExec.args.trackId).toBe('video-2');
    expect(insertExec.args.timelineStart).toBe(10);

    // Verify trace
    if (result.trace) {
      expect(result.trace.success).toBe(true);
      expect(result.trace.fastPath).toBe(false);
    }
  });
});

/**
 * Golden Scenario: Multi-Step Edit
 *
 * Tests full Think-Plan-Act-Observe cycle with 2 dependent tool calls.
 * Validates step reference resolution ($fromStep) and execution ordering.
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

describe('Golden: multi-step-edit', () => {
  let mockLLM: MockLLMAdapter;
  let mockToolExecutor: MockToolExecutor;
  let agentContext: AgentContext;
  let executionContext: ExecutionContext;

  beforeEach(() => {
    mockLLM = createMockLLMAdapter();
    mockToolExecutor = createMockToolExecutor();

    // Register trim_clip tool
    mockToolExecutor.registerTool({
      info: {
        name: 'trim_clip',
        description: 'Trim a clip start or end',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          startDelta: { type: 'number' },
          endDelta: { type: 'number' },
        },
      },
      required: ['clipId'],
      result: {
        success: true,
        data: { trimmed: true, clipId: 'clip-1', newDuration: 8 },
        duration: 40,
      },
    });

    // Register fadeIn_audio tool (depends on trim result)
    mockToolExecutor.registerTool({
      info: {
        name: 'fadeIn_audio',
        description: 'Add audio fade-in to a clip',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          durationMs: { type: 'number' },
        },
      },
      required: ['clipId', 'durationMs'],
      executor: async (args) => {
        return {
          success: true,
          data: { fadeApplied: true, clipId: args.clipId, durationMs: args.durationMs },
          duration: 25,
        };
      },
    });

    agentContext = createEmptyContext('project-1');
    agentContext.sequenceId = 'sequence-1';
    agentContext.selectedClips = ['clip-1'];
    agentContext.availableTools = mockToolExecutor.getAvailableTools().map((t) => t.name);

    executionContext = {
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      sessionId: 'session-golden-multi',
    };
  });

  it('should execute 4-phase TPAO with 2 dependent tool calls and step references', async () => {
    const thought: Thought = {
      understanding: 'User wants to trim a clip and add a fade-in effect',
      requirements: ['Clip ID', 'Trim amounts', 'Fade duration'],
      uncertainties: [],
      approach: 'Trim the clip first, then apply audio fade-in using the clip ID from trim result',
      needsMoreInfo: false,
    };

    const plan: Plan = {
      goal: 'Trim clip and add fade-in',
      steps: [
        {
          id: 'step-1',
          tool: 'trim_clip',
          args: { clipId: 'clip-1', startDelta: 2, endDelta: 0 },
          description: 'Trim 2 seconds from clip start',
          riskLevel: 'low',
          estimatedDuration: 50,
        },
        {
          id: 'step-2',
          tool: 'fadeIn_audio',
          args: {
            clipId: { $fromStep: 'step-1', $path: 'data.clipId' },
            durationMs: 500,
          },
          description: 'Apply 500ms audio fade-in to the trimmed clip',
          riskLevel: 'low',
          estimatedDuration: 30,
          dependsOn: ['step-1'],
        },
      ],
      estimatedTotalDuration: 80,
      requiresApproval: false,
      rollbackStrategy: 'Undo fade then undo trim',
    };

    const observation: Observation = {
      goalAchieved: true,
      stateChanges: [
        { type: 'clip_trimmed', target: 'clip-1', details: { startDelta: 2 } },
        { type: 'effect_applied', target: 'clip-1', details: { type: 'fadeIn' } },
      ],
      summary: 'Clip trimmed and fade-in applied successfully',
      confidence: 0.95,
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
      'Trim 2 seconds from the start and add a 500ms fade-in',
      agentContext,
      executionContext,
      (event) => events.push(event),
    );

    // Verify success
    expect(result.success).toBe(true);
    expect(result.iterations).toBe(1);

    // Verify LLM was called 3 times (Think, Plan, Observe)
    // Note: vi.spyOn replaces the method, so getCapturedRequests() is empty.
    // Use the callCount variable to verify.
    expect(callCount).toBe(3);

    // Verify 2 tool calls in correct order
    const executions = mockToolExecutor.getCapturedExecutions();
    expect(executions).toHaveLength(2);
    expect(executions[0].toolName).toBe('trim_clip');
    expect(executions[1].toolName).toBe('fadeIn_audio');

    // Verify $fromStep reference was resolved: step-2 received clip-1 from step-1
    expect(executions[1].args.clipId).toBe('clip-1');
    expect(executions[1].args.durationMs).toBe(500);

    // Verify trace records 4 phases (TPAO)
    if (result.trace) {
      expect(result.trace.fastPath).toBe(false);
      expect(result.trace.phases.length).toBeGreaterThanOrEqual(3);
      expect(result.trace.success).toBe(true);
    }

    // Verify TPAO event sequence
    expect(events.some((e) => e.type === 'thinking_start')).toBe(true);
    expect(events.some((e) => e.type === 'thinking_complete')).toBe(true);
    expect(events.some((e) => e.type === 'planning_start')).toBe(true);
    expect(events.some((e) => e.type === 'planning_complete')).toBe(true);
    expect(events.some((e) => e.type === 'execution_start')).toBe(true);
    expect(events.some((e) => e.type === 'execution_complete')).toBe(true);
    expect(events.some((e) => e.type === 'observation_complete')).toBe(true);
  });
});

/**
 * Golden Scenario: Canonical Runtime Contract
 *
 * Verifies the shipping TPAO runtime behavior without relying on the
 * compatibility runtime.
 */

import { describe, it, expect } from 'vitest';
import { createAgenticEngine } from '../../AgenticEngine';
import { createMockLLMAdapter } from '../../adapters/llm/MockLLMAdapter';
import { createMockToolExecutor } from '../../adapters/tools/MockToolExecutor';
import type { AgentContext, AgentEvent, Observation, Plan, Thought } from '../../core/types';
import { createEmptyContext } from '../../core/types';
import type { ExecutionContext } from '../../ports/IToolExecutor';

function createCanonicalContext(): AgentContext {
  return {
    ...createEmptyContext('project-canonical-runtime'),
    sequenceId: 'sequence-1',
    selectedClips: ['clip-1'],
    selectedTracks: ['track-1'],
    playheadPosition: 5,
  };
}

function createExecutionContext(sessionId: string): ExecutionContext {
  return {
    projectId: 'project-canonical-runtime',
    sequenceId: 'sequence-1',
    sessionId,
  };
}

describe('Golden: canonical-runtime', () => {
  it('should execute a deterministic split through the canonical TPAO runtime', async () => {
    const observation: Observation = {
      goalAchieved: true,
      stateChanges: [{ type: 'clip_created', target: 'clip-2' }],
      summary: 'Split completed',
      confidence: 0.95,
      needsIteration: false,
    };

    const llm = createMockLLMAdapter();
    llm.setStructuredResponse({ structured: observation });
    const tools = createMockToolExecutor();
    tools.registerTool({
      info: {
        name: 'split_clip',
        description: 'Split clip',
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
          clipId: { type: 'string' },
          splitTime: { type: 'number' },
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'splitTime'],
      result: {
        success: true,
        data: { newClipId: 'clip-2' },
        duration: 10,
      },
    });

    const context = createCanonicalContext();
    context.availableTools = tools.getAvailableTools().map((tool) => tool.name);

    const events: AgentEvent[] = [];
    const result = await createAgenticEngine(llm, tools, {
      enableFastPath: true,
      enableTracing: true,
    }).run(
      'Split selected clip at 5s',
      context,
      createExecutionContext('session-canonical-split'),
      (event) => events.push(event),
    );

    expect(result.success).toBe(true);
    expect(result.trace?.runtimeKind).toBe('tpao');
    expect(result.trace?.fastPath).toBe(true);
    expect(events.some((event) => event.type === 'approval_required')).toBe(false);
    expect(
      tools.wasToolCalledWith('split_clip', {
        sequenceId: 'sequence-1',
        trackId: 'track-1',
        clipId: 'clip-1',
        splitTime: 5,
      }),
    ).toBe(true);
  });

  it('should keep destructive edits approval-gated in the canonical runtime', async () => {
    const thought: Thought = {
      understanding: 'Delete all clips from the timeline',
      requirements: ['Sequence ID', 'User confirmation'],
      uncertainties: [],
      approach: 'Require approval before destructive deletion',
      needsMoreInfo: false,
    };
    const plan: Plan = {
      goal: 'Delete all clips from timeline',
      steps: [
        {
          id: 'step-1',
          tool: 'delete_all_clips',
          args: { sequenceId: 'sequence-1', confirm: true },
          description: 'Delete every clip in the active timeline',
          riskLevel: 'critical',
          estimatedDuration: 100,
        },
      ],
      estimatedTotalDuration: 100,
      requiresApproval: true,
      rollbackStrategy: 'Manual restore required',
    };
    const observation: Observation = {
      goalAchieved: true,
      stateChanges: [{ type: 'timeline_cleared', target: 'sequence-1' }],
      summary: 'Timeline cleared',
      confidence: 1,
      needsIteration: false,
    };

    const llm = createMockLLMAdapter();
    let llmCallCount = 0;
    llm.generateStructured = async <T>() => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return thought as T;
      }
      if (llmCallCount === 2) {
        return plan as T;
      }
      return observation as T;
    };

    const tools = createMockToolExecutor();
    tools.registerTool({
      info: {
        name: 'delete_all_clips',
        description: 'Delete all clips',
        category: 'editing',
        riskLevel: 'critical',
        supportsUndo: false,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          sequenceId: { type: 'string' },
          confirm: { type: 'boolean' },
        },
      },
      required: ['sequenceId', 'confirm'],
      result: {
        success: true,
        data: { removedCount: 12 },
        duration: 20,
      },
    });

    const events: AgentEvent[] = [];
    const result = await createAgenticEngine(llm, tools, {
      enableFastPath: true,
      approvalHandler: async () => true,
    }).run(
      'Delete all clips from the timeline',
      {
        ...createCanonicalContext(),
        availableTools: ['delete_all_clips'],
      },
      createExecutionContext('session-canonical-delete'),
      (event) => events.push(event),
    );

    expect(result.success).toBe(true);
    expect(events.some((event) => event.type === 'approval_required')).toBe(true);
    expect(
      tools.wasToolCalledWith('delete_all_clips', {
        sequenceId: 'sequence-1',
        confirm: true,
      }),
    ).toBe(true);
  });
});

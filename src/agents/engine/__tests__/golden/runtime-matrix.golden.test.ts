/**
 * Golden Scenario: Runtime Matrix
 *
 * Compares the canonical TPAO runtime and the compatibility fast runtime on
 * representative shipping scenarios: deterministic edits and gated destructive
 * actions.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAgenticEngine } from '../../AgenticEngine';
import { createAgentLoop, type AgentLoopEvent } from '../../AgentLoop';
import type {
  AgentContext,
  AgentEvent,
  Observation,
  Plan,
  Thought,
} from '../../core/types';
import { createEmptyContext } from '../../core/types';
import { createMockLLMAdapter } from '../../adapters/llm/MockLLMAdapter';
import { createMockToolExecutor } from '../../adapters/tools/MockToolExecutor';
import type { ExecutionContext } from '../../ports/IToolExecutor';

function createMatrixContext(): AgentContext {
  return {
    ...createEmptyContext('project-runtime-matrix'),
    sequenceId: 'sequence-1',
    selectedClips: ['clip-1'],
    selectedTracks: ['track-1'],
    playheadPosition: 5,
  };
}

function createExecutionContext(sessionId: string): ExecutionContext {
  return {
    projectId: 'project-runtime-matrix',
    sequenceId: 'sequence-1',
    sessionId,
  };
}

async function collectLoopEvents(
  events: AsyncGenerator<AgentLoopEvent, void, unknown>,
): Promise<AgentLoopEvent[]> {
  const collected: AgentLoopEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('Golden: runtime-matrix', () => {
  it('should keep deterministic split behavior aligned across TPAO fast path and AgentLoop', async () => {
    const observation: Observation = {
      goalAchieved: true,
      stateChanges: [{ type: 'clip_created', target: 'clip-2' }],
      summary: 'Split completed',
      confidence: 0.95,
      needsIteration: false,
    };

    const tpaoLlm = createMockLLMAdapter();
    tpaoLlm.setStructuredResponse({ structured: observation });
    const tpaoTools = createMockToolExecutor();
    tpaoTools.registerTool({
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

    const loopLlm = createMockLLMAdapter();
    const loopTools = createMockToolExecutor();
    loopTools.registerTool({
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

    const context = createMatrixContext();
    context.availableTools = tpaoTools.getAvailableTools().map((tool) => tool.name);

    const tpaoEvents: AgentEvent[] = [];
    const tpaoResult = await createAgenticEngine(tpaoLlm, tpaoTools, {
      enableFastPath: true,
      enableTracing: true,
    }).run(
      'Split selected clip at 5s',
      context,
      createExecutionContext('session-tpao-fast'),
      (event) => tpaoEvents.push(event),
    );

    const loopEvents = await collectLoopEvents(
      createAgentLoop(loopLlm, loopTools).run(
        'session-loop-fast',
        'Split selected clip at 5s',
        {
          ...context,
          availableTools: loopTools.getAvailableTools().map((tool) => tool.name),
        },
      ),
    );

    expect(tpaoResult.success).toBe(true);
    expect(tpaoResult.trace?.fastPath).toBe(true);
    expect(tpaoTools.wasToolCalledWith('split_clip', {
      sequenceId: 'sequence-1',
      trackId: 'track-1',
      clipId: 'clip-1',
      splitTime: 5,
    })).toBe(true);
    expect(tpaoEvents.some((event) => event.type === 'approval_required')).toBe(false);

    expect(loopEvents.find((event) => event.type === 'done')?.fastPath).toBe(true);
    expect(loopTools.wasToolCalledWith('split_clip', {
      sequenceId: 'sequence-1',
      trackId: 'track-1',
      clipId: 'clip-1',
      splitTime: 5,
    })).toBe(true);
  });

  it('should keep destructive edits gated in both the canonical and compatibility runtimes', async () => {
    const destructiveThought: Thought = {
      understanding: 'Delete all clips from the timeline',
      requirements: ['Sequence ID', 'User confirmation'],
      uncertainties: [],
      approach: 'Require approval before destructive deletion',
      needsMoreInfo: false,
    };
    const destructivePlan: Plan = {
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
    const destructiveObservation: Observation = {
      goalAchieved: true,
      stateChanges: [{ type: 'timeline_cleared', target: 'sequence-1' }],
      summary: 'Timeline cleared',
      confidence: 1,
      needsIteration: false,
    };

    const tpaoLlm = createMockLLMAdapter();
    let llmCallCount = 0;
    vi.spyOn(tpaoLlm, 'generateStructured').mockImplementation(async () => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return destructiveThought;
      }
      if (llmCallCount === 2) {
        return destructivePlan;
      }
      return destructiveObservation;
    });

    const tpaoTools = createMockToolExecutor();
    tpaoTools.registerTool({
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

    const tpaoEvents: AgentEvent[] = [];
    const tpaoResult = await createAgenticEngine(tpaoLlm, tpaoTools, {
      enableFastPath: true,
      approvalHandler: async () => true,
    }).run(
      'Delete all clips from the timeline',
      {
        ...createMatrixContext(),
        availableTools: tpaoTools.getAvailableTools().map((tool) => tool.name),
      },
      createExecutionContext('session-tpao-destructive'),
      (event) => tpaoEvents.push(event),
    );

    const loopLlm = createMockLLMAdapter();
    const loopTools = createMockToolExecutor();
    loopTools.registerTool({
      info: {
        name: 'delete_clips_in_range',
        description: 'Delete clips in range',
        category: 'editing',
        riskLevel: 'high',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          sequenceId: { type: 'string' },
          trackId: { type: 'string' },
          startTime: { type: 'number' },
          endTime: { type: 'number' },
        },
      },
      required: ['sequenceId', 'startTime', 'endTime'],
      result: {
        success: true,
        data: { removedCount: 2 },
        duration: 10,
      },
    });

    const permissionHandler = vi.fn().mockResolvedValue('allow');
    const loopEvents = await collectLoopEvents(
      createAgentLoop(loopLlm, loopTools, {
        approvalThreshold: 'high',
        toolPermissionHandler: permissionHandler,
      }).run(
        'session-loop-destructive',
        'Delete from 00:05 to 00:10',
        {
          ...createMatrixContext(),
          availableTools: loopTools.getAvailableTools().map((tool) => tool.name),
        },
      ),
    );

    expect(tpaoResult.success).toBe(true);
    expect(tpaoResult.trace?.fastPath).toBe(false);
    expect(tpaoEvents.some((event) => event.type === 'approval_required')).toBe(true);
    expect(tpaoEvents.some((event) => event.type === 'approval_response')).toBe(true);

    expect(permissionHandler).toHaveBeenCalledWith(
      'delete_clips_in_range',
      {
        sequenceId: 'sequence-1',
        trackId: 'track-1',
        startTime: 5,
        endTime: 10,
      },
      'high',
    );
    expect(loopEvents.find((event) => event.type === 'done')?.fastPath).toBe(true);
    expect(loopTools.wasToolCalled('delete_clips_in_range')).toBe(true);
  });
});

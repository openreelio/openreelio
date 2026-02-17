import { describe, it, expect, vi } from 'vitest';
import { createAgenticEngine } from './AgenticEngine';
import { createMockLLMAdapter } from './adapters/llm/MockLLMAdapter';
import { createMockToolExecutor, type MockToolExecutor } from './adapters/tools/MockToolExecutor';
import {
  createEmptyContext,
  type AgentContext,
  type Observation,
  type Plan,
  type Thought,
} from './core/types';
import type { ExecutionContext } from './ports/IToolExecutor';

function registerDeterministicTools(executor: MockToolExecutor): void {
  executor.registerTools([
    {
      info: {
        name: 'split_clip',
        description: 'Split selected clip',
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
        data: { split: true },
        duration: 15,
      },
    },
    {
      info: {
        name: 'trim_clip',
        description: 'Trim selected clip',
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
          newSourceOut: { type: 'number' },
        },
      },
      required: ['sequenceId', 'trackId', 'clipId'],
      result: {
        success: true,
        data: { trimmed: true },
        duration: 15,
      },
    },
    {
      info: {
        name: 'move_clip',
        description: 'Move selected clip',
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
          newTimelineIn: { type: 'number' },
        },
      },
      required: ['sequenceId', 'trackId', 'clipId', 'newTimelineIn'],
      result: {
        success: true,
        data: { moved: true },
        duration: 15,
      },
    },
    {
      info: {
        name: 'add_caption',
        description: 'Add caption',
        category: 'utility',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          sequenceId: { type: 'string' },
          text: { type: 'string' },
          startTime: { type: 'number' },
          endTime: { type: 'number' },
        },
      },
      required: ['sequenceId', 'text', 'startTime', 'endTime'],
      result: {
        success: true,
        data: { captionId: 'caption-1' },
        duration: 15,
      },
    },
    {
      info: {
        name: 'delete_clips_in_range',
        description: 'Delete clips in range',
        category: 'editing',
        riskLevel: 'medium',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          sequenceId: { type: 'string' },
          startTime: { type: 'number' },
          endTime: { type: 'number' },
        },
      },
      required: ['sequenceId', 'startTime', 'endTime'],
      result: {
        success: true,
        data: { deleted: 2 },
        duration: 15,
      },
    },
  ]);
}

function createContext(): AgentContext {
  return {
    ...createEmptyContext('project-1'),
    sequenceId: 'sequence-1',
    selectedClips: ['clip-1'],
    selectedTracks: ['track-1'],
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    projectId: 'project-1',
    sequenceId: 'sequence-1',
    sessionId: 'session-bdd',
  };
}

const successThought: Thought = {
  understanding: 'Split selected clip at given time',
  requirements: ['clip id', 'split time'],
  uncertainties: [],
  approach: 'Use split tool',
  needsMoreInfo: false,
};

const successPlan: Plan = {
  goal: 'Split selected clip at 5 seconds',
  steps: [
    {
      id: 'step-1',
      tool: 'split_clip',
      args: {
        sequenceId: 'sequence-1',
        trackId: 'track-1',
        clipId: 'clip-1',
        splitTime: 5,
      },
      description: 'Split clip at 5 seconds',
      riskLevel: 'low',
      estimatedDuration: 120,
    },
  ],
  estimatedTotalDuration: 120,
  requiresApproval: false,
  rollbackStrategy: 'Undo split operation',
};

const successObservation: Observation = {
  goalAchieved: true,
  stateChanges: [],
  summary: 'Operation completed successfully',
  confidence: 0.98,
  needsIteration: false,
};

function arrangeThreePhaseSuccess(
  llm = createMockLLMAdapter(),
  delayMs = 0,
): {
  llm: ReturnType<typeof createMockLLMAdapter>;
  getCallCount: () => number;
} {
  let callCount = 0;

  vi.spyOn(llm, 'generateStructured').mockImplementation(async () => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    callCount += 1;
    if (callCount === 1) {
      return successThought;
    }
    if (callCount === 2) {
      return successPlan;
    }
    return successObservation;
  });

  return {
    llm,
    getCallCount: () => callCount,
  };
}

describe('AgenticEngine fast path (BDD scenarios)', () => {
  it('Given a deterministic split request, When fast path is enabled, Then it executes without LLM think/plan', async () => {
    const llm = createMockLLMAdapter();
    llm.setStructuredResponse({ structured: successObservation });

    const toolExecutor = createMockToolExecutor();
    registerDeterministicTools(toolExecutor);

    const engine = createAgenticEngine(llm, toolExecutor);
    const result = await engine.run(
      'Split selected clip at 5s',
      createContext(),
      createExecutionContext(),
    );

    expect(result.success).toBe(true);
    expect(result.finalState.plan?.steps[0]?.id).toBe('fastpath-split');
    expect(toolExecutor.wasToolCalled('split_clip')).toBe(true);
    expect(llm.getRequestCount()).toBe(1);
  });

  it('Given an ambiguous prompt, When the parser confidence is low, Then the engine falls back to full TPAO', async () => {
    const arranged = arrangeThreePhaseSuccess();
    const toolExecutor = createMockToolExecutor();
    registerDeterministicTools(toolExecutor);

    const engine = createAgenticEngine(arranged.llm, toolExecutor);
    const result = await engine.run(
      'Make this opener feel more dramatic',
      createContext(),
      createExecutionContext(),
    );

    expect(result.success).toBe(true);
    expect(arranged.getCallCount()).toBe(3);
    expect(result.finalState.plan?.steps[0]?.id).toBe('step-1');
  });

  it('Given a deterministic command, When confidence threshold is stricter than parser confidence, Then it falls back to full TPAO', async () => {
    const arranged = arrangeThreePhaseSuccess();
    const toolExecutor = createMockToolExecutor();
    registerDeterministicTools(toolExecutor);

    const engine = createAgenticEngine(arranged.llm, toolExecutor, {
      fastPathConfidenceThreshold: 0.99,
    });

    const result = await engine.run(
      'Split selected clip at 5s',
      createContext(),
      createExecutionContext(),
    );

    expect(result.success).toBe(true);
    expect(arranged.getCallCount()).toBe(3);
    expect(result.finalState.plan?.steps[0]?.id).toBe('step-1');
  });

  it('Given fast path is disabled, When running a deterministic command, Then the engine always uses full TPAO', async () => {
    const arranged = arrangeThreePhaseSuccess();
    const toolExecutor = createMockToolExecutor();
    registerDeterministicTools(toolExecutor);

    const engine = createAgenticEngine(arranged.llm, toolExecutor, {
      enableFastPath: false,
    });

    const result = await engine.run(
      'Split selected clip at 5s',
      createContext(),
      createExecutionContext(),
    );

    expect(result.success).toBe(true);
    expect(arranged.getCallCount()).toBe(3);
    expect(result.finalState.plan?.steps[0]?.id).toBe('step-1');
  });

  it('Given identical deterministic input, When comparing fast path vs full TPAO, Then fast path latency is lower', async () => {
    const fastLlm = createMockLLMAdapter();
    fastLlm.setStructuredResponse({ structured: successObservation, delay: 40 });

    const fullArranged = arrangeThreePhaseSuccess(createMockLLMAdapter(), 40);

    const fastTools = createMockToolExecutor();
    registerDeterministicTools(fastTools);
    const fullTools = createMockToolExecutor();
    registerDeterministicTools(fullTools);

    const fastEngine = createAgenticEngine(fastLlm, fastTools);
    const fullEngine = createAgenticEngine(fullArranged.llm, fullTools, {
      enableFastPath: false,
    });

    const fastResult = await fastEngine.run('Split selected clip at 5s', createContext(), {
      ...createExecutionContext(),
      sessionId: 'session-fast',
    });
    const fullResult = await fullEngine.run('Split selected clip at 5s', createContext(), {
      ...createExecutionContext(),
      sessionId: 'session-full',
    });

    expect(fastResult.success).toBe(true);
    expect(fullResult.success).toBe(true);
    expect(fastResult.totalDuration).toBeLessThan(fullResult.totalDuration);
  });
});

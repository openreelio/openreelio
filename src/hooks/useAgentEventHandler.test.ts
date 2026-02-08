/**
 * Tests for useAgentEventHandler
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentEventHandler } from './useAgentEventHandler';
import { useConversationStore } from '@/stores/conversationStore';
import type { Thought, Plan, PlanStep, Observation } from '@/agents/engine';

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestThought(): Thought {
  return {
    understanding: 'Split the clip at 5 seconds',
    requirements: ['Find the clip'],
    uncertainties: [],
    approach: 'Use split_clip tool',
    needsMoreInfo: false,
  };
}

function createTestPlan(): Plan {
  return {
    goal: 'Split clip',
    steps: [
      {
        id: 's1',
        tool: 'split_clip',
        args: { clipId: 'c1', position: 5 },
        description: 'Split clip at 5s',
        riskLevel: 'low',
        estimatedDuration: 500,
      },
    ],
    estimatedTotalDuration: 500,
    requiresApproval: false,
    rollbackStrategy: 'Undo',
  };
}

function createTestStep(): PlanStep {
  return {
    id: 's1',
    tool: 'split_clip',
    args: { clipId: 'c1', position: 5 },
    description: 'Split clip at 5s',
    riskLevel: 'low',
    estimatedDuration: 500,
  };
}

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  useConversationStore.setState({
    activeConversation: {
      id: 'conv-1',
      projectId: 'project-1',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    isGenerating: false,
    streamingMessageId: null,
    activeProjectId: 'project-1',
  });

  let uuidCounter = 0;
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => `uuid-${++uuidCounter}`),
  });
});

// =============================================================================
// Tests
// =============================================================================

describe('useAgentEventHandler', () => {
  it('should create assistant message on session_start', () => {
    const { result } = renderHook(() => useAgentEventHandler());

    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'Split clip',
        timestamp: Date.now(),
      });
    });

    const state = useConversationStore.getState();
    expect(state.activeConversation!.messages).toHaveLength(1);
    expect(state.activeConversation!.messages[0].role).toBe('assistant');
    expect(state.activeConversation!.messages[0].sessionId).toBe('session-1');
    expect(state.isGenerating).toBe(true);
  });

  it('should append thinking part on thinking_complete', () => {
    const { result } = renderHook(() => useAgentEventHandler());
    const thought = createTestThought();

    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'test',
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'thinking_complete',
        thought,
        timestamp: Date.now(),
      });
    });

    const msg = useConversationStore.getState().activeConversation!.messages[0];
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0].type).toBe('thinking');
  });

  it('should append plan part on planning_complete', () => {
    const { result } = renderHook(() => useAgentEventHandler());
    const plan = createTestPlan();

    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'test',
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'planning_complete',
        plan,
        timestamp: Date.now(),
      });
    });

    const msg = useConversationStore.getState().activeConversation!.messages[0];
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0].type).toBe('plan');
    if (msg.parts[0].type === 'plan') {
      expect(msg.parts[0].status).toBe('proposed');
    }
  });

  it('should append tool_call on execution_start', () => {
    const { result } = renderHook(() => useAgentEventHandler());

    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'test',
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'execution_start',
        step: createTestStep(),
        timestamp: Date.now(),
      });
    });

    const msg = useConversationStore.getState().activeConversation!.messages[0];
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0].type).toBe('tool_call');
    if (msg.parts[0].type === 'tool_call') {
      expect(msg.parts[0].status).toBe('running');
      expect(msg.parts[0].tool).toBe('split_clip');
    }
  });

  it('should update approval and plan parts on approval_response', () => {
    const { result } = renderHook(() => useAgentEventHandler());
    const plan = {
      ...createTestPlan(),
      requiresApproval: true,
    };

    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'test',
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'planning_complete',
        plan,
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'approval_required',
        plan,
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'approval_response',
        approved: true,
        timestamp: Date.now(),
      });
    });

    const msg = useConversationStore.getState().activeConversation!.messages[0];
    const approvalPart = msg.parts.find((p) => p.type === 'approval');
    const planPart = msg.parts.find((p) => p.type === 'plan');

    expect(approvalPart?.type).toBe('approval');
    if (approvalPart?.type === 'approval') {
      expect(approvalPart.status).toBe('approved');
    }

    expect(planPart?.type).toBe('plan');
    if (planPart?.type === 'plan') {
      expect(planPart.status).toBe('approved');
    }
  });

  it('should append tool_result on execution_complete', () => {
    const { result } = renderHook(() => useAgentEventHandler());

    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'test',
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'execution_start',
        step: createTestStep(),
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'execution_complete',
        step: createTestStep(),
        result: { success: true, duration: 150, data: { ok: true } },
        timestamp: Date.now(),
      });
    });

    const msg = useConversationStore.getState().activeConversation!.messages[0];
    // tool_call + tool_result
    expect(msg.parts.filter((p) => p.type === 'tool_result')).toHaveLength(1);
    const resultPart = msg.parts.find((p) => p.type === 'tool_result');
    if (resultPart && resultPart.type === 'tool_result') {
      expect(resultPart.success).toBe(true);
      expect(resultPart.duration).toBe(150);
    }
  });

  it('should append observation text on observation_complete', () => {
    const { result } = renderHook(() => useAgentEventHandler());
    const observation: Observation = {
      goalAchieved: true,
      stateChanges: [],
      summary: 'Successfully split the clip.',
      confidence: 0.95,
      needsIteration: false,
    };

    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'test',
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'observation_complete',
        observation,
        timestamp: Date.now(),
      });
    });

    const msg = useConversationStore.getState().activeConversation!.messages[0];
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0].type).toBe('text');
    if (msg.parts[0].type === 'text') {
      expect(msg.parts[0].content).toBe('Successfully split the clip.');
    }
  });

  it('should finalize message on session_complete', () => {
    const { result } = renderHook(() => useAgentEventHandler());

    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'test',
        timestamp: Date.now(),
      });
    });

    expect(useConversationStore.getState().isGenerating).toBe(true);

    act(() => {
      result.current.handleEvent({
        type: 'session_complete',
        summary: {
          sessionId: 'session-1',
          input: 'test',
          totalIterations: 1,
          executedSteps: 1,
          successfulSteps: 1,
          failedSteps: 0,
          duration: 1000,
          finalState: 'completed',
        },
        timestamp: Date.now(),
      });
    });

    expect(useConversationStore.getState().isGenerating).toBe(false);
  });

  it('should append error on session_failed', () => {
    const { result } = renderHook(() => useAgentEventHandler());

    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'test',
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'session_failed',
        error: new Error('Something went wrong'),
        timestamp: Date.now(),
      });
    });

    const msg = useConversationStore.getState().activeConversation!.messages[0];
    expect(msg.parts.some((p) => p.type === 'error')).toBe(true);
    expect(useConversationStore.getState().isGenerating).toBe(false);
  });

  it('should handle session_aborted', () => {
    const { result } = renderHook(() => useAgentEventHandler());

    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'test',
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'session_aborted',
        reason: 'Cancelled by user',
        timestamp: Date.now(),
      });
    });

    const msg = useConversationStore.getState().activeConversation!.messages[0];
    expect(msg.parts.some((p) => p.type === 'text')).toBe(true);
    expect(useConversationStore.getState().isGenerating).toBe(false);
  });

  it('should handle full session lifecycle', () => {
    const { result } = renderHook(() => useAgentEventHandler());

    // Session start
    act(() => {
      result.current.handleEvent({
        type: 'session_start',
        sessionId: 'session-1',
        input: 'Split clip',
        timestamp: Date.now(),
      });
    });

    // Thinking
    act(() => {
      result.current.handleEvent({
        type: 'thinking_complete',
        thought: createTestThought(),
        timestamp: Date.now(),
      });
    });

    // Planning
    act(() => {
      result.current.handleEvent({
        type: 'planning_complete',
        plan: createTestPlan(),
        timestamp: Date.now(),
      });
    });

    // Execution
    act(() => {
      result.current.handleEvent({
        type: 'execution_start',
        step: createTestStep(),
        timestamp: Date.now(),
      });
    });

    act(() => {
      result.current.handleEvent({
        type: 'execution_complete',
        step: createTestStep(),
        result: { success: true, duration: 100 },
        timestamp: Date.now(),
      });
    });

    // Observation
    act(() => {
      result.current.handleEvent({
        type: 'observation_complete',
        observation: {
          goalAchieved: true,
          stateChanges: [],
          summary: 'Done!',
          confidence: 1,
          needsIteration: false,
        },
        timestamp: Date.now(),
      });
    });

    // Complete
    act(() => {
      result.current.handleEvent({
        type: 'session_complete',
        summary: {
          sessionId: 'session-1',
          input: 'Split clip',
          totalIterations: 1,
          executedSteps: 1,
          successfulSteps: 1,
          failedSteps: 0,
          duration: 500,
          finalState: 'completed',
        },
        timestamp: Date.now(),
      });
    });

    const state = useConversationStore.getState();
    expect(state.activeConversation!.messages).toHaveLength(1);
    const msg = state.activeConversation!.messages[0];
    expect(msg.parts.length).toBeGreaterThanOrEqual(5); // thinking, plan, tool_call, tool_result, text
    expect(state.isGenerating).toBe(false);
  });
});

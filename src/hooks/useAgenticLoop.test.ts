import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '@/bindings';
import { setFeatureFlag } from '@/config/featureFlags';
import { createMockLLMAdapter } from '@/agents/engine/adapters/llm/MockLLMAdapter';
import { createMockToolExecutorWithVideoTools } from '@/agents/engine/adapters/tools/MockToolExecutor';
import type { AgentSession } from '@/agents/engine';
import { useConversationStore } from '@/stores/conversationStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { useAgenticLoop } from './useAgenticLoop';

const mockTauriInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockTauriInvoke(...args),
}));

vi.mock('@/bindings', () => ({
  commands: {
    createAgentSession: vi.fn(),
    getAgentSession: vi.fn(),
    startAgentRun: vi.fn(),
    updateAgentRunPhase: vi.fn(),
    recordAgentPermissionDecision: vi.fn(),
    listAgentPermissionDecisions: vi.fn(),
    recordAgentCompaction: vi.fn(),
    listAgentCompactions: vi.fn(),
    createAgentResumeCheckpoint: vi.fn(),
    consumeAgentResumeCheckpoint: vi.fn(),
    listAgentResumeCheckpoints: vi.fn(),
  },
}));

function createAgentSessionDto(sessionId = 'conversation-session-1'): AgentSession {
  return {
    id: sessionId,
    projectId: 'project-1',
    sequenceId: 'sequence-1',
    title: 'Editor Session',
    status: 'idle',
    runtimeKind: 'tpao',
    agentProfileId: 'editor',
    sessionMode: 'primary',
    lineage: {
      parentSessionId: null,
      branchFromSessionId: null,
      rootSessionId: sessionId,
    },
    currentRunId: null,
    currentPlanId: null,
    pendingApprovalId: null,
    activeCheckpointId: null,
    permissionStateVersion: 0,
    compactionVersion: 0,
    resumeCursorVersion: 0,
    latestSummaryMessageId: null,
    lastCompactedAt: null,
    lastResumedAt: null,
    modelProvider: null,
    modelId: null,
    createdAt: 100,
    updatedAt: 100,
    completedAt: null,
  };
}

function createAgentRunDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-tpao-1',
    sessionId: 'conversation-session-1',
    runtimeKind: 'tpao',
    trigger: 'user',
    inputMessageId: null,
    outputMessageId: null,
    phase: 'initializing',
    iteration: 0,
    maxIterations: 20,
    toolCallsUsed: 0,
    maxToolCalls: 120,
    plannedStepCount: 0,
    completedStepCount: 0,
    traceId: null,
    rollbackReportJson: null,
    errorCode: null,
    errorMessage: null,
    startedAt: 100,
    updatedAt: 100,
    endedAt: null,
    ...overrides,
  };
}

function createPermissionDecisionDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'decision-1',
    sessionId: 'conversation-session-1',
    runId: 'run-previous',
    stepId: null,
    subjectType: 'workspace',
    subject: 'workspace.document.write#path:docs/ARCHITECTURE.md',
    action: 'allow_always',
    source: 'interactive_approval',
    reason: 'Persisted allow always',
    createdAt: 90,
    ...overrides,
  };
}

function createPersistedRecoveryCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: 'checkpoint-recovery-1',
    sessionId: 'conversation-session-1',
    runId: 'run-previous',
    checkpointKind: 'approval_wait',
    status: 'active',
    resumeCursorJson: JSON.stringify({
      checkpointKind: 'approval_wait',
      phase: 'awaiting_approval',
    }),
    sessionStateJson: JSON.stringify({
      phase: 'awaiting_approval',
      input: 'Delete the intro clip',
      planGoal: 'Delete the intro clip safely',
    }),
    pendingWorkJson: JSON.stringify({
      type: 'plan_approval',
      goal: 'Delete the intro clip safely',
      stepIds: ['step-1'],
    }),
    createdAt: 95,
    consumedAt: null,
    ...overrides,
  };
}

function createPersistedCompaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'compaction-summary-1',
    sessionId: 'conversation-session-1',
    runId: 'run-previous',
    tier: 'summary',
    trigger: 'auto',
    summaryMessageId: 'summary-message-1',
    sourceMessageCount: 12,
    retainedMessageCount: 4,
    estimatedTokensSaved: 3200,
    continuationSummaryJson: JSON.stringify({
      summary: 'Recovered TPAO summary',
      input: 'Delete the intro clip',
      sourceMessageCount: 12,
      retainedMessageCount: 4,
    }),
    stateRehydrationJson: JSON.stringify({
      phase: 'compacting',
      summary: 'Recovered TPAO summary',
      sourceMessageCount: 12,
      retainedMessageCount: 4,
    }),
    createdAt: 96,
    ...overrides,
  };
}

interface FailedRunLike {
  success: boolean;
  error?: {
    message?: string;
  } | null;
}

describe('useAgenticLoop', () => {
  let sessionState: AgentSession;
  let persistedCompactions: Array<Record<string, unknown>>;
  let persistedCheckpoints: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockTauriInvoke.mockReset().mockResolvedValue(undefined);

    setFeatureFlag('USE_AGENTIC_ENGINE', true);
    sessionState = createAgentSessionDto();
    persistedCompactions = [];
    persistedCheckpoints = [];

    useConversationStore.setState({
      activeConversation: {
        id: 'conversation-session-1',
        projectId: 'project-1',
        messages: [],
        createdAt: 100,
        updatedAt: 100,
      },
      isGenerating: false,
      streamingMessageId: null,
      activeProjectId: 'project-1',
      activeSessionId: 'conversation-session-1',
      sessions: [],
    });

    usePermissionStore.getState().loadDefaults();
    usePermissionStore.getState().resetSessionRules();
    useAgentSessionStore.getState().clear();

    vi.mocked(commands.getAgentSession).mockImplementation(async () => ({
      status: 'ok',
      data: {
        session: sessionState,
        runs: [],
      },
    }));
    vi.mocked(commands.listAgentPermissionDecisions).mockResolvedValue({
      status: 'ok',
      data: [createPermissionDecisionDto()],
    });
    vi.mocked(commands.listAgentCompactions).mockImplementation(async () => ({
      status: 'ok',
      data: persistedCompactions as any,
    }));
    vi.mocked(commands.listAgentResumeCheckpoints).mockImplementation(async () => ({
      status: 'ok',
      data: persistedCheckpoints as any,
    }));
    vi.mocked(commands.startAgentRun).mockResolvedValue({
      status: 'ok',
      data: createAgentRunDto(),
    });
    vi.mocked(commands.updateAgentRunPhase).mockImplementation(async (input) => ({
      status: 'ok',
      data: createAgentRunDto({
        id: input.runId,
        phase: input.phase,
        toolCallsUsed: input.toolCallsUsed ?? 0,
        completedStepCount: input.completedStepCount ?? 0,
        errorMessage: input.errorMessage ?? null,
        endedAt: input.endedAt ?? 200,
        updatedAt: input.endedAt ?? 200,
      }),
    }));
    vi.mocked(commands.recordAgentPermissionDecision).mockImplementation(async (input) => ({
      status: 'ok',
      data: createPermissionDecisionDto({
        id: input.id ?? `decision-${input.action}`,
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        stepId: input.stepId ?? null,
        subjectType: input.subjectType,
        subject: input.subject,
        action: input.action,
        source: input.source,
        reason: input.reason ?? null,
        createdAt: input.createdAt ?? 100,
      }),
    }));
    vi.mocked(commands.recordAgentCompaction).mockImplementation(async (input) => {
      const createdAt = input.createdAt ?? 150;
      sessionState = {
        ...sessionState,
        compactionVersion: sessionState.compactionVersion + 1,
        lastCompactedAt: createdAt,
        updatedAt: createdAt,
      };
      const record = {
        id: input.id ?? `compaction-${persistedCompactions.length + 1}`,
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        tier: input.tier,
        trigger: input.trigger,
        summaryMessageId: input.summaryMessageId ?? null,
        sourceMessageCount: input.sourceMessageCount,
        retainedMessageCount: input.retainedMessageCount,
        estimatedTokensSaved: input.estimatedTokensSaved ?? null,
        continuationSummaryJson: input.continuationSummaryJson ?? null,
        stateRehydrationJson: input.stateRehydrationJson ?? null,
        createdAt,
      };
      persistedCompactions = [record, ...persistedCompactions];
      return {
        status: 'ok',
        data: record as any,
      };
    });
    vi.mocked(commands.createAgentResumeCheckpoint).mockImplementation(async (input) => {
      const createdAt = input.createdAt ?? 120 + persistedCheckpoints.length;
      const checkpoint = {
        id: input.id ?? `checkpoint-${persistedCheckpoints.length + 1}`,
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        checkpointKind: input.checkpointKind,
        status: input.status ?? 'active',
        resumeCursorJson: input.resumeCursorJson,
        sessionStateJson: input.sessionStateJson,
        pendingWorkJson: input.pendingWorkJson ?? null,
        createdAt,
        consumedAt: null,
      };
      sessionState = {
        ...sessionState,
        activeCheckpointId: checkpoint.status === 'active' ? checkpoint.id : sessionState.activeCheckpointId,
        resumeCursorVersion: sessionState.resumeCursorVersion + 1,
        updatedAt: createdAt,
      };
      persistedCheckpoints = [checkpoint, ...persistedCheckpoints];
      return {
        status: 'ok',
        data: checkpoint as any,
      };
    });
    vi.mocked(commands.consumeAgentResumeCheckpoint).mockImplementation(async (checkpointId) => {
      const consumedAt = 500;
      persistedCheckpoints = persistedCheckpoints.map((checkpoint) =>
        checkpoint.id === checkpointId
          ? {
              ...checkpoint,
              status: 'consumed',
              consumedAt,
            }
          : checkpoint,
      );
      sessionState = {
        ...sessionState,
        activeCheckpointId:
          sessionState.activeCheckpointId === checkpointId ? null : sessionState.activeCheckpointId,
        resumeCursorVersion: sessionState.resumeCursorVersion + 1,
        lastResumedAt: consumedAt,
        updatedAt: consumedAt,
      };
      return {
        status: 'ok',
        data: persistedCheckpoints.find((checkpoint) => checkpoint.id === checkpointId) as any,
      };
    });
  });

  afterEach(() => {
    usePermissionStore.getState().loadDefaults();
    useAgentSessionStore.getState().clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('should replay persisted permissions and correlate interactive audits with the tpao run', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    useAgentSessionStore.getState().reportPersistenceIssue({
      sessionId: 'conversation-session-1',
      stage: 'run_finalize',
      error: new Error('previous degradation'),
      occurredAt: 50,
    });

    let structuredCallCount = 0;
    vi.spyOn(llm, 'generateStructured').mockImplementation(async () => {
      structuredCallCount += 1;

      if (structuredCallCount === 1) {
        return {
          understanding: 'The user wants to delete a clip',
          requirements: ['clipId'],
          uncertainties: [],
          approach: 'Plan a single delete step',
          needsMoreInfo: false,
        };
      }

      if (structuredCallCount === 2) {
        return {
          goal: 'Delete the target clip',
          steps: [
            {
              id: 'step-1',
              tool: 'delete_clip',
              args: { clipId: 'clip-1' },
              description: 'Delete clip-1 from the timeline',
              riskLevel: 'medium',
              estimatedDuration: 50,
            },
          ],
          estimatedTotalDuration: 50,
          requiresApproval: false,
          rollbackStrategy: 'Restore the deleted clip',
        };
      }

      return {
        goalAchieved: true,
        stateChanges: [
          {
            type: 'clip_deleted',
            target: 'clip-1',
            details: { deleted: true },
          },
        ],
        summary: 'Deleted clip-1',
        confidence: 0.95,
        needsIteration: false,
      };
    });

    const { result } = renderHook(() =>
      useAgenticLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableMemory: false,
          enableTracing: false,
          approvalThreshold: 'low',
          requireApprovalForDestructiveActions: false,
        },
      }),
    );

    let runPromise!: ReturnType<typeof result.current.run>;
    act(() => {
      runPromise = result.current.run('Delete clip 1');
    });

    await waitFor(() => {
      expect(result.current.events.map((event) => event.type)).toContain('tool_permission_request');
    });

    await waitFor(() => {
      expect(vi.mocked(commands.recordAgentPermissionDecision)).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'conversation-session-1',
          runId: 'run-tpao-1',
          stepId: 'step-1',
          action: 'ask',
        }),
      );
    });

    act(() => {
      result.current.approveToolPermission('allow_always');
    });

    await act(async () => {
      await runPromise;
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
      expect(result.current.sessionId).toBe('conversation-session-1');
    });

    const sessionRules = usePermissionStore.getState().sessionRules;
    expect(usePermissionStore.getState().hasHydratedSessionRules('conversation-session-1')).toBe(
      true,
    );
    expect(
      useAgentSessionStore.getState().persistenceIssuesBySessionId['conversation-session-1'],
    ).toBeUndefined();
    expect(
      sessionRules.some((rule) => rule.pattern === 'workspace.document.write#path:docs/ARCHITECTURE.md'),
    ).toBe(true);
    expect(sessionRules.some((rule) => rule.pattern.includes('timeline.clip.delete#clip:clip-1'))).toBe(
      true,
    );

    expect(vi.mocked(commands.listAgentPermissionDecisions)).toHaveBeenCalledWith(
      'conversation-session-1',
    );
    expect(vi.mocked(commands.startAgentRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runtimeKind: 'tpao',
        trigger: 'user',
      }),
    );
    expect(vi.mocked(commands.createAgentResumeCheckpoint)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runId: 'run-tpao-1',
        checkpointKind: 'safe_resume_point',
      }),
    );
    expect(vi.mocked(commands.createAgentResumeCheckpoint)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runId: 'run-tpao-1',
        checkpointKind: 'tool_wait',
      }),
    );
    expect(vi.mocked(commands.consumeAgentResumeCheckpoint)).toHaveBeenCalled();
    expect(vi.mocked(commands.updateAgentRunPhase)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-tpao-1',
        phase: 'completed',
        toolCallsUsed: 1,
        completedStepCount: 1,
      }),
    );

    const permissionAuditInputs = vi
      .mocked(commands.recordAgentPermissionDecision)
      .mock.calls.map(([input]) => input);

    expect(permissionAuditInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'conversation-session-1',
          runId: 'run-tpao-1',
          stepId: 'step-1',
          subject: 'timeline.clip.delete#clip:clip-1',
          action: 'ask',
        }),
        expect.objectContaining({
          sessionId: 'conversation-session-1',
          runId: 'run-tpao-1',
          stepId: 'step-1',
          subject: 'timeline.clip.delete#clip:clip-1',
          action: 'allow_always',
          source: 'interactive_approval',
        }),
      ]),
    );
  });

  it('should persist the final trace id on the tpao run when tracing is enabled', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    let structuredCallCount = 0;
    vi.spyOn(llm, 'generateStructured').mockImplementation(async () => {
      structuredCallCount += 1;

      if (structuredCallCount === 1) {
        return {
          understanding: 'The user wants to delete a clip',
          requirements: ['clipId'],
          uncertainties: [],
          approach: 'Plan a single delete step',
          needsMoreInfo: false,
        };
      }

      if (structuredCallCount === 2) {
        return {
          goal: 'Delete the target clip',
          steps: [
            {
              id: 'step-1',
              tool: 'delete_clip',
              args: { clipId: 'clip-1' },
              description: 'Delete clip-1 from the timeline',
              riskLevel: 'medium',
              estimatedDuration: 50,
            },
          ],
          estimatedTotalDuration: 50,
          requiresApproval: false,
          rollbackStrategy: 'Restore the deleted clip',
        };
      }

      return {
        goalAchieved: true,
        stateChanges: [
          {
            type: 'clip_deleted',
            target: 'clip-1',
            details: { deleted: true },
          },
        ],
        summary: 'Deleted clip-1',
        confidence: 0.95,
        needsIteration: false,
      };
    });

    const { result } = renderHook(() =>
      useAgenticLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableMemory: false,
          enableTracing: true,
          approvalThreshold: 'low',
          requireApprovalForDestructiveActions: false,
        },
      }),
    );

    let runPromise!: ReturnType<typeof result.current.run>;
    act(() => {
      runPromise = result.current.run('Delete clip 1');
    });

    await waitFor(() => {
      expect(result.current.events.map((event) => event.type)).toContain('tool_permission_request');
    });

    act(() => {
      result.current.approveToolPermission('allow');
    });

    await act(async () => {
      await runPromise;
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    const traceWriteCall = mockTauriInvoke.mock.calls.find(
      ([command]) => command === 'write_agent_trace',
    );
    expect(traceWriteCall).toBeDefined();

    const traceId = traceWriteCall?.[1] && typeof traceWriteCall[1] === 'object'
      ? (traceWriteCall[1] as { traceId?: string }).traceId
      : undefined;
    const traceJson = traceWriteCall?.[1] && typeof traceWriteCall[1] === 'object'
      ? (traceWriteCall[1] as { traceJson?: string }).traceJson
      : undefined;
    const trace = JSON.parse(traceJson ?? '{}');

    expect(traceId).toEqual(expect.any(String));
    expect(trace.runtimeKind).toBe('tpao');
    expect(trace.artifacts.persistedRunId).toBe('run-tpao-1');
    expect(trace.artifacts.permissionEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'ask',
          stepId: 'step-1',
          subject: 'timeline.clip.delete#clip:clip-1',
        }),
        expect.objectContaining({
          action: 'allow',
          source: 'interactive_approval',
        }),
      ]),
    );
    expect(trace.artifacts.checkpointEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpointKind: 'safe_resume_point',
          status: 'persisted',
        }),
        expect.objectContaining({
          checkpointKind: 'tool_wait',
          status: 'persisted',
        }),
      ]),
    );
    expect(vi.mocked(commands.startAgentRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runtimeKind: 'tpao',
        traceId,
      }),
    );
    expect(vi.mocked(commands.updateAgentRunPhase)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-tpao-1',
        phase: 'completed',
        traceId,
      }),
    );
  });

  it('should persist and consume approval wait checkpoints while awaiting plan approval', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    tools.registerTool({
      info: {
        name: 'delete_clip',
        description: 'Delete clip',
        category: 'editing',
        riskLevel: 'medium',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
        },
      },
      required: ['clipId'],
      result: {
        success: true,
        data: { deleted: true },
        duration: 10,
      },
    });

    let structuredCallCount = 0;
    vi.spyOn(llm, 'generateStructured').mockImplementation(async () => {
      structuredCallCount += 1;

      if (structuredCallCount === 1) {
        return {
          understanding: 'The user wants to delete a clip',
          requirements: ['clipId'],
          uncertainties: [],
          approach: 'Plan a destructive delete step',
          needsMoreInfo: false,
        };
      }

      if (structuredCallCount === 2) {
        return {
          goal: 'Delete the target clip',
          steps: [
            {
              id: 'step-approval-1',
              tool: 'delete_clip',
              args: { clipId: 'clip-1' },
              description: 'Delete clip-1 from the timeline',
              riskLevel: 'critical',
              estimatedDuration: 50,
            },
          ],
          estimatedTotalDuration: 50,
          requiresApproval: true,
          rollbackStrategy: 'Restore the deleted clip',
        };
      }

      return {
        goalAchieved: true,
        stateChanges: [
          {
            type: 'clip_deleted',
            target: 'clip-1',
            details: { deleted: true },
          },
        ],
        summary: 'Deleted clip-1 after approval',
        confidence: 0.95,
        needsIteration: false,
      };
    });

    const { result } = renderHook(() =>
      useAgenticLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableMemory: false,
          enableTracing: false,
          requireApprovalForDestructiveActions: false,
          toolPermissionHandler: async () => 'allow',
        },
      }),
    );

    let runPromise!: ReturnType<typeof result.current.run>;
    act(() => {
      runPromise = result.current.run('Delete clip 1 after approval');
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('awaiting_approval');
    });

    const approvalCheckpointCall = vi
      .mocked(commands.createAgentResumeCheckpoint)
      .mock.calls.map(([input]) => input)
      .find((input) => input.checkpointKind === 'approval_wait');

    expect(approvalCheckpointCall).toEqual(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runId: 'run-tpao-1',
        checkpointKind: 'approval_wait',
      }),
    );
    expect(JSON.parse(approvalCheckpointCall?.pendingWorkJson ?? 'null')).toEqual({
      type: 'plan_approval',
      goal: 'Delete the target clip',
      stepIds: ['step-approval-1'],
    });

    act(() => {
      result.current.approvePlan();
    });

    await act(async () => {
      await runPromise;
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    expect(vi.mocked(commands.createAgentResumeCheckpoint)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runId: 'run-tpao-1',
        checkpointKind: 'safe_resume_point',
      }),
    );
    expect(vi.mocked(commands.consumeAgentResumeCheckpoint)).toHaveBeenCalled();
    expect(vi.mocked(commands.updateAgentRunPhase)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-tpao-1',
        phase: 'completed',
      }),
    );
  });

  it('should bootstrap recovered context from an active persisted checkpoint before a new TPAO run', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    sessionState = {
      ...createAgentSessionDto(),
      activeCheckpointId: 'checkpoint-recovery-1',
      resumeCursorVersion: 1,
    };
    persistedCheckpoints = [createPersistedRecoveryCheckpoint()];

    let structuredCallCount = 0;
    vi.spyOn(llm, 'generateStructured').mockImplementation(async () => {
      structuredCallCount += 1;

      if (structuredCallCount === 1) {
        return {
          understanding: 'Continue the recovered task',
          requirements: [],
          uncertainties: [],
          approach: 'Proceed with the next edit step',
          needsMoreInfo: false,
        };
      }

      if (structuredCallCount === 2) {
        return {
          goal: 'Continue the recovered task',
          steps: [],
          estimatedTotalDuration: 0,
          requiresApproval: false,
          rollbackStrategy: 'N/A',
        };
      }

      return {
        goalAchieved: true,
        stateChanges: [],
        summary: 'Recovered context was acknowledged',
        confidence: 0.95,
        needsIteration: false,
      };
    });

    const { result } = renderHook(() =>
      useAgenticLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableMemory: false,
          enableTracing: false,
          toolPermissionHandler: async () => 'allow',
        },
      }),
    );

    await act(async () => {
      await result.current.run('Continue the edit');
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    const systemMessages = useConversationStore
      .getState()
      .activeConversation?.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.parts.find((part) => part.type === 'text'))
      .filter((part): part is { type: 'text'; content: string } => part?.type === 'text')
      .map((part) => part.content);

    expect(systemMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Recovered durable context from a previous app session.'),
      ]),
    );
    expect(systemMessages?.join('\n')).toContain('Pending plan approval was recovered into visible context.');
    expect(vi.mocked(commands.consumeAgentResumeCheckpoint)).not.toHaveBeenCalledWith(
      'checkpoint-recovery-1',
    );
  });

  it('should bootstrap recovered context from the latest persisted compaction summary when no checkpoint is linked', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    sessionState = {
      ...createAgentSessionDto(),
      latestSummaryMessageId: 'summary-message-1',
      compactionVersion: 1,
      lastCompactedAt: 96,
    };
    persistedCompactions = [createPersistedCompaction()];

    let structuredCallCount = 0;
    vi.spyOn(llm, 'generateStructured').mockImplementation(async () => {
      structuredCallCount += 1;

      if (structuredCallCount === 1) {
        return {
          understanding: 'Continue the recovered task',
          requirements: [],
          uncertainties: [],
          approach: 'Proceed with the next edit step',
          needsMoreInfo: false,
        };
      }

      if (structuredCallCount === 2) {
        return {
          goal: 'Continue the recovered task',
          steps: [],
          estimatedTotalDuration: 0,
          requiresApproval: false,
          rollbackStrategy: 'N/A',
        };
      }

      return {
        goalAchieved: true,
        stateChanges: [],
        summary: 'Recovered context was acknowledged',
        confidence: 0.95,
        needsIteration: false,
      };
    });

    const { result } = renderHook(() =>
      useAgenticLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableMemory: false,
          enableTracing: false,
          toolPermissionHandler: async () => 'allow',
        },
      }),
    );

    await act(async () => {
      await result.current.run('Continue the edit');
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    const systemMessages = useConversationStore
      .getState()
      .activeConversation?.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.parts.find((part) => part.type === 'text'))
      .filter((part): part is { type: 'text'; content: string } => part?.type === 'text')
      .map((part) => part.content)
      ?? [];

    expect(
      systemMessages.some((message) =>
        message.includes('Recovered durable context from persisted compaction history.'),
      ),
    ).toBe(true);
    expect(
      systemMessages.some((message) => message.includes('Recovered summary: Recovered TPAO summary')),
    ).toBe(true);
  });

  it('should ignore active checkpoint rows that are not linked from the session header before a new TPAO run', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    sessionState = createAgentSessionDto();
    persistedCheckpoints = [createPersistedRecoveryCheckpoint()];

    let structuredCallCount = 0;
    vi.spyOn(llm, 'generateStructured').mockImplementation(async () => {
      structuredCallCount += 1;

      if (structuredCallCount === 1) {
        return {
          understanding: 'Start a fresh task',
          requirements: [],
          uncertainties: [],
          approach: 'Proceed normally',
          needsMoreInfo: false,
        };
      }

      if (structuredCallCount === 2) {
        return {
          goal: 'Start a fresh task',
          steps: [],
          estimatedTotalDuration: 0,
          requiresApproval: false,
          rollbackStrategy: 'N/A',
        };
      }

      return {
        goalAchieved: true,
        stateChanges: [],
        summary: 'No recovered checkpoint was linked',
        confidence: 0.95,
        needsIteration: false,
      };
    });

    const { result } = renderHook(() =>
      useAgenticLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableMemory: false,
          enableTracing: false,
          toolPermissionHandler: async () => 'allow',
        },
      }),
    );

    await act(async () => {
      await result.current.run('Continue the edit');
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    const systemMessages = useConversationStore
      .getState()
      .activeConversation?.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.parts.find((part) => part.type === 'text'))
      .filter((part): part is { type: 'text'; content: string } => part?.type === 'text')
      .map((part) => part.content)
      ?? [];

    expect(
      systemMessages.some((message) =>
        message.includes('Recovered durable context from a previous app session.'),
      ),
    ).toBe(false);
    expect(vi.mocked(commands.consumeAgentResumeCheckpoint)).not.toHaveBeenCalledWith(
      'checkpoint-recovery-1',
    );
  });

  it('should persist rollback reports when recovery is attempted after execution failure', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

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
          clipId: { type: 'string' },
        },
      },
      required: ['clipId'],
      result: {
        success: true,
        data: { split: true },
        duration: 10,
        undoable: true,
        undoOperation: {
          tool: 'undo_split_clip',
          args: { clipId: 'clip-1' },
          description: 'Undo split',
        },
      },
    });

    tools.registerTool({
      info: {
        name: 'undo_split_clip',
        description: 'Undo split clip',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: false,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
        },
      },
      required: ['clipId'],
      result: {
        success: true,
        data: { undone: true },
        duration: 5,
      },
    });

    tools.registerTool({
      info: {
        name: 'delete_clip',
        description: 'Delete clip',
        category: 'editing',
        riskLevel: 'low',
        supportsUndo: true,
        parallelizable: false,
      },
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
        },
      },
      required: ['clipId'],
      error: new Error('delete failed'),
    });

    let structuredCallCount = 0;
    vi.spyOn(llm, 'generateStructured').mockImplementation(async () => {
      structuredCallCount += 1;

      if (structuredCallCount === 1) {
        return {
          understanding: 'Split the clip and then delete it',
          requirements: ['clipId'],
          uncertainties: [],
          approach: 'Execute a split before deleting',
          needsMoreInfo: false,
        };
      }

      return {
        goal: 'Split the clip and then delete it',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1' },
            description: 'Split clip-1',
            riskLevel: 'low',
            estimatedDuration: 10,
          },
          {
            id: 'step-2',
            tool: 'delete_clip',
            args: { clipId: 'clip-1' },
            description: 'Delete clip-1',
            riskLevel: 'low',
            estimatedDuration: 15,
          },
        ],
        estimatedTotalDuration: 25,
        requiresApproval: false,
        rollbackStrategy: 'Undo prior edits',
      };
    });

    const { result } = renderHook(() =>
      useAgenticLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableMemory: false,
          enableTracing: false,
          approvalThreshold: 'critical',
          requireApprovalForDestructiveActions: false,
          toolPermissionHandler: async () => 'allow',
        },
      }),
    );

    let runResult: FailedRunLike | null = null;
    await act(async () => {
      runResult = await result.current.run('Split and delete clip 1');
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('failed');
    });

    expect(runResult).not.toBeNull();
    const failedRun = runResult as any;
    expect(failedRun.success).toBe(false);
    expect(failedRun.rollbackReport?.attempted).toBe(true);
    expect(vi.mocked(commands.updateAgentRunPhase)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-tpao-1',
        phase: 'failed',
        plannedStepCount: 2,
        completedStepCount: 1,
        rollbackReportJson: expect.stringContaining('"attempted":true'),
      }),
    );
  });

  it('should not call onAbort during unmount cleanup when no user abort occurred', () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();
    const onAbort = vi.fn();

    const { unmount } = renderHook(() =>
      useAgenticLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableMemory: false,
          enableTracing: false,
          approvalThreshold: 'low',
          requireApprovalForDestructiveActions: false,
        },
        onAbort,
      }),
    );

    act(() => {
      unmount();
    });

    expect(onAbort).not.toHaveBeenCalled();
  });

  it('should finalize the persisted tpao run as failed when planning throws', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    let structuredCallCount = 0;
    vi.spyOn(llm, 'generateStructured').mockImplementation(async () => {
      structuredCallCount += 1;

      if (structuredCallCount === 1) {
        return {
          understanding: 'The user wants to delete a clip',
          requirements: ['clipId'],
          uncertainties: [],
          approach: 'Plan a delete step',
          needsMoreInfo: false,
        };
      }

      throw new Error('planner failed');
    });

    const { result } = renderHook(() =>
      useAgenticLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableMemory: false,
          enableTracing: false,
          requireApprovalForDestructiveActions: false,
          toolPermissionHandler: async () => 'allow',
        },
      }),
    );

    let runPromise!: ReturnType<typeof result.current.run>;
    act(() => {
      runPromise = result.current.run('Delete clip 1');
    });

    let runResult: FailedRunLike | null = null;
    await act(async () => {
      runResult = await runPromise;
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('failed');
      expect(result.current.error?.message).toContain('planner failed');
    });

    expect(runResult).not.toBeNull();
    if (!runResult) {
      throw new Error('Expected failed run result');
    }

    const failedRun = runResult as any;
    expect(failedRun.success).toBe(false);
    expect(failedRun.error?.message).toContain('planner failed');

    expect(vi.mocked(commands.listAgentPermissionDecisions)).toHaveBeenCalledWith(
      'conversation-session-1',
    );
    expect(vi.mocked(commands.updateAgentRunPhase)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-tpao-1',
        phase: 'failed',
        errorMessage: expect.stringContaining('planner failed'),
      }),
    );
  });

  it('should report degraded persistence state when tpao run finalization fails', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    vi.mocked(commands.updateAgentRunPhase).mockResolvedValue({
      status: 'error',
      error: 'tpao run finalize failed',
    });

    let structuredCallCount = 0;
    vi.spyOn(llm, 'generateStructured').mockImplementation(async () => {
      structuredCallCount += 1;

      if (structuredCallCount === 1) {
        return {
          understanding: 'The user wants to delete a clip',
          requirements: ['clipId'],
          uncertainties: [],
          approach: 'Plan a single delete step',
          needsMoreInfo: false,
        };
      }

      if (structuredCallCount === 2) {
        return {
          goal: 'Delete the target clip',
          steps: [
            {
              id: 'step-1',
              tool: 'delete_clip',
              args: { clipId: 'clip-1' },
              description: 'Delete clip-1 from the timeline',
              riskLevel: 'medium',
              estimatedDuration: 50,
            },
          ],
          estimatedTotalDuration: 50,
          requiresApproval: false,
          rollbackStrategy: 'Restore the deleted clip',
        };
      }

      return {
        goalAchieved: true,
        stateChanges: [
          {
            type: 'clip_deleted',
            target: 'clip-1',
            details: { deleted: true },
          },
        ],
        summary: 'Deleted clip-1',
        confidence: 0.95,
        needsIteration: false,
      };
    });

    const { result } = renderHook(() =>
      useAgenticLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableMemory: false,
          enableTracing: false,
          approvalThreshold: 'low',
          requireApprovalForDestructiveActions: false,
        },
      }),
    );

    let runPromise!: ReturnType<typeof result.current.run>;
    act(() => {
      runPromise = result.current.run('Delete clip 1');
    });

    await waitFor(() => {
      expect(result.current.events.map((event) => event.type)).toContain('tool_permission_request');
    });

    act(() => {
      result.current.approveToolPermission('allow');
    });

    await act(async () => {
      await runPromise;
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    expect(
      useAgentSessionStore.getState().persistenceIssuesBySessionId['conversation-session-1'],
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        stage: 'run_finalize',
        message: 'tpao run finalize failed',
        occurredAt: expect.any(Number),
      }),
    ]));
  });
});

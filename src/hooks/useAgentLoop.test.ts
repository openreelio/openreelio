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
import { useAgentLoop } from './useAgentLoop';

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
    runtimeKind: 'fast',
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
    id: 'run-fast-1',
    sessionId: 'conversation-session-1',
    runtimeKind: 'fast',
    trigger: 'user',
    inputMessageId: null,
    outputMessageId: null,
    phase: 'initializing',
    iteration: 0,
    maxIterations: 20,
    toolCallsUsed: 0,
    maxToolCalls: 50,
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
    subject: 'workspace.document.write#path:docs/ROADMAP.md',
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
    checkpointKind: 'tool_wait',
    status: 'active',
    resumeCursorJson: JSON.stringify({
      checkpointKind: 'tool_wait',
      phase: 'awaiting_tool_permission',
      toolName: 'delete_clip',
    }),
    sessionStateJson: JSON.stringify({
      phase: 'awaiting_tool_permission',
      input: 'Delete the intro clip',
      planGoal: 'Delete the intro clip safely',
    }),
    pendingWorkJson: JSON.stringify({
      type: 'tool_permission',
      toolName: 'delete_clip',
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
      summary: 'Recovered fast runtime summary',
      input: 'Delete the intro clip',
      sourceMessageCount: 12,
      retainedMessageCount: 4,
    }),
    stateRehydrationJson: JSON.stringify({
      phase: 'compacting',
      summary: 'Recovered fast runtime summary',
      sourceMessageCount: 12,
      retainedMessageCount: 4,
    }),
    createdAt: 96,
    ...overrides,
  };
}

describe('useAgentLoop', () => {
  let sessionState: AgentSession;
  let persistedCompactions: Array<Record<string, unknown>>;
  let persistedCheckpoints: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockTauriInvoke.mockReset().mockResolvedValue(undefined);

    setFeatureFlag('USE_AGENT_LOOP', true);
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
        activeCheckpointId:
          checkpoint.status === 'active' ? checkpoint.id : sessionState.activeCheckpointId,
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

  it('should replay persisted permissions and correlate interactive audits with the fast run', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    useAgentSessionStore.getState().reportPersistenceIssue({
      sessionId: 'conversation-session-1',
      stage: 'run_finalize',
      error: new Error('previous degradation'),
      occurredAt: 50,
    });

    llm.setToolsResponse({
      toolCalls: [
        {
          id: 'tool-call-1',
          name: 'delete_clip',
          args: { clipId: 'clip-1' },
        },
      ],
    });

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
      executor: async () => {
        llm.setToolsResponse({ content: 'The clip has been deleted.' });
        return {
          success: true,
          data: { deleted: true },
          duration: 10,
        };
      },
    });

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          approvalThreshold: 'low',
        },
      }),
    );

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run('Delete the selected clip');
    });

    await waitFor(() => {
      expect(result.current.events.map((event) => event.type)).toContain('tool_permission_request');
    });

    await waitFor(() => {
      expect(vi.mocked(commands.recordAgentPermissionDecision)).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'conversation-session-1',
          runId: 'run-fast-1',
          stepId: null,
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
    });

    expect(result.current.events.map((event) => event.type)).toContain('tool_permission_response');

    const sessionRules = usePermissionStore.getState().sessionRules;
    expect(usePermissionStore.getState().hasHydratedSessionRules('conversation-session-1')).toBe(
      true,
    );
    expect(
      useAgentSessionStore.getState().persistenceIssuesBySessionId['conversation-session-1'],
    ).toBeUndefined();
    expect(
      sessionRules.some((rule) => rule.pattern === 'workspace.document.write#path:docs/ROADMAP.md'),
    ).toBe(true);
    expect(
      sessionRules.some((rule) => rule.pattern.includes('timeline.clip.delete#clip:clip-1')),
    ).toBe(true);

    expect(vi.mocked(commands.listAgentPermissionDecisions)).toHaveBeenCalledWith(
      'conversation-session-1',
    );
    expect(vi.mocked(commands.startAgentRun)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runtimeKind: 'fast',
        trigger: 'user',
      }),
    );
    expect(vi.mocked(commands.createAgentResumeCheckpoint)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runId: 'run-fast-1',
        checkpointKind: 'safe_resume_point',
      }),
    );
    expect(vi.mocked(commands.createAgentResumeCheckpoint)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runId: 'run-fast-1',
        checkpointKind: 'tool_wait',
      }),
    );
    expect(vi.mocked(commands.consumeAgentResumeCheckpoint)).toHaveBeenCalled();
    expect(sessionState.activeCheckpointId).toBeNull();
    expect(
      persistedCheckpoints.find((checkpoint) => checkpoint.checkpointKind === 'safe_resume_point')
        ?.status,
    ).toBe('consumed');
    expect(vi.mocked(commands.updateAgentRunPhase)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-fast-1',
        phase: 'completed',
        toolCallsUsed: 1,
      }),
    );

    const permissionAuditInputs = vi
      .mocked(commands.recordAgentPermissionDecision)
      .mock.calls.map(([input]) => input);

    expect(permissionAuditInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'conversation-session-1',
          runId: 'run-fast-1',
          subject: 'timeline.clip.delete#clip:clip-1',
          action: 'ask',
        }),
        expect.objectContaining({
          sessionId: 'conversation-session-1',
          runId: 'run-fast-1',
          subject: 'timeline.clip.delete#clip:clip-1',
          action: 'allow_always',
          source: 'interactive_approval',
        }),
      ]),
    );
  });

  it('should bootstrap recovered context from an active persisted checkpoint before a new fast run', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    sessionState = createAgentSessionDto();
    sessionState = {
      ...sessionState,
      activeCheckpointId: 'checkpoint-recovery-1',
      resumeCursorVersion: 1,
    };
    persistedCheckpoints = [createPersistedRecoveryCheckpoint()];

    llm.setToolsResponse({ content: 'Recovered context acknowledged.' });

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
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
      .activeConversation?.messages.filter((message) => message.role === 'system')
      .map((message) => message.parts.find((part) => part.type === 'text'))
      .filter((part): part is { type: 'text'; content: string } => part?.type === 'text')
      .map((part) => part.content);

    expect(systemMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Recovered durable context from a previous app session.'),
      ]),
    );
    expect(systemMessages?.join('\n')).toContain('Pending tool permission: delete_clip');
    expect(vi.mocked(commands.consumeAgentResumeCheckpoint)).not.toHaveBeenCalledWith(
      'checkpoint-recovery-1',
    );
  });

  it('should ignore active checkpoint rows that are not linked from the session header', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    sessionState = createAgentSessionDto();
    persistedCheckpoints = [createPersistedRecoveryCheckpoint()];

    llm.setToolsResponse({ content: 'Started a fresh run.' });

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
        },
      }),
    );

    await act(async () => {
      await result.current.run('Continue the edit');
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    const systemMessages =
      useConversationStore
        .getState()
        .activeConversation?.messages.filter((message) => message.role === 'system')
        .map((message) => message.parts.find((part) => part.type === 'text'))
        .filter((part): part is { type: 'text'; content: string } => part?.type === 'text')
        .map((part) => part.content) ?? [];

    expect(
      systemMessages.some((message) =>
        message.includes('Recovered durable context from a previous app session.'),
      ),
    ).toBe(false);
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

    llm.setToolsResponse({ content: 'Recovered summary acknowledged.' });

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
        },
      }),
    );

    await act(async () => {
      await result.current.run('Continue the edit');
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    const systemMessages =
      useConversationStore
        .getState()
        .activeConversation?.messages.filter((message) => message.role === 'system')
        .map((message) => message.parts.find((part) => part.type === 'text'))
        .filter((part): part is { type: 'text'; content: string } => part?.type === 'text')
        .map((part) => part.content) ?? [];

    expect(
      systemMessages.some((message) =>
        message.includes('Recovered durable context from persisted compaction history.'),
      ),
    ).toBe(true);
    expect(
      systemMessages.some((message) =>
        message.includes('Recovered summary: Recovered fast runtime summary'),
      ),
    ).toBe(true);
  });

  it('should call onAbort only once when a pending permission prompt is aborted', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();
    const onAbort = vi.fn();

    vi.mocked(commands.listAgentPermissionDecisions).mockResolvedValue({
      status: 'ok',
      data: [],
    });

    llm.setToolsResponse({
      toolCalls: [
        {
          id: 'tool-call-1',
          name: 'delete_clip',
          args: { clipId: 'clip-1' },
        },
      ],
    });

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

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          approvalThreshold: 'low',
        },
        onAbort,
      }),
    );

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run('Delete the selected clip');
    });

    await waitFor(() => {
      expect(result.current.events.map((event) => event.type)).toContain('tool_call_start');
    });

    act(() => {
      result.current.abort();
    });

    expect(result.current.isRunning).toBe(true);

    await act(async () => {
      await runPromise;
    });

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('aborted');
  });

  it('should finalize the persisted fast run as aborted when cancelled mid-flight', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    llm.setToolsResponse({
      content: 'This response should be interrupted before completion.',
      delay: 150,
    });

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
        },
      }),
    );

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run('Start a long running loop');
    });

    await waitFor(() => {
      expect(vi.mocked(commands.startAgentRun)).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'conversation-session-1',
          runtimeKind: 'fast',
        }),
      );
    });

    act(() => {
      result.current.abort();
    });

    await act(async () => {
      await runPromise;
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('aborted');
    });

    expect(vi.mocked(commands.updateAgentRunPhase)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-fast-1',
        phase: 'aborted',
      }),
    );
  });

  it('should write a fast-runtime trace and persist the trace id on the run row', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    llm.setToolsResponse({
      toolCalls: [
        {
          id: 'tool-call-1',
          name: 'delete_clip',
          args: { clipId: 'clip-1' },
        },
      ],
    });

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
      executor: async () => {
        llm.setToolsResponse({
          content: 'The clip has been deleted.',
          usage: {
            inputTokens: 12,
            outputTokens: 8,
          },
        });
        return {
          success: true,
          data: { deleted: true },
          duration: 10,
        };
      },
    });

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          enableTracing: true,
          approvalThreshold: 'low',
        },
      }),
    );

    let runPromise!: Promise<void>;
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

    const traceWriteCall = mockTauriInvoke.mock.calls.find(
      ([command]) => command === 'write_agent_trace',
    );
    expect(traceWriteCall).toBeDefined();

    const tracePayload = traceWriteCall?.[1] as { traceId?: string; traceJson?: string };
    const trace = JSON.parse(tracePayload.traceJson ?? '{}');

    expect(trace.runtimeKind).toBe('fast');
    expect(trace.artifacts.persistedRunId).toBe('run-fast-1');
    expect(trace.artifacts.permissionEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'ask',
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
        runtimeKind: 'fast',
        traceId: tracePayload.traceId,
      }),
    );
    expect(vi.mocked(commands.updateAgentRunPhase)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-fast-1',
        phase: 'completed',
        traceId: tracePayload.traceId,
      }),
    );
  });

  it('should report degraded persistence state when run start persistence fails', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    vi.mocked(commands.startAgentRun).mockResolvedValue({
      status: 'error',
      error: 'run start failed',
    });
    llm.setToolsResponse({ content: 'Continuing without persisted run row.' });

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
        },
      }),
    );

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run('Continue despite persistence failure');
    });

    await act(async () => {
      await runPromise;
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    expect(vi.mocked(commands.updateAgentRunPhase)).not.toHaveBeenCalled();
    expect(
      useAgentSessionStore.getState().persistenceIssuesBySessionId['conversation-session-1'],
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'conversation-session-1',
          stage: 'run_start',
          message: 'run start failed',
          occurredAt: expect.any(Number),
        }),
      ]),
    );
  });

  it('should report degraded persistence state when fast run finalization fails', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    vi.mocked(commands.updateAgentRunPhase).mockResolvedValue({
      status: 'error',
      error: 'fast run finalize failed',
    });
    llm.setToolsResponse({ content: 'Completed despite finalize persistence failure.' });

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
        },
      }),
    );

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run('Finish the run even if persistence misses finalize');
    });

    await act(async () => {
      await runPromise;
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    expect(
      useAgentSessionStore.getState().persistenceIssuesBySessionId['conversation-session-1'],
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'conversation-session-1',
          stage: 'run_finalize',
          message: 'fast run finalize failed',
          occurredAt: expect.any(Number),
        }),
      ]),
    );
  });

  it('should persist compaction artifacts when the fast loop compacts context', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    llm.setToolsResponse({
      toolCalls: [
        {
          id: 'tool-call-1',
          name: 'delete_clip',
          args: { clipId: 'clip-1' },
        },
      ],
      usage: {
        inputTokens: 950,
        outputTokens: 120,
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
      executor: async () => {
        llm.setToolsResponse({
          content: 'Deleted.',
          usage: {
            inputTokens: 40,
            outputTokens: 20,
          },
        });
        return {
          success: true,
          data: { deleted: true },
          duration: 10,
        };
      },
    });

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          contextLimit: 1000,
        },
      }),
    );

    await act(async () => {
      await result.current.run('Delete clip 1 with a long enough context window');
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    expect(vi.mocked(commands.recordAgentCompaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runId: 'run-fast-1',
        tier: 'summary',
        trigger: 'auto',
      }),
    );
    expect(vi.mocked(commands.createAgentResumeCheckpoint)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runId: 'run-fast-1',
        checkpointKind: 'compaction_boundary',
      }),
    );
  });

  it('should not create a compaction checkpoint when compaction persistence fails', async () => {
    const llm = createMockLLMAdapter();
    const tools = createMockToolExecutorWithVideoTools();

    vi.mocked(commands.recordAgentCompaction).mockResolvedValue({
      status: 'error',
      error: 'compaction persist failed',
    });

    llm.setToolsResponse({
      toolCalls: [
        {
          id: 'tool-call-1',
          name: 'delete_clip',
          args: { clipId: 'clip-1' },
        },
      ],
      usage: {
        inputTokens: 950,
        outputTokens: 120,
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
      executor: async () => {
        llm.setToolsResponse({
          content: 'Deleted.',
          usage: {
            inputTokens: 40,
            outputTokens: 20,
          },
        });
        return {
          success: true,
          data: { deleted: true },
          duration: 10,
        };
      },
    });

    const { result } = renderHook(() =>
      useAgentLoop({
        llmClient: llm,
        toolExecutor: tools,
        context: {
          projectId: 'project-1',
          sequenceId: 'sequence-1',
        },
        config: {
          enableFastPath: false,
          contextLimit: 1000,
        },
      }),
    );

    await act(async () => {
      await result.current.run('Delete clip 1 with a long enough context window');
    });

    await waitFor(() => {
      expect(result.current.phase).toBe('completed');
    });

    expect(vi.mocked(commands.recordAgentCompaction)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runId: 'run-fast-1',
        tier: 'summary',
        trigger: 'auto',
      }),
    );
    expect(vi.mocked(commands.createAgentResumeCheckpoint)).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'conversation-session-1',
        runId: 'run-fast-1',
        checkpointKind: 'compaction_boundary',
      }),
    );
    expect(
      useAgentSessionStore.getState().persistenceIssuesBySessionId['conversation-session-1'],
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'conversation-session-1',
          stage: 'compaction_record',
          message: 'compaction persist failed',
          occurredAt: expect.any(Number),
        }),
      ]),
    );
  });
});

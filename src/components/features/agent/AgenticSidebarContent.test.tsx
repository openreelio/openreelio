import { forwardRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeatureFlags, setFeatureFlag } from '@/config/featureFlags';
import { useConversationStore } from '@/stores/conversationStore';
import { useProjectStore } from '@/stores';
import { useAgentArtifactReviewStore } from '@/stores/agentArtifactReviewStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { useAgentDelegationStore } from '@/stores/agentDelegationStore';
import { createDefaultLayout, useWorkspaceLayoutStore } from '@/stores/workspaceLayoutStore';
import { loadProjectPromptContext } from '@/agents/engine/core/projectPromptContext';
import { createToolRegistryAdapter } from '@/agents/engine/adapters/tools/ToolRegistryAdapter';
import { createBackendToolExecutor } from '@/agents/engine/adapters/tools/BackendToolExecutor';
import { AgenticSidebarContent } from './AgenticSidebarContent';

let latestSessionListProps: Record<string, unknown> | null = null;
let latestAgenticChatProps: Record<string, unknown> | null = null;

vi.mock('./AgenticChat', () => ({
  AgenticChat: forwardRef((_props, _ref) => {
    void _ref;
    const props = _props as Record<string, unknown>;
    latestAgenticChatProps = props as Record<string, unknown>;
    return <div data-testid="agentic-chat">TPAO Runtime</div>;
  }),
}));

vi.mock('./SessionList', () => ({
  SessionList: vi.fn((props) => {
    latestSessionListProps = props as Record<string, unknown>;
    return (
      <div data-testid="session-list">
        <button
          type="button"
          data-testid="mock-session-switch-btn"
          onClick={() =>
            (props as { onSwitchSession?: (sessionId: string) => void }).onSwitchSession?.(
              'session-2',
            )
          }
        >
          switch
        </button>
      </div>
    );
  }),
}));

vi.mock('@/agents/engine/adapters/llm/TauriLLMAdapter', () => ({
  createTauriLLMAdapter: vi.fn(() => ({
    isConfigured: () => true,
  })),
}));

vi.mock('@/agents/engine/adapters/tools/ToolRegistryAdapter', () => ({
  createToolRegistryAdapter: vi.fn(() => ({})),
}));

vi.mock('@/agents/engine/adapters/tools/BackendToolExecutor', () => ({
  createBackendToolExecutor: vi.fn(() => ({})),
}));

vi.mock('@/hooks/useNewChat', () => ({
  useNewChat: vi.fn(() => ({
    newChat: vi.fn(),
    canCreateNew: true,
  })),
}));

vi.mock('@/agents/engine/core/projectPromptContext', () => ({
  loadProjectPromptContext: vi.fn().mockResolvedValue({ knowledge: [] }),
}));

describe('AgenticSidebarContent', () => {
  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        store = {};
      }),
    };
  })();

  beforeEach(() => {
    vi.stubGlobal('localStorage', localStorageMock);
    localStorageMock.clear();
    resetFeatureFlags();
    latestSessionListProps = null;
    latestAgenticChatProps = null;
    vi.mocked(loadProjectPromptContext).mockResolvedValue({ knowledge: [] });

    useProjectStore.setState((state) => ({
      ...state,
      meta: null,
    }));
    useAgentArtifactReviewStore.setState((state) => ({
      ...state,
      selection: {
        focus: null,
        projectId: null,
        conversationId: null,
        sourceLabel: null,
        sourceAgentProfileId: null,
      },
      sourcesByConversationId: {},
      isLoadingByConversationId: {},
      lastErrorByConversationId: {},
    }));
    useWorkspaceLayoutStore.setState((state) => ({
      ...state,
      layout: createDefaultLayout(),
    }));

    useConversationStore.setState((state) => ({
      ...state,
      activeConversation: {
        id: 'session-1',
        projectId: 'project-1',
        messages: [
          { id: 'm1', role: 'user', parts: [{ type: 'text', content: 'old' }], timestamp: 1 },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
      activeProjectId: 'project-1',
      activeSessionId: 'session-1',
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Editor Session',
          agent: 'editor',
          modelProvider: null,
          modelId: null,
          createdAt: 1,
          updatedAt: 1,
          archived: false,
          messageCount: 1,
          lastMessagePreview: 'old',
        },
        {
          id: 'session-2',
          projectId: 'project-1',
          title: 'Planner Session',
          agent: 'planner',
          modelProvider: null,
          modelId: null,
          createdAt: 2,
          updatedAt: 2,
          archived: false,
          messageCount: 0,
          lastMessagePreview: null,
        },
      ],
    }));

    useAgentSessionStore.setState((state) => ({
      ...state,
      snapshotsById: {
        'session-1': {
          session: {
            id: 'session-1',
            projectId: 'project-1',
            sequenceId: null,
            title: 'Editor Session',
            status: 'idle',
            runtimeKind: 'tpao',
            agentProfileId: 'editor',
            sessionMode: 'primary',
            lineage: {
              parentSessionId: null,
              branchFromSessionId: null,
              rootSessionId: 'session-1',
            },
            currentRunId: 'run-parent',
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
            createdAt: 1,
            updatedAt: 1,
            completedAt: null,
          },
          runs: [
            {
              id: 'run-parent',
              sessionId: 'session-1',
              runtimeKind: 'tpao',
              trigger: 'user',
              inputMessageId: null,
              outputMessageId: null,
              phase: 'completed',
              iteration: 1,
              maxIterations: 20,
              toolCallsUsed: 0,
              maxToolCalls: 50,
              plannedStepCount: 0,
              completedStepCount: 0,
              traceId: null,
              rollbackReportJson: null,
              errorCode: null,
              errorMessage: null,
              startedAt: 1,
              updatedAt: 1,
              endedAt: 1,
            },
          ],
        },
      },
      activeSessionId: 'session-1',
      activeProjectId: 'project-1',
    }));

    useAgentDelegationStore.setState({
      recordsBySessionId: {},
      isLoadingBySessionId: {},
      lastErrorBySessionId: {},
      loadDelegations: vi.fn().mockResolvedValue([]),
      createDelegatedSession: vi.fn(),
      updateDelegationRecord: vi.fn(),
      clearForSession: vi.fn(),
      clear: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should render the canonical TPAO runtime by default', () => {
    render(<AgenticSidebarContent />);

    expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-runtime-disabled-state')).not.toBeInTheDocument();
  });

  it('should keep the canonical runtime selected when USE_AGENT_LOOP is enabled', () => {
    setFeatureFlag('USE_AGENT_LOOP', true);

    render(<AgenticSidebarContent />);

    expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-runtime-disabled-state')).not.toBeInTheDocument();
  });

  it('should render an explicit disabled state when the canonical runtime is disabled', () => {
    setFeatureFlag('USE_AGENTIC_ENGINE', false);
    setFeatureFlag('USE_AGENT_LOOP', true);

    render(<AgenticSidebarContent />);

    expect(screen.getByTestId('agent-runtime-disabled-state')).toBeInTheDocument();
    expect(screen.getByText('AI runtime is disabled')).toBeInTheDocument();
    expect(
      screen.getByText('Enable `USE_AGENTIC_ENGINE` to restore the canonical TPAO runtime.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('agentic-chat')).not.toBeInTheDocument();
  });

  it('keeps internal recovery diagnostics out of the main user sidebar surface', () => {
    render(<AgenticSidebarContent />);

    expect(screen.queryByText('Recovery History')).not.toBeInTheDocument();
    expect(screen.queryByText('Session Recovery')).not.toBeInTheDocument();
    expect(screen.queryByText('Restart safety')).not.toBeInTheDocument();
  });

  it('reacts to backend tool flag changes without remounting the sidebar', async () => {
    setFeatureFlag('USE_BACKEND_TOOLS', false);

    render(<AgenticSidebarContent />);

    expect(createToolRegistryAdapter).toHaveBeenCalledTimes(1);
    expect(createBackendToolExecutor).not.toHaveBeenCalled();

    await act(async () => {
      setFeatureFlag('USE_BACKEND_TOOLS', true);
    });

    expect(createToolRegistryAdapter).toHaveBeenCalledTimes(2);
    expect(createBackendToolExecutor).toHaveBeenCalledTimes(1);
  });

  it('shows a transition state while a new session is starting', async () => {
    const deferred = createDeferred<string | null>();
    const createSession = vi.fn().mockReturnValue(deferred.promise);
    useConversationStore.setState({ createSession });

    let registeredNewChat: (() => void) | null = null;
    render(
      <AgenticSidebarContent
        onRegisterNewChat={(handler) => {
          registeredNewChat = handler;
        }}
      />,
    );

    expect(registeredNewChat).not.toBeNull();

    act(() => {
      registeredNewChat?.();
    });

    expect(screen.getByTestId('agent-session-transition-state')).toBeInTheDocument();
    expect(screen.queryByTestId('agentic-chat')).not.toBeInTheDocument();
    expect(createSession).toHaveBeenCalledWith('editor', { preserveDraftConversation: false });

    await act(async () => {
      deferred.resolve('session-2');
      await deferred.promise;
    });

    expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
  });

  it('shows a transition state while switching sessions', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<void>();
    const switchSession = vi.fn().mockReturnValue(deferred.promise);
    useConversationStore.setState({ switchSession });

    render(<AgenticSidebarContent />);

    await user.click(screen.getByTestId('toggle-sessions-btn'));
    await user.click(screen.getByTestId('mock-session-switch-btn'));

    expect(screen.getByTestId('agent-session-transition-state')).toBeInTheDocument();
    expect(screen.queryByTestId('agentic-chat')).not.toBeInTheDocument();
    expect(switchSession).toHaveBeenCalledWith('session-2');
    expect(latestSessionListProps).not.toBeNull();

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
  });

  it('delegates a specialist from the current editor session', async () => {
    const createDelegatedSession = vi.fn().mockResolvedValue({
      childSession: {
        id: 'session-child',
        projectId: 'project-1',
        sequenceId: null,
        title: 'Planner: Analyze this cut',
        status: 'idle',
        runtimeKind: 'subagent',
        agentProfileId: 'planner',
        sessionMode: 'child',
        lineage: {
          parentSessionId: 'session-1',
          branchFromSessionId: null,
          rootSessionId: 'session-1',
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
        createdAt: 2,
        updatedAt: 2,
        completedAt: null,
      },
      delegationRecord: {
        id: 'delegation-1',
        parentSessionId: 'session-1',
        childSessionId: 'session-child',
        parentRunId: 'run-parent',
        agentProfileId: 'planner',
        delegatedGoal: 'old',
        contextPacketJson: '{}',
        allowedToolsDeltaJson: null,
        permissionSnapshotJson: null,
        status: 'requested',
        mergeStatus: 'pending',
        summaryMessageId: null,
        resultJson: null,
        errorMessage: null,
        createdAt: 2,
        updatedAt: 2,
        completedAt: null,
      },
      delegationErrorMessage: null,
    });
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    const switchSession = vi.fn().mockResolvedValue(undefined);
    const addSystemMessageToSession = vi.fn();
    const loadAgentSession = vi
      .fn()
      .mockResolvedValue(useAgentSessionStore.getState().snapshotsById['session-1']);

    useConversationStore.setState({ loadSessions, switchSession, addSystemMessageToSession });
    useAgentSessionStore.setState({ loadSession: loadAgentSession });
    useAgentDelegationStore.setState((state) => ({
      ...state,
      createDelegatedSession,
    }));
    useProjectStore.setState((state) => ({
      ...state,
      meta: {
        id: 'project-1',
        name: 'Test Project',
        path: '/tmp/project',
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z',
      },
    }));

    render(<AgenticSidebarContent />);

    expect(latestAgenticChatProps).not.toBeNull();

    await act(async () => {
      await (
        latestAgenticChatProps as { onStartSession?: (agentProfileId?: string) => void }
      ).onStartSession?.('planner');
    });

    expect(createDelegatedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'session-1',
        parentRunId: 'run-parent',
        projectId: 'project-1',
        agentProfileId: 'planner',
      }),
    );
    expect(JSON.parse(createDelegatedSession.mock.calls[0][0].contextPacketJson as string)).toEqual(
      expect.objectContaining({
        parentSessionId: 'session-1',
        parentAgentId: 'editor',
        delegatedGoal: 'old',
        taskContract: expect.objectContaining({
          objective: 'old',
          specialistId: 'planner',
          specialistName: expect.any(String),
          verificationSpec: expect.objectContaining({
            requireStructuredHandoff: true,
          }),
          expectedDeliverables: expect.any(Array),
          acceptanceChecklist: expect.any(Array),
          handoffRequirement: expect.stringContaining('Parent verification is required'),
        }),
      }),
    );
    expect(loadSessions).toHaveBeenCalledWith('project-1');
    expect(switchSession).toHaveBeenCalledWith('session-child');
    expect(addSystemMessageToSession).toHaveBeenCalledWith(
      'session-child',
      expect.stringContaining('DELEGATION_HANDOFF'),
    );
  });

  it('stores a delegation result summary when a child specialist session completes', async () => {
    const updateDelegationRecord = vi.fn().mockResolvedValue({});

    useConversationStore.setState((state) => ({
      ...state,
      activeSessionId: 'session-child',
      activeConversation: {
        id: 'session-child',
        projectId: 'project-1',
        messages: [
          {
            id: 'assistant-msg-1',
            role: 'assistant',
            parts: [{ type: 'text', content: 'Suggested a faster cold open.' }],
            timestamp: 2,
          },
        ],
        createdAt: 2,
        updatedAt: 2,
      },
      sessions: [
        ...state.sessions,
        {
          id: 'session-child',
          projectId: 'project-1',
          title: 'Planner Session',
          agent: 'planner',
          modelProvider: null,
          modelId: null,
          createdAt: 2,
          updatedAt: 2,
          archived: false,
          messageCount: 1,
          lastMessagePreview: 'Suggested a faster cold open.',
        },
      ],
    }));
    useAgentSessionStore.setState((state) => ({
      ...state,
      snapshotsById: {
        ...state.snapshotsById,
        'session-child': {
          session: {
            id: 'session-child',
            projectId: 'project-1',
            sequenceId: null,
            title: 'Planner Session',
            status: 'idle',
            runtimeKind: 'subagent',
            agentProfileId: 'planner',
            sessionMode: 'child',
            lineage: {
              parentSessionId: 'session-1',
              branchFromSessionId: null,
              rootSessionId: 'session-1',
            },
            currentRunId: 'run-child',
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
            createdAt: 2,
            updatedAt: 2,
            completedAt: null,
          },
          runs: [],
        },
      },
      activeSessionId: 'session-child',
    }));
    useAgentDelegationStore.setState((state) => ({
      ...state,
      recordsBySessionId: {
        'session-child': [
          {
            id: 'delegation-1',
            parentSessionId: 'session-1',
            childSessionId: 'session-child',
            parentRunId: 'run-parent',
            agentProfileId: 'planner',
            delegatedGoal: 'Review pacing',
            contextPacketJson: JSON.stringify({
              source: 'agent-workspace',
              parentSessionId: 'session-1',
              parentAgentId: 'editor',
              parentAgentName: 'Editor Session',
              delegatedGoal: 'Review pacing',
              createdAt: 2,
              taskContract: {
                objective: 'Review pacing',
                specialistId: 'planner',
                specialistName: 'Planner',
                verificationSpec: {
                  handoffSchemaVersion: 1,
                  requireStructuredHandoff: true,
                  requireSummary: true,
                  requireEvidence: true,
                  requireOpenIssuesStatement: true,
                  minimumEvidenceCount: 1,
                },
                expectedDeliverables: [
                  'Break down the goal into an execution-ready plan: Review pacing',
                ],
                acceptanceChecklist: [
                  'Provide a parent-reviewable summary before declaring the task done.',
                ],
                handoffRequirement:
                  'Parent verification is required before this delegated result can be merged.',
              },
            }),
            allowedToolsDeltaJson: null,
            permissionSnapshotJson: null,
            status: 'running',
            mergeStatus: 'pending',
            summaryMessageId: null,
            resultJson: null,
            errorMessage: null,
            createdAt: 2,
            updatedAt: 2,
            completedAt: null,
          },
        ],
      },
      updateDelegationRecord,
    }));

    render(<AgenticSidebarContent />);

    await act(async () => {
      await (latestAgenticChatProps as { onComplete?: (result: any) => void }).onComplete?.({
        success: true,
        executionResults: [],
        iterations: 1,
        totalDuration: 1200,
        aborted: false,
        finalState: {},
        summary: {
          sessionId: 'session-child',
          input: 'Review pacing',
          totalIterations: 1,
          executedSteps: 1,
          successfulSteps: 1,
          failedSteps: 0,
          duration: 1200,
          finalState: 'Suggested a faster cold open.',
        },
      });
    });

    expect(updateDelegationRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'delegation-1',
        status: 'completed',
        summaryMessageId: 'assistant-msg-1',
      }),
    );
    expect(JSON.parse(updateDelegationRecord.mock.calls[0][0].resultJson as string)).toEqual(
      expect.objectContaining({
        preview: 'Suggested a faster cold open.',
        autoVerification: expect.objectContaining({
          status: 'needs_follow_up',
        }),
        verification: expect.objectContaining({
          verdict: 'unverified',
        }),
      }),
    );
  });

  it('marks an active child delegation as cancelled when the run aborts', async () => {
    const updateDelegationRecord = vi.fn().mockResolvedValue({});

    useConversationStore.setState((state) => ({
      ...state,
      activeSessionId: 'session-child',
      activeConversation: {
        id: 'session-child',
        projectId: 'project-1',
        messages: [
          {
            id: 'assistant-msg-cancel',
            role: 'assistant',
            parts: [{ type: 'text', content: 'Partial pacing analysis.' }],
            timestamp: 2,
          },
        ],
        createdAt: 2,
        updatedAt: 2,
      },
      sessions: [
        ...state.sessions,
        {
          id: 'session-child',
          projectId: 'project-1',
          title: 'Planner Session',
          agent: 'planner',
          modelProvider: null,
          modelId: null,
          createdAt: 2,
          updatedAt: 2,
          archived: false,
          messageCount: 1,
          lastMessagePreview: 'Partial pacing analysis.',
        },
      ],
    }));
    useAgentSessionStore.setState((state) => ({
      ...state,
      snapshotsById: {
        ...state.snapshotsById,
        'session-child': {
          session: {
            id: 'session-child',
            projectId: 'project-1',
            sequenceId: null,
            title: 'Planner Session',
            status: 'idle',
            runtimeKind: 'subagent',
            agentProfileId: 'planner',
            sessionMode: 'child',
            lineage: {
              parentSessionId: 'session-1',
              branchFromSessionId: null,
              rootSessionId: 'session-1',
            },
            currentRunId: 'run-child',
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
            createdAt: 2,
            updatedAt: 2,
            completedAt: null,
          },
          runs: [],
        },
      },
      activeSessionId: 'session-child',
    }));
    useAgentDelegationStore.setState((state) => ({
      ...state,
      recordsBySessionId: {
        'session-child': [
          {
            id: 'delegation-1',
            parentSessionId: 'session-1',
            childSessionId: 'session-child',
            parentRunId: 'run-parent',
            agentProfileId: 'planner',
            delegatedGoal: 'Review pacing',
            contextPacketJson: '{}',
            allowedToolsDeltaJson: null,
            permissionSnapshotJson: null,
            status: 'running',
            mergeStatus: 'pending',
            summaryMessageId: null,
            resultJson: null,
            errorMessage: null,
            createdAt: 2,
            updatedAt: 2,
            completedAt: null,
          },
        ],
      },
      updateDelegationRecord,
    }));

    render(<AgenticSidebarContent />);

    await act(async () => {
      await (latestAgenticChatProps as { onAbort?: () => void }).onAbort?.();
    });

    expect(updateDelegationRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'delegation-1',
        status: 'cancelled',
        summaryMessageId: 'assistant-msg-cancel',
        errorMessage: 'Cancelled by user.',
      }),
    );
    expect(JSON.parse(updateDelegationRecord.mock.calls[0][0].resultJson as string)).toEqual(
      expect.objectContaining({
        aborted: true,
        autoVerification: expect.objectContaining({
          status: 'fail',
        }),
      }),
    );
  });

  it('opens agent review for a delegated child result from the parent session', async () => {
    const user = userEvent.setup();

    useProjectStore.setState((state) => ({
      ...state,
      meta: {
        id: 'project-1',
        name: 'Test Project',
        path: '/tmp/project',
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z',
      },
    }));
    useConversationStore.setState((state) => ({
      ...state,
      activeSessionId: 'session-1',
      sessions: [
        ...state.sessions,
        {
          id: 'session-child',
          projectId: 'project-1',
          title: 'Planner Session',
          agent: 'planner',
          modelProvider: null,
          modelId: null,
          createdAt: 2,
          updatedAt: 2,
          archived: false,
          messageCount: 1,
          lastMessagePreview: 'Suggested a tighter intro.',
        },
      ],
    }));
    useAgentDelegationStore.setState((state) => ({
      ...state,
      recordsBySessionId: {
        'session-1': [
          {
            id: 'delegation-1',
            parentSessionId: 'session-1',
            childSessionId: 'session-child',
            parentRunId: 'run-parent',
            agentProfileId: 'planner',
            delegatedGoal: 'Review pacing',
            contextPacketJson: '{}',
            allowedToolsDeltaJson: null,
            permissionSnapshotJson: null,
            status: 'completed',
            mergeStatus: 'pending',
            summaryMessageId: 'assistant-msg-1',
            resultJson: JSON.stringify({
              success: true,
              aborted: false,
              totalDuration: 800,
              iterations: 1,
              finalState: 'Suggested a tighter intro.',
              executedSteps: 1,
              successfulSteps: 1,
              failedSteps: 0,
              preview: 'Suggested a tighter intro.',
              recentTools: [],
              recentFiles: ['src/foo.ts'],
            }),
            errorMessage: null,
            createdAt: 2,
            updatedAt: 2,
            completedAt: 2,
          },
        ],
      },
    }));

    render(<AgenticSidebarContent />);

    await user.click(screen.getByTestId('agent-delegated-child-review-delegation-1'));

    expect(useAgentArtifactReviewStore.getState().selection).toEqual(
      expect.objectContaining({
        projectId: 'project-1',
        conversationId: 'session-child',
        sourceLabel: 'Planner Session',
        sourceAgentProfileId: 'planner',
        focus: { kind: 'file', value: 'src/foo.ts' },
      }),
    );
    expect(screen.getByTestId('agent-review-inline-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('agentic-chat')).not.toBeInTheDocument();
    expect(useWorkspaceLayoutStore.getState().layout.zones.bottom.panelIds).not.toContain(
      'agent-review',
    );
    expect(useWorkspaceLayoutStore.getState().layout.zones.bottom.activePanelId).toBe('history');

    await user.click(screen.getByTestId('agent-review-inline-close-btn'));

    expect(screen.queryByTestId('agent-review-inline-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
    expect(useAgentArtifactReviewStore.getState().selection.conversationId).toBeNull();
  });
});

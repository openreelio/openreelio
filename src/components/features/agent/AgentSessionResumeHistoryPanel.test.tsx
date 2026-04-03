import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentSession,
  CompactionRecord,
  ResumeCheckpoint,
} from '@/agents/engine';
import { useConversationStore } from '@/stores/conversationStore';
import {
  buildAgentSessionRecoveryFingerprint,
  createEmptyAgentSessionRecoveryArtifacts,
  useAgentSessionStore,
} from '@/stores/agentSessionStore';
import { AgentSessionResumeHistoryPanel } from './AgentSessionResumeHistoryPanel';

function createSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    sequenceId: null,
    title: 'Session',
    status: 'idle',
    runtimeKind: 'tpao',
    agentProfileId: 'editor',
    sessionMode: 'primary',
    lineage: {
      parentSessionId: null,
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
    createdAt: 100,
    updatedAt: 100,
    completedAt: null,
    ...overrides,
  };
}

function createCompactionRecord(
  overrides: Partial<CompactionRecord> = {},
): CompactionRecord {
  return {
    id: 'compaction-1',
    sessionId: 'session-1',
    runId: 'run-1',
    tier: 'summary',
    trigger: 'auto',
    summaryMessageId: 'summary-1',
    sourceMessageCount: 12,
    retainedMessageCount: 4,
    estimatedTokensSaved: 3000,
    continuationSummaryJson: '{"summary":"trimmed"}',
    stateRehydrationJson: '{"resume":"cursor"}',
    createdAt: 700,
    ...overrides,
  };
}

function createResumeCheckpoint(
  overrides: Partial<ResumeCheckpoint> = {},
): ResumeCheckpoint {
  return {
    id: 'checkpoint-1',
    sessionId: 'session-1',
    runId: 'run-1',
    checkpointKind: 'safe_resume_point',
    status: 'active',
    resumeCursorJson: '{"cursor":1}',
    sessionStateJson: '{"phase":"executing"}',
    pendingWorkJson: '{"step":"step-1"}',
    createdAt: 800,
    consumedAt: null,
    ...overrides,
  };
}

function setActiveConversation(sessionId: string = 'session-1'): void {
  useConversationStore.setState({
    activeConversation: {
      id: sessionId,
      projectId: 'project-1',
      messages: [],
      createdAt: 100,
      updatedAt: 100,
    },
    isGenerating: false,
    streamingMessageId: null,
    activeProjectId: 'project-1',
    activeSessionId: sessionId,
    sessions: [],
  });
}

function seedSessionKernel(input?: {
  sessionOverrides?: Partial<AgentSession>;
  compactions?: CompactionRecord[];
  checkpoints?: ResumeCheckpoint[];
  artifactsLastError?: string | null;
  activeIssues?: ReturnType<typeof useAgentSessionStore.getState>['persistenceIssuesBySessionId'][string];
  latchedIssues?: ReturnType<typeof useAgentSessionStore.getState>['persistenceLatchesBySessionId'][string];
}): AgentSession {
  const session = createSession(input?.sessionOverrides);
  const headerFingerprint = buildAgentSessionRecoveryFingerprint(session);

  useAgentSessionStore.setState({
    snapshotsById: {
      [session.id]: {
        session,
        runs: [],
      },
    },
    recoveryArtifactsBySessionId: {
      [session.id]: {
        ...createEmptyAgentSessionRecoveryArtifacts(),
        compactions: input?.compactions ?? [],
        checkpoints: input?.checkpoints ?? [],
        headerFingerprint,
        lastRefreshedAt: 900,
        lastError: input?.artifactsLastError ?? null,
      },
    },
    persistenceIssuesBySessionId: input?.activeIssues
      ? { [session.id]: input.activeIssues }
      : {},
    persistenceLatchesBySessionId: input?.latchedIssues
      ? { [session.id]: input.latchedIssues }
      : {},
  });

  return session;
}

describe('AgentSessionResumeHistoryPanel', () => {
  beforeEach(() => {
    act(() => {
      useAgentSessionStore.getState().clear();
      setActiveConversation();
    });
  });

  afterEach(() => {
    act(() => {
      useAgentSessionStore.getState().clear();
    });
  });

  it('should render a pending state before the session kernel is hydrated', () => {
    render(<AgentSessionResumeHistoryPanel />);

    expect(screen.getByText('Recovery History')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(
      screen.getByText(/has not been hydrated into the session kernel yet/i),
    ).toBeInTheDocument();
  });

  it('should render linked recovery context when an active checkpoint is linked', () => {
    seedSessionKernel({
      sessionOverrides: {
        activeCheckpointId: 'checkpoint-1',
        compactionVersion: 2,
        resumeCursorVersion: 4,
        lastCompactedAt: 700,
        lastResumedAt: 800,
      },
      compactions: [createCompactionRecord()],
      checkpoints: [createResumeCheckpoint()],
    });

    render(<AgentSessionResumeHistoryPanel />);

    expect(screen.getByText('Context Available')).toBeInTheDocument();
    expect(screen.getByText('Linked checkpoint')).toBeInTheDocument();
    expect(
      screen.getByText(
        'A persisted checkpoint is linked to the current session state, so the next run can rebuild visible context from a durable boundary.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('1 persisted checkpoints')).toBeInTheDocument();
    expect(screen.getByText('1 persisted compactions')).toBeInTheDocument();
  });

  it('should render a degraded summary-boundary path when no checkpoint is linked', () => {
    seedSessionKernel({
      sessionOverrides: {
        latestSummaryMessageId: 'summary-1',
        compactionVersion: 1,
        lastCompactedAt: 700,
      },
      compactions: [createCompactionRecord()],
      artifactsLastError: 'Failed to load compaction history: backend offline',
    });

    render(<AgentSessionResumeHistoryPanel />);

    expect(screen.getByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText('Persisted summary')).toBeInTheDocument();
    expect(
      screen.getByText(
        /recovery will rebuild visible context from that summary instead of a linked checkpoint/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/persisted recovery history refresh is partial/i),
    ).toBeInTheDocument();
  });

  it('should render a cold conversation-log path when no durable boundary exists', () => {
    seedSessionKernel();

    render(<AgentSessionResumeHistoryPanel />);

    expect(screen.getByText('Cold')).toBeInTheDocument();
    expect(screen.getByText('Conversation log replay')).toBeInTheDocument();
    expect(screen.getByText('0 persisted checkpoints')).toBeInTheDocument();
    expect(screen.getByText('0 persisted compactions')).toBeInTheDocument();
  });

  it('should keep the restart mode ephemeral when a non-durable boundary was latched', () => {
    seedSessionKernel({
      sessionOverrides: {
        activeCheckpointId: 'checkpoint-1',
        resumeCursorVersion: 1,
      },
      checkpoints: [createResumeCheckpoint()],
      latchedIssues: [
        {
          sessionId: 'session-1',
          stage: 'run_start',
          message: 'failed to persist run start',
          occurredAt: 100,
        },
      ],
    });

    render(<AgentSessionResumeHistoryPanel />);

    expect(screen.getByText('Ephemeral')).toBeInTheDocument();
    expect(
      screen.getByText(/crossed a non-durable boundary in the current app session/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Linked checkpoint')).toBeInTheDocument();
  });
});

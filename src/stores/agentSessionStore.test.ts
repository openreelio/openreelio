import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildAgentSessionRecoveryFingerprint,
  createEmptyAgentSessionRecoveryArtifacts,
  createAgentSessionStore,
  summarizeAgentSessionPersistence,
  summarizeAgentSessionPersistenceView,
  summarizeAgentSessionResumeHistory,
  type AgentSessionBackendLike,
} from './agentSessionStore';
import type {
  AgentRun,
  AgentSession,
  AgentSessionSnapshot,
  CompactionRecord,
  CreatePersistedCompactionInput,
  CreatePersistedResumeCheckpointInput,
  PermissionDecision,
  ResumeCheckpoint,
} from '@/agents/engine';

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

function createRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    runtimeKind: 'tpao',
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

function createSnapshot(
  sessionOverrides: Partial<AgentSession> = {},
  runs: AgentRun[] = [],
): AgentSessionSnapshot {
  return {
    session: createSession(sessionOverrides),
    runs,
  };
}

function createPermissionDecision(
  overrides: Partial<PermissionDecision> = {},
): PermissionDecision {
  return {
    id: 'decision-1',
    sessionId: 'session-1',
    runId: 'run-1',
    stepId: 'step-1',
    subjectType: 'resource',
    subject: 'timeline.clip.delete#clip:clip-7',
    action: 'allow_always',
    source: 'interactive_approval',
    reason: null,
    createdAt: 100,
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
    createdAt: 200,
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
    createdAt: 250,
    consumedAt: null,
    ...overrides,
  };
}

describe('agentSessionStore', () => {
  let backend: AgentSessionBackendLike;
  let store: ReturnType<typeof createAgentSessionStore>;

  beforeEach(() => {
    backend = {
      createSession: async (input) => createSession({
        id: input.id ?? 'session-1',
        projectId: input.projectId,
        title: input.title ?? 'New Agent Session',
      }),
      getSession: async (sessionId) => createSnapshot({ id: sessionId }),
      listPermissionDecisions: async () => [],
      listCompactions: async () => [],
      listResumeCheckpoints: async () => [],
      recordCompaction: async (input: CreatePersistedCompactionInput) =>
        createCompactionRecord({
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
        }),
      createResumeCheckpoint: async (input: CreatePersistedResumeCheckpointInput) =>
        createResumeCheckpoint({
          sessionId: input.sessionId,
          runId: input.runId ?? null,
          checkpointKind: input.checkpointKind,
          status: input.status ?? 'active',
          resumeCursorJson: input.resumeCursorJson,
          sessionStateJson: input.sessionStateJson,
          pendingWorkJson: input.pendingWorkJson ?? null,
        }),
      consumeResumeCheckpoint: async (checkpointId: string) =>
        createResumeCheckpoint({
          id: checkpointId,
          status: 'consumed',
          consumedAt: 600,
        }),
      startRun: async (input) =>
        createRun({
          id: input.id ?? 'run-1',
          sessionId: input.sessionId,
          plannedStepCount: input.plannedStepCount ?? 0,
        }),
      updateRunPhase: async (input) =>
        createRun({
          id: input.runId,
          phase: input.phase,
          completedStepCount: input.completedStepCount ?? 0,
          outputMessageId: input.outputMessageId ?? null,
          endedAt: input.endedAt ?? null,
        }),
    };

    store = createAgentSessionStore(backend);
    store.getState().clear();
  });

  it('loads project scope and clears stale session cache on project switch', () => {
    const degradedIssue = {
      sessionId: 'session-old',
      stage: 'run_start' as const,
      message: 'stale persistence issue',
      occurredAt: 50,
    };

    store.setState({
      activeProjectId: 'project-old',
      activeSessionId: 'session-old',
      snapshotsById: {
        'session-old': createSnapshot({ id: 'session-old', projectId: 'project-old' }),
      },
      permissionDecisionsBySessionId: {
        'session-old': [createPermissionDecision({ sessionId: 'session-old' })],
      },
      persistenceIssuesBySessionId: {
        'session-old': [degradedIssue],
      },
      persistenceLatchesBySessionId: {
        'session-old': [degradedIssue],
      },
      sessionOrder: ['session-old'],
      isLoading: false,
      isMutating: false,
      lastError: 'stale',
    });

    store.getState().loadForProject('project-1');

    const state = store.getState();
    expect(state.activeProjectId).toBe('project-1');
    expect(state.activeSessionId).toBeNull();
    expect(state.snapshotsById).toEqual({});
    expect(state.permissionDecisionsBySessionId).toEqual({});
    expect(state.persistenceIssuesBySessionId).toEqual({});
    expect(state.persistenceLatchesBySessionId).toEqual({
      'session-old': [degradedIssue],
    });
    expect(state.recoveryArtifactsBySessionId).toEqual({});
    expect(state.sessionOrder).toEqual([]);
    expect(state.lastError).toBeNull();
  });

  it('creates and activates a session using the active project by default', async () => {
    store.getState().loadForProject('project-1');

    const session = await store.getState().createSession({
      id: 'session-2',
      title: 'Planner',
      agentProfileId: 'planner',
    });

    const state = store.getState();
    expect(session.id).toBe('session-2');
    expect(state.activeSessionId).toBe('session-2');
    expect(state.sessionOrder).toEqual(['session-2']);
    expect(state.snapshotsById['session-2']?.session.title).toBe('Planner');
    expect(state.isMutating).toBe(false);
  });

  it('refreshes the session snapshot after starting a run', async () => {
    backend.getSession = async (sessionId) =>
      createSnapshot(
        {
          id: sessionId,
          status: 'running',
          currentRunId: 'run-1',
          updatedAt: 200,
        },
        [createRun({ id: 'run-1', sessionId, plannedStepCount: 2 })],
      );

    const run = await store.getState().startRun({
      id: 'run-1',
      sessionId: 'session-1',
      plannedStepCount: 2,
    });

    const state = store.getState();
    expect(run.id).toBe('run-1');
    expect(state.activeSessionId).toBe('session-1');
    expect(state.snapshotsById['session-1']?.session.status).toBe('running');
    expect(state.snapshotsById['session-1']?.runs).toHaveLength(1);
    expect(state.snapshotsById['session-1']?.runs[0]?.plannedStepCount).toBe(2);
  });

  it('ensures a missing session by creating it with the requested id', async () => {
    backend.getSession = async (sessionId) => {
      if (sessionId === 'session-ensure' && !store.getState().snapshotsById[sessionId]) {
        throw new Error(`Failed to get agent session: Session not found: ${sessionId}`);
      }
      return createSnapshot({ id: sessionId, projectId: 'project-1' });
    };

    const snapshot = await store.getState().ensureSession({
      id: 'session-ensure',
      projectId: 'project-1',
      runtimeKind: 'tpao',
      agentProfileId: 'editor',
    });

    expect(snapshot.session.id).toBe('session-ensure');
    expect(store.getState().activeSessionId).toBe('session-ensure');
    expect(store.getState().snapshotsById['session-ensure']?.session.projectId).toBe('project-1');
  });

  it('refreshes persisted permission decisions into the session cache', async () => {
    backend.listPermissionDecisions = async (sessionId) => [
      createPermissionDecision({
        id: 'decision-9',
        sessionId,
        subject: 'workspace.document.write#path:docs/ROADMAP.md',
      }),
    ];

    const decisions = await store.getState().refreshPermissionDecisions('session-1');

    expect(decisions).toHaveLength(1);
    expect(store.getState().permissionDecisionsBySessionId['session-1']).toEqual(decisions);
  });

  it('refreshes persisted recovery artifacts into the session cache', async () => {
    backend.listCompactions = async (sessionId) => [
      createCompactionRecord({
        sessionId,
        id: 'compaction-9',
        createdAt: 400,
      }),
    ];
    backend.listResumeCheckpoints = async (sessionId) => [
      createResumeCheckpoint({
        sessionId,
        id: 'checkpoint-9',
        createdAt: 500,
      }),
    ];

    const session = createSession({
      id: 'session-1',
      currentRunId: 'run-1',
      activeCheckpointId: 'checkpoint-9',
      latestSummaryMessageId: 'summary-1',
      compactionVersion: 2,
      resumeCursorVersion: 3,
      lastCompactedAt: 400,
      lastResumedAt: 500,
    });
    const artifacts = await store.getState().refreshRecoveryArtifacts('session-1', {
      headerFingerprint: buildAgentSessionRecoveryFingerprint(session),
    });

    expect(artifacts.compactions).toHaveLength(1);
    expect(artifacts.checkpoints).toHaveLength(1);
    expect(artifacts.lastError).toBeNull();
    expect(artifacts.headerFingerprint).toBe(buildAgentSessionRecoveryFingerprint(session));
    expect(store.getState().recoveryArtifactsBySessionId['session-1']).toEqual({
      ...artifacts,
      lastRefreshedAt: expect.any(Number),
    });
  });

  it('keeps the last known recovery artifacts when one history lane fails to refresh', async () => {
    store.setState({
      recoveryArtifactsBySessionId: {
        'session-1': {
          ...createEmptyAgentSessionRecoveryArtifacts(),
          compactions: [
            createCompactionRecord({
              id: 'compaction-stable',
              createdAt: 300,
            }),
          ],
          checkpoints: [
            createResumeCheckpoint({
              id: 'checkpoint-stable',
              createdAt: 350,
            }),
          ],
          headerFingerprint: 'fingerprint-1',
          lastRefreshedAt: 360,
        },
      },
    });
    backend.listCompactions = async () => {
      throw new Error('compaction list unavailable');
    };
    backend.listResumeCheckpoints = async () => [
      createResumeCheckpoint({
        id: 'checkpoint-fresh',
        createdAt: 450,
      }),
    ];

    const artifacts = await store.getState().refreshRecoveryArtifacts('session-1', {
      headerFingerprint: 'fingerprint-2',
    });

    expect(artifacts.compactions).toEqual([
      createCompactionRecord({
        id: 'compaction-stable',
        createdAt: 300,
      }),
    ]);
    expect(artifacts.checkpoints).toEqual([
      createResumeCheckpoint({
        id: 'checkpoint-fresh',
        createdAt: 450,
      }),
    ]);
    expect(artifacts.lastError).toMatch(/failed to load compaction history/i);
    expect(artifacts.headerFingerprint).toBe('fingerprint-2');
  });

  it('records compaction artifacts and refreshes session recovery metadata', async () => {
    backend.getSession = async (sessionId) =>
      createSnapshot({
        id: sessionId,
        compactionVersion: 1,
        lastCompactedAt: 700,
      });
    backend.listCompactions = async () => [
      createCompactionRecord({
        id: 'compaction-1',
        createdAt: 700,
      }),
    ];

    const record = await store.getState().recordCompaction({
      sessionId: 'session-1',
      runId: 'run-1',
      tier: 'summary',
      trigger: 'auto',
      sourceMessageCount: 12,
      retainedMessageCount: 4,
      continuationSummaryJson: '{"summary":"trimmed"}',
      stateRehydrationJson: '{"phase":"compacting"}',
    });

    expect(record.sessionId).toBe('session-1');
    expect(store.getState().snapshotsById['session-1']?.session.compactionVersion).toBe(1);
    expect(store.getState().recoveryArtifactsBySessionId['session-1']?.compactions).toHaveLength(1);
  });

  it('creates and consumes resume checkpoints while refreshing recovery metadata', async () => {
    backend.getSession = async (sessionId) =>
      createSnapshot({
        id: sessionId,
        activeCheckpointId: 'checkpoint-1',
        resumeCursorVersion: 2,
      });
    backend.listResumeCheckpoints = async () => [
      createResumeCheckpoint({
        id: 'checkpoint-1',
        status: 'active',
      }),
    ];

    const checkpoint = await store.getState().createResumeCheckpoint({
      sessionId: 'session-1',
      runId: 'run-1',
      checkpointKind: 'tool_wait',
      resumeCursorJson: '{"cursor":1}',
      sessionStateJson: '{"phase":"waiting"}',
      pendingWorkJson: '{"tool":"delete_clip"}',
    });

    expect(checkpoint.checkpointKind).toBe('tool_wait');
    expect(store.getState().snapshotsById['session-1']?.session.activeCheckpointId).toBe(
      'checkpoint-1',
    );

    backend.getSession = async (sessionId) =>
      createSnapshot({
        id: sessionId,
        activeCheckpointId: null,
        resumeCursorVersion: 3,
        lastResumedAt: 900,
      });
    backend.listResumeCheckpoints = async () => [
      createResumeCheckpoint({
        id: 'checkpoint-1',
        status: 'consumed',
        consumedAt: 900,
      }),
    ];

    const consumed = await store.getState().consumeResumeCheckpoint('checkpoint-1');

    expect(consumed.status).toBe('consumed');
    expect(store.getState().snapshotsById['session-1']?.session.activeCheckpointId).toBeNull();
    expect(store.getState().recoveryArtifactsBySessionId['session-1']?.checkpoints[0]?.status).toBe(
      'consumed',
    );
  });

  it('tracks persistence degradation by stage and clears it selectively', () => {
    store.setState({
      activeSessionId: 'session-1',
    });

    const finalizeIssue = store.getState().reportPersistenceIssue({
      sessionId: 'session-1',
      stage: 'run_finalize',
      error: new Error('failed to persist final run phase'),
      occurredAt: 300,
    });
    const replayIssue = store.getState().reportPersistenceIssue({
      sessionId: 'session-1',
      stage: 'permission_replay',
      error: new Error('failed to reload permission decisions'),
      occurredAt: 200,
    });

    expect(finalizeIssue).toEqual({
      sessionId: 'session-1',
      stage: 'run_finalize',
      message: 'failed to persist final run phase',
      occurredAt: 300,
    });
    expect(replayIssue).toEqual({
      sessionId: 'session-1',
      stage: 'permission_replay',
      message: 'failed to reload permission decisions',
      occurredAt: 200,
    });
    expect(store.getState().persistenceIssuesBySessionId['session-1']).toEqual([
      replayIssue,
      finalizeIssue,
    ]);
    expect(store.getState().persistenceLatchesBySessionId['session-1']).toEqual([
      replayIssue,
      finalizeIssue,
    ]);
    expect(store.getState().lastError).toBe('failed to persist final run phase');

    store.getState().clearPersistenceIssue('session-1', 'permission_replay');

    expect(store.getState().persistenceIssuesBySessionId['session-1']).toEqual([finalizeIssue]);

    store.getState().clearPersistenceIssue('session-1', 'run_finalize');

    expect(store.getState().persistenceIssuesBySessionId).toEqual({});
    expect(store.getState().persistenceLatchesBySessionId['session-1']).toEqual([
      replayIssue,
      finalizeIssue,
    ]);
    expect(store.getState().lastError).toBeNull();
  });

  it('clears a stage-specific persistence issue after a successful retry', async () => {
    backend.listPermissionDecisions = async () => {
      throw new Error('failed to reload permission decisions');
    };

    await expect(store.getState().refreshPermissionDecisions('session-1')).rejects.toThrow(
      'failed to reload permission decisions',
    );

    const replayIssue = store.getState().persistenceIssuesBySessionId['session-1']?.[0];
    expect(replayIssue).toEqual({
      sessionId: 'session-1',
      stage: 'permission_replay',
      message: 'failed to reload permission decisions',
      occurredAt: expect.any(Number),
    });
    expect(store.getState().persistenceLatchesBySessionId['session-1']).toEqual([replayIssue]);

    backend.listPermissionDecisions = async () => [
      createPermissionDecision({
        id: 'decision-10',
        sessionId: 'session-1',
      }),
    ];

    await store.getState().refreshPermissionDecisions('session-1');

    expect(store.getState().persistenceIssuesBySessionId['session-1']).toBeUndefined();
    expect(store.getState().persistenceLatchesBySessionId['session-1']).toEqual([replayIssue]);
  });

  it('captures backend errors without leaving mutation flags stuck', async () => {
    backend.updateRunPhase = async () => {
      throw new Error('run update failed');
    };

    await expect(
      store.getState().updateRunPhase({
        runId: 'run-1',
        phase: 'failed',
        errorMessage: 'run update failed',
      }),
    ).rejects.toThrow('run update failed');

    const state = store.getState();
    expect(state.isMutating).toBe(false);
    expect(state.lastError).toBe('run update failed');
  });

  it('classifies permission replay and finalize misses as degraded', () => {
    expect(summarizeAgentSessionPersistence([
      {
        sessionId: 'session-1',
        stage: 'permission_replay',
        message: 'failed to replay permissions',
        occurredAt: 100,
      },
      {
        sessionId: 'session-1',
        stage: 'run_finalize',
        message: 'failed to finalize run',
        occurredAt: 200,
      },
    ])).toEqual({
      status: 'degraded',
      label: 'Degraded',
      description:
        'Persistence is partial. Resume, approval history, or audit trail may be incomplete until persistence recovers.',
      isRestartSafe: true,
    });
  });

  it('classifies session creation or run-start misses as ephemeral', () => {
    expect(summarizeAgentSessionPersistence([
      {
        sessionId: 'session-1',
        stage: 'run_start',
        message: 'failed to start persisted run',
        occurredAt: 100,
      },
    ])).toEqual({
      status: 'ephemeral',
      label: 'Ephemeral',
      description:
        'Persistence failed before the session boundary was durably recorded. Restart survivability is not guaranteed.',
      isRestartSafe: false,
    });
  });

  it('surfaces recovered persistence as a latched view for the current process', () => {
    const latchedIssue = {
      sessionId: 'session-1',
      stage: 'run_start' as const,
      message: 'failed to create persisted run',
      occurredAt: 100,
    };

    expect(summarizeAgentSessionPersistenceView(undefined, [latchedIssue])).toEqual({
      status: 'ephemeral',
      label: 'Ephemeral',
      description:
        'Persistence recovered for the active run, but this session crossed a non-durable boundary earlier in this app session. Restart survivability is still not guaranteed for that earlier history.',
      isRestartSafe: false,
      hasActiveIssues: false,
      isLatched: true,
      visibleIssues: [latchedIssue],
    });
  });

  it('classifies a linked checkpoint as a full restart path', () => {
    const session = createSession({
      activeCheckpointId: 'checkpoint-9',
      compactionVersion: 2,
      resumeCursorVersion: 4,
    });

    expect(summarizeAgentSessionResumeHistory({
      session,
      artifacts: {
        ...createEmptyAgentSessionRecoveryArtifacts(),
        checkpoints: [
          createResumeCheckpoint({
            id: 'checkpoint-9',
            checkpointKind: 'approval_wait',
            status: 'active',
            createdAt: 900,
          }),
        ],
        compactions: [
          createCompactionRecord({
            id: 'compaction-9',
            createdAt: 800,
          }),
        ],
      },
    })).toMatchObject({
      status: 'full',
      label: 'Full',
      restartBoundary: {
        kind: 'checkpoint',
        title: 'Resume checkpoint',
      },
      checkpointCount: 1,
      compactionCount: 1,
    });
  });

  it('falls back to a degraded summary boundary when no checkpoint is linked', () => {
    const session = createSession({
      latestSummaryMessageId: 'summary-9',
      lastCompactedAt: 700,
    });

    expect(summarizeAgentSessionResumeHistory({
      session,
      artifacts: {
        ...createEmptyAgentSessionRecoveryArtifacts(),
        checkpoints: [],
        compactions: [
          createCompactionRecord({
            id: 'compaction-9',
            createdAt: 700,
          }),
        ],
      },
    })).toMatchObject({
      status: 'degraded',
      label: 'Degraded',
      restartBoundary: {
        kind: 'summary_boundary',
        title: 'Summary boundary',
      },
      checkpointCount: 0,
      compactionCount: 1,
    });
  });

  it('classifies restart as cold when no durable boundary is linked', () => {
    expect(summarizeAgentSessionResumeHistory({
      session: createSession(),
      artifacts: createEmptyAgentSessionRecoveryArtifacts(),
    })).toMatchObject({
      status: 'cold',
      label: 'Cold',
      restartBoundary: {
        kind: 'conversation_log',
        title: 'Conversation log replay',
      },
      checkpointCount: 0,
      compactionCount: 0,
    });
  });

  it('keeps restart mode ephemeral when a non-durable boundary was latched', () => {
    expect(summarizeAgentSessionResumeHistory({
      session: createSession({
        activeCheckpointId: 'checkpoint-9',
        resumeCursorVersion: 1,
      }),
      latchedIssues: [
        {
          sessionId: 'session-1',
          stage: 'run_start',
          message: 'failed to persist run start',
          occurredAt: 100,
        },
      ],
      artifacts: {
        ...createEmptyAgentSessionRecoveryArtifacts(),
        checkpoints: [
          createResumeCheckpoint({
            id: 'checkpoint-9',
          }),
        ],
      },
    })).toMatchObject({
      status: 'ephemeral',
      label: 'Ephemeral',
      restartBoundary: {
        kind: 'checkpoint',
        title: 'Resume checkpoint',
      },
      checkpointCount: 1,
    });
  });

  it('builds a stable recovery fingerprint from persisted session markers', () => {
    expect(buildAgentSessionRecoveryFingerprint(createSession())).toBe(
      'session-1||||0|0||',
    );
    expect(buildAgentSessionRecoveryFingerprint(createSession({
      currentRunId: 'run-2',
      activeCheckpointId: 'checkpoint-2',
      latestSummaryMessageId: 'summary-2',
      compactionVersion: 2,
      resumeCursorVersion: 4,
      lastCompactedAt: 600,
      lastResumedAt: 700,
    }))).toBe('session-1|run-2|checkpoint-2|summary-2|2|4|600|700');
  });
});

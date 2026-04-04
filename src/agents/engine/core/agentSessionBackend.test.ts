import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '@/bindings';
import {
  AgentSessionBackend,
  createAgentSessionBackend,
  hydrateCompactionRecord,
  hydrateDelegationRecord,
  hydrateAgentRun,
  hydrateAgentSession,
  hydrateAgentSessionSnapshot,
  hydratePermissionDecision,
  hydrateResumeCheckpoint,
} from './agentSessionBackend';

vi.mock('@/bindings', () => ({
  commands: {
    createAgentSession: vi.fn(),
    getAgentSession: vi.fn(),
    startAgentRun: vi.fn(),
    updateAgentRunPhase: vi.fn(),
    createAgentDelegationRecord: vi.fn(),
    updateAgentDelegationRecord: vi.fn(),
    listAgentDelegationRecords: vi.fn(),
    recordAgentPermissionDecision: vi.fn(),
    listAgentPermissionDecisions: vi.fn(),
    recordAgentCompaction: vi.fn(),
    listAgentCompactions: vi.fn(),
    createAgentResumeCheckpoint: vi.fn(),
    consumeAgentResumeCheckpoint: vi.fn(),
    listAgentResumeCheckpoints: vi.fn(),
  },
}));

describe('AgentSessionBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a session using the shared session factory defaults', async () => {
    vi.mocked(commands.createAgentSession).mockResolvedValue({
      status: 'ok',
      data: {
        id: 'session-1',
        projectId: 'project-1',
        sequenceId: null,
        title: 'New Agent Session',
        status: 'idle',
        runtimeKind: 'subagent',
        agentProfileId: 'planner',
        sessionMode: 'child',
        lineage: {
          parentSessionId: 'parent-1',
          branchFromSessionId: null,
          rootSessionId: 'root-1',
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
        modelProvider: 'openai',
        modelId: 'gpt-5',
        createdAt: 100,
        updatedAt: 100,
        completedAt: null,
      },
    });

    const backend = createAgentSessionBackend();
    const session = await backend.createSession({
      id: 'session-1',
      now: 100,
      projectId: 'project-1',
      parentSessionId: 'parent-1',
      rootSessionId: 'root-1',
      runtimeKind: 'subagent',
      sessionMode: 'child',
      agentProfileId: 'planner',
      modelProvider: 'openai',
      modelId: 'gpt-5',
    });

    expect(commands.createAgentSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      sequenceId: null,
      title: 'New Agent Session',
      runtimeKind: 'subagent',
      agentProfileId: 'planner',
      sessionMode: 'child',
      parentSessionId: 'parent-1',
      branchFromSessionId: null,
      rootSessionId: 'root-1',
      modelProvider: 'openai',
      modelId: 'gpt-5',
      id: 'session-1',
    });
    expect(session.lineage.rootSessionId).toBe('root-1');
    expect(session.runtimeKind).toBe('subagent');
    expect(session.status).toBe('idle');
  });

  it('loads a persisted session snapshot with run history', async () => {
    vi.mocked(commands.getAgentSession).mockResolvedValue({
      status: 'ok',
      data: {
        session: {
          id: 'session-1',
          projectId: 'project-1',
          sequenceId: null,
          title: 'Session',
          status: 'running',
          runtimeKind: 'tpao',
          agentProfileId: 'editor',
          sessionMode: 'primary',
          lineage: {
            parentSessionId: null,
            branchFromSessionId: null,
            rootSessionId: 'session-1',
          },
          currentRunId: 'run-2',
          currentPlanId: 'plan-1',
          pendingApprovalId: null,
          activeCheckpointId: null,
          permissionStateVersion: 1,
          compactionVersion: 2,
          resumeCursorVersion: 3,
          latestSummaryMessageId: 'summary-1',
          lastCompactedAt: 400,
          lastResumedAt: 500,
          modelProvider: 'openai',
          modelId: 'gpt-5',
          createdAt: 100,
          updatedAt: 600,
          completedAt: null,
        },
        runs: [
          {
            id: 'run-2',
            sessionId: 'session-1',
            runtimeKind: 'tpao',
            trigger: 'resume',
            inputMessageId: 'm-1',
            outputMessageId: null,
            phase: 'executing',
            iteration: 1,
            maxIterations: 20,
            toolCallsUsed: 2,
            maxToolCalls: 50,
            plannedStepCount: 3,
            completedStepCount: 1,
            traceId: 'trace-2',
            rollbackReportJson: null,
            errorCode: null,
            errorMessage: null,
            startedAt: 200,
            updatedAt: 600,
            endedAt: null,
          },
        ],
      },
    });

    const backend = new AgentSessionBackend();
    const snapshot = await backend.getSession('session-1');

    expect(commands.getAgentSession).toHaveBeenCalledWith('session-1');
    expect(snapshot.session.currentRunId).toBe('run-2');
    expect(snapshot.session.latestSummaryMessageId).toBe('summary-1');
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0].phase).toBe('executing');
    expect(snapshot.runs[0].trigger).toBe('resume');
  });

  it('starts and updates runs through the persisted backend surface', async () => {
    vi.mocked(commands.startAgentRun).mockResolvedValue({
      status: 'ok',
      data: {
        id: 'run-1',
        sessionId: 'session-1',
        runtimeKind: 'tpao',
        trigger: 'user',
        inputMessageId: 'm-user',
        outputMessageId: null,
        phase: 'initializing',
        iteration: 0,
        maxIterations: 20,
        toolCallsUsed: 0,
        maxToolCalls: 40,
        plannedStepCount: 2,
        completedStepCount: 0,
        traceId: 'trace-1',
        rollbackReportJson: null,
        errorCode: null,
        errorMessage: null,
        startedAt: 100,
        updatedAt: 100,
        endedAt: null,
      },
    });
    vi.mocked(commands.updateAgentRunPhase).mockResolvedValue({
      status: 'ok',
      data: {
        id: 'run-1',
        sessionId: 'session-1',
        runtimeKind: 'tpao',
        trigger: 'user',
        inputMessageId: 'm-user',
        outputMessageId: 'm-assistant',
        phase: 'completed',
        iteration: 0,
        maxIterations: 20,
        toolCallsUsed: 2,
        maxToolCalls: 40,
        plannedStepCount: 2,
        completedStepCount: 2,
        traceId: 'trace-1',
        rollbackReportJson: null,
        errorCode: null,
        errorMessage: null,
        startedAt: 100,
        updatedAt: 200,
        endedAt: 200,
      },
    });

    const backend = createAgentSessionBackend();
    const run = await backend.startRun({
      id: 'run-1',
      now: 100,
      sessionId: 'session-1',
      runtimeKind: 'tpao',
      trigger: 'user',
      inputMessageId: 'm-user',
      maxToolCalls: 40,
      plannedStepCount: 2,
      traceId: 'trace-1',
    });

    expect(commands.startAgentRun).toHaveBeenCalledWith({
      sessionId: 'session-1',
      runtimeKind: 'tpao',
      trigger: 'user',
      maxIterations: 20,
      maxToolCalls: 40,
      plannedStepCount: 2,
      inputMessageId: 'm-user',
      traceId: 'trace-1',
      id: 'run-1',
    });
    expect(run.phase).toBe('initializing');

    const completedRun = await backend.updateRunPhase({
      runId: 'run-1',
      phase: 'completed',
      traceId: 'trace-1',
      toolCallsUsed: 2,
      plannedStepCount: 2,
      completedStepCount: 2,
      outputMessageId: 'm-assistant',
      endedAt: 200,
    });

    expect(commands.updateAgentRunPhase).toHaveBeenCalledWith({
      runId: 'run-1',
      phase: 'completed',
      traceId: 'trace-1',
      toolCallsUsed: 2,
      plannedStepCount: 2,
      completedStepCount: 2,
      outputMessageId: 'm-assistant',
      rollbackReportJson: null,
      errorCode: null,
      errorMessage: null,
      currentPlanId: null,
      pendingApprovalId: null,
      activeCheckpointId: null,
      permissionStateVersion: null,
      compactionVersion: null,
      resumeCursorVersion: null,
      lastCompactedAt: null,
      lastResumedAt: null,
      endedAt: 200,
    });
    expect(completedRun.phase).toBe('completed');
    expect(completedRun.completedStepCount).toBe(2);
  });

  it('hydrates DTO helpers with internal kernel vocabulary', () => {
    const session = hydrateAgentSession({
      id: 'session-1',
      projectId: 'project-1',
      sequenceId: null,
      title: 'Session',
      status: 'awaiting_approval',
      runtimeKind: 'fast',
      agentProfileId: 'editor',
      sessionMode: 'branch',
      lineage: {
        parentSessionId: null,
        branchFromSessionId: 'source-1',
        rootSessionId: 'root-1',
      },
      currentRunId: 'run-1',
      currentPlanId: 'plan-1',
      pendingApprovalId: 'approval-1',
      activeCheckpointId: 'checkpoint-1',
      permissionStateVersion: 3,
      compactionVersion: 4,
      resumeCursorVersion: 5,
      latestSummaryMessageId: 'summary-1',
      lastCompactedAt: 10,
      lastResumedAt: 20,
      modelProvider: null,
      modelId: null,
      createdAt: 1,
      updatedAt: 2,
      completedAt: null,
    });
    const run = hydrateAgentRun({
      id: 'run-1',
      sessionId: 'session-1',
      runtimeKind: 'fast',
      trigger: 'delegation',
      inputMessageId: null,
      outputMessageId: null,
      phase: 'awaiting_approval',
      iteration: 1,
      maxIterations: 10,
      toolCallsUsed: 1,
      maxToolCalls: 5,
      plannedStepCount: 2,
      completedStepCount: 1,
      traceId: null,
      rollbackReportJson: null,
      errorCode: null,
      errorMessage: null,
      startedAt: 10,
      updatedAt: 11,
      endedAt: null,
    });
    const snapshot = hydrateAgentSessionSnapshot({
      session: {
        id: 'session-1',
        projectId: 'project-1',
        sequenceId: null,
        title: 'Session',
        status: 'awaiting_approval',
        runtimeKind: 'fast',
        agentProfileId: 'editor',
        sessionMode: 'branch',
        lineage: {
          parentSessionId: null,
          branchFromSessionId: 'source-1',
          rootSessionId: 'root-1',
        },
        currentRunId: 'run-1',
        currentPlanId: 'plan-1',
        pendingApprovalId: 'approval-1',
        activeCheckpointId: 'checkpoint-1',
        permissionStateVersion: 3,
        compactionVersion: 4,
        resumeCursorVersion: 5,
        latestSummaryMessageId: 'summary-1',
        lastCompactedAt: 10,
        lastResumedAt: 20,
        modelProvider: null,
        modelId: null,
        createdAt: 1,
        updatedAt: 2,
        completedAt: null,
      },
      runs: [
        {
          id: 'run-1',
          sessionId: 'session-1',
          runtimeKind: 'fast',
          trigger: 'delegation',
          inputMessageId: null,
          outputMessageId: null,
          phase: 'awaiting_approval',
          iteration: 1,
          maxIterations: 10,
          toolCallsUsed: 1,
          maxToolCalls: 5,
          plannedStepCount: 2,
          completedStepCount: 1,
          traceId: null,
          rollbackReportJson: null,
          errorCode: null,
          errorMessage: null,
          startedAt: 10,
          updatedAt: 11,
          endedAt: null,
        },
      ],
    });

    expect(session.sessionMode).toBe('branch');
    expect(run.trigger).toBe('delegation');
    expect(snapshot.runs[0].phase).toBe('awaiting_approval');
  });

  it('persists and hydrates delegation, permission, compaction, and resume artifacts', async () => {
    vi.mocked(commands.createAgentDelegationRecord).mockResolvedValue({
      status: 'ok',
      data: {
        id: 'delegation-1',
        parentSessionId: 'session-parent',
        childSessionId: 'session-child',
        parentRunId: 'run-parent',
        agentProfileId: 'planner',
        delegatedGoal: 'Analyze shots',
        contextPacketJson: '{"goal":"Analyze shots"}',
        allowedToolsDeltaJson: null,
        permissionSnapshotJson: '{"scope":"narrow"}',
        status: 'requested',
        mergeStatus: 'pending',
        summaryMessageId: null,
        resultJson: null,
        errorMessage: null,
        createdAt: 100,
        updatedAt: 100,
        completedAt: null,
      },
    });
    vi.mocked(commands.recordAgentPermissionDecision).mockResolvedValue({
      status: 'ok',
      data: {
        id: 'decision-1',
        sessionId: 'session-parent',
        runId: 'run-parent',
        stepId: 'step-1',
        subjectType: 'tool',
        subject: 'timeline.clip.delete',
        action: 'ask',
        source: 'interactive_approval',
        reason: 'destructive',
        createdAt: 101,
      },
    });
    vi.mocked(commands.recordAgentCompaction).mockResolvedValue({
      status: 'ok',
      data: {
        id: 'compaction-1',
        sessionId: 'session-parent',
        runId: 'run-parent',
        tier: 'summary',
        trigger: 'auto',
        summaryMessageId: 'summary-1',
        sourceMessageCount: 12,
        retainedMessageCount: 4,
        estimatedTokensSaved: 3000,
        continuationSummaryJson: '{"summary":"trimmed"}',
        stateRehydrationJson: '{"resume":"cursor"}',
        createdAt: 102,
      },
    });
    vi.mocked(commands.createAgentResumeCheckpoint).mockResolvedValue({
      status: 'ok',
      data: {
        id: 'checkpoint-1',
        sessionId: 'session-parent',
        runId: 'run-parent',
        checkpointKind: 'safe_resume_point',
        status: 'active',
        resumeCursorJson: '{"cursor":1}',
        sessionStateJson: '{"phase":"executing"}',
        pendingWorkJson: '{"step":"step-1"}',
        createdAt: 103,
        consumedAt: null,
      },
    });
    vi.mocked(commands.consumeAgentResumeCheckpoint).mockResolvedValue({
      status: 'ok',
      data: {
        id: 'checkpoint-1',
        sessionId: 'session-parent',
        runId: 'run-parent',
        checkpointKind: 'safe_resume_point',
        status: 'consumed',
        resumeCursorJson: '{"cursor":1}',
        sessionStateJson: '{"phase":"executing"}',
        pendingWorkJson: '{"step":"step-1"}',
        createdAt: 103,
        consumedAt: 200,
      },
    });
    vi.mocked(commands.listAgentDelegationRecords).mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'delegation-1',
          parentSessionId: 'session-parent',
          childSessionId: 'session-child',
          parentRunId: 'run-parent',
          agentProfileId: 'planner',
          delegatedGoal: 'Analyze shots',
          contextPacketJson: '{"goal":"Analyze shots"}',
          allowedToolsDeltaJson: null,
          permissionSnapshotJson: '{"scope":"narrow"}',
          status: 'requested',
          mergeStatus: 'pending',
          summaryMessageId: null,
          resultJson: null,
          errorMessage: null,
          createdAt: 100,
          updatedAt: 100,
          completedAt: null,
        },
      ],
    });
    vi.mocked(commands.listAgentPermissionDecisions).mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'decision-1',
          sessionId: 'session-parent',
          runId: 'run-parent',
          stepId: 'step-1',
          subjectType: 'tool',
          subject: 'timeline.clip.delete',
          action: 'ask',
          source: 'interactive_approval',
          reason: 'destructive',
          createdAt: 101,
        },
      ],
    });
    vi.mocked(commands.listAgentCompactions).mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'compaction-1',
          sessionId: 'session-parent',
          runId: 'run-parent',
          tier: 'summary',
          trigger: 'auto',
          summaryMessageId: 'summary-1',
          sourceMessageCount: 12,
          retainedMessageCount: 4,
          estimatedTokensSaved: 3000,
          continuationSummaryJson: '{"summary":"trimmed"}',
          stateRehydrationJson: '{"resume":"cursor"}',
          createdAt: 102,
        },
      ],
    });
    vi.mocked(commands.listAgentResumeCheckpoints).mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'checkpoint-1',
          sessionId: 'session-parent',
          runId: 'run-parent',
          checkpointKind: 'safe_resume_point',
          status: 'active',
          resumeCursorJson: '{"cursor":1}',
          sessionStateJson: '{"phase":"executing"}',
          pendingWorkJson: '{"step":"step-1"}',
          createdAt: 103,
          consumedAt: null,
        },
      ],
    });

    const backend = createAgentSessionBackend();
    const delegation = await backend.createDelegationRecord({
      parentSessionId: 'session-parent',
      childSessionId: 'session-child',
      parentRunId: 'run-parent',
      agentProfileId: 'planner',
      delegatedGoal: 'Analyze shots',
      contextPacketJson: '{"goal":"Analyze shots"}',
      permissionSnapshotJson: '{"scope":"narrow"}',
    });
    const decision = await backend.recordPermissionDecision({
      sessionId: 'session-parent',
      runId: 'run-parent',
      stepId: 'step-1',
      subjectType: 'tool',
      subject: 'timeline.clip.delete',
      action: 'ask',
      source: 'interactive_approval',
      reason: 'destructive',
      createdAt: 101,
    });
    const compaction = await backend.recordCompaction({
      sessionId: 'session-parent',
      runId: 'run-parent',
      tier: 'summary',
      trigger: 'auto',
      summaryMessageId: 'summary-1',
      sourceMessageCount: 12,
      retainedMessageCount: 4,
      estimatedTokensSaved: 3000,
      continuationSummaryJson: '{"summary":"trimmed"}',
      stateRehydrationJson: '{"resume":"cursor"}',
      createdAt: 102,
    });
    const checkpoint = await backend.createResumeCheckpoint({
      sessionId: 'session-parent',
      runId: 'run-parent',
      checkpointKind: 'safe_resume_point',
      resumeCursorJson: '{"cursor":1}',
      sessionStateJson: '{"phase":"executing"}',
      pendingWorkJson: '{"step":"step-1"}',
      createdAt: 103,
    });
    const consumedCheckpoint = await backend.consumeResumeCheckpoint('checkpoint-1');
    const delegations = await backend.listDelegationRecords('session-parent');
    const decisions = await backend.listPermissionDecisions('session-parent');
    const compactions = await backend.listCompactions('session-parent');
    const checkpoints = await backend.listResumeCheckpoints('session-parent');

    expect(commands.createAgentDelegationRecord).toHaveBeenCalledWith({
      id: null,
      parentSessionId: 'session-parent',
      childSessionId: 'session-child',
      parentRunId: 'run-parent',
      agentProfileId: 'planner',
      delegatedGoal: 'Analyze shots',
      contextPacketJson: '{"goal":"Analyze shots"}',
      allowedToolsDeltaJson: null,
      permissionSnapshotJson: '{"scope":"narrow"}',
      status: null,
      mergeStatus: null,
      summaryMessageId: null,
      resultJson: null,
      errorMessage: null,
      completedAt: null,
    });
    expect(commands.recordAgentPermissionDecision).toHaveBeenCalledWith({
      id: null,
      sessionId: 'session-parent',
      runId: 'run-parent',
      stepId: 'step-1',
      subjectType: 'tool',
      subject: 'timeline.clip.delete',
      action: 'ask',
      source: 'interactive_approval',
      reason: 'destructive',
      createdAt: 101,
    });
    expect(commands.recordAgentCompaction).toHaveBeenCalledWith({
      id: null,
      sessionId: 'session-parent',
      runId: 'run-parent',
      tier: 'summary',
      trigger: 'auto',
      summaryMessageId: 'summary-1',
      sourceMessageCount: 12,
      retainedMessageCount: 4,
      estimatedTokensSaved: 3000,
      continuationSummaryJson: '{"summary":"trimmed"}',
      stateRehydrationJson: '{"resume":"cursor"}',
      createdAt: 102,
    });
    expect(commands.createAgentResumeCheckpoint).toHaveBeenCalledWith({
      id: null,
      sessionId: 'session-parent',
      runId: 'run-parent',
      checkpointKind: 'safe_resume_point',
      status: null,
      resumeCursorJson: '{"cursor":1}',
      sessionStateJson: '{"phase":"executing"}',
      pendingWorkJson: '{"step":"step-1"}',
      createdAt: 103,
    });
    expect(commands.consumeAgentResumeCheckpoint).toHaveBeenCalledWith('checkpoint-1');

    expect(delegation.status).toBe('requested');
    expect(decision.source).toBe('interactive_approval');
    expect(compaction.tier).toBe('summary');
    expect(checkpoint.status).toBe('active');
    expect(consumedCheckpoint.status).toBe('consumed');
    expect(delegations[0].agentProfileId).toBe('planner');
    expect(decisions[0].action).toBe('ask');
    expect(compactions[0].estimatedTokensSaved).toBe(3000);
    expect(checkpoints[0].checkpointKind).toBe('safe_resume_point');

    expect(hydrateDelegationRecord({
      id: 'delegation-2',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child',
      parentRunId: 'run-parent',
      agentProfileId: 'planner',
      delegatedGoal: 'Analyze shots',
      contextPacketJson: '{}',
      allowedToolsDeltaJson: null,
      permissionSnapshotJson: null,
      status: 'running',
      mergeStatus: 'pending',
      summaryMessageId: null,
      resultJson: null,
      errorMessage: null,
      createdAt: 1,
      updatedAt: 2,
      completedAt: null,
    }).status).toBe('running');
    expect(hydratePermissionDecision({
      id: 'decision-2',
      sessionId: 'session-parent',
      runId: null,
      stepId: null,
      subjectType: 'delegation',
      subject: 'delegation.spawn',
      action: 'allow',
      source: 'session_rule',
      reason: null,
      createdAt: 1,
    }).subjectType).toBe('delegation');
    expect(hydrateCompactionRecord({
      id: 'compaction-2',
      sessionId: 'session-parent',
      runId: null,
      tier: 'prune',
      trigger: 'manual',
      summaryMessageId: null,
      sourceMessageCount: 3,
      retainedMessageCount: 2,
      estimatedTokensSaved: null,
      continuationSummaryJson: null,
      stateRehydrationJson: null,
      createdAt: 1,
    }).trigger).toBe('manual');
    expect(hydrateResumeCheckpoint({
      id: 'checkpoint-2',
      sessionId: 'session-parent',
      runId: null,
      checkpointKind: 'delegation_wait',
      status: 'active',
      resumeCursorJson: '{}',
      sessionStateJson: '{}',
      pendingWorkJson: null,
      createdAt: 1,
      consumedAt: null,
    }).checkpointKind).toBe('delegation_wait');
  });
});

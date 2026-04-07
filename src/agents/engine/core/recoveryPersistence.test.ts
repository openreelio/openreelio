import { describe, expect, it } from 'vitest';
import {
  buildCompactionTraceRecord,
  buildCompactionPayload,
  buildResumeCheckpointPayload,
  buildResumeCheckpointTraceRecord,
} from './recoveryPersistence';

describe('recoveryPersistence', () => {
  it('should build approval-wait checkpoint payloads with pending plan work', () => {
    const plan = {
      goal: 'Delete the target clip',
      steps: [
        {
          id: 'step-1',
          tool: 'delete_clip',
          args: { clipId: 'clip-1' },
          description: 'Delete clip-1 from the timeline',
          riskLevel: 'high' as const,
          estimatedDuration: 50,
        },
      ],
      estimatedTotalDuration: 50,
      requiresApproval: true,
      rollbackStrategy: 'Restore the deleted clip',
    };

    const payload = buildResumeCheckpointPayload({
      sessionId: 'session-1',
      runId: 'run-1',
      runtimeKind: 'tpao',
      checkpointKind: 'approval_wait',
      phase: 'awaiting_approval',
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      input: 'Delete clip 1',
      currentPlanId: 'plan-1',
      planGoal: 'Delete the target clip',
      planStepIds: ['step-1', 'step-2'],
      plan,
    });

    expect(JSON.parse(payload.resumeCursorJson)).toEqual({
      version: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      runtimeKind: 'tpao',
      checkpointKind: 'approval_wait',
      phase: 'awaiting_approval',
      stepId: null,
      toolName: null,
    });
    expect(JSON.parse(payload.sessionStateJson)).toEqual({
      version: 1,
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      projectStateVersion: null,
      phase: 'awaiting_approval',
      input: 'Delete clip 1',
      currentPlanId: 'plan-1',
      pendingApprovalId: null,
      planGoal: 'Delete the target clip',
      planStepIds: ['step-1', 'step-2'],
      summary: null,
      sourceMessageCount: null,
      retainedMessageCount: null,
      estimatedTokensSaved: null,
    });
    expect(JSON.parse(payload.pendingWorkJson ?? 'null')).toEqual({
      type: 'plan_approval',
      goal: 'Delete the target clip',
      stepIds: ['step-1', 'step-2'],
      plan,
    });
  });

  it('should build tool-wait checkpoint payloads with pending tool arguments', () => {
    const plan = {
      goal: 'Delete the selected clip',
      steps: [
        {
          id: 'step-1',
          tool: 'delete_clip',
          args: { clipId: 'clip-1' },
          description: 'Delete clip-1 from the timeline',
          riskLevel: 'high' as const,
          estimatedDuration: 60,
        },
      ],
      estimatedTotalDuration: 60,
      requiresApproval: false,
      rollbackStrategy: 'Restore the deleted clip',
    };

    const payload = buildResumeCheckpointPayload({
      sessionId: 'session-1',
      runId: 'run-1',
      runtimeKind: 'fast',
      checkpointKind: 'tool_wait',
      phase: 'awaiting_tool_permission',
      projectId: 'project-1',
      sequenceId: null,
      projectStateVersion: 7,
      input: 'Delete the selected clip',
      plan,
      nextStepIndex: 0,
      completedStepIds: [],
      toolCallsUsed: 0,
      stepId: 'tool-call-1',
      toolName: 'delete_clip',
      args: { clipId: 'clip-1' },
    });

    expect(JSON.parse(payload.pendingWorkJson ?? 'null')).toEqual({
      type: 'tool_permission',
      stepId: 'tool-call-1',
      toolName: 'delete_clip',
      args: { clipId: 'clip-1' },
      plan,
      nextStepIndex: 0,
      completedStepIds: [],
      toolCallsUsed: 0,
    });
  });

  it('should build compaction payloads with rehydration metadata', () => {
    const payload = buildCompactionPayload({
      sessionId: 'session-1',
      runId: 'run-1',
      runtimeKind: 'fast',
      trigger: 'auto',
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      input: 'Trim the intro',
      summary: 'Conversation compacted around the trim workflow.',
      sourceMessageCount: 24,
      retainedMessageCount: 5,
      estimatedTokensSaved: 6400,
    });

    expect(JSON.parse(payload.continuationSummaryJson)).toEqual({
      version: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      runtimeKind: 'fast',
      trigger: 'auto',
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      input: 'Trim the intro',
      summary: 'Conversation compacted around the trim workflow.',
      sourceMessageCount: 24,
      retainedMessageCount: 5,
      estimatedTokensSaved: 6400,
    });
    expect(JSON.parse(payload.stateRehydrationJson)).toEqual({
      version: 1,
      phase: 'compacting',
      sessionId: 'session-1',
      runId: 'run-1',
      runtimeKind: 'fast',
      summary: 'Conversation compacted around the trim workflow.',
      sourceMessageCount: 24,
      retainedMessageCount: 5,
      estimatedTokensSaved: 6400,
    });
  });

  it('should build normalized checkpoint trace records', () => {
    expect(
      buildResumeCheckpointTraceRecord({
        checkpointId: 'checkpoint-1',
        runId: 'run-1',
        checkpointKind: 'tool_wait',
        phase: 'awaiting_tool_permission',
        toolName: 'delete_clip',
        status: 'recovered',
        recordedAt: 44,
      }),
    ).toEqual({
      checkpointId: 'checkpoint-1',
      runId: 'run-1',
      checkpointKind: 'tool_wait',
      phase: 'awaiting_tool_permission',
      stepId: null,
      toolName: 'delete_clip',
      summary: null,
      status: 'recovered',
      recordedAt: 44,
    });
  });

  it('should build normalized compaction trace records', () => {
    expect(
      buildCompactionTraceRecord({
        compactionId: 'compaction-1',
        runId: 'run-1',
        tier: 'summary',
        trigger: 'auto',
        summary: 'Compacted around delete flow',
        sourceMessageCount: 12,
        retainedMessageCount: 4,
        estimatedTokensSaved: 3200,
        status: 'persisted',
        recordedAt: 55,
      }),
    ).toEqual({
      compactionId: 'compaction-1',
      runId: 'run-1',
      tier: 'summary',
      trigger: 'auto',
      summary: 'Compacted around delete flow',
      sourceMessageCount: 12,
      retainedMessageCount: 4,
      estimatedTokensSaved: 3200,
      status: 'persisted',
      recordedAt: 55,
    });
  });
});

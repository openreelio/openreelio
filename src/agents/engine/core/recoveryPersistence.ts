import type {
  AgentRuntimeKind,
  CompactionTrigger,
  CompactionTier,
  ResumeCheckpointKind,
} from './agentSession';
import type { Plan } from './types';
import type { CheckpointTraceRecord, CompactionTraceRecord } from './traceRecorder';

export interface RecoveryCheckpointPayloadInput {
  sessionId: string;
  runId: string | null;
  runtimeKind: AgentRuntimeKind;
  checkpointKind: ResumeCheckpointKind;
  phase: string;
  projectId: string;
  sequenceId: string | null;
  projectStateVersion?: number | null;
  input: string;
  currentPlanId?: string | null;
  pendingApprovalId?: string | null;
  planGoal?: string | null;
  planStepIds?: string[];
  plan?: Plan | null;
  nextStepIndex?: number | null;
  completedStepIds?: string[] | null;
  toolCallsUsed?: number | null;
  stepId?: string | null;
  toolName?: string | null;
  args?: Record<string, unknown> | null;
  summary?: string | null;
  sourceMessageCount?: number | null;
  retainedMessageCount?: number | null;
  estimatedTokensSaved?: number | null;
}

export interface RecoveryCompactionPayloadInput {
  sessionId: string;
  runId: string | null;
  runtimeKind: AgentRuntimeKind;
  trigger: CompactionTrigger;
  projectId: string;
  sequenceId: string | null;
  input: string;
  summary: string;
  sourceMessageCount: number;
  retainedMessageCount: number;
  estimatedTokensSaved?: number | null;
}

export interface PersistedRecoveryCheckpointPayload {
  resumeCursorJson: string;
  sessionStateJson: string;
  pendingWorkJson: string | null;
}

export interface PersistedCompactionPayload {
  continuationSummaryJson: string;
  stateRehydrationJson: string;
}

export interface ResumeCheckpointTraceRecordInput {
  checkpointId?: string | null;
  runId: string | null;
  checkpointKind: ResumeCheckpointKind;
  phase?: string | null;
  stepId?: string | null;
  toolName?: string | null;
  summary?: string | null;
  status?: CheckpointTraceRecord['status'];
  recordedAt?: number;
}

export interface CompactionTraceRecordInput {
  compactionId?: string | null;
  runId: string | null;
  tier: CompactionTier;
  trigger: CompactionTrigger;
  summary?: string | null;
  sourceMessageCount: number;
  retainedMessageCount: number;
  estimatedTokensSaved?: number | null;
  status?: CompactionTraceRecord['status'];
  recordedAt?: number;
}

export function buildResumeCheckpointPayload(
  input: RecoveryCheckpointPayloadInput,
): PersistedRecoveryCheckpointPayload {
  const resumeCursor = {
    version: 1,
    sessionId: input.sessionId,
    runId: input.runId,
    runtimeKind: input.runtimeKind,
    checkpointKind: input.checkpointKind,
    phase: input.phase,
    stepId: input.stepId ?? null,
    toolName: input.toolName ?? null,
  };
  const sessionState = {
    version: 1,
    projectId: input.projectId,
    sequenceId: input.sequenceId,
    projectStateVersion: input.projectStateVersion ?? null,
    phase: input.phase,
    input: input.input,
    currentPlanId: input.currentPlanId ?? null,
    pendingApprovalId: input.pendingApprovalId ?? null,
    planGoal: input.planGoal ?? null,
    planStepIds: input.planStepIds ?? [],
    summary: input.summary ?? null,
    sourceMessageCount: input.sourceMessageCount ?? null,
    retainedMessageCount: input.retainedMessageCount ?? null,
    estimatedTokensSaved: input.estimatedTokensSaved ?? null,
  };

  let pendingWorkJson: string | null = null;
  if (input.checkpointKind === 'approval_wait') {
    pendingWorkJson = JSON.stringify({
      type: 'plan_approval',
      goal: input.planGoal ?? null,
      stepIds: input.planStepIds ?? [],
      plan: input.plan ?? null,
    });
  } else if (input.checkpointKind === 'tool_wait') {
    pendingWorkJson = JSON.stringify({
      type: 'tool_permission',
      stepId: input.stepId ?? null,
      toolName: input.toolName ?? null,
      args: input.args ?? null,
      plan: input.plan ?? null,
      nextStepIndex: input.nextStepIndex ?? null,
      completedStepIds: input.completedStepIds ?? null,
      toolCallsUsed: input.toolCallsUsed ?? null,
    });
  } else if (input.checkpointKind === 'compaction_boundary') {
    pendingWorkJson = JSON.stringify({
      type: 'compaction_resume',
      summary: input.summary ?? null,
      sourceMessageCount: input.sourceMessageCount ?? null,
      retainedMessageCount: input.retainedMessageCount ?? null,
    });
  }

  return {
    resumeCursorJson: JSON.stringify(resumeCursor),
    sessionStateJson: JSON.stringify(sessionState),
    pendingWorkJson,
  };
}

export function buildCompactionPayload(
  input: RecoveryCompactionPayloadInput,
): PersistedCompactionPayload {
  const continuationSummary = {
    version: 1,
    sessionId: input.sessionId,
    runId: input.runId,
    runtimeKind: input.runtimeKind,
    trigger: input.trigger,
    projectId: input.projectId,
    sequenceId: input.sequenceId,
    input: input.input,
    summary: input.summary,
    sourceMessageCount: input.sourceMessageCount,
    retainedMessageCount: input.retainedMessageCount,
    estimatedTokensSaved: input.estimatedTokensSaved ?? null,
  };

  const rehydrationState = {
    version: 1,
    phase: 'compacting',
    sessionId: input.sessionId,
    runId: input.runId,
    runtimeKind: input.runtimeKind,
    summary: input.summary,
    sourceMessageCount: input.sourceMessageCount,
    retainedMessageCount: input.retainedMessageCount,
    estimatedTokensSaved: input.estimatedTokensSaved ?? null,
  };

  return {
    continuationSummaryJson: JSON.stringify(continuationSummary),
    stateRehydrationJson: JSON.stringify(rehydrationState),
  };
}

export function buildResumeCheckpointTraceRecord(
  input: ResumeCheckpointTraceRecordInput,
): CheckpointTraceRecord {
  return {
    checkpointId: input.checkpointId ?? null,
    runId: input.runId,
    checkpointKind: input.checkpointKind,
    phase: input.phase ?? null,
    stepId: input.stepId ?? null,
    toolName: input.toolName ?? null,
    summary: input.summary ?? null,
    status: input.status ?? 'persisted',
    recordedAt: input.recordedAt ?? Date.now(),
  };
}

export function buildCompactionTraceRecord(
  input: CompactionTraceRecordInput,
): CompactionTraceRecord {
  return {
    compactionId: input.compactionId ?? null,
    runId: input.runId,
    tier: input.tier,
    trigger: input.trigger,
    summary: input.summary ?? null,
    sourceMessageCount: input.sourceMessageCount,
    retainedMessageCount: input.retainedMessageCount,
    estimatedTokensSaved: input.estimatedTokensSaved ?? null,
    status: input.status ?? 'persisted',
    recordedAt: input.recordedAt ?? Date.now(),
  };
}

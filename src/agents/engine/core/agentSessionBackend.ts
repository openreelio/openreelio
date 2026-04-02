import {
  commands,
  type AgentRunDto,
  type AgentSessionDetailDto,
  type AgentSessionDto,
  type CompactionRecordDto,
  type DelegationRecordDto,
  type PermissionDecisionDto,
  type ResumeCheckpointDto,
} from '@/bindings';
import {
  createAgentRun as buildAgentRun,
  createAgentSession as buildAgentSession,
  type AgentRun,
  type AgentRunPhase,
  type AgentRunTrigger,
  type AgentRuntimeKind,
  type AgentSession,
  type AgentSessionMode,
  type AgentSessionStatus,
  type CompactionRecord,
  type CompactionTier,
  type CompactionTrigger,
  type CreateAgentRunInput,
  type CreateAgentSessionInput,
  type DelegationMergeStatus,
  type DelegationRecord,
  type DelegationStatus,
  type PermissionDecision,
  type PermissionDecisionAction,
  type PermissionDecisionSource,
  type PermissionSubjectType,
  type ResumeCheckpoint,
  type ResumeCheckpointKind,
  type ResumeCheckpointStatus,
} from './agentSession';

type CommandResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'error'; error: string };

export interface AgentSessionSnapshot {
  session: AgentSession;
  runs: AgentRun[];
}

export interface StartPersistedAgentRunInput extends CreateAgentRunInput {
  plannedStepCount?: number;
  traceId?: string | null;
}

export interface UpdatePersistedAgentRunPhaseInput {
  runId: string;
  phase: AgentRunPhase;
  toolCallsUsed?: number;
  plannedStepCount?: number;
  completedStepCount?: number;
  outputMessageId?: string | null;
  rollbackReportJson?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  currentPlanId?: string | null;
  pendingApprovalId?: string | null;
  activeCheckpointId?: string | null;
  permissionStateVersion?: number;
  compactionVersion?: number;
  resumeCursorVersion?: number;
  lastCompactedAt?: number | null;
  lastResumedAt?: number | null;
  endedAt?: number | null;
}

export interface CreatePersistedDelegationRecordInput {
  parentSessionId: string;
  childSessionId: string;
  parentRunId: string;
  agentProfileId: string;
  delegatedGoal: string;
  contextPacketJson: string;
  allowedToolsDeltaJson?: string | null;
  permissionSnapshotJson?: string | null;
  status?: DelegationStatus;
  mergeStatus?: DelegationMergeStatus;
  summaryMessageId?: string | null;
  resultJson?: string | null;
  errorMessage?: string | null;
  completedAt?: number | null;
  id?: string;
}

export interface UpdatePersistedDelegationRecordInput {
  id: string;
  status?: DelegationStatus;
  mergeStatus?: DelegationMergeStatus;
  summaryMessageId?: string | null;
  resultJson?: string | null;
  errorMessage?: string | null;
  completedAt?: number | null;
}

export interface CreatePersistedPermissionDecisionInput {
  sessionId: string;
  runId?: string | null;
  stepId?: string | null;
  subjectType: PermissionSubjectType;
  subject: string;
  action: PermissionDecisionAction;
  source: PermissionDecisionSource;
  reason?: string | null;
  createdAt?: number;
  id?: string;
}

export interface CreatePersistedCompactionInput {
  sessionId: string;
  runId?: string | null;
  tier: CompactionTier;
  trigger: CompactionTrigger;
  summaryMessageId?: string | null;
  sourceMessageCount: number;
  retainedMessageCount: number;
  estimatedTokensSaved?: number | null;
  continuationSummaryJson?: string | null;
  stateRehydrationJson?: string | null;
  createdAt?: number;
  id?: string;
}

export interface CreatePersistedResumeCheckpointInput {
  sessionId: string;
  runId?: string | null;
  checkpointKind: ResumeCheckpointKind;
  status?: ResumeCheckpointStatus;
  resumeCursorJson: string;
  sessionStateJson: string;
  pendingWorkJson?: string | null;
  createdAt?: number;
  id?: string;
}

function unwrapResult<T>(result: CommandResult<T>): T {
  if (result.status === 'error') {
    throw new Error(result.error);
  }

  return result.data;
}

function nullable<T>(value: T | undefined): T | null {
  return value ?? null;
}

export function hydrateAgentSession(dto: AgentSessionDto): AgentSession {
  return {
    id: dto.id,
    projectId: dto.projectId,
    sequenceId: dto.sequenceId,
    title: dto.title,
    status: dto.status as AgentSessionStatus,
    runtimeKind: dto.runtimeKind as AgentRuntimeKind,
    agentProfileId: dto.agentProfileId,
    sessionMode: dto.sessionMode as AgentSessionMode,
    lineage: {
      parentSessionId: dto.lineage.parentSessionId,
      branchFromSessionId: dto.lineage.branchFromSessionId,
      rootSessionId: dto.lineage.rootSessionId,
    },
    currentRunId: dto.currentRunId,
    currentPlanId: dto.currentPlanId,
    pendingApprovalId: dto.pendingApprovalId,
    activeCheckpointId: dto.activeCheckpointId,
    permissionStateVersion: dto.permissionStateVersion,
    compactionVersion: dto.compactionVersion,
    resumeCursorVersion: dto.resumeCursorVersion,
    latestSummaryMessageId: dto.latestSummaryMessageId,
    lastCompactedAt: dto.lastCompactedAt,
    lastResumedAt: dto.lastResumedAt,
    modelProvider: dto.modelProvider,
    modelId: dto.modelId,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    completedAt: dto.completedAt,
  };
}

export function hydrateAgentRun(dto: AgentRunDto): AgentRun {
  return {
    id: dto.id,
    sessionId: dto.sessionId,
    runtimeKind: dto.runtimeKind as AgentRuntimeKind,
    trigger: dto.trigger as AgentRunTrigger,
    inputMessageId: dto.inputMessageId,
    outputMessageId: dto.outputMessageId,
    phase: dto.phase as AgentRunPhase,
    iteration: dto.iteration,
    maxIterations: dto.maxIterations,
    toolCallsUsed: dto.toolCallsUsed,
    maxToolCalls: dto.maxToolCalls,
    plannedStepCount: dto.plannedStepCount,
    completedStepCount: dto.completedStepCount,
    traceId: dto.traceId,
    rollbackReportJson: dto.rollbackReportJson,
    errorCode: dto.errorCode,
    errorMessage: dto.errorMessage,
    startedAt: dto.startedAt,
    updatedAt: dto.updatedAt,
    endedAt: dto.endedAt,
  };
}

export function hydrateDelegationRecord(dto: DelegationRecordDto): DelegationRecord {
  return {
    id: dto.id,
    parentSessionId: dto.parentSessionId,
    childSessionId: dto.childSessionId,
    parentRunId: dto.parentRunId,
    agentProfileId: dto.agentProfileId,
    delegatedGoal: dto.delegatedGoal,
    contextPacketJson: dto.contextPacketJson,
    allowedToolsDeltaJson: dto.allowedToolsDeltaJson,
    permissionSnapshotJson: dto.permissionSnapshotJson,
    status: dto.status as DelegationStatus,
    mergeStatus: dto.mergeStatus as DelegationMergeStatus,
    summaryMessageId: dto.summaryMessageId,
    resultJson: dto.resultJson,
    errorMessage: dto.errorMessage,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    completedAt: dto.completedAt,
  };
}

export function hydratePermissionDecision(dto: PermissionDecisionDto): PermissionDecision {
  return {
    id: dto.id,
    sessionId: dto.sessionId,
    runId: dto.runId,
    stepId: dto.stepId,
    subjectType: dto.subjectType as PermissionSubjectType,
    subject: dto.subject,
    action: dto.action as PermissionDecisionAction,
    source: dto.source as PermissionDecisionSource,
    reason: dto.reason,
    createdAt: dto.createdAt,
  };
}

export function hydrateCompactionRecord(dto: CompactionRecordDto): CompactionRecord {
  return {
    id: dto.id,
    sessionId: dto.sessionId,
    runId: dto.runId,
    tier: dto.tier as CompactionTier,
    trigger: dto.trigger as CompactionTrigger,
    summaryMessageId: dto.summaryMessageId,
    sourceMessageCount: dto.sourceMessageCount,
    retainedMessageCount: dto.retainedMessageCount,
    estimatedTokensSaved: dto.estimatedTokensSaved,
    continuationSummaryJson: dto.continuationSummaryJson,
    stateRehydrationJson: dto.stateRehydrationJson,
    createdAt: dto.createdAt,
  };
}

export function hydrateResumeCheckpoint(dto: ResumeCheckpointDto): ResumeCheckpoint {
  return {
    id: dto.id,
    sessionId: dto.sessionId,
    runId: dto.runId,
    checkpointKind: dto.checkpointKind as ResumeCheckpointKind,
    status: dto.status as ResumeCheckpointStatus,
    resumeCursorJson: dto.resumeCursorJson,
    sessionStateJson: dto.sessionStateJson,
    pendingWorkJson: dto.pendingWorkJson,
    createdAt: dto.createdAt,
    consumedAt: dto.consumedAt,
  };
}

export function hydrateAgentSessionSnapshot(dto: AgentSessionDetailDto): AgentSessionSnapshot {
  return {
    session: hydrateAgentSession(dto.session),
    runs: dto.runs.map(hydrateAgentRun),
  };
}

export class AgentSessionBackend {
  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    const session = buildAgentSession(input);
    const result = await commands.createAgentSession({
      projectId: session.projectId,
      sequenceId: nullable(session.sequenceId),
      title: session.title,
      runtimeKind: session.runtimeKind,
      agentProfileId: session.agentProfileId,
      sessionMode: session.sessionMode,
      parentSessionId: nullable(session.lineage.parentSessionId),
      branchFromSessionId: nullable(session.lineage.branchFromSessionId),
      rootSessionId: session.lineage.rootSessionId,
      modelProvider: nullable(session.modelProvider),
      modelId: nullable(session.modelId),
      id: session.id,
    });

    return hydrateAgentSession(unwrapResult(result));
  }

  async getSession(sessionId: string): Promise<AgentSessionSnapshot> {
    const result = await commands.getAgentSession(sessionId);
    return hydrateAgentSessionSnapshot(unwrapResult(result));
  }

  async startRun(input: StartPersistedAgentRunInput): Promise<AgentRun> {
    const run = buildAgentRun(input);
    const result = await commands.startAgentRun({
      sessionId: run.sessionId,
      runtimeKind: run.runtimeKind,
      trigger: run.trigger,
      maxIterations: run.maxIterations,
      maxToolCalls: run.maxToolCalls,
      plannedStepCount: input.plannedStepCount ?? run.plannedStepCount,
      inputMessageId: nullable(run.inputMessageId),
      traceId: nullable(input.traceId ?? run.traceId),
      id: run.id,
    });

    return hydrateAgentRun(unwrapResult(result));
  }

  async updateRunPhase(input: UpdatePersistedAgentRunPhaseInput): Promise<AgentRun> {
    const result = await commands.updateAgentRunPhase({
      runId: input.runId,
      phase: input.phase,
      toolCallsUsed: input.toolCallsUsed ?? null,
      plannedStepCount: input.plannedStepCount ?? null,
      completedStepCount: input.completedStepCount ?? null,
      outputMessageId: nullable(input.outputMessageId),
      rollbackReportJson: nullable(input.rollbackReportJson),
      errorCode: nullable(input.errorCode),
      errorMessage: nullable(input.errorMessage),
      currentPlanId: nullable(input.currentPlanId),
      pendingApprovalId: nullable(input.pendingApprovalId),
      activeCheckpointId: nullable(input.activeCheckpointId),
      permissionStateVersion: input.permissionStateVersion ?? null,
      compactionVersion: input.compactionVersion ?? null,
      resumeCursorVersion: input.resumeCursorVersion ?? null,
      lastCompactedAt: input.lastCompactedAt ?? null,
      lastResumedAt: input.lastResumedAt ?? null,
      endedAt: input.endedAt ?? null,
    });

    return hydrateAgentRun(unwrapResult(result));
  }

  async createDelegationRecord(
    input: CreatePersistedDelegationRecordInput,
  ): Promise<DelegationRecord> {
    const result = await commands.createAgentDelegationRecord({
      id: input.id ?? null,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      parentRunId: input.parentRunId,
      agentProfileId: input.agentProfileId,
      delegatedGoal: input.delegatedGoal,
      contextPacketJson: input.contextPacketJson,
      allowedToolsDeltaJson: nullable(input.allowedToolsDeltaJson),
      permissionSnapshotJson: nullable(input.permissionSnapshotJson),
      status: input.status ?? null,
      mergeStatus: input.mergeStatus ?? null,
      summaryMessageId: nullable(input.summaryMessageId),
      resultJson: nullable(input.resultJson),
      errorMessage: nullable(input.errorMessage),
      completedAt: input.completedAt ?? null,
    });

    return hydrateDelegationRecord(unwrapResult(result));
  }

  async updateDelegationRecord(
    input: UpdatePersistedDelegationRecordInput,
  ): Promise<DelegationRecord> {
    const result = await commands.updateAgentDelegationRecord({
      id: input.id,
      status: input.status ?? null,
      mergeStatus: input.mergeStatus ?? null,
      summaryMessageId: nullable(input.summaryMessageId),
      resultJson: nullable(input.resultJson),
      errorMessage: nullable(input.errorMessage),
      completedAt: input.completedAt ?? null,
    });

    return hydrateDelegationRecord(unwrapResult(result));
  }

  async listDelegationRecords(sessionId: string): Promise<DelegationRecord[]> {
    const result = await commands.listAgentDelegationRecords(sessionId);
    return unwrapResult(result).map(hydrateDelegationRecord);
  }

  async recordPermissionDecision(
    input: CreatePersistedPermissionDecisionInput,
  ): Promise<PermissionDecision> {
    const result = await commands.recordAgentPermissionDecision({
      id: input.id ?? null,
      sessionId: input.sessionId,
      runId: nullable(input.runId),
      stepId: nullable(input.stepId),
      subjectType: input.subjectType,
      subject: input.subject,
      action: input.action,
      source: input.source,
      reason: nullable(input.reason),
      createdAt: input.createdAt ?? null,
    });

    return hydratePermissionDecision(unwrapResult(result));
  }

  async listPermissionDecisions(sessionId: string): Promise<PermissionDecision[]> {
    const result = await commands.listAgentPermissionDecisions(sessionId);
    return unwrapResult(result).map(hydratePermissionDecision);
  }

  async recordCompaction(input: CreatePersistedCompactionInput): Promise<CompactionRecord> {
    const result = await commands.recordAgentCompaction({
      id: input.id ?? null,
      sessionId: input.sessionId,
      runId: nullable(input.runId),
      tier: input.tier,
      trigger: input.trigger,
      summaryMessageId: nullable(input.summaryMessageId),
      sourceMessageCount: input.sourceMessageCount,
      retainedMessageCount: input.retainedMessageCount,
      estimatedTokensSaved: input.estimatedTokensSaved ?? null,
      continuationSummaryJson: nullable(input.continuationSummaryJson),
      stateRehydrationJson: nullable(input.stateRehydrationJson),
      createdAt: input.createdAt ?? null,
    });

    return hydrateCompactionRecord(unwrapResult(result));
  }

  async listCompactions(sessionId: string): Promise<CompactionRecord[]> {
    const result = await commands.listAgentCompactions(sessionId);
    return unwrapResult(result).map(hydrateCompactionRecord);
  }

  async createResumeCheckpoint(
    input: CreatePersistedResumeCheckpointInput,
  ): Promise<ResumeCheckpoint> {
    const result = await commands.createAgentResumeCheckpoint({
      id: input.id ?? null,
      sessionId: input.sessionId,
      runId: nullable(input.runId),
      checkpointKind: input.checkpointKind,
      status: input.status ?? null,
      resumeCursorJson: input.resumeCursorJson,
      sessionStateJson: input.sessionStateJson,
      pendingWorkJson: nullable(input.pendingWorkJson),
      createdAt: input.createdAt ?? null,
    });

    return hydrateResumeCheckpoint(unwrapResult(result));
  }

  async consumeResumeCheckpoint(checkpointId: string): Promise<ResumeCheckpoint> {
    const result = await commands.consumeAgentResumeCheckpoint(checkpointId);
    return hydrateResumeCheckpoint(unwrapResult(result));
  }

  async listResumeCheckpoints(sessionId: string): Promise<ResumeCheckpoint[]> {
    const result = await commands.listAgentResumeCheckpoints(sessionId);
    return unwrapResult(result).map(hydrateResumeCheckpoint);
  }
}

export function createAgentSessionBackend(): AgentSessionBackend {
  return new AgentSessionBackend();
}

import type {
  AgentContext,
  AgentRunPhase,
  AgentRuntimeKind,
  CompactionRecord,
  ILLMClient,
  ResumeCheckpoint,
  ShippingAgentRuntimeKind,
} from '@/agents/engine';
import {
  buildCompactionTraceRecord,
  buildResumeCheckpointPayload,
  buildResumeCheckpointTraceRecord,
} from '@/agents/engine/core/recoveryPersistence';
import { hydratePersistedPermissionRules } from '@/agents/engine/core/permissionAudit';
import type {
  CheckpointTraceRecord,
  CompactionTraceRecord,
} from '@/agents/engine/core/traceRecorder';
import type { ConversationStore } from '@/stores/conversationStore';
import {
  buildAgentSessionRecoveryFingerprint,
  useAgentSessionStore,
} from '@/stores/agentSessionStore';

type WarnLogger = {
  warn: (message: string, context?: Record<string, unknown>) => void;
};

type PersistedRunIdRef = {
  current: string | null;
};

type ResumeCheckpointInput = Parameters<typeof buildResumeCheckpointPayload>[0];

export interface ResumeCheckpointController {
  persistCheckpoint: (input: ResumeCheckpointInput) => Promise<string | null>;
  consumeCheckpoint: (checkpointId: string | null) => Promise<void>;
}

type CheckpointIdRef = {
  current: string | null;
};

type RecoveryBootstrapBoundary =
  {
    boundaryId: string;
    message: string;
    kind: 'checkpoint';
    traceRecord: CheckpointTraceRecord;
  }
  | {
    boundaryId: string;
    message: string;
    kind: 'summary';
    traceRecord: CompactionTraceRecord;
  };

export async function ensureConfiguredProvider(
  llmClient: ILLMClient,
  logger: WarnLogger,
  loggerLabel: string,
): Promise<boolean> {
  if (typeof llmClient.isConfigured !== 'function' || llmClient.isConfigured()) {
    return true;
  }

  const refreshableClient = llmClient as ILLMClient & {
    refreshStatus?: () => Promise<{ isConfigured: boolean }>;
  };

  if (typeof refreshableClient.refreshStatus === 'function') {
    try {
      await refreshableClient.refreshStatus();
    } catch (error) {
      logger.warn(`Failed to refresh ${loggerLabel} provider status before run`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return llmClient.isConfigured();
}

export async function ensureConversationSessionId(
  store: Pick<ConversationStore, 'activeSessionId' | 'ensureSession'>,
): Promise<string | null> {
  return store.activeSessionId ?? await store.ensureSession();
}

export function createResumeCheckpointController(input: {
  sessionId: string;
  persistedRunIdRef: PersistedRunIdRef;
  logger: WarnLogger;
  loggerLabel: string;
  onCheckpointPersisted?: (record: CheckpointTraceRecord) => void;
  onCheckpointConsumed?: (record: CheckpointTraceRecord) => void;
}): ResumeCheckpointController {
  const {
    sessionId,
    persistedRunIdRef,
    logger,
    loggerLabel,
    onCheckpointPersisted,
    onCheckpointConsumed,
  } = input;
  const checkpointInputsById = new Map<string, ResumeCheckpointInput>();

  return {
    persistCheckpoint: async (checkpointInput) => {
      try {
        const agentSessionStore = useAgentSessionStore.getState();
        const sessionSnapshot = agentSessionStore.snapshotsById[sessionId]?.session;
        const runId = checkpointInput.runId ?? persistedRunIdRef.current;
        const payload = buildResumeCheckpointPayload({
          ...checkpointInput,
          runId,
          currentPlanId: sessionSnapshot?.currentPlanId ?? null,
          pendingApprovalId: sessionSnapshot?.pendingApprovalId ?? null,
        });
        const checkpoint = await agentSessionStore.createResumeCheckpoint({
          sessionId,
          runId,
          checkpointKind: checkpointInput.checkpointKind,
          ...payload,
        });
        checkpointInputsById.set(checkpoint.id, checkpointInput);
        onCheckpointPersisted?.(
          buildResumeCheckpointTraceRecord({
            checkpointId: checkpoint.id,
            runId,
            checkpointKind: checkpointInput.checkpointKind,
            phase: checkpointInput.phase,
            stepId: checkpointInput.stepId ?? null,
            toolName: checkpointInput.toolName ?? null,
            summary: checkpointInput.summary ?? null,
            status: 'persisted',
            recordedAt: checkpoint.createdAt,
          }),
        );

        return checkpoint.id;
      } catch (error) {
        logger.warn(`Failed to persist ${loggerLabel} recovery checkpoint`, {
          sessionId,
          checkpointKind: checkpointInput.checkpointKind,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    consumeCheckpoint: async (checkpointId) => {
      if (!checkpointId) {
        return;
      }

      try {
        await useAgentSessionStore.getState().consumeResumeCheckpoint(checkpointId);
        const checkpointInput = checkpointInputsById.get(checkpointId);
        if (checkpointInput) {
          onCheckpointConsumed?.(
            buildResumeCheckpointTraceRecord({
              checkpointId,
              runId: checkpointInput.runId ?? persistedRunIdRef.current,
              checkpointKind: checkpointInput.checkpointKind,
              phase: checkpointInput.phase,
              stepId: checkpointInput.stepId ?? null,
              toolName: checkpointInput.toolName ?? null,
              summary: checkpointInput.summary ?? null,
              status: 'consumed',
            }),
          );
          checkpointInputsById.delete(checkpointId);
        }
      } catch (error) {
        logger.warn(`Failed to consume ${loggerLabel} recovery checkpoint`, {
          sessionId,
          checkpointId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export async function bootstrapPersistedAgentSession(input: {
  sessionId: string;
  projectId: string | null | undefined;
  sequenceId: string | null;
  runtimeKind: ShippingAgentRuntimeKind;
  modelProvider?: string | null;
  modelId?: string | null;
  logger: WarnLogger;
  loggerLabel: string;
}): Promise<void> {
  const {
    sessionId,
    projectId,
    sequenceId,
    runtimeKind,
    modelProvider = null,
    modelId = null,
    logger,
    loggerLabel,
  } = input;

  if (!projectId) {
    return;
  }

  const agentSessionStore = useAgentSessionStore.getState();
  agentSessionStore.loadForProject(projectId);

  try {
    await agentSessionStore.ensureSession({
      id: sessionId,
      projectId,
      sequenceId,
      runtimeKind,
      sessionMode: 'primary',
      agentProfileId: 'editor',
      modelProvider,
      modelId,
    });
  } catch (error) {
    logger.warn(`Failed to ensure persisted ${loggerLabel} session`, {
      sessionId,
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await hydratePersistedPermissionRules(sessionId);
  } catch (error) {
    logger.warn(`Failed to replay persisted ${loggerLabel} permissions`, {
      sessionId,
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startPersistedRun(input: {
  sessionId: string;
  runtimeKind: AgentRuntimeKind;
  maxIterations?: number;
  maxToolCalls?: number;
  traceId?: string | null;
  runInput: string;
  context: AgentContext;
  checkpointController: ResumeCheckpointController;
  persistedRunIdRef: PersistedRunIdRef;
  logger: WarnLogger;
  loggerLabel: string;
}): Promise<string | null> {
  const {
    sessionId,
    runtimeKind,
    maxIterations,
    maxToolCalls,
    traceId,
    runInput,
    context,
    checkpointController,
    persistedRunIdRef,
    logger,
    loggerLabel,
  } = input;

  try {
    const persistedRun = await useAgentSessionStore.getState().startRun({
      sessionId,
      runtimeKind,
      trigger: 'user',
      maxIterations,
      maxToolCalls,
      traceId,
    });

    persistedRunIdRef.current = persistedRun.id;
    await checkpointController.persistCheckpoint({
      sessionId,
      runId: persistedRun.id,
      runtimeKind,
      checkpointKind: 'safe_resume_point',
      phase: 'initializing',
      projectId: context.projectId,
      sequenceId: context.sequenceId ?? null,
      input: runInput,
    });

    return persistedRun.id;
  } catch (error) {
    persistedRunIdRef.current = null;
    logger.warn(`Failed to create persisted ${loggerLabel} run`, {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function finalizePersistedRun(input: {
  sessionId: string;
  runId: string;
  phase: AgentRunPhase;
  traceId?: string | null;
  toolCallsUsed: number;
  plannedStepCount?: number;
  completedStepCount?: number;
  rollbackReportJson?: string | null;
  errorMessage: string | null;
  logger: WarnLogger;
  loggerLabel: string;
  reportIssue?: (input: {
    sessionId: string;
    stage: 'run_finalize';
    error: unknown;
  }) => void;
}): Promise<void> {
  const {
    sessionId,
    runId,
    phase,
    traceId,
    toolCallsUsed,
    plannedStepCount,
    completedStepCount,
    rollbackReportJson,
    errorMessage,
    logger,
    loggerLabel,
    reportIssue,
  } = input;

  try {
    await useAgentSessionStore.getState().updateRunPhase({
      runId,
      phase,
      traceId,
      toolCallsUsed,
      plannedStepCount,
      completedStepCount,
      rollbackReportJson,
      errorMessage,
      endedAt: Date.now(),
    });
  } catch (error) {
    reportIssue?.({
      sessionId,
      stage: 'run_finalize',
      error,
    });
    logger.warn(`Failed to finalize persisted ${loggerLabel} run`, {
      runId,
      phase,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function bootstrapRecoveredContextFromCheckpoint(input: {
  sessionId: string;
  addSystemMessage: ConversationStore['addSystemMessage'];
  logger: WarnLogger;
  loggerLabel: string;
  lastBootstrappedCheckpointIdRef: CheckpointIdRef;
  onCheckpointRecovered?: (record: CheckpointTraceRecord) => void;
  onCompactionRecovered?: (record: CompactionTraceRecord) => void;
}): Promise<void> {
  const {
    sessionId,
    addSystemMessage,
    logger,
    loggerLabel,
    lastBootstrappedCheckpointIdRef,
    onCheckpointRecovered,
    onCompactionRecovered,
  } = input;
  const agentSessionStore = useAgentSessionStore.getState();
  const session = agentSessionStore.snapshotsById[sessionId]?.session;

  if (!session) {
    return;
  }

  try {
    await agentSessionStore.refreshRecoveryArtifacts(sessionId, {
      headerFingerprint: buildAgentSessionRecoveryFingerprint(session),
    });
  } catch (error) {
    logger.warn(`Failed to refresh ${loggerLabel} recovery artifacts before bootstrap`, {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const refreshedSession = useAgentSessionStore.getState().snapshotsById[sessionId]?.session;
  const compactions =
    useAgentSessionStore.getState().recoveryArtifactsBySessionId[sessionId]?.compactions ?? [];
  const checkpoints =
    useAgentSessionStore.getState().recoveryArtifactsBySessionId[sessionId]?.checkpoints ?? [];
  const bootstrapBoundary = resolveRecoveryBootstrapBoundary(
    refreshedSession ?? session,
    checkpoints,
    compactions,
  );

  if (
    !bootstrapBoundary
    || bootstrapBoundary.boundaryId === lastBootstrappedCheckpointIdRef.current
  ) {
    return;
  }

  addSystemMessage(bootstrapBoundary.message);
  if (bootstrapBoundary.kind === 'checkpoint') {
    onCheckpointRecovered?.(bootstrapBoundary.traceRecord);
  } else {
    onCompactionRecovered?.(bootstrapBoundary.traceRecord);
  }
  lastBootstrappedCheckpointIdRef.current = bootstrapBoundary.boundaryId;
}

export function getPersistedSessionTraceState(sessionId: string): {
  permissionStateVersion: number | null;
  compactionVersion: number | null;
  resumeCursorVersion: number | null;
  activeCheckpointId: string | null;
  latestSummaryMessageId: string | null;
} {
  const session = useAgentSessionStore.getState().snapshotsById[sessionId]?.session;
  if (!session) {
    return {
      permissionStateVersion: null,
      compactionVersion: null,
      resumeCursorVersion: null,
      activeCheckpointId: null,
      latestSummaryMessageId: null,
    };
  }

  return {
    permissionStateVersion: session.permissionStateVersion,
    compactionVersion: session.compactionVersion,
    resumeCursorVersion: session.resumeCursorVersion,
    activeCheckpointId: session.activeCheckpointId,
    latestSummaryMessageId: session.latestSummaryMessageId,
  };
}

function resolveRecoveryBootstrapBoundary(
  session: { activeCheckpointId: string | null },
  checkpoints: ResumeCheckpoint[],
  compactions: CompactionRecord[],
): RecoveryBootstrapBoundary | null {
  const activeCheckpoint = resolveActiveCheckpoint(session, checkpoints);
  if (activeCheckpoint) {
    const message = buildRecoveredCheckpointMessage(activeCheckpoint);
    if (!message) {
      return null;
    }
    const resumeCursor = parseJson<Record<string, unknown>>(activeCheckpoint.resumeCursorJson);
    const sessionState = parseJson<Record<string, unknown>>(activeCheckpoint.sessionStateJson);

    return {
      boundaryId: `checkpoint:${activeCheckpoint.id}`,
      kind: 'checkpoint',
      message,
      traceRecord: buildResumeCheckpointTraceRecord({
        checkpointId: activeCheckpoint.id,
        runId: activeCheckpoint.runId,
        checkpointKind: activeCheckpoint.checkpointKind,
        phase: stringValue(resumeCursor?.phase) ?? stringValue(sessionState?.phase),
        stepId: stringValue(resumeCursor?.stepId),
        toolName: stringValue(resumeCursor?.toolName),
        summary: stringValue(sessionState?.summary),
        status: 'recovered',
      }),
    };
  }

  const latestSummaryCompaction = resolveLatestSummaryCompaction(compactions);
  if (!latestSummaryCompaction) {
    return null;
  }

  const message = buildRecoveredCompactionMessage(latestSummaryCompaction);
  if (!message) {
    return null;
  }

  return {
    boundaryId: `compaction:${latestSummaryCompaction.id}`,
    kind: 'summary',
    message,
    traceRecord: buildCompactionTraceRecord({
      compactionId: latestSummaryCompaction.id,
      runId: latestSummaryCompaction.runId,
      tier: latestSummaryCompaction.tier,
      trigger: latestSummaryCompaction.trigger,
      summary:
        stringValue(parseJson<Record<string, unknown>>(
          latestSummaryCompaction.continuationSummaryJson,
        )?.summary)
        ?? stringValue(parseJson<Record<string, unknown>>(
          latestSummaryCompaction.stateRehydrationJson,
        )?.summary),
      sourceMessageCount: latestSummaryCompaction.sourceMessageCount,
      retainedMessageCount: latestSummaryCompaction.retainedMessageCount,
      estimatedTokensSaved: latestSummaryCompaction.estimatedTokensSaved,
      status: 'recovered',
    }),
  };
}

function resolveActiveCheckpoint(
  session: { activeCheckpointId: string | null },
  checkpoints: ResumeCheckpoint[],
): ResumeCheckpoint | null {
  if (!session.activeCheckpointId) {
    return null;
  }

  return checkpoints.find((checkpoint) => checkpoint.id === session.activeCheckpointId) ?? null;
}

function resolveLatestSummaryCompaction(compactions: CompactionRecord[]): CompactionRecord | null {
  const sorted = [...compactions].sort((left, right) => right.createdAt - left.createdAt);
  return sorted.find((compaction) => compaction.tier === 'summary') ?? sorted[0] ?? null;
}

function buildRecoveredCheckpointMessage(checkpoint: ResumeCheckpoint): string | null {
  const resumeCursor = parseJson<Record<string, unknown>>(checkpoint.resumeCursorJson);
  const sessionState = parseJson<Record<string, unknown>>(checkpoint.sessionStateJson);
  const pendingWork = parseJson<Record<string, unknown> | null>(checkpoint.pendingWorkJson, null);

  const lines = [
    'Recovered durable context from a previous app session.',
    `- Recovery checkpoint: ${stringValue(resumeCursor?.checkpointKind) ?? checkpoint.checkpointKind}`,
    `- Previous phase: ${stringValue(resumeCursor?.phase) ?? stringValue(sessionState?.phase) ?? 'unknown'}`,
  ];

  const priorInput = stringValue(sessionState?.input);
  if (priorInput) {
    lines.push(`- Previous user input: ${truncate(priorInput, 180)}`);
  }

  const planGoal = stringValue(sessionState?.planGoal);
  if (planGoal) {
    lines.push(`- Pending goal: ${truncate(planGoal, 180)}`);
  }

  const pendingType = stringValue(pendingWork?.type);
  if (pendingType === 'tool_permission') {
    const toolName = stringValue(pendingWork?.toolName) ?? stringValue(resumeCursor?.toolName);
    lines.push(`- Pending tool permission: ${toolName ?? 'unknown tool'}`);
  } else if (pendingType === 'plan_approval') {
    lines.push('- Pending plan approval was recovered into visible context.');
  } else if (pendingType === 'compaction_resume') {
    lines.push('- Recovered compaction boundary for context rebuild.');
  }

  const summary = stringValue(sessionState?.summary);
  if (summary) {
    lines.push(`- Recovered summary: ${truncate(summary, 280)}`);
  }

  lines.push('Use this recovered context when continuing the conversation. Execution did not automatically resume.');

  return lines.join('\n');
}

function buildRecoveredCompactionMessage(compaction: CompactionRecord): string | null {
  const continuationSummary = parseJson<Record<string, unknown>>(compaction.continuationSummaryJson);
  const stateRehydration = parseJson<Record<string, unknown>>(compaction.stateRehydrationJson);
  const summary = stringValue(continuationSummary?.summary) ?? stringValue(stateRehydration?.summary);

  if (!summary) {
    return null;
  }

  const lines = [
    'Recovered durable context from persisted compaction history.',
    `- Recovery boundary: ${compaction.tier} / ${compaction.trigger}`,
    `- Previous phase: ${stringValue(stateRehydration?.phase) ?? 'compacting'}`,
  ];

  const priorInput = stringValue(continuationSummary?.input);
  if (priorInput) {
    lines.push(`- Previous user input: ${truncate(priorInput, 180)}`);
  }

  lines.push(`- Recovered summary: ${truncate(summary, 280)}`);

  const sourceMessageCount = numberValue(continuationSummary?.sourceMessageCount)
    ?? numberValue(stateRehydration?.sourceMessageCount);
  if (sourceMessageCount !== null) {
    lines.push(`- Source messages compacted: ${sourceMessageCount}`);
  }

  const retainedMessageCount = numberValue(continuationSummary?.retainedMessageCount)
    ?? numberValue(stateRehydration?.retainedMessageCount);
  if (retainedMessageCount !== null) {
    lines.push(`- Retained messages after compaction: ${retainedMessageCount}`);
  }

  lines.push('Use this recovered summary when continuing the conversation. Execution did not automatically resume.');

  return lines.join('\n');
}

function parseJson<T>(raw: string | null, fallback: T | null = null): T | null {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

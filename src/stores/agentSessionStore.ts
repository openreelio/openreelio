import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  createAgentSessionBackend,
  type AgentRun,
  type AgentSession,
  type AgentSessionSnapshot,
  type CompactionRecord,
  type CreatePersistedCompactionInput,
  type CreatePersistedResumeCheckpointInput,
  type PermissionDecision,
  type ResumeCheckpoint,
  type StartPersistedAgentRunInput,
  type UpdatePersistedAgentRunPhaseInput,
} from '@/agents/engine';
import type { CreateAgentSessionInput } from '@/agents/engine';

export type AgentSessionStoreCreateInput =
  Omit<CreateAgentSessionInput, 'projectId'> & { projectId?: string };
export type AgentSessionStoreEnsureInput = AgentSessionStoreCreateInput & { id: string };
export type AgentSessionPersistenceStage =
  | 'session_ensure'
  | 'permission_replay'
  | 'run_start'
  | 'run_finalize'
  | 'compaction_record'
  | 'resume_checkpoint';
export type AgentSessionPersistenceMode = 'healthy' | 'degraded' | 'ephemeral';

export interface AgentSessionPersistenceIssue {
  sessionId: string;
  stage: AgentSessionPersistenceStage;
  message: string;
  occurredAt: number;
}

export type AgentSessionPersistenceStatus = AgentSessionPersistenceMode;

export interface AgentSessionPersistenceSummary {
  status: AgentSessionPersistenceStatus;
  label: 'Healthy' | 'Degraded' | 'Ephemeral';
  description: string;
  isRestartSafe: boolean;
}

export interface AgentSessionPersistenceView {
  status: AgentSessionPersistenceStatus;
  label: 'Healthy' | 'Degraded' | 'Ephemeral';
  description: string;
  isRestartSafe: boolean;
  hasActiveIssues: boolean;
  isLatched: boolean;
  visibleIssues: AgentSessionPersistenceIssue[];
}

export interface AgentSessionRecoveryArtifacts {
  compactions: CompactionRecord[];
  checkpoints: ResumeCheckpoint[];
  isLoading: boolean;
  lastError: string | null;
  lastRefreshedAt: number | null;
  headerFingerprint: string | null;
}

export type AgentSessionRecoveryMode = 'full' | 'degraded' | 'cold' | 'ephemeral';
export type AgentSessionRestartBoundaryKind =
  | 'checkpoint'
  | 'summary_boundary'
  | 'conversation_log'
  | 'session_kernel_unavailable';

export interface AgentSessionRestartBoundaryView {
  kind: AgentSessionRestartBoundaryKind;
  title: string;
  description: string;
}

export interface AgentSessionResumeHistoryView {
  status: AgentSessionRecoveryMode;
  label: 'Full' | 'Degraded' | 'Cold' | 'Ephemeral';
  description: string;
  restartBoundary: AgentSessionRestartBoundaryView;
  activeCheckpoint: ResumeCheckpoint | null;
  latestCheckpoint: ResumeCheckpoint | null;
  latestCompaction: CompactionRecord | null;
  latestSummaryCompaction: CompactionRecord | null;
  checkpointCount: number;
  compactionCount: number;
}

export interface AgentSessionBackendLike {
  createSession(input: CreateAgentSessionInput): Promise<AgentSession>;
  getSession(sessionId: string): Promise<AgentSessionSnapshot>;
  listPermissionDecisions(sessionId: string): Promise<PermissionDecision[]>;
  listCompactions(sessionId: string): Promise<CompactionRecord[]>;
  listResumeCheckpoints(sessionId: string): Promise<ResumeCheckpoint[]>;
  recordCompaction(input: CreatePersistedCompactionInput): Promise<CompactionRecord>;
  createResumeCheckpoint(input: CreatePersistedResumeCheckpointInput): Promise<ResumeCheckpoint>;
  consumeResumeCheckpoint(checkpointId: string): Promise<ResumeCheckpoint>;
  startRun(input: StartPersistedAgentRunInput): Promise<AgentRun>;
  updateRunPhase(input: UpdatePersistedAgentRunPhaseInput): Promise<AgentRun>;
}

export interface AgentSessionStoreState {
  activeProjectId: string | null;
  activeSessionId: string | null;
  snapshotsById: Record<string, AgentSessionSnapshot>;
  permissionDecisionsBySessionId: Record<string, PermissionDecision[]>;
  persistenceIssuesBySessionId: Record<string, AgentSessionPersistenceIssue[]>;
  persistenceLatchesBySessionId: Record<string, AgentSessionPersistenceIssue[]>;
  recoveryArtifactsBySessionId: Record<string, AgentSessionRecoveryArtifacts>;
  sessionOrder: string[];
  isLoading: boolean;
  isMutating: boolean;
  lastError: string | null;
}

export interface AgentSessionStoreActions {
  loadForProject(projectId: string): void;
  loadSession(sessionId: string): Promise<AgentSessionSnapshot>;
  ensureSession(input: AgentSessionStoreEnsureInput): Promise<AgentSessionSnapshot>;
  refreshPermissionDecisions(sessionId: string): Promise<PermissionDecision[]>;
  refreshRecoveryArtifacts(
    sessionId: string,
    options?: { headerFingerprint?: string | null },
  ): Promise<AgentSessionRecoveryArtifacts>;
  recordCompaction(input: CreatePersistedCompactionInput): Promise<CompactionRecord>;
  createResumeCheckpoint(
    input: CreatePersistedResumeCheckpointInput,
  ): Promise<ResumeCheckpoint>;
  consumeResumeCheckpoint(checkpointId: string): Promise<ResumeCheckpoint>;
  reportPersistenceIssue: (input: {
    sessionId: string;
    stage: AgentSessionPersistenceStage;
    error: unknown;
    occurredAt?: number;
  }) => AgentSessionPersistenceIssue;
  clearPersistenceIssue: (
    sessionId: string,
    stage?: AgentSessionPersistenceStage,
  ) => void;
  createSession(input?: AgentSessionStoreCreateInput): Promise<AgentSession>;
  startRun(input: StartPersistedAgentRunInput): Promise<AgentRun>;
  updateRunPhase(input: UpdatePersistedAgentRunPhaseInput): Promise<AgentRun>;
  clear(): void;
}

export type AgentSessionStore = AgentSessionStoreState & AgentSessionStoreActions;

const EPHEMERAL_PERSISTENCE_STAGES = new Set<AgentSessionPersistenceStage>([
  'session_ensure',
  'run_start',
]);

export function summarizeAgentSessionPersistence(
  issues?: AgentSessionPersistenceIssue[],
): AgentSessionPersistenceSummary {
  if (!issues || issues.length === 0) {
    return {
      status: 'healthy',
      label: 'Healthy',
      description: 'Persistence is healthy.',
      isRestartSafe: true,
    };
  }

  if (issues.some((issue) => EPHEMERAL_PERSISTENCE_STAGES.has(issue.stage))) {
    return {
      status: 'ephemeral',
      label: 'Ephemeral',
      description:
        'Persistence failed before the session boundary was durably recorded. Restart survivability is not guaranteed.',
      isRestartSafe: false,
    };
  }

  return {
    status: 'degraded',
    label: 'Degraded',
    description:
      'Persistence is partial. Resume, approval history, or audit trail may be incomplete until persistence recovers.',
    isRestartSafe: true,
  };
}

function touchSessionOrder(order: string[], sessionId: string): string[] {
  return [sessionId, ...order.filter((existingId) => existingId !== sessionId)];
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function applySnapshot(state: AgentSessionStoreState, snapshot: AgentSessionSnapshot): void {
  state.snapshotsById[snapshot.session.id] = snapshot;
  state.activeProjectId = snapshot.session.projectId;
  state.activeSessionId = snapshot.session.id;
  state.sessionOrder = touchSessionOrder(state.sessionOrder, snapshot.session.id);
}

function isMissingSessionError(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase();
  return message.includes('session not found') || message.includes('failed to get agent session');
}

function upsertPersistenceIssue(
  issues: AgentSessionPersistenceIssue[],
  nextIssue: AgentSessionPersistenceIssue,
): AgentSessionPersistenceIssue[] {
  return [
    ...issues.filter((issue) => issue.stage !== nextIssue.stage),
    nextIssue,
  ].sort((left, right) => left.occurredAt - right.occurredAt);
}

export function deriveAgentSessionPersistenceMode(
  issues: AgentSessionPersistenceIssue[] | undefined,
): AgentSessionPersistenceMode {
  return summarizeAgentSessionPersistence(issues).status;
}

export function summarizeAgentSessionPersistenceView(
  activeIssues?: AgentSessionPersistenceIssue[],
  latchedIssues?: AgentSessionPersistenceIssue[],
): AgentSessionPersistenceView {
  const hasActiveIssues = Boolean(activeIssues && activeIssues.length > 0);
  const visibleIssues = hasActiveIssues
    ? [...(activeIssues ?? [])]
    : [...(latchedIssues ?? [])];
  const summary = summarizeAgentSessionPersistence(visibleIssues);

  if (summary.status === 'healthy') {
    return {
      ...summary,
      hasActiveIssues: false,
      isLatched: false,
      visibleIssues: [],
    };
  }

  if (hasActiveIssues) {
    return {
      ...summary,
      hasActiveIssues: true,
      isLatched: false,
      visibleIssues,
    };
  }

  return {
    ...summary,
    description:
      summary.status === 'ephemeral'
        ? 'Persistence recovered for the active run, but this session crossed a non-durable boundary earlier in this app session. Restart survivability is still not guaranteed for that earlier history.'
        : 'Persistence recovered for the active run, but this session previously ran in degraded mode during this app session. Resume or audit history may still be incomplete for that earlier boundary.',
    hasActiveIssues: false,
    isLatched: true,
    visibleIssues,
  };
}

export function createEmptyAgentSessionRecoveryArtifacts(): AgentSessionRecoveryArtifacts {
  return {
    compactions: [],
    checkpoints: [],
    isLoading: false,
    lastError: null,
    lastRefreshedAt: null,
    headerFingerprint: null,
  };
}

export function buildAgentSessionRecoveryFingerprint(session: AgentSession): string {
  return [
    session.id,
    session.currentRunId ?? '',
    session.activeCheckpointId ?? '',
    session.latestSummaryMessageId ?? '',
    String(session.compactionVersion),
    String(session.resumeCursorVersion),
    String(session.lastCompactedAt ?? ''),
    String(session.lastResumedAt ?? ''),
  ].join('|');
}

function sortCompactions(
  compactions: CompactionRecord[],
): CompactionRecord[] {
  return [...compactions].sort((left, right) => right.createdAt - left.createdAt);
}

function sortResumeCheckpoints(
  checkpoints: ResumeCheckpoint[],
): ResumeCheckpoint[] {
  return [...checkpoints].sort((left, right) => right.createdAt - left.createdAt);
}

function resolveActiveCheckpoint(
  session: AgentSession,
  checkpoints: ResumeCheckpoint[],
): ResumeCheckpoint | null {
  if (session.activeCheckpointId) {
    const exactMatch = checkpoints.find((checkpoint) => checkpoint.id === session.activeCheckpointId);
    if (exactMatch) {
      return exactMatch;
    }
  }

  return checkpoints.find((checkpoint) => checkpoint.status === 'active') ?? null;
}

function buildResumeHistoryLabel(
  status: AgentSessionRecoveryMode,
): AgentSessionResumeHistoryView['label'] {
  switch (status) {
    case 'full':
      return 'Full';
    case 'degraded':
      return 'Degraded';
    case 'cold':
      return 'Cold';
    case 'ephemeral':
      return 'Ephemeral';
  }
}

function buildRestartBoundary(input: {
  session: AgentSession | null;
  activeCheckpoint: ResumeCheckpoint | null;
  latestSummaryCompaction: CompactionRecord | null;
  latestCompaction: CompactionRecord | null;
}): AgentSessionRestartBoundaryView {
  if (!input.session) {
    return {
      kind: 'session_kernel_unavailable',
      title: 'Session kernel unavailable',
      description:
        'Resume anchor details will appear after this conversation is hydrated into the persisted session kernel.',
    };
  }

  if (input.activeCheckpoint) {
    return {
      kind: 'checkpoint',
      title: 'Resume checkpoint',
      description:
        'Restart will resume from the active persisted checkpoint before replaying live execution state.',
    };
  }

  if (
    input.latestSummaryCompaction
    || input.latestCompaction
    || input.session.latestSummaryMessageId
    || input.session.lastCompactedAt
  ) {
    return {
      kind: 'summary_boundary',
      title: 'Summary boundary',
      description:
        'Restart will fall back to the latest persisted compaction boundary and rebuild the visible context from durable rows.',
    };
  }

  return {
    kind: 'conversation_log',
    title: 'Conversation log replay',
    description:
      'Restart will rebuild the session from persisted conversation rows because no safe checkpoint boundary is currently available.',
  };
}

export function summarizeAgentSessionResumeHistory(input: {
  session: AgentSession | null;
  activeIssues?: AgentSessionPersistenceIssue[];
  latchedIssues?: AgentSessionPersistenceIssue[];
  artifacts?: AgentSessionRecoveryArtifacts | null;
}): AgentSessionResumeHistoryView {
  const persistence = summarizeAgentSessionPersistenceView(
    input.activeIssues,
    input.latchedIssues,
  );
  const checkpoints = sortResumeCheckpoints(input.artifacts?.checkpoints ?? []);
  const compactions = sortCompactions(input.artifacts?.compactions ?? []);
  const activeCheckpoint = input.session
    ? resolveActiveCheckpoint(input.session, checkpoints)
    : null;
  const latestCheckpoint = checkpoints[0] ?? null;
  const latestCompaction = compactions[0] ?? null;
  const latestSummaryCompaction = compactions.find((compaction) => compaction.tier === 'summary')
    ?? null;
  const restartBoundary = buildRestartBoundary({
    session: input.session,
    activeCheckpoint,
    latestSummaryCompaction,
    latestCompaction,
  });

  let status: AgentSessionRecoveryMode = 'cold';
  let description =
    'Restart will rely on persisted conversation-log replay because no safe checkpoint or summary boundary is currently linked.';

  if (persistence.status === 'ephemeral') {
    status = 'ephemeral';
    description =
      'This session crossed a non-durable boundary in the current app session. Restart may fall back to older persisted history only.';
  } else if (persistence.status === 'degraded') {
    status = 'degraded';
    description = persistence.description;
  } else if (restartBoundary.kind === 'checkpoint') {
    status = 'full';
    description =
      'A persisted checkpoint is linked to the current session state, so restart can resume from a durable boundary.';
  } else if (restartBoundary.kind === 'summary_boundary') {
    status = 'degraded';
    description =
      'A persisted compaction boundary exists, but restart will rebuild from that summary boundary instead of a live checkpoint.';
  }

  return {
    status,
    label: buildResumeHistoryLabel(status),
    description,
    restartBoundary,
    activeCheckpoint,
    latestCheckpoint,
    latestCompaction,
    latestSummaryCompaction,
    checkpointCount: checkpoints.length,
    compactionCount: compactions.length,
  };
}

function findSessionIdForRun(
  snapshotsById: Record<string, AgentSessionSnapshot>,
  runId: string,
): string | null {
  for (const snapshot of Object.values(snapshotsById)) {
    if (
      snapshot.runs.some((run) => run.id === runId)
      || snapshot.session.currentRunId === runId
    ) {
      return snapshot.session.id;
    }
  }

  return null;
}

export function createAgentSessionStore(
  backend: AgentSessionBackendLike = createAgentSessionBackend(),
): UseBoundStore<StoreApi<AgentSessionStore>> {
  return create<AgentSessionStore>()(
    immer((set, get) => ({
      activeProjectId: null,
      activeSessionId: null,
      snapshotsById: {},
      permissionDecisionsBySessionId: {},
      persistenceIssuesBySessionId: {},
      persistenceLatchesBySessionId: {},
      recoveryArtifactsBySessionId: {},
      sessionOrder: [],
      isLoading: false,
      isMutating: false,
      lastError: null,

      loadForProject: (projectId: string) => {
        set((state) => {
          if (state.activeProjectId !== projectId) {
            state.snapshotsById = {};
            state.permissionDecisionsBySessionId = {};
            state.persistenceIssuesBySessionId = {};
            state.recoveryArtifactsBySessionId = {};
            state.sessionOrder = [];
            state.activeSessionId = null;
          }
          state.activeProjectId = projectId;
          state.lastError = null;
        });
      },

      loadSession: async (sessionId: string) => {
        set((state) => {
          state.isLoading = true;
          state.lastError = null;
        });

        try {
          const snapshot = await backend.getSession(sessionId);
          const headerFingerprint = buildAgentSessionRecoveryFingerprint(snapshot.session);
          set((state) => {
            applySnapshot(state, snapshot);
            state.isLoading = false;
          });
          void get().refreshRecoveryArtifacts(sessionId, {
            headerFingerprint,
          });
          return snapshot;
        } catch (error) {
          const message = extractErrorMessage(error);
          set((state) => {
            state.isLoading = false;
            state.lastError = message;
          });
          throw error;
        }
      },

      ensureSession: async (input: AgentSessionStoreEnsureInput) => {
        const projectId = input.projectId ?? get().activeProjectId;
        if (!projectId) {
          throw new Error('Active project is required before ensuring an agent session');
        }

        if (get().activeProjectId !== projectId) {
          get().loadForProject(projectId);
        }

        try {
          const snapshot = await get().loadSession(input.id);
          get().clearPersistenceIssue(input.id, 'session_ensure');
          return snapshot;
        } catch (error) {
          if (!isMissingSessionError(error)) {
            get().reportPersistenceIssue({
              sessionId: input.id,
              stage: 'session_ensure',
              error,
            });
            throw error;
          }

          try {
            await get().createSession({
              ...input,
              projectId,
            });

            const snapshot = await get().loadSession(input.id);
            get().clearPersistenceIssue(input.id, 'session_ensure');
            return snapshot;
          } catch (retryError) {
            get().reportPersistenceIssue({
              sessionId: input.id,
              stage: 'session_ensure',
              error: retryError,
            });
            throw retryError;
          }
        }
      },

      refreshPermissionDecisions: async (sessionId: string) => {
        set((state) => {
          state.isLoading = true;
          state.lastError = null;
        });

        try {
          const decisions = await backend.listPermissionDecisions(sessionId);
          set((state) => {
            state.permissionDecisionsBySessionId[sessionId] = decisions;
            state.isLoading = false;
          });
          get().clearPersistenceIssue(sessionId, 'permission_replay');
          return decisions;
        } catch (error) {
          const message = extractErrorMessage(error);
          set((state) => {
            state.isLoading = false;
            state.lastError = message;
          });
          get().reportPersistenceIssue({
            sessionId,
            stage: 'permission_replay',
            error,
          });
          throw error;
        }
      },

      refreshRecoveryArtifacts: async (sessionId: string, options) => {
        const current =
          get().recoveryArtifactsBySessionId[sessionId]
          ?? createEmptyAgentSessionRecoveryArtifacts();

        set((state) => {
          state.recoveryArtifactsBySessionId[sessionId] = {
            ...current,
            isLoading: true,
            lastError: null,
            headerFingerprint: options?.headerFingerprint ?? current.headerFingerprint,
          };
        });

        const [compactionsResult, checkpointsResult] = await Promise.allSettled([
          backend.listCompactions(sessionId),
          backend.listResumeCheckpoints(sessionId),
        ]);
        const nextCompactions = compactionsResult.status === 'fulfilled'
          ? compactionsResult.value
          : current.compactions;
        const nextCheckpoints = checkpointsResult.status === 'fulfilled'
          ? checkpointsResult.value
          : current.checkpoints;
        const errors: string[] = [];

        if (compactionsResult.status === 'rejected') {
          errors.push(`Failed to load compaction history: ${extractErrorMessage(compactionsResult.reason)}`);
        }

        if (checkpointsResult.status === 'rejected') {
          errors.push(
            `Failed to load resume checkpoints: ${extractErrorMessage(checkpointsResult.reason)}`,
          );
        }

        const nextArtifacts: AgentSessionRecoveryArtifacts = {
          compactions: nextCompactions,
          checkpoints: nextCheckpoints,
          isLoading: false,
          lastError: errors.length > 0 ? errors.join(' ') : null,
          lastRefreshedAt: Date.now(),
          headerFingerprint: options?.headerFingerprint ?? current.headerFingerprint,
        };

        set((state) => {
          state.recoveryArtifactsBySessionId[sessionId] = nextArtifacts;
        });

        return nextArtifacts;
      },

      recordCompaction: async (input: CreatePersistedCompactionInput) => {
        try {
          const record = await backend.recordCompaction(input);
          const snapshot = await backend.getSession(record.sessionId);
          const headerFingerprint = buildAgentSessionRecoveryFingerprint(snapshot.session);

          set((state) => {
            applySnapshot(state, snapshot);
          });

          get().clearPersistenceIssue(record.sessionId, 'compaction_record');
          await get().refreshRecoveryArtifacts(record.sessionId, {
            headerFingerprint,
          });
          return record;
        } catch (error) {
          get().reportPersistenceIssue({
            sessionId: input.sessionId,
            stage: 'compaction_record',
            error,
          });
          throw error;
        }
      },

      createResumeCheckpoint: async (input: CreatePersistedResumeCheckpointInput) => {
        try {
          const checkpoint = await backend.createResumeCheckpoint(input);
          const snapshot = await backend.getSession(checkpoint.sessionId);
          const headerFingerprint = buildAgentSessionRecoveryFingerprint(snapshot.session);

          set((state) => {
            applySnapshot(state, snapshot);
          });

          get().clearPersistenceIssue(checkpoint.sessionId, 'resume_checkpoint');
          await get().refreshRecoveryArtifacts(checkpoint.sessionId, {
            headerFingerprint,
          });
          return checkpoint;
        } catch (error) {
          get().reportPersistenceIssue({
            sessionId: input.sessionId,
            stage: 'resume_checkpoint',
            error,
          });
          throw error;
        }
      },

      consumeResumeCheckpoint: async (checkpointId: string) => {
        const checkpoints = Object.values(get().recoveryArtifactsBySessionId)
          .flatMap((artifacts) => artifacts.checkpoints);
        const cachedCheckpoint = checkpoints.find((checkpoint) => checkpoint.id === checkpointId);

        try {
          const checkpoint = await backend.consumeResumeCheckpoint(checkpointId);
          const snapshot = await backend.getSession(checkpoint.sessionId);
          const headerFingerprint = buildAgentSessionRecoveryFingerprint(snapshot.session);

          set((state) => {
            applySnapshot(state, snapshot);
          });

          get().clearPersistenceIssue(checkpoint.sessionId, 'resume_checkpoint');
          await get().refreshRecoveryArtifacts(checkpoint.sessionId, {
            headerFingerprint,
          });
          return checkpoint;
        } catch (error) {
          if (cachedCheckpoint) {
            get().reportPersistenceIssue({
              sessionId: cachedCheckpoint.sessionId,
              stage: 'resume_checkpoint',
              error,
            });
          }
          throw error;
        }
      },

      reportPersistenceIssue: (input) => {
        const issue: AgentSessionPersistenceIssue = {
          sessionId: input.sessionId,
          stage: input.stage,
          message: extractErrorMessage(input.error),
          occurredAt: input.occurredAt ?? Date.now(),
        };

        set((state) => {
          const nextIssues = upsertPersistenceIssue(
            state.persistenceIssuesBySessionId[input.sessionId] ?? [],
            issue,
          );
          const nextLatches = upsertPersistenceIssue(
            state.persistenceLatchesBySessionId[input.sessionId] ?? [],
            issue,
          );
          state.persistenceIssuesBySessionId[input.sessionId] = nextIssues;
          state.persistenceLatchesBySessionId[input.sessionId] = nextLatches;
          state.lastError = nextIssues[nextIssues.length - 1]?.message ?? issue.message;
        });

        return issue;
      },

      clearPersistenceIssue: (sessionId: string, stage?: AgentSessionPersistenceStage) => {
        set((state) => {
          const currentIssues = state.persistenceIssuesBySessionId[sessionId] ?? [];
          let remainingIssues: AgentSessionPersistenceIssue[] = currentIssues;

          if (!stage) {
            delete state.persistenceIssuesBySessionId[sessionId];
            remainingIssues = [];
          } else {
            remainingIssues = currentIssues.filter(
              (issue) => issue.stage !== stage,
            );
            if (remainingIssues.length === 0) {
              delete state.persistenceIssuesBySessionId[sessionId];
            } else {
              state.persistenceIssuesBySessionId[sessionId] = remainingIssues;
            }
          }

          if (state.activeSessionId === sessionId) {
            state.lastError = remainingIssues.length > 0
              ? remainingIssues[remainingIssues.length - 1]?.message ?? null
              : null;
          }
        });
      },

      createSession: async (input?: AgentSessionStoreCreateInput) => {
        const projectId = input?.projectId ?? get().activeProjectId;
        if (!projectId) {
          throw new Error('Active project is required before creating an agent session');
        }

        set((state) => {
          state.isMutating = true;
          state.lastError = null;
        });

        try {
          const session = await backend.createSession({
            ...input,
            projectId,
          });
          const snapshot: AgentSessionSnapshot = {
            session,
            runs: [],
          };

          set((state) => {
            applySnapshot(state, snapshot);
            state.recoveryArtifactsBySessionId[session.id] ??= createEmptyAgentSessionRecoveryArtifacts();
            state.isMutating = false;
          });

          return session;
        } catch (error) {
          const message = extractErrorMessage(error);
          set((state) => {
            state.isMutating = false;
            state.lastError = message;
          });
          throw error;
        }
      },

      startRun: async (input: StartPersistedAgentRunInput) => {
        set((state) => {
          state.isMutating = true;
          state.lastError = null;
        });

        try {
          const run = await backend.startRun(input);
          const snapshot = await backend.getSession(run.sessionId);
          const headerFingerprint = buildAgentSessionRecoveryFingerprint(snapshot.session);

          set((state) => {
            applySnapshot(state, snapshot);
            state.isMutating = false;
          });

          get().clearPersistenceIssue(run.sessionId, 'run_start');
          void get().refreshRecoveryArtifacts(run.sessionId, {
            headerFingerprint,
          });
          return run;
        } catch (error) {
          const message = extractErrorMessage(error);
          set((state) => {
            state.isMutating = false;
            state.lastError = message;
          });
          get().reportPersistenceIssue({
            sessionId: input.sessionId,
            stage: 'run_start',
            error,
          });
          throw error;
        }
      },

      updateRunPhase: async (input: UpdatePersistedAgentRunPhaseInput) => {
        set((state) => {
          state.isMutating = true;
          state.lastError = null;
        });

        try {
          const run = await backend.updateRunPhase(input);
          const snapshot = await backend.getSession(run.sessionId);
          const headerFingerprint = buildAgentSessionRecoveryFingerprint(snapshot.session);

          set((state) => {
            applySnapshot(state, snapshot);
            state.isMutating = false;
          });

          get().clearPersistenceIssue(run.sessionId, 'run_finalize');
          void get().refreshRecoveryArtifacts(run.sessionId, {
            headerFingerprint,
          });
          return run;
        } catch (error) {
          const message = extractErrorMessage(error);
          const sessionId = findSessionIdForRun(get().snapshotsById, input.runId)
            ?? get().activeSessionId;
          set((state) => {
            state.isMutating = false;
            state.lastError = message;
          });
          if (sessionId) {
            get().reportPersistenceIssue({
              sessionId,
              stage: 'run_finalize',
              error,
            });
          }
          throw error;
        }
      },

      clear: () => {
        set((state) => {
          state.activeProjectId = null;
          state.activeSessionId = null;
          state.snapshotsById = {};
          state.permissionDecisionsBySessionId = {};
          state.persistenceIssuesBySessionId = {};
          state.persistenceLatchesBySessionId = {};
          state.recoveryArtifactsBySessionId = {};
          state.sessionOrder = [];
          state.isLoading = false;
          state.isMutating = false;
          state.lastError = null;
        });
      },
    })),
  );
}

export const useAgentSessionStore = createAgentSessionStore();

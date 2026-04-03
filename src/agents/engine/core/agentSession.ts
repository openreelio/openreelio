/**
 * Agent Session Kernel Types
 *
 * Defines the canonical session-layer vocabulary for the agent rewrite.
 * This layer models orchestration state only; project mutation truth remains
 * in the backend command executor and command log.
 *
 * Shipping runtime paths use `tpao`/`fast` with `primary` mode. Compatibility
 * literals for delegation, child sessions, and system runtimes remain here for
 * backend/test migration work, but they are not part of the active product UI.
 */

// =============================================================================
// Enums / Literal Types
// =============================================================================

export type AgentSessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted';

export type AgentRuntimeKind = 'tpao' | 'fast' | 'subagent' | 'system';

export type AgentSessionMode = 'primary' | 'child' | 'branch' | 'system';

export type AgentRunTrigger = 'user' | 'resume' | 'delegation' | 'system';

export type AgentRunPhase =
  | 'initializing'
  | 'thinking'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'observing'
  | 'compacting'
  | 'completed'
  | 'failed'
  | 'aborted';

export type PermissionSubjectType =
  | 'capability'
  | 'resource'
  | 'tool'
  | 'workspace'
  | 'asset'
  | 'export'
  | 'external_provider'
  | 'delegation'
  | 'approval'
  | 'system';

export type PermissionDecisionAction = 'allow' | 'ask' | 'deny' | 'allow_always';

export type PermissionDecisionSource =
  | 'builtin'
  | 'global_policy'
  | 'profile_default'
  | 'profile_override'
  | 'session_rule'
  | 'user_prompt'
  | 'interactive_approval'
  | 'system_override';

export type DelegationStatus = 'requested' | 'running' | 'completed' | 'failed' | 'cancelled';

export type DelegationMergeStatus = 'pending' | 'merged' | 'discarded';

export type CompactionTier = 'prune' | 'summary';

export type CompactionTrigger = 'auto' | 'manual' | 'resume_preflight';

export type ResumeCheckpointKind =
  | 'approval_wait'
  | 'tool_wait'
  | 'compaction_boundary'
  | 'safe_resume_point'
  | 'delegation_wait';

export type ResumeCheckpointStatus = 'active' | 'consumed' | 'invalidated';

export type ShippingAgentRuntimeKind = Extract<AgentRuntimeKind, 'tpao' | 'fast'>;
export type ShippingAgentSessionMode = Extract<AgentSessionMode, 'primary'>;
export type ShippingResumeCheckpointKind = Exclude<ResumeCheckpointKind, 'delegation_wait'>;

export const DEFAULT_AGENT_RUNTIME_KIND: ShippingAgentRuntimeKind = 'tpao';
export const DEFAULT_AGENT_SESSION_MODE: ShippingAgentSessionMode = 'primary';

export interface CreateShippingAgentSessionInput
  extends Omit<
    CreateAgentSessionInput,
    'runtimeKind' | 'sessionMode' | 'parentSessionId' | 'branchFromSessionId' | 'rootSessionId'
  > {
  runtimeKind?: ShippingAgentRuntimeKind;
  sessionMode?: ShippingAgentSessionMode;
}

// =============================================================================
// Core Models
// =============================================================================

export interface AgentSessionLineage {
  parentSessionId: string | null;
  branchFromSessionId: string | null;
  rootSessionId: string;
}

export interface AgentSession {
  id: string;
  projectId: string;
  sequenceId: string | null;
  title: string;
  status: AgentSessionStatus;
  runtimeKind: AgentRuntimeKind;
  agentProfileId: string;
  sessionMode: AgentSessionMode;
  lineage: AgentSessionLineage;
  currentRunId: string | null;
  currentPlanId: string | null;
  pendingApprovalId: string | null;
  activeCheckpointId: string | null;
  permissionStateVersion: number;
  compactionVersion: number;
  resumeCursorVersion: number;
  latestSummaryMessageId: string | null;
  lastCompactedAt: number | null;
  lastResumedAt: number | null;
  modelProvider: string | null;
  modelId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface AgentRun {
  id: string;
  sessionId: string;
  runtimeKind: AgentRuntimeKind;
  trigger: AgentRunTrigger;
  inputMessageId: string | null;
  outputMessageId: string | null;
  phase: AgentRunPhase;
  iteration: number;
  maxIterations: number;
  toolCallsUsed: number;
  maxToolCalls: number;
  plannedStepCount: number;
  completedStepCount: number;
  traceId: string | null;
  rollbackReportJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export interface DelegationRecord {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  parentRunId: string;
  agentProfileId: string;
  delegatedGoal: string;
  contextPacketJson: string;
  allowedToolsDeltaJson: string | null;
  permissionSnapshotJson: string | null;
  status: DelegationStatus;
  mergeStatus: DelegationMergeStatus;
  summaryMessageId: string | null;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface PermissionDecision {
  id: string;
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  subjectType: PermissionSubjectType;
  subject: string;
  action: PermissionDecisionAction;
  source: PermissionDecisionSource;
  reason: string | null;
  createdAt: number;
}

export interface CompactionRecord {
  id: string;
  sessionId: string;
  runId: string | null;
  tier: CompactionTier;
  trigger: CompactionTrigger;
  summaryMessageId: string | null;
  sourceMessageCount: number;
  retainedMessageCount: number;
  estimatedTokensSaved: number | null;
  continuationSummaryJson: string | null;
  stateRehydrationJson: string | null;
  createdAt: number;
}

export interface ResumeCheckpoint {
  id: string;
  sessionId: string;
  runId: string | null;
  checkpointKind: ResumeCheckpointKind;
  status: ResumeCheckpointStatus;
  resumeCursorJson: string;
  sessionStateJson: string;
  pendingWorkJson: string | null;
  createdAt: number;
  consumedAt: number | null;
}

// =============================================================================
// Factory Inputs
// =============================================================================

export interface CreateAgentSessionInput {
  projectId: string;
  sequenceId?: string | null;
  title?: string;
  runtimeKind?: AgentRuntimeKind;
  agentProfileId?: string;
  sessionMode?: AgentSessionMode;
  parentSessionId?: string | null;
  branchFromSessionId?: string | null;
  rootSessionId?: string;
  modelProvider?: string | null;
  modelId?: string | null;
  id?: string;
  now?: number;
}

export interface CreateAgentRunInput {
  sessionId: string;
  runtimeKind?: AgentRuntimeKind;
  trigger?: AgentRunTrigger;
  maxIterations?: number;
  maxToolCalls?: number;
  inputMessageId?: string | null;
  outputMessageId?: string | null;
  id?: string;
  now?: number;
}

// =============================================================================
// Factory Helpers
// =============================================================================

function resolveRootSessionId(
  id: string,
  parentSessionId: string | null | undefined,
  branchFromSessionId: string | null | undefined,
  rootSessionId: string | undefined,
): string {
  if (!parentSessionId && !branchFromSessionId) {
    return rootSessionId ?? id;
  }

  if (!rootSessionId) {
    throw new Error(
      'rootSessionId is required when creating a child or branch session',
    );
  }

  return rootSessionId;
}

// =============================================================================
// Factories
// =============================================================================

/**
 * Create a root, child, or branch session shell with safe defaults.
 */
export function createAgentSession(input: CreateAgentSessionInput): AgentSession {
  const now = input.now ?? Date.now();
  const id = input.id ?? crypto.randomUUID();
  const parentSessionId = input.parentSessionId ?? null;
  const branchFromSessionId = input.branchFromSessionId ?? null;

  return {
    id,
    projectId: input.projectId,
    sequenceId: input.sequenceId ?? null,
    title: input.title ?? 'New Agent Session',
    status: 'idle',
    runtimeKind: input.runtimeKind ?? DEFAULT_AGENT_RUNTIME_KIND,
    agentProfileId: input.agentProfileId ?? 'editor',
    sessionMode: input.sessionMode ?? DEFAULT_AGENT_SESSION_MODE,
    lineage: {
      parentSessionId,
      branchFromSessionId,
      rootSessionId: resolveRootSessionId(
        id,
        parentSessionId,
        branchFromSessionId,
        input.rootSessionId,
      ),
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
    modelProvider: input.modelProvider ?? null,
    modelId: input.modelId ?? null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

/**
 * Create a run shell for a session before runtime-specific execution begins.
 */
export function createAgentRun(input: CreateAgentRunInput): AgentRun {
  const now = input.now ?? Date.now();

  return {
    id: input.id ?? crypto.randomUUID(),
    sessionId: input.sessionId,
    runtimeKind: input.runtimeKind ?? 'tpao',
    trigger: input.trigger ?? 'user',
    inputMessageId: input.inputMessageId ?? null,
    outputMessageId: input.outputMessageId ?? null,
    phase: 'initializing',
    iteration: 0,
    maxIterations: input.maxIterations ?? 20,
    toolCallsUsed: 0,
    maxToolCalls: input.maxToolCalls ?? 50,
    plannedStepCount: 0,
    completedStepCount: 0,
    traceId: null,
    rollbackReportJson: null,
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    updatedAt: now,
    endedAt: null,
  };
}

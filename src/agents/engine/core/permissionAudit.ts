import { createAgentSessionBackend } from './agentSessionBackend';
import type {
  PermissionDecision,
  PermissionDecisionAction,
  PermissionDecisionSource,
  PermissionSubjectType,
} from './agentSession';
import type { PermissionTraceRecord } from './traceRecorder';
import { createLogger } from '@/services/logger';
import { usePermissionStore } from '@/stores/permissionStore';

export interface PermissionAuditResolution {
  subjectType: PermissionSubjectType;
  subject: string;
  matchedPattern: string | null;
  matchedScope: 'global' | 'session' | null;
  source: PermissionDecisionSource;
}

const logger = createLogger('PermissionAudit');
const agentSessionBackend = createAgentSessionBackend();

function buildReason(
  resolution: PermissionAuditResolution,
  action: PermissionDecisionAction,
  source: PermissionDecisionSource,
): string {
  const ruleSource = resolution.matchedPattern
    ? `${resolution.matchedScope ?? 'builtin'}:${resolution.matchedPattern}`
    : 'builtin';

  if (action === 'ask') {
    return `Prompted by ${ruleSource} for ${resolution.subject}`;
  }

  if (source === 'interactive_approval') {
    return `Resolved interactively as ${action} for ${resolution.subject}`;
  }

  return `Resolved automatically as ${action} by ${ruleSource}`;
}

export function persistPermissionAudit(
  sessionId: string | null,
  runId: string | null,
  stepId: string | null,
  resolution: PermissionAuditResolution,
  action: PermissionDecisionAction,
  source: PermissionDecisionSource = resolution.source,
): void {
  if (!sessionId) {
    return;
  }

  void agentSessionBackend.recordPermissionDecision({
    sessionId,
    runId,
    stepId,
    subjectType: resolution.subjectType,
    subject: resolution.subject,
    action,
    source,
    reason: buildReason(resolution, action, source),
  }).catch((error) => {
    logger.warn('Failed to persist permission decision', {
      sessionId,
      stepId,
      subject: resolution.subject,
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export interface HydratePersistedPermissionRulesOptions {
  shouldApply?: () => boolean;
}

export function buildPermissionTraceRecord(input: {
  runId: string | null;
  stepId: string | null;
  resolution: PermissionAuditResolution;
  action: PermissionDecisionAction;
  source?: PermissionDecisionSource;
  recordedAt?: number;
  reason?: string | null;
  decisionId?: string | null;
}): PermissionTraceRecord {
  const source = input.source ?? input.resolution.source;
  return {
    decisionId: input.decisionId ?? null,
    runId: input.runId,
    stepId: input.stepId,
    subjectType: input.resolution.subjectType,
    subject: input.resolution.subject,
    action: input.action,
    source,
    reason: input.reason ?? buildReason(input.resolution, input.action, source),
    recordedAt: input.recordedAt ?? Date.now(),
  };
}

export async function hydratePersistedPermissionRules(
  sessionId: string | null,
  options: HydratePersistedPermissionRulesOptions = {},
): Promise<void> {
  if (!sessionId) {
    return;
  }

  const store = usePermissionStore.getState();
  if (store.hasHydratedSessionRules(sessionId)) {
    return;
  }

  try {
    const decisions = await agentSessionBackend.listPermissionDecisions(sessionId);
    if (options.shouldApply && !options.shouldApply()) {
      return;
    }
    usePermissionStore
      .getState()
      .hydrateSessionRulesFromPersistedDecisions(
        sessionId,
        decisions.map((decision: PermissionDecision) => ({
          id: decision.id,
          subject: decision.subject,
          action: decision.action,
          createdAt: decision.createdAt,
        })),
      );
  } catch (error) {
    logger.warn('Failed to hydrate persisted permission decisions', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

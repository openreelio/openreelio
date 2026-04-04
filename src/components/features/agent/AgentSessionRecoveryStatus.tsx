import { useConversationStore } from '@/stores/conversationStore';
import {
  summarizeAgentSessionPersistenceView,
  useAgentSessionStore,
} from '@/stores/agentSessionStore';

function getRecoveryCopy(status: 'degraded' | 'ephemeral', isLatched: boolean): string {
  if (status === 'ephemeral') {
    return isLatched
      ? 'Recovered in this app session, but earlier history is not restart-safe.'
      : 'Restart safety is not guaranteed for this session.';
  }

  return isLatched
    ? 'Recovered in this app session, but earlier recovery context may still be partial.'
    : 'Recovery context or audit history may be incomplete.';
}

export interface AgentSessionRecoveryStatusProps {
  className?: string;
}

export function AgentSessionRecoveryStatus({
  className = '',
}: AgentSessionRecoveryStatusProps): JSX.Element | null {
  const activeSessionId = useConversationStore((state) => state.activeSessionId);
  const activeIssues = useAgentSessionStore((state) =>
    activeSessionId ? state.persistenceIssuesBySessionId[activeSessionId] : undefined,
  );
  const latchedIssues = useAgentSessionStore((state) =>
    activeSessionId ? state.persistenceLatchesBySessionId[activeSessionId] : undefined,
  );
  const summary = summarizeAgentSessionPersistenceView(activeIssues, latchedIssues);

  if (!activeSessionId || summary.status === 'healthy') {
    return null;
  }

  const badgeClass = summary.status === 'ephemeral'
    ? 'border-status-error/30 bg-status-error/10 text-status-error'
    : 'border-status-warning/30 bg-status-warning/10 text-status-warning';

  return (
    <div
      data-testid="agent-session-recovery-status"
      title={summary.description}
      className={`ml-auto flex min-w-0 items-center gap-2 ${className}`}
    >
      <span
        className={`rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] ${badgeClass}`}
      >
        {summary.label}
      </span>
      <span className="truncate text-[10px] text-text-tertiary">
        {getRecoveryCopy(summary.status, summary.isLatched)}
      </span>
    </div>
  );
}

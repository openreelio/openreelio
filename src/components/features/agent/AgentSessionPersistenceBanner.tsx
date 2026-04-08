import { useConversationStore } from '@/stores/conversationStore';
import {
  summarizeAgentSessionPersistenceView,
  useAgentSessionStore,
} from '@/stores/agentSessionStore';

function buildHeadline(status: 'degraded' | 'ephemeral', isLatched: boolean): string {
  if (status === 'ephemeral') {
    return isLatched
      ? 'Earlier recovery protection was limited in this app session'
      : 'Saved recovery protection is limited right now';
  }

  return isLatched
    ? 'Earlier recovery details were partially unavailable'
    : 'Some saved recovery details are temporarily unavailable';
}

function buildBody(status: 'degraded' | 'ephemeral', isLatched: boolean): string {
  if (status === 'ephemeral') {
    return isLatched
      ? 'Current work can continue, but some interrupted work from earlier in this app session may not be restorable after a reload.'
      : 'Current work can continue, but if the app closes unexpectedly, this turn may not be restorable.';
  }

  return isLatched
    ? 'Current work can continue, but older recovery details from earlier in this app session may be incomplete.'
    : 'Current work can continue, but resuming an interrupted task may be limited until recovery catches up.';
}

export interface AgentSessionPersistenceBannerProps {
  className?: string;
}

export function AgentSessionPersistenceBanner({
  className = '',
}: AgentSessionPersistenceBannerProps): JSX.Element | null {
  const activeSessionId = useConversationStore((state) => state.activeSessionId);
  const activeIssues = useAgentSessionStore((state) =>
    activeSessionId ? state.persistenceIssuesBySessionId[activeSessionId] : undefined,
  );
  const latchedIssues = useAgentSessionStore((state) =>
    activeSessionId ? state.persistenceLatchesBySessionId[activeSessionId] : undefined,
  );
  const summary = summarizeAgentSessionPersistenceView(activeIssues, latchedIssues);

  if (!activeSessionId || summary.visibleIssues.length === 0) {
    return null;
  }

  if (summary.status === 'healthy') {
    return null;
  }

  const bannerStatus = summary.status;
  const isEphemeral = bannerStatus === 'ephemeral';
  const containerClass = isEphemeral
    ? 'border-status-error/30 bg-status-error/10'
    : 'border-status-warning/30 bg-status-warning/10';
  const titleClass = isEphemeral ? 'text-status-error' : 'text-status-warning';
  const headline = buildHeadline(bannerStatus, summary.isLatched);
  const body = buildBody(bannerStatus, summary.isLatched);

  return (
    <div
      data-testid="agent-session-persistence-banner"
      role="alert"
      className={`border-b px-4 py-3 ${containerClass} ${className}`}
    >
      <p className={`text-sm font-medium ${titleClass}`}>{headline}</p>
      <p className="mt-1 text-xs text-text-secondary">{body}</p>
    </div>
  );
}

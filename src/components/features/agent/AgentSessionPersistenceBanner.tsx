import { useConversationStore } from '@/stores/conversationStore';
import {
  summarizeAgentSessionPersistenceView,
  useAgentSessionStore,
  type AgentSessionPersistenceStage,
} from '@/stores/agentSessionStore';

const STAGE_COPY: Record<AgentSessionPersistenceStage, string> = {
  session_ensure: 'The persisted agent session could not be prepared.',
  permission_replay: 'Saved permission decisions could not be restored.',
  run_start: 'Run history could not be persisted at start.',
  run_finalize: 'Run completion could not be persisted.',
  compaction_record: 'Compaction history could not be persisted.',
  resume_checkpoint: 'Resume checkpoint history could not be persisted.',
};

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

  const isEphemeral = summary.status === 'ephemeral';
  const containerClass = isEphemeral
    ? 'border-status-error/30 bg-status-error/10'
    : 'border-status-warning/30 bg-status-warning/10';
  const titleClass = isEphemeral ? 'text-status-error' : 'text-status-warning';
  const headline = summary.hasActiveIssues
    ? isEphemeral
      ? 'Agent session persistence is ephemeral'
      : 'Agent session persistence is degraded'
    : isEphemeral
      ? 'Agent session persistence was ephemeral earlier in this app session'
      : 'Agent session persistence was degraded earlier in this app session';

  return (
    <div
      data-testid="agent-session-persistence-banner"
      role="alert"
      className={`border-b px-4 py-3 ${containerClass} ${className}`}
    >
      <p className={`text-sm font-medium ${titleClass}`}>{headline}</p>
      <p className="mt-1 text-xs text-text-secondary">{summary.description}</p>
      <div className="mt-2 space-y-2">
        {summary.visibleIssues.map((issue) => (
          <div key={`${issue.sessionId}-${issue.stage}`} className="text-xs">
            <p className="text-text-secondary">{STAGE_COPY[issue.stage]}</p>
            <p className="mt-0.5 text-text-tertiary">{issue.message}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

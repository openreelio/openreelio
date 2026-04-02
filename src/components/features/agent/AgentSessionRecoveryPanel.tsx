import { useConversationStore } from '@/stores/conversationStore';
import {
  summarizeAgentSessionPersistenceView,
  useAgentSessionStore,
  type AgentSessionPersistenceStage,
} from '@/stores/agentSessionStore';

const STAGE_COPY: Record<AgentSessionPersistenceStage, string> = {
  session_ensure: 'Session boundary preparation failed',
  permission_replay: 'Saved permission replay failed',
  run_start: 'Persisted run creation failed',
  run_finalize: 'Persisted run finalization failed',
  compaction_record: 'Compaction artifact persistence failed',
  resume_checkpoint: 'Resume checkpoint persistence failed',
};

export interface AgentSessionRecoveryPanelProps {
  className?: string;
}

export function AgentSessionRecoveryPanel({
  className = '',
}: AgentSessionRecoveryPanelProps): JSX.Element | null {
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

  const isEphemeral = summary.status === 'ephemeral';
  const toneClass = isEphemeral
    ? 'border-status-error/30 bg-status-error/10'
    : 'border-status-warning/30 bg-status-warning/10';
  const badgeClass = isEphemeral
    ? 'border-status-error/30 bg-status-error/10 text-status-error'
    : 'border-status-warning/30 bg-status-warning/10 text-status-warning';

  return (
    <section
      data-testid="agent-session-recovery-panel"
      className={`border-b px-3 py-2 ${toneClass} ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-text-primary">Session Recovery</h3>
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] ${badgeClass}`}
            >
              {summary.label}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-text-secondary">{summary.description}</p>
        </div>

        <div className="shrink-0 text-right text-[10px] text-text-tertiary">
          <p>{summary.hasActiveIssues ? 'Current run' : 'Earlier in this app session'}</p>
          <p>{summary.isRestartSafe ? 'Restart safety: limited' : 'Restart safety: not guaranteed'}</p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {summary.visibleIssues.map((issue) => (
          <span
            key={`${issue.sessionId}-${issue.stage}`}
            className="rounded-full border border-border-subtle bg-surface-elevated px-2 py-0.5 text-[10px] text-text-secondary"
            title={issue.message}
          >
            {STAGE_COPY[issue.stage]}
          </span>
        ))}
      </div>
    </section>
  );
}

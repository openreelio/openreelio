import { useEffect } from 'react';
import { useConversationStore } from '@/stores/conversationStore';
import {
  buildAgentSessionRecoveryFingerprint,
  summarizeAgentSessionResumeHistory,
  useAgentSessionStore,
} from '@/stores/agentSessionStore';

const MODE_BADGE_CLASS = {
  full: 'border-status-success/30 bg-status-success/10 text-status-success',
  degraded: 'border-status-warning/30 bg-status-warning/10 text-status-warning',
  cold: 'border-status-info/30 bg-status-info/10 text-status-info',
  ephemeral: 'border-status-error/30 bg-status-error/10 text-status-error',
} as const;

const BOUNDARY_BADGE_CLASS = {
  checkpoint: 'border-status-success/30 bg-status-success/10 text-status-success',
  summary_boundary: 'border-status-warning/30 bg-status-warning/10 text-status-warning',
  conversation_log: 'border-status-info/30 bg-status-info/10 text-status-info',
  session_kernel_unavailable: 'border-border-subtle bg-surface-elevated text-text-secondary',
} as const;

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) {
    return 'Not recorded yet';
  }

  const iso = new Date(timestamp).toISOString();
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

function humanizeToken(value: string): string {
  return value.replace(/_/g, ' ');
}

export interface AgentSessionResumeHistoryPanelProps {
  className?: string;
}

export function AgentSessionResumeHistoryPanel({
  className = '',
}: AgentSessionResumeHistoryPanelProps): JSX.Element | null {
  const activeSessionId = useConversationStore((state) => state.activeSessionId);
  const snapshot = useAgentSessionStore((state) =>
    activeSessionId ? state.snapshotsById[activeSessionId] : undefined,
  );
  const activeIssues = useAgentSessionStore((state) =>
    activeSessionId ? state.persistenceIssuesBySessionId[activeSessionId] : undefined,
  );
  const latchedIssues = useAgentSessionStore((state) =>
    activeSessionId ? state.persistenceLatchesBySessionId[activeSessionId] : undefined,
  );
  const artifacts = useAgentSessionStore((state) =>
    activeSessionId ? state.recoveryArtifactsBySessionId[activeSessionId] : undefined,
  );
  const refreshRecoveryArtifacts = useAgentSessionStore((state) => state.refreshRecoveryArtifacts);

  const headerFingerprint = snapshot?.session
    ? buildAgentSessionRecoveryFingerprint(snapshot.session)
    : null;

  useEffect(() => {
    if (!activeSessionId || !headerFingerprint) {
      return;
    }

    if (
      artifacts?.isLoading
      || (
        artifacts?.headerFingerprint === headerFingerprint
        && artifacts.lastRefreshedAt !== null
      )
    ) {
      return;
    }

    void refreshRecoveryArtifacts(activeSessionId, {
      headerFingerprint,
    });
  }, [
    activeSessionId,
    artifacts?.headerFingerprint,
    artifacts?.isLoading,
    artifacts?.lastRefreshedAt,
    headerFingerprint,
    refreshRecoveryArtifacts,
  ]);

  if (!activeSessionId) {
    return null;
  }

  if (!snapshot?.session) {
    return (
      <section
        data-testid="agent-session-resume-history-panel"
        className={`border-b border-border-subtle bg-surface-base px-3 py-2 ${className}`}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium text-text-primary">Resume History</h3>
          <span className="rounded-full border border-border-subtle bg-surface-elevated px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-text-secondary">
            Pending
          </span>
        </div>
        <p className="mt-1 text-[11px] text-text-secondary">
          This conversation has not been hydrated into the session kernel yet. Restart anchor
          details will appear after persisted session state is loaded.
        </p>
      </section>
    );
  }

  const history = summarizeAgentSessionResumeHistory({
    session: snapshot.session,
    activeIssues,
    latchedIssues,
    artifacts,
  });
  const boundaryTimestamp = history.activeCheckpoint?.createdAt
    ?? history.latestSummaryCompaction?.createdAt
    ?? history.latestCompaction?.createdAt
    ?? snapshot.session.lastResumedAt
    ?? snapshot.session.lastCompactedAt;

  return (
    <section
      data-testid="agent-session-resume-history-panel"
      className={`border-b border-border-subtle bg-surface-base px-3 py-2 ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-medium text-text-primary">Resume History</h3>
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] ${MODE_BADGE_CLASS[history.status]}`}
            >
              {history.label}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] ${BOUNDARY_BADGE_CLASS[history.restartBoundary.kind]}`}
            >
              {history.restartBoundary.title}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-text-secondary">{history.description}</p>
          <p className="mt-1 text-[11px] text-text-tertiary">
            {history.restartBoundary.description}
          </p>
          {artifacts?.lastError && (
            <p className="mt-1 text-[10px] text-status-warning">
              Persisted resume history refresh is partial: {artifacts.lastError}
            </p>
          )}
          {artifacts?.isLoading && (
            <p className="mt-1 text-[10px] text-text-tertiary">
              Refreshing persisted resume artifacts...
            </p>
          )}
        </div>

        <div className="shrink-0 text-right text-[10px] text-text-tertiary">
          <p>Preferred anchor</p>
          <p>{formatTimestamp(boundaryTimestamp ?? null)}</p>
        </div>
      </div>

      <div className="mt-2 grid gap-1 text-[10px] text-text-secondary sm:grid-cols-2">
        <p>
          Checkpoint:
          {' '}
          {history.activeCheckpoint
            ? `${humanizeToken(history.activeCheckpoint.checkpointKind)} / ${history.activeCheckpoint.status}`
            : 'not linked'}
        </p>
        <p>
          Compaction:
          {' '}
          {history.latestCompaction
            ? `${history.latestCompaction.tier} / ${history.latestCompaction.trigger}`
            : 'not recorded'}
        </p>
        <p>Resume cursor v{snapshot.session.resumeCursorVersion}</p>
        <p>Compaction v{snapshot.session.compactionVersion}</p>
        <p>{history.checkpointCount} persisted checkpoints</p>
        <p>{history.compactionCount} persisted compactions</p>
      </div>
    </section>
  );
}

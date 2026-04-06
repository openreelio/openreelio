import { useCallback, useEffect, useMemo } from 'react';
import { useConversationStore } from '@/stores/conversationStore';
import { useAgentArtifactReviewStore } from '@/stores/agentArtifactReviewStore';
import { useAgentDelegationStore } from '@/stores/agentDelegationStore';
import {
  buildAgentArtifactSessionSummary,
  resolvePreferredArtifactFocus,
} from './agentArtifactSummary';
import { AgentArtifactDetailPanel } from './AgentArtifactDetailPanel';
import { isSameArtifactFocus, type AgentArtifactFocus } from './agentArtifactFocus';
import {
  parseDelegationResultPayload,
  resolveDelegationReviewFocus,
} from './agentDelegationResult';

interface ReviewSourceNavItem {
  conversationId: string;
  projectId: string;
  title: string;
  agentProfileId: string;
  sourceKind: 'current' | 'delegated' | 'parent';
  statusLabel?: string | null;
  defaultFocus: AgentArtifactFocus | null;
}

function formatDelegationStatus(status: string): string {
  switch (status) {
    case 'requested':
      return 'Requested';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

function getSourceKindLabel(kind: ReviewSourceNavItem['sourceKind']): string {
  switch (kind) {
    case 'current':
      return 'Current';
    case 'delegated':
      return 'Delegated';
    case 'parent':
      return 'Parent';
    default:
      return kind;
  }
}

export function AgentArtifactReviewPanel({ className = '' }: { className?: string }) {
  const activeConversationId = useConversationStore(
    (state) => state.activeConversation?.id ?? null,
  );
  const activeProjectId = useConversationStore((state) => state.activeProjectId);
  const activeSessions = useConversationStore((state) => state.sessions);
  const messages = useConversationStore((state) => state.activeConversation?.messages ?? []);
  const delegationRecordsBySessionId = useAgentDelegationStore((state) => state.recordsBySessionId);
  const selection = useAgentArtifactReviewStore((state) => state.selection);
  const reviewSource = useAgentArtifactReviewStore((state) =>
    selection.conversationId
      ? (state.sourcesByConversationId[selection.conversationId] ?? null)
      : null,
  );
  const isReviewSourceLoading = useAgentArtifactReviewStore((state) =>
    selection.conversationId
      ? (state.isLoadingByConversationId[selection.conversationId] ?? false)
      : false,
  );
  const reviewSourceError = useAgentArtifactReviewStore((state) =>
    selection.conversationId
      ? (state.lastErrorByConversationId[selection.conversationId] ?? null)
      : null,
  );
  const setSelection = useAgentArtifactReviewStore((state) => state.setSelection);
  const clearSelection = useAgentArtifactReviewStore((state) => state.clearSelection);
  const ensureSourceLoaded = useAgentArtifactReviewStore((state) => state.ensureSourceLoaded);

  useEffect(() => {
    if (
      !selection.conversationId ||
      selection.conversationId === activeConversationId ||
      reviewSource
    ) {
      return;
    }

    void ensureSourceLoaded(selection.conversationId).catch(() => {});
  }, [activeConversationId, ensureSourceLoaded, reviewSource, selection.conversationId]);

  const reviewSession = useMemo(() => {
    if (selection.conversationId && selection.conversationId !== activeConversationId) {
      return reviewSource;
    }

    return {
      conversationId: activeConversationId,
      projectId: activeProjectId,
      title:
        activeSessions.find((session) => session.id === activeConversationId)?.title ??
        selection.sourceLabel ??
        'Current Session',
      agentProfileId:
        activeSessions.find((session) => session.id === activeConversationId)?.agent ??
        selection.sourceAgentProfileId ??
        'editor',
      messages,
      createdAt: null,
      updatedAt: null,
    };
  }, [
    activeConversationId,
    activeProjectId,
    activeSessions,
    messages,
    reviewSource,
    selection.conversationId,
    selection.sourceAgentProfileId,
    selection.sourceLabel,
  ]);

  const reviewMessages = reviewSession?.messages ?? [];
  const sessionSummary = useMemo(
    () => buildAgentArtifactSessionSummary(reviewMessages),
    [reviewMessages],
  );
  const relatedSources = useMemo(() => {
    const sources: ReviewSourceNavItem[] = [];
    const seenConversationIds = new Set<string>();

    const pushSource = (source: ReviewSourceNavItem | null) => {
      if (!source || seenConversationIds.has(source.conversationId)) {
        return;
      }
      seenConversationIds.add(source.conversationId);
      sources.push(source);
    };

    if (activeConversationId && activeProjectId) {
      const activeSession = activeSessions.find((session) => session.id === activeConversationId);
      const activeSummary = buildAgentArtifactSessionSummary(messages);
      pushSource({
        conversationId: activeConversationId,
        projectId: activeProjectId,
        title: activeSession?.title ?? 'Current Session',
        agentProfileId: activeSession?.agent ?? 'editor',
        sourceKind: 'current',
        defaultFocus: resolvePreferredArtifactFocus(activeSummary),
      });
    }

    const relatedRecordSessionIds = new Set<string>();
    if (activeConversationId) {
      relatedRecordSessionIds.add(activeConversationId);
    }
    if (selection.conversationId) {
      relatedRecordSessionIds.add(selection.conversationId);
    }

    Array.from(relatedRecordSessionIds)
      .flatMap((sessionId) => delegationRecordsBySessionId[sessionId] ?? [])
      .forEach((record) => {
        const childSession = activeSessions.find((session) => session.id === record.childSessionId);
        const parentSession = activeSessions.find(
          (session) => session.id === record.parentSessionId,
        );
        const delegationResult = parseDelegationResultPayload(record.resultJson);

        pushSource({
          conversationId: record.childSessionId,
          projectId:
            childSession?.projectId ?? reviewSource?.projectId ?? selection.projectId ?? '',
          title: childSession?.title ?? selection.sourceLabel ?? 'Delegated Session',
          agentProfileId: childSession?.agent ?? record.agentProfileId,
          sourceKind: 'delegated',
          statusLabel: formatDelegationStatus(record.status),
          defaultFocus: resolveDelegationReviewFocus(delegationResult),
        });

        if (parentSession && activeProjectId) {
          pushSource({
            conversationId: parentSession.id,
            projectId: parentSession.projectId,
            title: parentSession.title,
            agentProfileId: parentSession.agent,
            sourceKind: 'parent',
            defaultFocus:
              parentSession.id === activeConversationId
                ? resolvePreferredArtifactFocus(buildAgentArtifactSessionSummary(messages))
                : null,
          });
        }
      });

    if (
      reviewSource &&
      selection.conversationId &&
      !seenConversationIds.has(selection.conversationId)
    ) {
      pushSource({
        conversationId: reviewSource.conversationId,
        projectId: reviewSource.projectId,
        title: reviewSource.title,
        agentProfileId: reviewSource.agentProfileId,
        sourceKind: selection.conversationId === activeConversationId ? 'current' : 'delegated',
        defaultFocus: resolvePreferredArtifactFocus(
          buildAgentArtifactSessionSummary(reviewSource.messages),
        ),
      });
    }

    return sources;
  }, [
    activeConversationId,
    activeProjectId,
    activeSessions,
    delegationRecordsBySessionId,
    messages,
    reviewSource,
    selection.conversationId,
    selection.projectId,
    selection.sourceLabel,
  ]);

  const activeFocus = useMemo(() => {
    if (!selection.focus) {
      return null;
    }

    if (!reviewSession) {
      return null;
    }

    if (
      selection.projectId !== reviewSession.projectId ||
      selection.conversationId !== reviewSession.conversationId
    ) {
      return null;
    }

    return selection.focus;
  }, [reviewSession, selection]);

  const hasArtifacts =
    sessionSummary.toolRuns > 0 || sessionSummary.touchedFiles > 0 || sessionSummary.hasCompaction;

  const handleSelectFocus = useCallback(
    (focus: AgentArtifactFocus) => {
      if (isSameArtifactFocus(activeFocus, focus)) {
        clearSelection();
        return;
      }

      setSelection({
        focus,
        projectId: reviewSession?.projectId ?? activeProjectId,
        conversationId: reviewSession?.conversationId ?? activeConversationId,
        sourceLabel: reviewSession?.title ?? selection.sourceLabel,
        sourceAgentProfileId: reviewSession?.agentProfileId ?? selection.sourceAgentProfileId,
      });
    },
    [
      activeConversationId,
      activeFocus,
      activeProjectId,
      clearSelection,
      reviewSession,
      selection.sourceAgentProfileId,
      selection.sourceLabel,
      setSelection,
    ],
  );

  const handleSelectSource = useCallback(
    (source: ReviewSourceNavItem) => {
      setSelection({
        focus: source.defaultFocus,
        projectId: source.projectId,
        conversationId: source.conversationId,
        sourceLabel: source.title,
        sourceAgentProfileId: source.agentProfileId,
      });
    },
    [setSelection],
  );

  const renderSelectorButton = (label: string, focus: AgentArtifactFocus, testId: string) => {
    const isActive = isSameArtifactFocus(activeFocus, focus);

    return (
      <button
        key={testId}
        type="button"
        onClick={() => handleSelectFocus(focus)}
        data-testid={testId}
        className={`w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
          isActive
            ? 'bg-primary-500/15 text-primary-300 ring-1 ring-primary-500/40'
            : 'bg-editor-sidebar text-editor-text hover:bg-editor-border/50'
        }`}
      >
        {label}
      </button>
    );
  };

  if (!hasArtifacts) {
    if (isReviewSourceLoading) {
      return (
        <div
          className={`flex h-full items-center justify-center p-6 text-center ${className}`}
          data-testid="agent-artifact-review-panel-loading"
        >
          <div>
            <p className="text-sm font-medium text-editor-text">Loading review source</p>
            <p className="mt-2 text-xs text-editor-text-muted">
              Fetching the selected delegation session for read-only review.
            </p>
          </div>
        </div>
      );
    }

    if (reviewSourceError) {
      return (
        <div
          className={`flex h-full items-center justify-center p-6 text-center ${className}`}
          data-testid="agent-artifact-review-panel-error"
        >
          <div>
            <p className="text-sm font-medium text-editor-text">Unable to load review source</p>
            <p className="mt-2 text-xs text-editor-text-muted">{reviewSourceError}</p>
          </div>
        </div>
      );
    }

    return (
      <div
        className={`flex h-full items-center justify-center p-6 text-center ${className}`}
        data-testid="agent-artifact-review-panel-empty"
      >
        <div>
          <p className="text-sm font-medium text-editor-text">No artifact selected</p>
          <p className="mt-2 text-xs text-editor-text-muted">
            Run an AI-assisted edit first, then review its tool calls, files, and summaries here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex h-full flex-col bg-editor-bg ${className}`}
      data-testid="agent-artifact-review-panel"
    >
      <div className="border-b border-editor-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-editor-text-muted">
            Agent Review
          </span>
          {reviewSession?.title && (
            <span className="rounded-full border border-editor-border bg-editor-sidebar px-2 py-0.5 text-[11px] text-editor-text-muted">
              {reviewSession.title}
            </span>
          )}
          {sessionSummary.toolRuns > 0 && (
            <span className="rounded-full border border-editor-border bg-editor-sidebar px-2 py-0.5 text-[11px] text-editor-text-muted">
              {sessionSummary.toolRuns} tool runs
            </span>
          )}
          {sessionSummary.touchedFiles > 0 && (
            <span className="rounded-full border border-editor-border bg-editor-sidebar px-2 py-0.5 text-[11px] text-editor-text-muted">
              {sessionSummary.touchedFiles} files
            </span>
          )}
          {sessionSummary.hasCompaction && (
            <span className="rounded-full border border-editor-border bg-editor-sidebar px-2 py-0.5 text-[11px] text-editor-text-muted">
              summary
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-editor-text-muted">
          Inspect the latest execution details from the selected AI session.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
        <div className="overflow-auto border-r border-editor-border p-3">
          <div className="space-y-3">
            {relatedSources.length > 0 && (
              <section>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-editor-text-muted">
                  Sessions
                </p>
                <div className="space-y-1.5">
                  {relatedSources.map((source) => {
                    const isActiveSource = selection.conversationId === source.conversationId;

                    return (
                      <button
                        key={source.conversationId}
                        type="button"
                        onClick={() => handleSelectSource(source)}
                        data-testid={`review-source-${source.conversationId}`}
                        className={`w-full rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                          isActiveSource
                            ? 'bg-primary-500/15 text-primary-300 ring-1 ring-primary-500/40'
                            : 'bg-editor-sidebar text-editor-text hover:bg-editor-border/50'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{source.title}</span>
                          <span className="rounded-full border border-editor-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-editor-text-muted">
                            {getSourceKindLabel(source.sourceKind)}
                          </span>
                        </div>
                        {source.statusLabel && (
                          <div className="mt-1 text-[11px] text-editor-text-muted">
                            {source.statusLabel}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {sessionSummary.recentTools.length > 0 && (
              <section>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-editor-text-muted">
                  Tools
                </p>
                <div className="space-y-1.5">
                  {sessionSummary.recentTools.map((tool) =>
                    renderSelectorButton(
                      tool,
                      { kind: 'tool', value: tool },
                      `review-tool-${tool}`,
                    ),
                  )}
                </div>
              </section>
            )}

            {sessionSummary.recentFiles.length > 0 && (
              <section>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-editor-text-muted">
                  Files
                </p>
                <div className="space-y-1.5">
                  {sessionSummary.recentFiles.map((file) =>
                    renderSelectorButton(
                      file,
                      { kind: 'file', value: file },
                      `review-file-${file}`,
                    ),
                  )}
                </div>
              </section>
            )}

            {sessionSummary.hasCompaction && (
              <section>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-editor-text-muted">
                  Summary
                </p>
                {renderSelectorButton('Context summary', { kind: 'summary' }, 'review-summary')}
              </section>
            )}
          </div>
        </div>

        <div className="min-h-0 overflow-hidden">
          {activeFocus ? (
            <AgentArtifactDetailPanel
              messages={reviewMessages}
              focus={activeFocus}
              variant="panel"
            />
          ) : (
            <div
              className="flex h-full items-center justify-center p-6 text-center"
              data-testid="agent-artifact-review-panel-unselected"
            >
              <div>
                <p className="text-sm font-medium text-editor-text">Select an artifact to review</p>
                <p className="mt-2 text-xs text-editor-text-muted">
                  Choose a tool, file, or context summary from the list to inspect its latest
                  details.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConversationStore } from '@/stores/conversationStore';
import { useAgentArtifactReviewStore } from '@/stores/agentArtifactReviewStore';
import { useAgentDelegationStore } from '@/stores/agentDelegationStore';
import { useAgentSessionStore } from '@/stores/agentSessionStore';
import { getAgentDisplayName } from '@/agents/engine/core/agentCatalog';
import { writeWorkspaceDocumentToBackend } from '@/services/workspaceGateway';
import {
  buildAgentArtifactSessionSummary,
  resolvePreferredArtifactFocus,
} from './agentArtifactSummary';
import { AgentArtifactDetailPanel } from './AgentArtifactDetailPanel';
import { isSameArtifactFocus, type AgentArtifactFocus } from './agentArtifactFocus';
import {
  deriveDelegationReviewState,
  parseDelegationResultPayload,
  resolveDelegationAutoVerificationLabel,
  resolveDelegationReviewFocus,
  withDelegationVerification,
} from './agentDelegationResult';
import {
  buildDelegationContextPacket,
  buildDelegationContractSystemMessage,
  parseDelegationContextPacket,
  type DelegationRecommendation,
} from './agentDelegationContract';
import { buildVerifierPacket } from './agentVerifierPacket';

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

function formatDelegationMergeStatus(status: string): string {
  switch (status) {
    case 'merged':
      return 'Merged';
    case 'discarded':
      return 'Discarded';
    default:
      return 'Pending merge';
  }
}

function formatDelegationReviewOutcome(
  mergeStatus: string,
  reviewPhase: NonNullable<ReturnType<typeof deriveDelegationReviewState>>['phase'] | undefined,
): string {
  if (reviewPhase === 'failed' || reviewPhase === 'cancelled') {
    return 'Not mergeable';
  }

  return formatDelegationMergeStatus(mergeStatus);
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

function formatDelegationRecommendation(recommendation: DelegationRecommendation): string {
  switch (recommendation) {
    case 'merge':
      return 'Merge';
    case 'follow_up':
      return 'Follow-up';
    case 'discard':
      return 'Discard';
    default:
      return recommendation;
  }
}

export function AgentArtifactReviewPanel({ className = '' }: { className?: string }) {
  const [isApplyingReviewDecision, setIsApplyingReviewDecision] = useState(false);
  const [isLaunchingVerifier, setIsLaunchingVerifier] = useState(false);
  const [verifierLaunchError, setVerifierLaunchError] = useState<string | null>(null);
  const activeConversationId = useConversationStore(
    (state) => state.activeConversation?.id ?? null,
  );
  const activeProjectId = useConversationStore((state) => state.activeProjectId);
  const activeSessions = useConversationStore((state) => state.sessions);
  const messages = useConversationStore((state) => state.activeConversation?.messages ?? []);
  const loadSessions = useConversationStore((state) => state.loadSessions);
  const switchSession = useConversationStore((state) => state.switchSession);
  const addSystemMessageToSession = useConversationStore(
    (state) => state.addSystemMessageToSession,
  );
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
  const loadAgentSession = useAgentSessionStore((state) => state.loadSession);
  const createDelegatedSession = useAgentDelegationStore((state) => state.createDelegatedSession);
  const loadDelegations = useAgentDelegationStore((state) => state.loadDelegations);
  const updateDelegationRecord = useAgentDelegationStore((state) => state.updateDelegationRecord);

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
  const allDelegationRecords = useMemo(() => {
    const uniqueRecords = new Map<string, (typeof delegationRecordsBySessionId)[string][number]>();

    Object.values(delegationRecordsBySessionId).forEach((records) => {
      records.forEach((record) => {
        uniqueRecords.set(record.id, record);
      });
    });

    return [...uniqueRecords.values()];
  }, [delegationRecordsBySessionId]);
  const reviewDelegationRecord = useMemo(() => {
    const reviewConversationId = reviewSession?.conversationId ?? selection.conversationId;

    if (!reviewConversationId) {
      return null;
    }

    return (
      allDelegationRecords.find((record) => record.childSessionId === reviewConversationId) ?? null
    );
  }, [allDelegationRecords, reviewSession?.conversationId, selection.conversationId]);

  useEffect(() => {
    setVerifierLaunchError(null);
  }, [reviewDelegationRecord?.id]);
  const reviewDelegationResult = useMemo(
    () =>
      parseDelegationResultPayload(reviewDelegationRecord?.resultJson, {
        contextPacketJson: reviewDelegationRecord?.contextPacketJson,
        specialistId: reviewDelegationRecord?.agentProfileId,
      }),
    [
      reviewDelegationRecord?.agentProfileId,
      reviewDelegationRecord?.contextPacketJson,
      reviewDelegationRecord?.resultJson,
    ],
  );
  const reviewDelegationContext = useMemo(
    () =>
      parseDelegationContextPacket(reviewDelegationRecord?.contextPacketJson, {
        specialistId: reviewDelegationRecord?.agentProfileId,
        specialistName: reviewDelegationRecord?.agentProfileId
          ? getAgentDisplayName(reviewDelegationRecord.agentProfileId)
          : undefined,
      }),
    [reviewDelegationRecord?.agentProfileId, reviewDelegationRecord?.contextPacketJson],
  );
  const reviewDelegationState = useMemo(
    () => deriveDelegationReviewState(reviewDelegationRecord, reviewDelegationResult),
    [reviewDelegationRecord, reviewDelegationResult],
  );
  const isVerifierReview = reviewDelegationRecord?.agentProfileId === 'verifier';
  const verifierRecommendation = reviewDelegationResult?.handoff.recommendation ?? null;
  const verifierReviewTargetRecord = useMemo(() => {
    const delegationId = reviewDelegationContext?.reviewTarget?.delegationId;

    if (!delegationId) {
      return null;
    }

    return allDelegationRecords.find((record) => record.id === delegationId) ?? null;
  }, [allDelegationRecords, reviewDelegationContext?.reviewTarget?.delegationId]);
  const verifierReviewTargetResult = useMemo(
    () =>
      parseDelegationResultPayload(verifierReviewTargetRecord?.resultJson, {
        contextPacketJson: verifierReviewTargetRecord?.contextPacketJson,
        specialistId: verifierReviewTargetRecord?.agentProfileId,
      }),
    [
      verifierReviewTargetRecord?.agentProfileId,
      verifierReviewTargetRecord?.contextPacketJson,
      verifierReviewTargetRecord?.resultJson,
    ],
  );
  const verifierReviewTargetState = useMemo(
    () => deriveDelegationReviewState(verifierReviewTargetRecord, verifierReviewTargetResult),
    [verifierReviewTargetRecord, verifierReviewTargetResult],
  );
  const verifierReviewTargetSession = useMemo(
    () =>
      activeSessions.find((session) => session.id === verifierReviewTargetRecord?.childSessionId) ??
      null,
    [activeSessions, verifierReviewTargetRecord?.childSessionId],
  );
  const canApplyDelegationReview = reviewDelegationState?.canApplyReview ?? false;
  const canConfirmDelegationMerge =
    canApplyDelegationReview && reviewDelegationResult?.autoVerification.status === 'pass';
  const canApplyVerifierRecommendation = Boolean(
    isVerifierReview &&
    verifierRecommendation &&
    verifierReviewTargetRecord &&
    verifierReviewTargetResult &&
    reviewDelegationState?.canApplyReview &&
    reviewDelegationResult?.autoVerification.status === 'pass' &&
    verifierReviewTargetState?.canApplyReview &&
    (verifierRecommendation !== 'merge' ||
      verifierReviewTargetResult.autoVerification.status === 'pass'),
  );
  const shouldShowDirectReviewActions =
    canApplyDelegationReview && !(isVerifierReview && verifierReviewTargetRecord);
  const canLaunchVerifier = Boolean(
    reviewDelegationRecord &&
    reviewDelegationResult &&
    reviewDelegationRecord.status === 'completed' &&
    reviewDelegationRecord.agentProfileId !== 'verifier' &&
    reviewDelegationState?.phase !== 'failed' &&
    reviewDelegationState?.phase !== 'cancelled',
  );
  const autoVerificationLabel = useMemo(
    () => resolveDelegationAutoVerificationLabel(reviewDelegationResult),
    [reviewDelegationResult],
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
        const delegationResult = parseDelegationResultPayload(record.resultJson, {
          contextPacketJson: record.contextPacketJson,
          specialistId: record.agentProfileId,
        });
        const reviewState = deriveDelegationReviewState(record, delegationResult);

        pushSource({
          conversationId: record.childSessionId,
          projectId:
            childSession?.projectId ?? reviewSource?.projectId ?? selection.projectId ?? '',
          title: childSession?.title ?? selection.sourceLabel ?? 'Delegated Session',
          agentProfileId: childSession?.agent ?? record.agentProfileId,
          sourceKind: 'delegated',
          statusLabel:
            reviewState && record.status === 'completed'
              ? `${formatDelegationStatus(record.status)} · ${reviewState.label}`
              : formatDelegationStatus(record.status),
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

  const hasDelegationReview = Boolean(reviewDelegationRecord && reviewDelegationResult);

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

  const handleApplyDelegationReview = useCallback(
    async (
      verdict: 'pass' | 'fail' | 'partial',
      mergeStatus: 'merged' | 'discarded' | 'pending',
      summary: string,
    ) => {
      if (!reviewDelegationRecord || !reviewDelegationResult) {
        return;
      }

      setIsApplyingReviewDecision(true);
      try {
        await updateDelegationRecord({
          id: reviewDelegationRecord.id,
          mergeStatus,
          resultJson: JSON.stringify(
            withDelegationVerification(reviewDelegationResult, {
              verdict,
              summary,
              verifiedAt: Date.now(),
            }),
          ),
        });
      } finally {
        setIsApplyingReviewDecision(false);
      }
    },
    [reviewDelegationRecord, reviewDelegationResult, updateDelegationRecord],
  );

  const handleOpenReviewedHandoff = useCallback(() => {
    if (!verifierReviewTargetRecord) {
      return;
    }

    setSelection({
      focus: resolveDelegationReviewFocus(verifierReviewTargetResult),
      projectId:
        verifierReviewTargetSession?.projectId ?? reviewSession?.projectId ?? activeProjectId,
      conversationId: verifierReviewTargetRecord.childSessionId,
      sourceLabel:
        verifierReviewTargetSession?.title ??
        getAgentDisplayName(verifierReviewTargetRecord.agentProfileId),
      sourceAgentProfileId:
        verifierReviewTargetSession?.agent ?? verifierReviewTargetRecord.agentProfileId,
    });
  }, [
    activeProjectId,
    reviewSession?.projectId,
    setSelection,
    verifierReviewTargetRecord,
    verifierReviewTargetResult,
    verifierReviewTargetSession?.agent,
    verifierReviewTargetSession?.projectId,
    verifierReviewTargetSession?.title,
  ]);

  const handleApplyVerifierRecommendation = useCallback(async () => {
    if (
      !verifierRecommendation ||
      !reviewDelegationRecord ||
      !verifierReviewTargetRecord ||
      !verifierReviewTargetResult ||
      !reviewDelegationResult
    ) {
      return;
    }

    const reviewSummary =
      reviewDelegationResult.handoff.summary ??
      reviewDelegationResult.preview ??
      reviewDelegationResult.verification.summary ??
      'Verifier recommendation applied to the reviewed delegation.';

    const nextDecision =
      verifierRecommendation === 'merge'
        ? {
            verdict: 'pass' as const,
            mergeStatus: 'merged' as const,
            summary: `Verifier recommended merge. ${reviewSummary}`,
          }
        : verifierRecommendation === 'follow_up'
          ? {
              verdict: 'partial' as const,
              mergeStatus: 'pending' as const,
              summary: `Verifier recommended follow-up. ${reviewSummary}`,
            }
          : {
              verdict: 'fail' as const,
              mergeStatus: 'discarded' as const,
              summary: `Verifier recommended discard. ${reviewSummary}`,
            };

    setIsApplyingReviewDecision(true);
    try {
      const verifiedAt = Date.now();

      await Promise.all([
        updateDelegationRecord({
          id: verifierReviewTargetRecord.id,
          mergeStatus: nextDecision.mergeStatus,
          resultJson: JSON.stringify(
            withDelegationVerification(verifierReviewTargetResult, {
              verdict: nextDecision.verdict,
              summary: nextDecision.summary,
              verifiedAt,
            }),
          ),
        }),
        updateDelegationRecord({
          id: reviewDelegationRecord.id,
          mergeStatus: 'merged',
          resultJson: JSON.stringify(
            withDelegationVerification(reviewDelegationResult, {
              verdict: 'pass',
              summary: 'Parent accepted the verifier recommendation.',
              verifiedAt,
            }),
          ),
        }),
      ]);
    } finally {
      setIsApplyingReviewDecision(false);
    }
  }, [
    reviewDelegationRecord,
    reviewDelegationResult,
    updateDelegationRecord,
    verifierRecommendation,
    verifierReviewTargetRecord,
    verifierReviewTargetResult,
  ]);

  const handleLaunchVerifier = useCallback(async () => {
    if (!reviewDelegationRecord || !reviewDelegationResult) {
      return;
    }

    const parentSession = activeSessions.find(
      (session) => session.id === reviewDelegationRecord.parentSessionId,
    );
    const parentAgentId = parentSession?.agent ?? 'editor';
    const parentLabel = parentSession?.title ?? getAgentDisplayName(parentAgentId);
    const projectId = parentSession?.projectId ?? reviewSession?.projectId ?? activeProjectId;

    if (!projectId) {
      setVerifierLaunchError('Unable to determine the project for verifier launch.');
      return;
    }

    setIsLaunchingVerifier(true);
    setVerifierLaunchError(null);

    try {
      let parentSequenceId: string | null = null;
      try {
        const parentSnapshot = await loadAgentSession(reviewDelegationRecord.parentSessionId);
        parentSequenceId = parentSnapshot.session.sequenceId ?? null;
      } catch {
        // Best-effort only; verifier can still launch without a hydrated parent snapshot.
      }

      const verifierPacket = buildVerifierPacket({
        record: reviewDelegationRecord,
        reviewSession,
        contextPacket: reviewDelegationContext,
        result: reviewDelegationResult,
        reviewState: reviewDelegationState,
      });

      await writeWorkspaceDocumentToBackend(
        verifierPacket.relativePath,
        verifierPacket.content,
        true,
      );

      const verifierContextPacket = buildDelegationContextPacket({
        parentSessionId: reviewDelegationRecord.parentSessionId,
        parentAgentId,
        parentAgentName: parentLabel,
        delegatedGoal: verifierPacket.launchGoal,
        specialistId: 'verifier',
        specialistName: 'Verifier',
        reviewTarget: {
          delegationId: reviewDelegationRecord.id,
          childSessionId: reviewDelegationRecord.childSessionId,
          agentProfileId: reviewDelegationRecord.agentProfileId,
        },
      });

      const { childSession, delegationRecord, delegationErrorMessage } =
        await createDelegatedSession({
          parentSessionId: reviewDelegationRecord.parentSessionId,
          parentRunId: reviewDelegationRecord.parentRunId,
          projectId,
          sequenceId: parentSequenceId,
          agentProfileId: 'verifier',
          title: `Verifier: ${reviewDelegationRecord.delegatedGoal.slice(0, 48)}`,
          delegatedGoal: verifierPacket.launchGoal,
          contextPacketJson: JSON.stringify(verifierContextPacket),
        });

      try {
        await loadAgentSession(childSession.id);
      } catch {
        // Best-effort hydration only; session switching still works without it.
      }

      await loadSessions(projectId);
      await switchSession(childSession.id);

      addSystemMessageToSession(
        childSession.id,
        buildDelegationContractSystemMessage(verifierContextPacket),
      );
      addSystemMessageToSession(
        childSession.id,
        `Verification packet: ${verifierPacket.relativePath}\nRead this document first. Validate the reviewed delegation against its contract and return a DELEGATION_HANDOFF with a merge recommendation.`,
      );

      if (delegationRecord) {
        await loadDelegations(childSession.id).catch(() => {});
      } else if (delegationErrorMessage) {
        setVerifierLaunchError(
          `Verifier delegation tracking unavailable: ${delegationErrorMessage}`,
        );
      }

      if (useConversationStore.getState().activeSessionId !== childSession.id) {
        setVerifierLaunchError(
          'Verifier session was created, but the workspace could not switch into it automatically.',
        );
      }
    } catch (error) {
      setVerifierLaunchError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLaunchingVerifier(false);
    }
  }, [
    activeProjectId,
    activeSessions,
    addSystemMessageToSession,
    createDelegatedSession,
    loadAgentSession,
    loadDelegations,
    loadSessions,
    reviewDelegationContext,
    reviewDelegationRecord,
    reviewDelegationResult,
    reviewDelegationState,
    reviewSession,
    switchSession,
  ]);

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

  if (!hasArtifacts && !hasDelegationReview) {
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
          {reviewDelegationRecord && (
            <span className="rounded-full border border-editor-border bg-editor-sidebar px-2 py-0.5 text-[11px] text-editor-text-muted">
              {formatDelegationReviewOutcome(
                reviewDelegationRecord.mergeStatus,
                reviewDelegationState?.phase,
              )}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-editor-text-muted">
          Inspect the latest execution details from the selected AI session.
        </p>
        {reviewDelegationRecord && reviewDelegationResult && (
          <div className="mt-3 rounded-md border border-editor-border bg-editor-sidebar px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-editor-text">Delegation handoff</span>
                  {reviewDelegationState?.label && (
                    <span className="rounded-full border border-editor-border bg-editor-bg px-2 py-0.5 text-[11px] text-editor-text-muted">
                      {reviewDelegationState.label}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-xs text-editor-text-muted">
                  {reviewDelegationState?.summary ??
                    reviewDelegationResult.verification.summary ??
                    'Completed child work remains pending until parent verification.'}
                </p>
                {reviewDelegationResult.preview && (
                  <p className="mt-2 truncate text-xs text-editor-text-muted">
                    Latest result: {reviewDelegationResult.preview}
                  </p>
                )}
                <div className="mt-3 space-y-2 rounded-md border border-editor-border/70 bg-editor-bg/50 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-editor-text-muted">
                      Automatic verification
                    </p>
                    {autoVerificationLabel && (
                      <span className="rounded-full border border-editor-border bg-editor-sidebar px-2 py-0.5 text-[11px] text-editor-text-muted">
                        {autoVerificationLabel}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-editor-text-muted">
                    {reviewDelegationResult.autoVerification.summary}
                  </p>
                  {reviewDelegationResult.autoVerification.missingRequirements.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-editor-text-muted">
                        Missing requirements
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {reviewDelegationResult.autoVerification.missingRequirements.map((item) => (
                          <span
                            key={item}
                            className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200"
                          >
                            {item}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {reviewDelegationResult.autoVerification.warnings.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-editor-text-muted">Warnings</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {reviewDelegationResult.autoVerification.warnings.map((warning) => (
                          <span
                            key={warning}
                            className="rounded-full border border-editor-border bg-editor-sidebar px-2 py-1 text-[11px] text-editor-text-muted"
                          >
                            {warning}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {reviewDelegationContext && (
                  <div className="mt-3 space-y-2 rounded-md border border-editor-border/70 bg-editor-bg/50 px-3 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-editor-text-muted">
                      Task contract
                    </p>
                    <p className="text-sm text-editor-text">
                      {reviewDelegationContext.taskContract.objective}
                    </p>
                    {reviewDelegationContext.taskContract.expectedDeliverables.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-editor-text-muted">
                          Expected handoff
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {reviewDelegationContext.taskContract.expectedDeliverables.map(
                            (deliverable) => (
                              <span
                                key={deliverable}
                                className="rounded-full border border-editor-border bg-editor-sidebar px-2 py-1 text-[11px] text-editor-text-muted"
                              >
                                {deliverable}
                              </span>
                            ),
                          )}
                        </div>
                      </div>
                    )}
                    {reviewDelegationContext.taskContract.acceptanceChecklist.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-editor-text-muted">
                          Acceptance checklist
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {reviewDelegationContext.taskContract.acceptanceChecklist.map((item) => (
                            <span
                              key={item}
                              className="rounded-full border border-editor-border bg-editor-sidebar px-2 py-1 text-[11px] text-editor-text-muted"
                            >
                              {item}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <p className="text-xs text-editor-text-muted">
                      {reviewDelegationContext.taskContract.handoffRequirement}
                    </p>
                  </div>
                )}
                {isVerifierReview && verifierReviewTargetRecord && (
                  <div className="mt-3 space-y-2 rounded-md border border-editor-border/70 bg-editor-bg/50 px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-editor-text-muted">
                        Verifier recommendation
                      </p>
                      {verifierRecommendation && (
                        <span className="rounded-full border border-editor-border bg-editor-sidebar px-2 py-0.5 text-[11px] text-editor-text-muted">
                          {formatDelegationRecommendation(verifierRecommendation)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-editor-text-muted">
                      {reviewDelegationResult.handoff.summary ??
                        reviewDelegationResult.preview ??
                        'Verifier did not return a parent-reviewable recommendation summary yet.'}
                    </p>
                    <p className="text-xs text-editor-text-muted">
                      Reviewed handoff:{' '}
                      {verifierReviewTargetSession?.title ??
                        getAgentDisplayName(verifierReviewTargetRecord.agentProfileId)}
                      {verifierReviewTargetState?.label
                        ? ` · ${verifierReviewTargetState.label}`
                        : ''}
                    </p>
                  </div>
                )}
              </div>
              {shouldShowDirectReviewActions && (
                <div className="flex flex-wrap items-center gap-2">
                  {canLaunchVerifier && (
                    <button
                      type="button"
                      onClick={() => void handleLaunchVerifier()}
                      disabled={isLaunchingVerifier}
                      className="rounded-md border border-editor-border bg-editor-bg px-2.5 py-1 text-xs text-editor-text transition-colors hover:bg-editor-border/40 disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid="delegation-review-launch-verifier-btn"
                    >
                      {isLaunchingVerifier ? 'Launching Verifier...' : 'Launch Verifier'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void handleApplyDelegationReview(
                        'pass',
                        'merged',
                        'Verified by parent review and ready to merge.',
                      )
                    }
                    disabled={isApplyingReviewDecision || !canConfirmDelegationMerge}
                    className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="delegation-review-verify-btn"
                  >
                    Mark Verified
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleApplyDelegationReview(
                        'partial',
                        'pending',
                        'Parent review requires follow-up before merge.',
                      )
                    }
                    disabled={isApplyingReviewDecision}
                    className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="delegation-review-follow-up-btn"
                  >
                    Needs Follow-up
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleApplyDelegationReview(
                        'fail',
                        'discarded',
                        'Parent review discarded this delegated result.',
                      )
                    }
                    disabled={isApplyingReviewDecision}
                    className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="delegation-review-discard-btn"
                  >
                    Discard
                  </button>
                  {!canConfirmDelegationMerge && (
                    <p className="w-full text-[11px] text-editor-text-muted">
                      Automatic contract verification must pass before this handoff can be merged.
                    </p>
                  )}
                  {verifierLaunchError && (
                    <p className="w-full text-[11px] text-rose-300">{verifierLaunchError}</p>
                  )}
                </div>
              )}
              {isVerifierReview && verifierReviewTargetRecord && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleOpenReviewedHandoff}
                    className="rounded-md border border-editor-border bg-editor-bg px-2.5 py-1 text-xs text-editor-text transition-colors hover:bg-editor-border/40"
                    data-testid="delegation-review-open-reviewed-handoff-btn"
                  >
                    Open Reviewed Handoff
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleApplyVerifierRecommendation()}
                    disabled={isApplyingReviewDecision || !canApplyVerifierRecommendation}
                    className="rounded-md border border-primary-500/30 bg-primary-500/10 px-2.5 py-1 text-xs text-primary-200 transition-colors hover:bg-primary-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="delegation-review-apply-verifier-recommendation-btn"
                  >
                    Apply Recommendation
                  </button>
                  {!canApplyVerifierRecommendation && (
                    <p className="w-full text-[11px] text-editor-text-muted">
                      The verifier must return a valid structured recommendation before it can be
                      applied.
                    </p>
                  )}
                  {verifierLaunchError && (
                    <p className="w-full text-[11px] text-rose-300">{verifierLaunchError}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
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
                  {hasArtifacts
                    ? 'Choose a tool, file, or context summary from the list to inspect its latest details.'
                    : canApplyDelegationReview
                      ? 'No detailed artifacts were captured for this delegation. Use the verification controls above to accept, request follow-up, or discard the handoff.'
                      : 'No detailed artifacts were captured for this delegation. This handoff is shown for reference only because it is not eligible for merge actions.'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

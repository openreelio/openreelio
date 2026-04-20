import { DEFAULT_AGENT_PROFILE_ID } from '@/agents/engine';
import { getAgentDisplayName } from '@/agents/engine/core/agentCatalog';
import type { DelegationRecord } from '@/agents/engine/core/agentSession';
import type { DelegatedChildItem, DelegatedParentContext } from './AgentDelegationStrip';
import { deriveDelegationReviewState, parseDelegationResultPayload } from './agentDelegationResult';
import { formatDelegationStatus } from './agentDelegationUi';

interface SessionListItem {
  id: string;
  title: string;
  agent: string | null;
}

interface ActiveAgentSnapshot {
  session: {
    lineage: {
      parentSessionId: string | null;
    };
  };
}

export interface OpenDelegationReviewInput {
  conversationId: string;
  title: string;
  agentProfileId: string;
  resultJson?: string | null;
}

interface BuildDelegatedChildItemsArgs {
  activeSessionId: string | null;
  delegationRecords: readonly DelegationRecord[];
  sessions: readonly SessionListItem[];
  handleSessionSwitch: (sessionId: string) => void;
  openDelegationReview: (input: OpenDelegationReviewInput) => void;
}

export function buildDelegatedChildItems({
  activeSessionId,
  delegationRecords,
  sessions,
  handleSessionSwitch,
  openDelegationReview,
}: BuildDelegatedChildItemsArgs): DelegatedChildItem[] {
  if (!activeSessionId) {
    return [];
  }

  return delegationRecords
    .filter((record) => record.parentSessionId === activeSessionId)
    .map((record) => {
      const childSession = sessions.find((session) => session.id === record.childSessionId);
      const resultPayload = parseDelegationResultPayload(record.resultJson, {
        contextPacketJson: record.contextPacketJson,
        specialistId: record.agentProfileId,
      });
      const reviewState = deriveDelegationReviewState(record, resultPayload);

      return {
        id: record.id,
        label: childSession?.title || getAgentDisplayName(record.agentProfileId),
        delegatedGoal: record.delegatedGoal,
        delegationStatus: record.status,
        mergeStatus: record.mergeStatus,
        errorMessage: record.errorMessage,
        statusLabel: formatDelegationStatus(record.status),
        resultPreview: resultPayload?.preview ?? resultPayload?.finalState ?? null,
        result: resultPayload,
        onOpen: () => handleSessionSwitch(record.childSessionId),
        onReview:
          reviewState || resultPayload
            ? () =>
                openDelegationReview({
                  conversationId: record.childSessionId,
                  title: childSession?.title || getAgentDisplayName(record.agentProfileId),
                  agentProfileId: record.agentProfileId,
                  resultJson: record.resultJson,
                })
            : undefined,
      };
    });
}

interface BuildDelegatedFromContextArgs {
  activeAgentDefinitionName?: string | null;
  activeAgentProfileId?: string | null;
  activeAgentSnapshot: ActiveAgentSnapshot | null;
  activeDelegationRecord: DelegationRecord | null;
  activeSessionId: string | null;
  sessions: readonly SessionListItem[];
  handleSessionSwitch: (sessionId: string) => void;
  openDelegationReview: (input: OpenDelegationReviewInput) => void;
}

export function buildDelegatedFromContext({
  activeAgentDefinitionName,
  activeAgentProfileId,
  activeAgentSnapshot,
  activeDelegationRecord,
  activeSessionId,
  sessions,
  handleSessionSwitch,
  openDelegationReview,
}: BuildDelegatedFromContextArgs): DelegatedParentContext | null {
  const parentSessionId = activeAgentSnapshot?.session.lineage.parentSessionId;
  if (!parentSessionId) {
    return null;
  }

  const parentSession = sessions.find((session) => session.id === parentSessionId);
  const resultPayload = parseDelegationResultPayload(activeDelegationRecord?.resultJson, {
    contextPacketJson: activeDelegationRecord?.contextPacketJson,
    specialistId: activeDelegationRecord?.agentProfileId,
  });
  const reviewState = deriveDelegationReviewState(activeDelegationRecord, resultPayload);

  return {
    parentLabel: parentSession?.title || getAgentDisplayName(parentSession?.agent ?? 'editor'),
    delegatedGoal: activeDelegationRecord?.delegatedGoal ?? null,
    delegationStatus: activeDelegationRecord?.status,
    mergeStatus: activeDelegationRecord?.mergeStatus,
    errorMessage: activeDelegationRecord?.errorMessage ?? null,
    statusLabel: activeDelegationRecord
      ? formatDelegationStatus(activeDelegationRecord.status)
      : 'Delegated',
    resultPreview: resultPayload?.preview ?? resultPayload?.finalState ?? null,
    result: resultPayload,
    onReview:
      reviewState || resultPayload
        ? () =>
            openDelegationReview({
              conversationId: activeSessionId ?? parentSessionId,
              title:
                sessions.find((session) => session.id === activeSessionId)?.title ||
                activeAgentDefinitionName ||
                'Delegated Session',
              agentProfileId: activeAgentProfileId ?? DEFAULT_AGENT_PROFILE_ID,
              resultJson: activeDelegationRecord?.resultJson ?? null,
            })
        : undefined,
    onReturnToParent: () => handleSessionSwitch(parentSessionId),
  };
}

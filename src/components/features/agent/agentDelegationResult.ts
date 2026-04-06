import type { AgentRunResult } from '@/agents/engine';
import type { ConversationMessage, MessagePart } from '@/agents/engine/core/conversation';
import { buildAgentArtifactSessionSummary } from './agentArtifactSummary';
import type { AgentArtifactFocus } from './agentArtifactFocus';

export interface DelegationResultPayload {
  success: boolean;
  aborted: boolean;
  totalDuration: number;
  iterations: number;
  finalState: string | null;
  executedSteps: number;
  successfulSteps: number;
  failedSteps: number;
  preview: string | null;
  recentTools: string[];
  recentFiles: string[];
}

export function parseDelegationResultPayload(
  value: string | null | undefined,
): DelegationResultPayload | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as DelegationResultPayload;
  } catch {
    return null;
  }
}

function extractPreviewFromPart(part: MessagePart): string | null {
  switch (part.type) {
    case 'text':
      return part.content.trim() || null;
    case 'clarification':
      return part.question.trim() || null;
    case 'compaction':
      return part.summary.trim() || null;
    case 'error':
      return part.message.trim() || null;
    default:
      return null;
  }
}

export function buildDelegationResultPayload(
  result: AgentRunResult,
  messages: readonly ConversationMessage[],
): DelegationResultPayload {
  const artifactSummary = buildAgentArtifactSessionSummary(messages);
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  const preview = latestAssistantMessage
    ? ([...latestAssistantMessage.parts]
        .reverse()
        .map(extractPreviewFromPart)
        .find((value): value is string => Boolean(value)) ?? null)
    : null;

  return {
    success: result.success,
    aborted: result.aborted,
    totalDuration: result.totalDuration,
    iterations: result.iterations,
    finalState: result.summary?.finalState ?? null,
    executedSteps: result.summary?.executedSteps ?? 0,
    successfulSteps: result.summary?.successfulSteps ?? 0,
    failedSteps: result.summary?.failedSteps ?? 0,
    preview,
    recentTools: artifactSummary.recentTools,
    recentFiles: artifactSummary.recentFiles,
  };
}

export function resolveDelegationSummaryMessageId(
  messages: readonly ConversationMessage[],
): string | null {
  return [...messages].reverse().find((message) => message.role === 'assistant')?.id ?? null;
}

export function resolveDelegationReviewFocus(
  result: DelegationResultPayload | null | undefined,
): AgentArtifactFocus | null {
  if (!result) {
    return null;
  }

  if (result.recentFiles.length > 0) {
    return { kind: 'file', value: result.recentFiles[0] };
  }

  if (result.recentTools.length > 0) {
    return { kind: 'tool', value: result.recentTools[0] };
  }

  return { kind: 'summary' };
}

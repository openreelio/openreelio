import type { AgentRunResult } from '@/agents/engine';
import type { DelegationRecord } from '@/agents/engine/core/agentSession';
import type { ConversationMessage, MessagePart } from '@/agents/engine/core/conversation';
import { buildAgentArtifactSessionSummary } from './agentArtifactSummary';
import type { AgentArtifactFocus } from './agentArtifactFocus';
import {
  parseDelegationContextPacket,
  type DelegationRecommendation,
} from './agentDelegationContract';

export type DelegationVerificationVerdict = 'unverified' | 'pass' | 'fail' | 'partial';

export interface DelegationVerificationEvidence {
  kind: 'file' | 'tool' | 'summary';
  value: string;
}

export interface DelegationVerification {
  verdict: DelegationVerificationVerdict;
  summary: string | null;
  verifiedAt: number | null;
  evidence: DelegationVerificationEvidence[];
}

export type DelegationHandoffParseStatus = 'missing' | 'invalid' | 'parsed';

export interface DelegationHandoff {
  parseStatus: DelegationHandoffParseStatus;
  recommendation: DelegationRecommendation | null;
  summary: string | null;
  summaryProvided: boolean;
  openIssues: string[];
  openIssuesDeclared: boolean;
  evidence: DelegationVerificationEvidence[];
}

export type DelegationAutoVerificationStatus = 'pass' | 'needs_follow_up' | 'fail';

export interface DelegationAutoVerification {
  status: DelegationAutoVerificationStatus;
  summary: string;
  missingRequirements: string[];
  warnings: string[];
  checkedAt: number | null;
}

export interface DelegationReviewState {
  phase:
    | 'pending_execution'
    | 'awaiting_review'
    | 'follow_up'
    | 'verified'
    | 'rejected'
    | 'failed'
    | 'cancelled';
  label: string;
  summary: string | null;
  canApplyReview: boolean;
}

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
  handoff: DelegationHandoff;
  autoVerification: DelegationAutoVerification;
  verification: DelegationVerification;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function normalizeEvidenceArray(value: unknown): DelegationVerificationEvidence[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is DelegationVerificationEvidence =>
        Boolean(
          entry &&
          typeof entry === 'object' &&
          (entry.kind === 'file' || entry.kind === 'tool' || entry.kind === 'summary') &&
          isString(entry.value),
        ),
      )
    : [];
}

function normalizeDelegationRecommendation(value: unknown): DelegationRecommendation | null {
  return value === 'merge' || value === 'follow_up' || value === 'discard' ? value : null;
}

function buildDelegationVerificationEvidence(input: {
  preview: string | null;
  finalState: string | null;
  recentFiles: string[];
  recentTools: string[];
}): DelegationVerificationEvidence[] {
  const evidence: DelegationVerificationEvidence[] = [];
  const summaryValue = input.preview?.trim() || input.finalState?.trim() || null;

  if (summaryValue) {
    evidence.push({ kind: 'summary', value: summaryValue });
  }

  input.recentFiles.slice(0, 3).forEach((file) => {
    evidence.push({ kind: 'file', value: file });
  });

  input.recentTools.slice(0, 3).forEach((tool) => {
    evidence.push({ kind: 'tool', value: tool });
  });

  return evidence;
}

export function createPendingDelegationVerification(input?: {
  preview?: string | null;
  finalState?: string | null;
  recentFiles?: string[];
  recentTools?: string[];
}): DelegationVerification {
  return {
    verdict: 'unverified',
    summary: 'Completed child work remains pending until parent verification.',
    verifiedAt: null,
    evidence: buildDelegationVerificationEvidence({
      preview: input?.preview?.trim() || null,
      finalState: input?.finalState?.trim() || null,
      recentFiles: input?.recentFiles ?? [],
      recentTools: input?.recentTools ?? [],
    }),
  };
}

function findBalancedJsonObject(source: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === '\\') {
        isEscaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function extractDelegationHandoffJsonCandidate(content: string): string | null {
  const markerIndex = content.lastIndexOf('DELEGATION_HANDOFF');
  if (markerIndex < 0) {
    return null;
  }

  const firstBraceIndex = content.indexOf('{', markerIndex);
  if (firstBraceIndex < 0) {
    return null;
  }

  return findBalancedJsonObject(content, firstBraceIndex);
}

function hasDelegationHandoffMarker(content: string): boolean {
  return content.includes('DELEGATION_HANDOFF');
}

function stripDelegationHandoffBlock(content: string): string {
  const markerIndex = content.lastIndexOf('DELEGATION_HANDOFF');
  if (markerIndex < 0) {
    return content.trim();
  }

  return content.slice(0, markerIndex).trim();
}

function extractDelegationHandoffBlock(messages: readonly ConversationMessage[]): {
  parseStatus: DelegationHandoffParseStatus;
  parsed: unknown | null;
} {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== 'assistant') {
      continue;
    }

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      const rawContent =
        part.type === 'text'
          ? part.content
          : part.type === 'clarification'
            ? part.question
            : part.type === 'compaction'
              ? part.summary
              : part.type === 'error'
                ? part.message
                : null;

      if (!rawContent) {
        continue;
      }

      const candidateJson = extractDelegationHandoffJsonCandidate(rawContent);
      if (!candidateJson && hasDelegationHandoffMarker(rawContent)) {
        return { parseStatus: 'invalid', parsed: null };
      }

      if (!candidateJson) {
        continue;
      }

      try {
        return { parseStatus: 'parsed', parsed: JSON.parse(candidateJson) };
      } catch {
        return { parseStatus: 'invalid', parsed: null };
      }
    }
  }

  return { parseStatus: 'missing', parsed: null };
}

function normalizeDelegationHandoff(
  value: unknown,
  fallback: {
    preview: string | null;
    finalState: string | null;
    recentFiles: string[];
    recentTools: string[];
  },
  parseStatusOverride?: DelegationHandoffParseStatus,
): DelegationHandoff {
  const fallbackEvidence = buildDelegationVerificationEvidence(fallback);

  if (!value || typeof value !== 'object') {
    return {
      parseStatus: parseStatusOverride ?? 'missing',
      recommendation: null,
      summary: fallback.preview ?? fallback.finalState ?? null,
      summaryProvided: false,
      openIssues: [],
      openIssuesDeclared: false,
      evidence: fallbackEvidence,
    };
  }

  const candidate = value as Partial<DelegationHandoff> & {
    recommendation?: unknown;
    openIssues?: unknown;
    evidence?: unknown;
  };
  const parseStatus: DelegationHandoffParseStatus =
    candidate.parseStatus === 'missing' ||
    candidate.parseStatus === 'invalid' ||
    candidate.parseStatus === 'parsed'
      ? candidate.parseStatus
      : (parseStatusOverride ?? 'parsed');

  return {
    parseStatus,
    recommendation: normalizeDelegationRecommendation(candidate.recommendation),
    summary: isString(candidate.summary)
      ? candidate.summary
      : (fallback.preview ?? fallback.finalState ?? null),
    summaryProvided: isString(candidate.summary),
    openIssues: normalizeStringArray(candidate.openIssues),
    openIssuesDeclared: Array.isArray(candidate.openIssues),
    evidence: normalizeEvidenceArray(candidate.evidence),
  };
}

function evaluateDelegationAutoVerification(input: {
  success: boolean;
  aborted: boolean;
  handoff: DelegationHandoff;
  preview: string | null;
  recentFiles: string[];
  recentTools: string[];
  contextPacketJson?: string | null;
  specialistId?: string;
}): DelegationAutoVerification {
  const packet = parseDelegationContextPacket(input.contextPacketJson, {
    specialistId: input.specialistId,
    specialistName: input.specialistId,
  });
  const verificationSpec = packet?.taskContract.verificationSpec;
  const requiredRecommendationOptions = verificationSpec?.requiredRecommendationOptions ?? [];
  const missingRequirements: string[] = [];
  const warnings: string[] = [];

  if (input.aborted) {
    return {
      status: 'fail',
      summary: 'Automatic verification skipped because the delegated run was cancelled.',
      missingRequirements: ['Complete the delegated run before requesting merge.'],
      warnings: [],
      checkedAt: Date.now(),
    };
  }

  if (!input.success) {
    return {
      status: 'fail',
      summary: 'Automatic verification failed because the delegated run did not succeed.',
      missingRequirements: ['Fix the delegated run before requesting merge.'],
      warnings: [],
      checkedAt: Date.now(),
    };
  }

  if (!verificationSpec) {
    return {
      status: 'needs_follow_up',
      summary:
        'Automatic verification needs follow-up because the stored delegation task contract is missing or unreadable.',
      missingRequirements: ['Restore the delegation task contract before requesting merge.'],
      warnings: [],
      checkedAt: Date.now(),
    };
  }

  if (verificationSpec.requireStructuredHandoff && input.handoff.parseStatus !== 'parsed') {
    missingRequirements.push('Return a final DELEGATION_HANDOFF JSON block.');
  }

  if (verificationSpec.requireSummary && !input.handoff.summaryProvided) {
    missingRequirements.push('Provide a parent-reviewable summary in the final handoff.');
  }

  if (
    verificationSpec.requireEvidence &&
    input.handoff.evidence.length < verificationSpec.minimumEvidenceCount
  ) {
    missingRequirements.push('Attach at least one concrete piece of supporting evidence.');
  }

  if (verificationSpec.requireOpenIssuesStatement && !input.handoff.openIssuesDeclared) {
    missingRequirements.push('Declare open issues explicitly, even when none remain.');
  }

  if (
    requiredRecommendationOptions.length > 0 &&
    (input.handoff.recommendation === null ||
      !requiredRecommendationOptions.includes(input.handoff.recommendation))
  ) {
    missingRequirements.push(
      `Return exactly one recommendation: ${requiredRecommendationOptions.join(', ')}.`,
    );
  }

  const mismatchedEvidence = input.handoff.evidence.filter((entry) => {
    if (entry.kind === 'file') {
      return !input.recentFiles.includes(entry.value);
    }
    if (entry.kind === 'tool') {
      return !input.recentTools.includes(entry.value);
    }
    return false;
  });

  if (mismatchedEvidence.length > 0) {
    warnings.push(
      'Some handoff evidence could not be corroborated from the captured session artifacts.',
    );
  }

  if (input.handoff.parseStatus === 'invalid') {
    return {
      status: 'fail',
      summary:
        'Automatic verification failed because the final DELEGATION_HANDOFF block was invalid JSON.',
      missingRequirements,
      warnings,
      checkedAt: Date.now(),
    };
  }

  if (missingRequirements.length > 0) {
    return {
      status: 'needs_follow_up',
      summary:
        input.handoff.parseStatus === 'missing'
          ? 'Automatic verification needs follow-up because the delegated handoff was not returned in the required structured format.'
          : 'Automatic verification found follow-up items before this delegated result can be merged.',
      missingRequirements,
      warnings,
      checkedAt: Date.now(),
    };
  }

  if (!isString(input.preview) && !isString(input.handoff.summary)) {
    warnings.push(
      'The delegated run completed without a clear natural-language summary outside the handoff block.',
    );
  }

  return {
    status: 'pass',
    summary:
      'Automatic verification passed the delegated handoff against the stored task contract.',
    missingRequirements: [],
    warnings,
    checkedAt: Date.now(),
  };
}

function normalizeDelegationVerification(
  value: unknown,
  fallback: {
    preview: string | null;
    finalState: string | null;
    recentFiles: string[];
    recentTools: string[];
  },
): DelegationVerification {
  const normalizedFallback = createPendingDelegationVerification(fallback);

  if (!value || typeof value !== 'object') {
    return normalizedFallback;
  }

  const candidate = value as Partial<DelegationVerification>;
  const verdict: DelegationVerificationVerdict =
    candidate.verdict === 'pass' ||
    candidate.verdict === 'fail' ||
    candidate.verdict === 'partial' ||
    candidate.verdict === 'unverified'
      ? candidate.verdict
      : 'unverified';
  const evidence = normalizeEvidenceArray(candidate.evidence);

  return {
    verdict,
    summary: isString(candidate.summary) ? candidate.summary : normalizedFallback.summary,
    verifiedAt: typeof candidate.verifiedAt === 'number' ? candidate.verifiedAt : null,
    evidence: evidence.length > 0 ? evidence : normalizedFallback.evidence,
  };
}

function normalizeDelegationResultPayload(
  value: unknown,
  options?: { contextPacketJson?: string | null; specialistId?: string },
): DelegationResultPayload | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<DelegationResultPayload>;
  const recentTools = normalizeStringArray(candidate.recentTools);
  const recentFiles = normalizeStringArray(candidate.recentFiles);
  const preview = isString(candidate.preview) ? candidate.preview : null;
  const finalState = isString(candidate.finalState) ? candidate.finalState : null;
  const handoff = normalizeDelegationHandoff(candidate.handoff, {
    preview,
    finalState,
    recentFiles,
    recentTools,
  });
  const evaluatedAutoVerification = evaluateDelegationAutoVerification({
    success: Boolean(candidate.success),
    aborted: Boolean(candidate.aborted),
    handoff,
    preview,
    recentFiles,
    recentTools,
    contextPacketJson: options?.contextPacketJson,
    specialistId: options?.specialistId,
  });
  const storedCheckedAt =
    candidate.autoVerification &&
    typeof candidate.autoVerification === 'object' &&
    typeof candidate.autoVerification.checkedAt === 'number'
      ? candidate.autoVerification.checkedAt
      : null;
  const autoVerification = {
    ...evaluatedAutoVerification,
    checkedAt: storedCheckedAt ?? evaluatedAutoVerification.checkedAt,
  };

  return {
    success: Boolean(candidate.success),
    aborted: Boolean(candidate.aborted),
    totalDuration: typeof candidate.totalDuration === 'number' ? candidate.totalDuration : 0,
    iterations: typeof candidate.iterations === 'number' ? candidate.iterations : 0,
    finalState,
    executedSteps: typeof candidate.executedSteps === 'number' ? candidate.executedSteps : 0,
    successfulSteps: typeof candidate.successfulSteps === 'number' ? candidate.successfulSteps : 0,
    failedSteps: typeof candidate.failedSteps === 'number' ? candidate.failedSteps : 0,
    preview,
    recentTools,
    recentFiles,
    handoff,
    autoVerification,
    verification: normalizeDelegationVerification(candidate.verification, {
      preview,
      finalState,
      recentFiles,
      recentTools,
    }),
  };
}

export function parseDelegationResultPayload(
  value: string | null | undefined,
  options?: { contextPacketJson?: string | null; specialistId?: string },
): DelegationResultPayload | null {
  if (!value) {
    return null;
  }

  try {
    return normalizeDelegationResultPayload(JSON.parse(value), options);
  } catch {
    return null;
  }
}

function extractPreviewFromPart(part: MessagePart): string | null {
  switch (part.type) {
    case 'text':
      return stripDelegationHandoffBlock(part.content) || null;
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
  options?: { contextPacketJson?: string | null; specialistId?: string },
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
  const handoffBlock = extractDelegationHandoffBlock(messages);
  const handoff = normalizeDelegationHandoff(
    handoffBlock.parsed,
    {
      preview,
      finalState: result.summary?.finalState ?? null,
      recentFiles: artifactSummary.recentFiles,
      recentTools: artifactSummary.recentTools,
    },
    handoffBlock.parseStatus,
  );
  const autoVerification = evaluateDelegationAutoVerification({
    success: result.success,
    aborted: result.aborted,
    handoff,
    preview,
    recentFiles: artifactSummary.recentFiles,
    recentTools: artifactSummary.recentTools,
    contextPacketJson: options?.contextPacketJson,
    specialistId: options?.specialistId,
  });

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
    handoff,
    autoVerification,
    verification: createPendingDelegationVerification({
      preview,
      finalState: result.summary?.finalState ?? null,
      recentFiles: artifactSummary.recentFiles,
      recentTools: artifactSummary.recentTools,
    }),
  };
}

export function buildDelegationFailurePayload(errorMessage: string): DelegationResultPayload {
  return {
    success: false,
    aborted: false,
    totalDuration: 0,
    iterations: 0,
    finalState: null,
    executedSteps: 0,
    successfulSteps: 0,
    failedSteps: 0,
    preview: errorMessage,
    recentTools: [],
    recentFiles: [],
    handoff: {
      parseStatus: 'missing',
      recommendation: null,
      summary: errorMessage,
      summaryProvided: false,
      openIssues: [],
      openIssuesDeclared: false,
      evidence: [{ kind: 'summary', value: errorMessage }],
    },
    autoVerification: {
      status: 'fail',
      summary: 'Automatic verification failed because the delegated run did not succeed.',
      missingRequirements: ['Fix the delegated run before requesting merge.'],
      warnings: [],
      checkedAt: Date.now(),
    },
    verification: {
      verdict: 'unverified',
      summary: 'This delegated run failed and is not eligible for merge.',
      verifiedAt: null,
      evidence: [{ kind: 'summary', value: errorMessage }],
    },
  };
}

export function buildCancelledDelegationPayload(message: string): DelegationResultPayload {
  return {
    success: false,
    aborted: true,
    totalDuration: 0,
    iterations: 0,
    finalState: null,
    executedSteps: 0,
    successfulSteps: 0,
    failedSteps: 0,
    preview: message,
    recentTools: [],
    recentFiles: [],
    handoff: {
      parseStatus: 'missing',
      recommendation: null,
      summary: message,
      summaryProvided: false,
      openIssues: [],
      openIssuesDeclared: false,
      evidence: [{ kind: 'summary', value: message }],
    },
    autoVerification: {
      status: 'fail',
      summary: 'Automatic verification skipped because the delegated run was cancelled.',
      missingRequirements: ['Complete the delegated run before requesting merge.'],
      warnings: [],
      checkedAt: Date.now(),
    },
    verification: {
      verdict: 'unverified',
      summary: 'This delegated run was cancelled before completion.',
      verifiedAt: null,
      evidence: [{ kind: 'summary', value: message }],
    },
  };
}

export function withDelegationVerification(
  payload: DelegationResultPayload,
  verification: Pick<DelegationVerification, 'verdict' | 'summary' | 'verifiedAt'>,
): DelegationResultPayload {
  return {
    ...payload,
    verification: {
      ...payload.verification,
      verdict: verification.verdict,
      summary: verification.summary,
      verifiedAt: verification.verifiedAt,
    },
  };
}

export function resolveDelegationVerificationLabel(
  result: DelegationResultPayload | null | undefined,
): string | null {
  switch (result?.verification.verdict) {
    case 'pass':
      return 'Verified';
    case 'fail':
      return 'Rejected';
    case 'partial':
      return 'Needs follow-up';
    case 'unverified':
      return 'Needs verification';
    default:
      return null;
  }
}

export function resolveDelegationAutoVerificationLabel(
  result: DelegationResultPayload | null | undefined,
): string | null {
  switch (result?.autoVerification.status) {
    case 'pass':
      return 'Contract check passed';
    case 'needs_follow_up':
      return 'Contract follow-up';
    case 'fail':
      return 'Contract check failed';
    default:
      return null;
  }
}

export function deriveDelegationReviewState(
  record: Pick<DelegationRecord, 'status' | 'mergeStatus' | 'errorMessage'> | null | undefined,
  result: DelegationResultPayload | null | undefined,
): DelegationReviewState | null {
  if (!record || !result) {
    return null;
  }

  if (record.status === 'cancelled' || result.aborted) {
    return {
      phase: 'cancelled',
      label: 'Cancelled handoff',
      summary:
        record.errorMessage ??
        result.verification.summary ??
        result.preview ??
        'This delegated run was cancelled before completion.',
      canApplyReview: false,
    };
  }

  if (record.status === 'failed' || !result.success) {
    return {
      phase: 'failed',
      label: 'Failed handoff',
      summary:
        record.errorMessage ??
        result.verification.summary ??
        result.preview ??
        'This delegated run failed and cannot be merged.',
      canApplyReview: false,
    };
  }

  if (record.mergeStatus === 'merged' || result.verification.verdict === 'pass') {
    return {
      phase: 'verified',
      label: 'Verified',
      summary:
        result.verification.summary ?? 'Parent review verified this delegated result for merge.',
      canApplyReview: false,
    };
  }

  if (record.mergeStatus === 'discarded' || result.verification.verdict === 'fail') {
    return {
      phase: 'rejected',
      label: 'Rejected',
      summary: result.verification.summary ?? 'Parent review discarded this delegated result.',
      canApplyReview: false,
    };
  }

  if (result.verification.verdict === 'partial') {
    return {
      phase: 'follow_up',
      label: 'Needs follow-up',
      summary: result.verification.summary ?? 'Parent review requires follow-up before merge.',
      canApplyReview: true,
    };
  }

  if (record.status === 'completed') {
    return {
      phase: 'awaiting_review',
      label: 'Needs verification',
      summary:
        result.verification.summary ??
        'Completed child work remains pending until parent verification.',
      canApplyReview: true,
    };
  }

  return {
    phase: 'pending_execution',
    label: 'In progress',
    summary: 'This delegated run is still in progress.',
    canApplyReview: false,
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

  return null;
}

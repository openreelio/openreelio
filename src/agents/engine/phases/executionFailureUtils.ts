/**
 * Execution Failure Utilities
 *
 * Shared helpers for retry classification and loop-prevention heuristics.
 * The goal is to avoid repeatedly retrying deterministic failures.
 */

import type { AgentContext } from '../core/types';
import type { ExecutionResult } from './Executor';

export interface TerminalFailureGuidance {
  reason: string;
  suggestedAction: string;
  failureSignature: string;
}

interface FailureSignature {
  tool: string;
  normalizedError: string;
  signature: string;
}

const TRANSIENT_FAILURE_PATTERNS: RegExp[] = [
  /timeout|timed out|deadline exceeded/i,
  /temporary|temporarily|transient/i,
  /try again/i,
  /rate limit|too many requests|\b429\b/i,
  /network|connection|econn|enet|eai_again|socket/i,
  /service unavailable|unavailable|server busy|busy/i,
];

const CLIP_NOT_FOUND_PATTERNS: RegExp[] = [
  /clip not found/i,
  /could not be found on the timeline/i,
  /no clips? (on|in) (the )?timeline/i,
  /timeline is empty/i,
];

const TRACK_NOT_FOUND_PATTERNS: RegExp[] = [/track[^\n]*not found/i, /unknown track/i];
const SEQUENCE_NOT_FOUND_PATTERNS: RegExp[] = [/sequence[^\n]*not found/i, /unknown sequence/i];
const ASSET_NOT_FOUND_PATTERNS: RegExp[] = [/asset[^\n]*not found/i, /file not found/i];
const PRECONDITION_FAILURE_PATTERNS: RegExp[] = [
  /precondition_failed/i,
  /preflight/i,
  /rev_conflict/i,
  /stale context/i,
  /placeholder/i,
  /alias/i,
];

const CLIP_EDIT_TOOL_NAMES = new Set([
  'split_clip',
  'trim_clip',
  'move_clip',
  'delete_clip',
  'delete_clips_in_range',
]);

const READ_ONLY_TOOL_PREFIXES = [
  'get_',
  'list_',
  'find_',
  'search_',
  'analyze_',
  'inspect_',
  'query_',
  'read_',
];

/**
 * Whether a failed tool result is worth retrying with the same arguments.
 *
 * Retry is intentionally limited to failures that look transient.
 * Deterministic failures (not-found, invalid args, etc.) should not be retried.
 */
export function isRetryableToolFailure(errorMessage?: string): boolean {
  if (!errorMessage || errorMessage.trim().length === 0) {
    return false;
  }

  const normalized = normalizeToolFailure(errorMessage);
  return TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Normalize an error message so semantically identical failures can be compared.
 */
export function normalizeToolFailure(errorMessage?: string): string {
  if (!errorMessage || errorMessage.trim().length === 0) {
    return 'unknown failure';
  }

  return errorMessage
    .toLowerCase()
    .replace(/["'`][^"'`]+["'`]/g, '<value>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Heuristic classification for read-only tool names.
 */
export function isReadOnlyTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return READ_ONLY_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Determine if an execution produced meaningful timeline/project mutation.
 */
export function didExecutionMutateState(execution: ExecutionResult): boolean {
  return execution.completedSteps.some((step) => {
    if ((step.result.sideEffects?.length ?? 0) > 0) {
      return true;
    }

    if (step.result.undoable) {
      return true;
    }

    return !isReadOnlyTool(step.tool);
  });
}

/**
 * Detect immediate terminal failures based on known preconditions.
 */
export function detectImmediateTerminalFailure(
  execution: ExecutionResult,
  context: AgentContext,
): TerminalFailureGuidance | null {
  if (execution.failedSteps.length === 0 || didExecutionMutateState(execution)) {
    return null;
  }

  const preconditionFailure = execution.failedSteps.find((step) =>
    matchesAnyPattern(step.result.error, PRECONDITION_FAILURE_PATTERNS),
  );

  if (preconditionFailure) {
    return {
      reason:
        'Execution stopped because plan arguments no longer match the current timeline state.',
      suggestedAction:
        'Refresh timeline context, re-run analysis tools, and retry with exact current IDs.',
      failureSignature: `precondition:${normalizeToolFailure(preconditionFailure.result.error)}`,
    };
  }

  const deterministicNotFound = execution.failedSteps.find((step) => {
    if (isRetryableToolFailure(step.result.error)) {
      return false;
    }

    return (
      matchesAnyPattern(step.result.error, TRACK_NOT_FOUND_PATTERNS) ||
      matchesAnyPattern(step.result.error, SEQUENCE_NOT_FOUND_PATTERNS) ||
      matchesAnyPattern(step.result.error, ASSET_NOT_FOUND_PATTERNS)
    );
  });

  if (deterministicNotFound) {
    const normalizedFailure = normalizeToolFailure(deterministicNotFound.result.error);
    return {
      reason: describeFailureReason({
        tool: deterministicNotFound.tool,
        normalizedError: normalizedFailure,
        signature: `${deterministicNotFound.tool.toLowerCase()}:${normalizedFailure}`,
      }),
      suggestedAction: suggestAction({
        tool: deterministicNotFound.tool,
        normalizedError: normalizedFailure,
        signature: `${deterministicNotFound.tool.toLowerCase()}:${normalizedFailure}`,
      }),
      failureSignature: `precondition:${normalizedFailure}`,
    };
  }

  const timelineClipCount = getTimelineClipCount(context);
  const hasClipTargetedFailure = execution.failedSteps.some((step) => {
    if (isRetryableToolFailure(step.result.error)) {
      return false;
    }

    return (
      isClipEditTool(step.tool) || matchesAnyPattern(step.result.error, CLIP_NOT_FOUND_PATTERNS)
    );
  });

  if (timelineClipCount === 0 && hasClipTargetedFailure) {
    return {
      reason: 'No clips are available on the timeline for clip-edit operations',
      suggestedAction:
        'Add a video clip to the timeline (or select an existing clip) before retrying this command.',
      failureSignature: 'precondition:no_timeline_clips',
    };
  }

  return null;
}

/**
 * Detect repeated non-retryable failures across consecutive iterations.
 */
export function detectRepeatedTerminalFailure(
  previous: ExecutionResult,
  current: ExecutionResult,
): TerminalFailureGuidance | null {
  if (didExecutionMutateState(previous) || didExecutionMutateState(current)) {
    return null;
  }

  const previousSignatures = collectTerminalFailureSignatures(previous);
  const currentSignatures = collectTerminalFailureSignatures(current);

  if (previousSignatures.length === 0 || currentSignatures.length === 0) {
    return null;
  }

  const repeated = currentSignatures.find((candidate) =>
    previousSignatures.some((baseline) => baseline.signature === candidate.signature),
  );

  if (!repeated) {
    return null;
  }

  return {
    reason: describeFailureReason(repeated),
    suggestedAction: suggestAction(repeated),
    failureSignature: repeated.signature,
  };
}

function collectTerminalFailureSignatures(execution: ExecutionResult): FailureSignature[] {
  const signatures = new Map<string, FailureSignature>();

  for (const step of execution.failedSteps) {
    if (isRetryableToolFailure(step.result.error)) {
      continue;
    }

    const normalizedError = normalizeToolFailure(step.result.error);
    const signature = `${step.tool.toLowerCase()}:${normalizedError}`;

    if (!signatures.has(signature)) {
      signatures.set(signature, {
        tool: step.tool,
        normalizedError,
        signature,
      });
    }
  }

  return [...signatures.values()];
}

function describeFailureReason(signature: FailureSignature): string {
  if (matchesAnyPattern(signature.normalizedError, CLIP_NOT_FOUND_PATTERNS)) {
    return 'Repeated retries were stopped because the target clip could not be resolved.';
  }

  if (matchesAnyPattern(signature.normalizedError, TRACK_NOT_FOUND_PATTERNS)) {
    return 'Repeated retries were stopped because the target track does not exist.';
  }

  if (matchesAnyPattern(signature.normalizedError, SEQUENCE_NOT_FOUND_PATTERNS)) {
    return 'Repeated retries were stopped because the target sequence does not exist.';
  }

  if (matchesAnyPattern(signature.normalizedError, ASSET_NOT_FOUND_PATTERNS)) {
    return 'Repeated retries were stopped because the referenced asset is missing.';
  }

  return `Repeated retries were stopped after the same terminal failure from '${signature.tool}'.`;
}

function suggestAction(signature: FailureSignature): string {
  if (matchesAnyPattern(signature.normalizedError, CLIP_NOT_FOUND_PATTERNS)) {
    return 'Select the target clip on the timeline or insert media first, then retry.';
  }

  if (matchesAnyPattern(signature.normalizedError, TRACK_NOT_FOUND_PATTERNS)) {
    return 'Choose an existing track (or create one) and retry the request.';
  }

  if (matchesAnyPattern(signature.normalizedError, SEQUENCE_NOT_FOUND_PATTERNS)) {
    return 'Open the correct sequence before retrying this edit request.';
  }

  if (matchesAnyPattern(signature.normalizedError, ASSET_NOT_FOUND_PATTERNS)) {
    return 'Import or relink the missing asset before retrying the operation.';
  }

  return 'Provide additional targeting details (clip/track/sequence) before retrying.';
}

function isClipEditTool(toolName: string): boolean {
  return CLIP_EDIT_TOOL_NAMES.has(toolName.toLowerCase());
}

function getTimelineClipCount(context: AgentContext): number {
  return context.availableTracks.reduce((total, track) => {
    if (!Number.isFinite(track.clipCount)) {
      return total;
    }
    return total + Math.max(0, track.clipCount);
  }, 0);
}

function matchesAnyPattern(value: string | undefined, patterns: RegExp[]): boolean {
  if (!value || value.trim().length === 0) {
    return false;
  }

  return patterns.some((pattern) => pattern.test(value));
}

import {
  deriveDelegationReviewState,
  resolveDelegationAutoVerificationLabel,
  resolveDelegationVerificationLabel,
  type DelegationResultPayload,
} from './agentDelegationResult';

interface DelegatedParentContext {
  parentLabel: string;
  delegatedGoal?: string | null;
  delegationStatus?: 'requested' | 'running' | 'completed' | 'failed' | 'cancelled';
  mergeStatus?: 'pending' | 'merged' | 'discarded';
  errorMessage?: string | null;
  statusLabel?: string | null;
  resultPreview?: string | null;
  result?: DelegationResultPayload | null;
  onReview?: () => void;
  onReturnToParent?: () => void;
}

interface DelegatedChildItem {
  id: string;
  label: string;
  delegatedGoal?: string | null;
  delegationStatus?: 'requested' | 'running' | 'completed' | 'failed' | 'cancelled';
  mergeStatus?: 'pending' | 'merged' | 'discarded';
  errorMessage?: string | null;
  statusLabel: string;
  resultPreview?: string | null;
  result?: DelegationResultPayload | null;
  onOpen: () => void;
  onReview?: () => void;
}

interface AgentDelegationStripProps {
  delegatedFrom?: DelegatedParentContext | null;
  delegatedChildren?: DelegatedChildItem[];
  className?: string;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function HandoffMetricChip({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const toneClassName =
    tone === 'success'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
      : tone === 'warning'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
        : tone === 'danger'
          ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
          : 'border-border-subtle bg-surface-base text-text-secondary';

  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${toneClassName}`}>
      {children}
    </span>
  );
}

function DelegationResultSummary({
  result,
  preview,
  delegationStatus,
  mergeStatus,
  errorMessage,
}: {
  result?: DelegationResultPayload | null;
  preview?: string | null;
  delegationStatus?: 'requested' | 'running' | 'completed' | 'failed' | 'cancelled';
  mergeStatus?: 'pending' | 'merged' | 'discarded';
  errorMessage?: string | null;
}) {
  if (!result && !preview) {
    return null;
  }

  const reviewState = deriveDelegationReviewState(
    result
      ? {
          status: delegationStatus ?? 'running',
          mergeStatus: mergeStatus ?? 'pending',
          errorMessage: errorMessage ?? null,
        }
      : null,
    result,
  );
  const verificationLabel = reviewState?.label ?? resolveDelegationVerificationLabel(result);
  const autoVerificationLabel = resolveDelegationAutoVerificationLabel(result);
  const verificationTone =
    reviewState?.phase === 'verified' || result?.verification.verdict === 'pass'
      ? 'success'
      : reviewState?.phase === 'rejected' ||
          reviewState?.phase === 'failed' ||
          result?.verification.verdict === 'fail'
        ? 'danger'
        : 'warning';

  return (
    <div className="mt-2 space-y-2">
      {preview && <p className="truncate text-xs text-text-secondary">Latest result: {preview}</p>}

      {result && (
        <>
          <div className="flex flex-wrap gap-1.5">
            <HandoffMetricChip>
              {result.aborted ? 'aborted' : result.success ? 'success' : 'failed'}
            </HandoffMetricChip>
            {verificationLabel && (
              <HandoffMetricChip tone={verificationTone}>{verificationLabel}</HandoffMetricChip>
            )}
            {autoVerificationLabel && (
              <HandoffMetricChip>{autoVerificationLabel}</HandoffMetricChip>
            )}
            <HandoffMetricChip>{formatDuration(result.totalDuration)}</HandoffMetricChip>
            <HandoffMetricChip>{result.iterations} iter</HandoffMetricChip>
            <HandoffMetricChip>{result.executedSteps} steps</HandoffMetricChip>
            {result.recentTools.length > 0 && (
              <HandoffMetricChip>{result.recentTools.length} tools</HandoffMetricChip>
            )}
            {result.recentFiles.length > 0 && (
              <HandoffMetricChip>{result.recentFiles.length} files</HandoffMetricChip>
            )}
          </div>

          {(result.recentTools.length > 0 || result.recentFiles.length > 0) && (
            <div className="space-y-1">
              {result.recentTools.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                    Tools
                  </span>
                  {result.recentTools.slice(0, 3).map((tool) => (
                    <code
                      key={tool}
                      className="rounded bg-surface-base px-1.5 py-0.5 text-[10px] text-text-secondary"
                    >
                      {tool}
                    </code>
                  ))}
                </div>
              )}

              {result.recentFiles.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                    Files
                  </span>
                  {result.recentFiles.slice(0, 3).map((file) => (
                    <code
                      key={file}
                      className="rounded bg-surface-base px-1.5 py-0.5 text-[10px] text-text-secondary"
                    >
                      {file}
                    </code>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function AgentDelegationStrip({
  delegatedFrom = null,
  delegatedChildren = [],
  className = '',
}: AgentDelegationStripProps) {
  if (!delegatedFrom && delegatedChildren.length === 0) {
    return null;
  }

  return (
    <div
      className={`border-b border-border-subtle bg-surface-elevated/70 px-3 py-2 ${className}`}
      data-testid="agent-delegation-strip"
    >
      {delegatedFrom && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
              Delegated Session
            </p>
            <p className="mt-1 text-sm text-text-primary">From {delegatedFrom.parentLabel}</p>
            {delegatedFrom.delegatedGoal && (
              <p className="mt-1 truncate text-xs text-text-secondary">
                Goal: {delegatedFrom.delegatedGoal}
              </p>
            )}
            <DelegationResultSummary
              preview={delegatedFrom.resultPreview}
              result={delegatedFrom.result}
              delegationStatus={delegatedFrom.delegationStatus}
              mergeStatus={delegatedFrom.mergeStatus}
              errorMessage={delegatedFrom.errorMessage}
            />
          </div>
          <div className="flex items-center gap-2">
            {delegatedFrom.statusLabel && (
              <span className="rounded-full border border-border-subtle bg-surface-base px-2 py-0.5 text-[11px] text-text-secondary">
                {delegatedFrom.statusLabel}
              </span>
            )}
            {delegatedFrom.onReview && (
              <button
                type="button"
                onClick={delegatedFrom.onReview}
                className="rounded-md border border-border-subtle bg-surface-base px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-active"
                data-testid="agent-delegation-review-btn"
              >
                Review
              </button>
            )}
            {delegatedFrom.onReturnToParent && (
              <button
                type="button"
                onClick={delegatedFrom.onReturnToParent}
                className="rounded-md border border-border-subtle bg-surface-base px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-active"
                data-testid="agent-delegation-return-btn"
              >
                Return to Parent
              </button>
            )}
          </div>
        </div>
      )}

      {delegatedChildren.length > 0 && (
        <div className={delegatedFrom ? 'mt-2' : ''}>
          <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
            Delegated Specialists
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {delegatedChildren.map((child) => (
              <div
                key={child.id}
                className="max-w-full rounded-md border border-border-subtle bg-surface-base px-2.5 py-1.5 text-left transition-colors hover:bg-surface-active"
                data-testid={`agent-delegated-child-${child.id}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text-primary">{child.label}</span>
                  <span className="rounded-full border border-border-subtle px-1.5 py-0.5 text-[10px] text-text-tertiary">
                    {child.statusLabel}
                  </span>
                </div>
                {child.delegatedGoal && (
                  <div className="mt-1 truncate text-[11px] text-text-secondary">
                    {child.delegatedGoal}
                  </div>
                )}
                <DelegationResultSummary
                  preview={child.resultPreview}
                  result={child.result}
                  delegationStatus={child.delegationStatus}
                  mergeStatus={child.mergeStatus}
                  errorMessage={child.errorMessage}
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={child.onOpen}
                    className="rounded-md border border-border-subtle bg-surface-base px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-active"
                    data-testid={`agent-delegated-child-open-${child.id}`}
                  >
                    Open Session
                  </button>
                  {child.onReview && (
                    <button
                      type="button"
                      onClick={child.onReview}
                      className="rounded-md border border-border-subtle bg-surface-base px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-active"
                      data-testid={`agent-delegated-child-review-${child.id}`}
                    >
                      Review
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

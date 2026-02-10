/**
 * ProposalCard Component
 *
 * Displays an AI-generated proposal inline in the chat.
 * Shows commands, risk assessment, and approve/reject actions.
 */

import { useState, memo, useCallback, useRef, useEffect } from 'react';
import { useAIStore, type AIProposal } from '@/stores/aiStore';

// =============================================================================
// Types
// =============================================================================

export interface ProposalCardProps {
  /** The proposal to display */
  proposal: AIProposal;
}

// =============================================================================
// Component
// =============================================================================

export const ProposalCard = memo(function ProposalCard({
  proposal,
}: ProposalCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  // Track if component is mounted to avoid state updates after unmount
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const approveProposal = useAIStore((state) => state.approveProposal);
  const rejectProposal = useAIStore((state) => state.rejectProposal);

  const { editScript, status, id } = proposal;
  const isPending = status === 'pending' || status === 'reviewing';
  const isFailed = status === 'failed';

  // Handle approve
  const handleApprove = useCallback(async () => {
    setIsApplying(true);
    setApproveError(null);
    try {
      await approveProposal(id);
    } catch (error) {
      if (isMountedRef.current) {
        setApproveError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      // Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsApplying(false);
      }
    }
  }, [approveProposal, id]);

  // Handle reject
  const handleReject = useCallback(() => {
    rejectProposal(id);
  }, [rejectProposal, id]);

  return (
    <div
      data-testid="proposal-card"
      className={`w-full rounded-lg border overflow-hidden ${getStatusBorderColor(
        status
      )}`}
    >
      {/* Header */}
      <div className="px-3 py-2 bg-editor-surface flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CommandIcon />
          <span className="text-xs font-medium text-editor-text">
            {editScript.commands.length} command
            {editScript.commands.length !== 1 ? 's' : ''}
          </span>
          {/* Risk badge */}
          <RiskBadge risk={editScript.risk} />
        </div>
        {/* Status badge */}
        <StatusBadge status={status} />
      </div>

      {/* Command preview or full list */}
      <div className="px-3 py-2 bg-editor-bg">
        {isExpanded ? (
          <div className="space-y-1.5">
            {editScript.commands.map((cmd, index) => (
              <div
                key={index}
                className="text-xs flex items-start gap-2 text-editor-text"
              >
                <span className="text-editor-text-secondary">
                  {index + 1}.
                </span>
                <div>
                  <span className="font-mono text-blue-400">
                    {cmd.commandType}
                  </span>
                  {cmd.description && (
                    <p className="text-editor-text-secondary mt-0.5">
                      {cmd.description}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-editor-text-secondary line-clamp-2">
            {editScript.explanation}
          </p>
        )}

        {/* Toggle expand */}
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-2 text-[10px] text-blue-400 hover:text-blue-300"
        >
          {isExpanded ? 'Show less' : 'Show details'}
        </button>
      </div>

      {/* Actions - only show if pending */}
      {isPending && (
        <div className="px-3 py-2 border-t border-editor-border flex gap-2">
          <button
            type="button"
            onClick={handleApprove}
            disabled={isApplying}
            className="flex-1 px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isApplying ? 'Applying...' : 'Approve'}
          </button>
          <button
            type="button"
            onClick={handleReject}
            disabled={isApplying}
            className="flex-1 px-3 py-1.5 text-xs font-medium rounded bg-editor-surface text-editor-text border border-editor-border hover:bg-editor-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Reject
          </button>
        </div>
      )}

      {/* Error message if failed */}
      {((isFailed && proposal.error) || approveError) && (
        <div className="px-3 py-2 border-t border-red-600 bg-red-900/20">
          <p className="text-xs text-red-400">{proposal.error || approveError}</p>
        </div>
      )}
    </div>
  );
});

// =============================================================================
// Sub-Components
// =============================================================================

function StatusBadge({ status }: { status: AIProposal['status'] }) {
  const config = {
    pending: { label: 'Pending', className: 'bg-yellow-600/20 text-yellow-400' },
    reviewing: { label: 'Reviewing', className: 'bg-blue-600/20 text-blue-400' },
    approved: { label: 'Approved', className: 'bg-green-600/20 text-green-400' },
    rejected: { label: 'Rejected', className: 'bg-editor-surface text-editor-text-secondary' },
    applied: { label: 'Applied', className: 'bg-green-600/20 text-green-400' },
    failed: { label: 'Failed', className: 'bg-red-600/20 text-red-400' },
  };

  const { label, className } = config[status];

  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${className}`}>
      {label}
    </span>
  );
}

function RiskBadge({
  risk,
}: {
  risk: { copyright: string; nsfw: string };
}) {
  const hasCopyrightRisk = risk.copyright !== 'none';
  const hasNsfwRisk = risk.nsfw !== 'none';

  if (!hasCopyrightRisk && !hasNsfwRisk) return null;

  const highRisk =
    risk.copyright === 'high' || risk.nsfw === 'high';

  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded ${
        highRisk
          ? 'bg-red-600/20 text-red-400'
          : 'bg-yellow-600/20 text-yellow-400'
      }`}
    >
      {highRisk ? 'High Risk' : 'Warning'}
    </span>
  );
}

function CommandIcon() {
  return (
    <svg
      className="w-3.5 h-3.5 text-editor-text-secondary"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function getStatusBorderColor(status: AIProposal['status']): string {
  switch (status) {
    case 'pending':
    case 'reviewing':
      return 'border-yellow-600/50';
    case 'approved':
    case 'applied':
      return 'border-green-600/50';
    case 'rejected':
      return 'border-editor-border';
    case 'failed':
      return 'border-red-600/50';
    default:
      return 'border-editor-border';
  }
}

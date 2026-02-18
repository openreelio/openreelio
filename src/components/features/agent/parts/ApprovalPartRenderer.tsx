/**
 * ApprovalPartRenderer
 *
 * Renders approval request/response with approve/reject controls.
 * Reject includes an optional feedback textarea so the user
 * can explain what should change.
 */

import { useState, useCallback } from 'react';
import type { ApprovalPart } from '@/agents/engine/core/conversation';

interface ApprovalPartRendererProps {
  part: ApprovalPart;
  onApprove?: () => void;
  onReject?: (reason?: string) => void;
  className?: string;
}

const statusConfig: Record<string, { label: string; color: string }> = {
  pending: { label: 'Awaiting Approval', color: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400' },
  approved: { label: 'Approved', color: 'bg-green-500/10 border-green-500/20 text-green-400' },
  rejected: { label: 'Rejected', color: 'bg-red-500/10 border-red-500/20 text-red-400' },
};

export function ApprovalPartRenderer({
  part,
  onApprove,
  onReject,
  className = '',
}: ApprovalPartRendererProps) {
  const config = statusConfig[part.status];
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');

  const handleReject = useCallback(() => {
    if (showFeedback) {
      // Already showing textarea — send with feedback
      onReject?.(feedback.trim() || undefined);
      setShowFeedback(false);
      setFeedback('');
    } else {
      // Show the feedback textarea
      setShowFeedback(true);
    }
  }, [showFeedback, feedback, onReject]);

  const handleRejectWithoutFeedback = useCallback(() => {
    onReject?.();
    setShowFeedback(false);
    setFeedback('');
  }, [onReject]);

  return (
    <div
      className={`p-3 border rounded-lg ${config.color} ${className}`}
      data-testid="approval-part"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium">{config.label}</span>
      </div>

      <p className="text-sm mb-2">{part.plan.goal}</p>

      {part.reason && (
        <p className="text-xs opacity-80 mb-2">Reason: {part.reason}</p>
      )}

      {part.status === 'pending' && (
        <>
          <div className="flex gap-2">
            {onApprove && (
              <button
                onClick={onApprove}
                className="px-3 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
                data-testid="approval-approve-btn"
              >
                Approve
              </button>
            )}
            {onReject && (
              <button
                onClick={handleReject}
                className="px-3 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                data-testid="approval-reject-btn"
              >
                {showFeedback ? 'Send Feedback & Reject' : 'Reject'}
              </button>
            )}
            {showFeedback && (
              <button
                onClick={handleRejectWithoutFeedback}
                className="px-3 py-1 text-xs bg-surface-active hover:bg-surface-elevated text-text-secondary rounded transition-colors"
                data-testid="approval-reject-no-feedback-btn"
              >
                Reject without feedback
              </button>
            )}
          </div>

          {showFeedback && (
            <div className="mt-2">
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Explain what should change..."
                className="w-full px-3 py-2 text-xs rounded bg-surface-base border border-border-subtle text-text-primary placeholder-text-tertiary focus:outline-none focus:ring-1 focus:ring-primary-500/50 resize-none"
                rows={2}
                autoFocus
                data-testid="approval-feedback-input"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

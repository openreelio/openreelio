/**
 * PlanPartRenderer
 *
 * Renders plan steps with status indicators and optional approve/reject buttons.
 */

import type { PlanPart } from '@/agents/engine/core/conversation';

interface PlanPartRendererProps {
  part: PlanPart;
  onApprove?: () => void;
  onReject?: (reason?: string) => void;
  className?: string;
}

const riskColors: Record<string, string> = {
  low: 'text-green-400',
  medium: 'text-yellow-400',
  high: 'text-orange-400',
  critical: 'text-red-400',
};

const statusLabels: Record<string, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  rejected: 'Rejected',
};

const statusColors: Record<string, string> = {
  proposed: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
  approved: 'bg-green-500/10 border-green-500/20 text-green-400',
  rejected: 'bg-red-500/10 border-red-500/20 text-red-400',
};

export function PlanPartRenderer({
  part,
  onApprove,
  onReject,
  className = '',
}: PlanPartRendererProps) {
  const { plan, status } = part;

  return (
    <div
      className={`border border-border-subtle rounded-lg overflow-hidden ${className}`}
      data-testid="plan-part"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-surface-elevated">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">Plan</span>
          <span className={`text-xs px-1.5 py-0.5 rounded border ${statusColors[status]}`}>
            {statusLabels[status]}
          </span>
        </div>
        <span className="text-xs text-text-tertiary">{plan.steps.length} steps</span>
      </div>

      {/* Goal */}
      <div className="px-3 py-2 border-b border-border-subtle">
        <p className="text-sm text-text-primary">{plan.goal}</p>
      </div>

      {/* Steps */}
      <div className="px-3 py-2 space-y-1.5">
        {plan.steps.map((step, i) => (
          <div key={step.id} className="flex items-start gap-2 text-sm">
            <span className="text-text-tertiary font-mono text-xs mt-0.5">
              {i + 1}.
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-text-primary">{step.description}</span>
              <span className="text-text-tertiary text-xs ml-2">
                {step.tool}
              </span>
            </div>
            <span className={`text-xs ${riskColors[step.riskLevel]}`}>
              {step.riskLevel}
            </span>
          </div>
        ))}
      </div>

      {/* Approve/Reject buttons (only when pending) */}
      {status === 'proposed' && plan.requiresApproval && (onApprove || onReject) && (
        <div className="flex gap-2 px-3 py-2 border-t border-border-subtle">
          {onApprove && (
            <button
              onClick={onApprove}
              className="px-3 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
              data-testid="plan-approve-btn"
            >
              Approve
            </button>
          )}
          {onReject && (
            <button
              onClick={() => onReject()}
              className="px-3 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
              data-testid="plan-reject-btn"
            >
              Reject
            </button>
          )}
        </div>
      )}
    </div>
  );
}

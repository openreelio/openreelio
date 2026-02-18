/**
 * ToolApprovalPartRenderer
 *
 * Compact inline approval UI for individual tool permission requests.
 * Shows tool name, description, risk badge, and args preview
 * with Allow / Allow Always / Deny buttons.
 */

import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ToolApprovalPart } from '@/agents/engine/core/conversation';
import type { RiskLevel } from '@/agents/engine/core/types';

// =============================================================================
// Types
// =============================================================================

interface ToolApprovalPartRendererProps {
  part: ToolApprovalPart;
  onAllow?: () => void;
  onAllowAlways?: () => void;
  onDeny?: () => void;
  className?: string;
}

// =============================================================================
// Helpers
// =============================================================================

const riskConfig: Record<
  RiskLevel,
  { label: string; color: string; icon: typeof Shield }
> = {
  low: {
    label: 'Low Risk',
    color: 'text-green-400 bg-green-500/10',
    icon: ShieldCheck,
  },
  medium: {
    label: 'Medium Risk',
    color: 'text-yellow-400 bg-yellow-500/10',
    icon: Shield,
  },
  high: {
    label: 'High Risk',
    color: 'text-orange-400 bg-orange-500/10',
    icon: ShieldAlert,
  },
  critical: {
    label: 'Critical',
    color: 'text-red-400 bg-red-500/10',
    icon: ShieldAlert,
  },
};

const statusConfig: Record<string, { label: string; color: string }> = {
  pending: {
    label: 'Permission Required',
    color: 'bg-yellow-500/10 border-yellow-500/20',
  },
  approved: {
    label: 'Allowed',
    color: 'bg-green-500/10 border-green-500/20',
  },
  denied: {
    label: 'Denied',
    color: 'bg-red-500/10 border-red-500/20',
  },
};

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return 'No arguments';
  return entries
    .slice(0, 4)
    .map(([key, value]) => {
      const v =
        typeof value === 'string'
          ? `"${value.length > 30 ? value.slice(0, 30) + '...' : value}"`
          : JSON.stringify(value);
      return `${key}: ${v}`;
    })
    .join(', ');
}

// =============================================================================
// Component
// =============================================================================

export function ToolApprovalPartRenderer({
  part,
  onAllow,
  onAllowAlways,
  onDeny,
  className = '',
}: ToolApprovalPartRendererProps) {
  const risk = riskConfig[part.riskLevel];
  const status = statusConfig[part.status];
  const RiskIcon = risk.icon;

  return (
    <div
      className={`p-3 border rounded-lg ${status.color} ${className}`}
      data-testid="tool-approval-part"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-text-secondary">
            {status.label}
          </span>
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded ${risk.color}`}
          >
            <RiskIcon className="w-3 h-3" />
            {risk.label}
          </span>
        </div>
      </div>

      {/* Tool info */}
      <div className="mb-2">
        <span className="text-sm font-mono font-medium text-text-primary">
          {part.tool}
        </span>
        {part.description && (
          <p className="text-xs text-text-tertiary mt-0.5">
            {part.description}
          </p>
        )}
      </div>

      {/* Args preview */}
      <div className="mb-2.5 px-2 py-1.5 bg-surface-base/50 rounded text-xs font-mono text-text-secondary truncate">
        {formatArgs(part.args)}
      </div>

      {/* Action buttons */}
      {part.status === 'pending' && (
        <div className="flex gap-2">
          {onAllow && (
            <button
              onClick={onAllow}
              className="px-3 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
              data-testid="tool-approval-allow-btn"
            >
              Allow
            </button>
          )}
          {onAllowAlways && (
            <button
              onClick={onAllowAlways}
              className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
              data-testid="tool-approval-allow-always-btn"
            >
              Allow Always
            </button>
          )}
          {onDeny && (
            <button
              onClick={onDeny}
              className="px-3 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
              data-testid="tool-approval-deny-btn"
            >
              Deny
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ToolApprovalPartRenderer
 *
 * Compact inline approval UI for individual tool permission requests.
 * Shows tool name, description, risk badge, and args preview
 * with Allow / Allow Always / Deny buttons.
 */

import { useState } from 'react';
import { ChevronRight, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
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

const riskConfig: Record<RiskLevel, { label: string; color: string; icon: typeof Shield }> = {
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const risk = riskConfig[part.riskLevel];
  const status = statusConfig[part.status];
  const RiskIcon = risk.icon;
  const canAct = part.status === 'pending';
  const hasArgs = Object.keys(part.args).length > 0;

  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${status.color} ${className}`}
      data-testid="tool-approval-part"
    >
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          onClick={() => setDetailsOpen((prev) => !prev)}
          className="mt-0.5 rounded p-0.5 text-text-tertiary transition-colors hover:bg-surface-active hover:text-text-secondary"
          aria-expanded={detailsOpen}
          data-testid="tool-approval-details-toggle"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${detailsOpen ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
          <span className="sr-only">Toggle approval details</span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-text-secondary">{status.label}</span>
            <span className="truncate text-xs font-mono text-text-primary">{part.tool}</span>
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${risk.color}`}
            >
              <RiskIcon className="w-3 h-3" />
              {risk.label}
            </span>
          </div>
          {part.description && (
            <p className="mt-0.5 break-words text-xs text-text-tertiary">{part.description}</p>
          )}
        </div>
      </div>

      {detailsOpen && (
        <div
          className="mt-2 rounded border border-border-subtle bg-surface-base/50 px-2 py-1.5 text-xs font-mono text-text-secondary"
          data-testid="tool-approval-details"
        >
          {hasArgs ? formatArgs(part.args) : 'No arguments'}
        </div>
      )}

      {canAct && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {onAllow && (
            <button
              onClick={onAllow}
              className="rounded bg-green-600 px-2.5 py-1 text-xs text-white transition-colors hover:bg-green-500"
              data-testid="tool-approval-allow-btn"
            >
              Allow
            </button>
          )}
          {onAllowAlways && (
            <button
              onClick={onAllowAlways}
              className="rounded border border-border-subtle bg-surface-base px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-active"
              data-testid="tool-approval-allow-always-btn"
            >
              Always
            </button>
          )}
          {onDeny && (
            <button
              onClick={onDeny}
              className="rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs text-red-300 transition-colors hover:bg-red-500/20"
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

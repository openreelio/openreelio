/**
 * ApprovalDialog Component
 *
 * Human-in-the-loop confirmation dialog for AI agent operations.
 * Displays operation details and risk level for user approval.
 */

import { useCallback, useId, useRef, useEffect, type KeyboardEvent } from 'react';
import type { RiskLevel } from '@/agents/registry/ToolMetadata';

// =============================================================================
// Types
// =============================================================================

export interface ApprovalDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Tool name being requested */
  toolName: string;
  /** Description of the operation */
  description: string;
  /** Risk level of the operation */
  riskLevel: RiskLevel;
  /** Optional arguments to display */
  args?: Record<string, unknown>;
  /** Callback when approved */
  onApprove: () => void;
  /** Callback when rejected */
  onReject: (reason?: string) => void;
  /** Callback when dismissed */
  onDismiss?: () => void;
  /** Whether the dialog is in loading state */
  isLoading?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const RISK_COLORS: Record<RiskLevel, { bg: string; text: string; border: string }> = {
  low: {
    bg: 'bg-green-500/10',
    text: 'text-green-400',
    border: 'border-green-500/30',
  },
  medium: {
    bg: 'bg-yellow-500/10',
    text: 'text-yellow-400',
    border: 'border-yellow-500/30',
  },
  high: {
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    border: 'border-red-500/30',
  },
};

const RISK_LABELS: Record<RiskLevel, string> = {
  low: 'Low Risk',
  medium: 'Medium Risk',
  high: 'High Risk',
};

const RISK_DESCRIPTIONS: Record<RiskLevel, string> = {
  low: 'This operation is safe and can be easily undone.',
  medium: 'This operation may have moderate effects. Review before proceeding.',
  high: 'This operation may cause significant changes. Proceed with caution.',
};

// =============================================================================
// Component
// =============================================================================

export function ApprovalDialog({
  isOpen,
  toolName,
  description,
  riskLevel,
  args,
  onApprove,
  onReject,
  onDismiss,
  isLoading = false,
}: ApprovalDialogProps) {
  const titleId = useId();
  const descId = useId();
  const rejectButtonRef = useRef<HTMLButtonElement>(null);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onDismiss) {
          onDismiss();
        } else {
          onReject('User dismissed');
        }
      }
    },
    [onDismiss, onReject]
  );

  const handleBackdropClick = useCallback(() => {
    if (onDismiss) {
      onDismiss();
    } else {
      onReject('User dismissed');
    }
  }, [onDismiss, onReject]);

  const handleDialogClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const handleReject = useCallback(() => {
    onReject('User rejected');
  }, [onReject]);

  // ===========================================================================
  // Effects
  // ===========================================================================

  useEffect(() => {
    if (isOpen && rejectButtonRef.current) {
      rejectButtonRef.current.focus();
    }
  }, [isOpen]);

  // ===========================================================================
  // Render
  // ===========================================================================

  if (!isOpen) {
    return null;
  }

  const riskColors = RISK_COLORS[riskLevel];

  return (
    <div
      data-testid="approval-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        data-testid="dialog-backdrop"
        className="absolute inset-0 bg-surface-overlay backdrop-blur-sm"
        onClick={handleBackdropClick}
      />

      {/* Dialog Content */}
      <div
        className="relative z-10 w-[calc(100%-2rem)] max-w-lg mx-4 bg-surface-elevated rounded-lg shadow-xl border border-border-default overflow-hidden"
        onClick={handleDialogClick}
      >
        {/* Header with Risk Badge */}
        <div className="px-6 pt-6 pb-4 border-b border-border-subtle">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2
                id={titleId}
                className="text-lg font-semibold text-text-primary"
              >
                Approval Required
              </h2>
              <p className="text-sm text-text-tertiary mt-1">
                AI agent is requesting permission to execute an operation
              </p>
            </div>
            <span
              className={`px-2 py-1 text-xs font-medium rounded ${riskColors.bg} ${riskColors.text} ${riskColors.border} border`}
            >
              {RISK_LABELS[riskLevel]}
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4">
          {/* Tool Name */}
          <div>
            <label className="text-xs font-medium text-text-tertiary uppercase tracking-wide">
              Operation
            </label>
            <p className="mt-1 text-text-primary font-mono text-sm bg-surface-active px-3 py-2 rounded">
              {toolName}
            </p>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium text-text-tertiary uppercase tracking-wide">
              Description
            </label>
            <p id={descId} className="mt-1 text-text-secondary">
              {description}
            </p>
          </div>

          {/* Arguments (if any) */}
          {args && Object.keys(args).length > 0 && (
            <div>
              <label className="text-xs font-medium text-text-tertiary uppercase tracking-wide">
                Parameters
              </label>
              <div className="mt-1 bg-surface-active rounded p-3 overflow-x-auto">
                <pre className="text-xs text-text-secondary font-mono">
                  {JSON.stringify(args, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* Risk Warning */}
          <div
            className={`p-3 rounded ${riskColors.bg} ${riskColors.border} border`}
          >
            <p className={`text-sm ${riskColors.text}`}>
              {RISK_DESCRIPTIONS[riskLevel]}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-surface-active border-t border-border-subtle flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
          <button
            ref={rejectButtonRef}
            data-testid="reject-button"
            type="button"
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-surface-elevated rounded hover:bg-surface-highest transition-colors disabled:opacity-50 disabled:cursor-not-allowed border border-border-default"
            onClick={handleReject}
            disabled={isLoading}
          >
            Reject
          </button>
          <button
            data-testid="approve-button"
            type="button"
            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            onClick={onApprove}
            disabled={isLoading}
          >
            {isLoading && (
              <div
                data-testid="loading-spinner"
                className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"
              />
            )}
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ProposalDialog Component
 *
 * Displays AI-generated edit proposals for user approval.
 * Shows commands, explanation, risk assessment, and allows approve/reject actions.
 */

import React, { useCallback, useMemo } from 'react';
import type { EditScript, ApplyResult } from '@/hooks/useAIAgent';
import { createLogger } from '@/services/logger';

const logger = createLogger('ProposalDialog');

// =============================================================================
// Types
// =============================================================================

export interface ProposalDialogProps {
  /** The edit script proposal to display */
  proposal: EditScript | null;
  /** Whether the proposal is being applied */
  isApplying: boolean;
  /** Callback when user approves the proposal */
  onApprove: () => Promise<ApplyResult>;
  /** Callback when user rejects the proposal */
  onReject: () => void;
  /** Optional callback for modifying the proposal */
  onModify?: () => void;
}

// =============================================================================
// Helper Components
// =============================================================================

interface CommandItemProps {
  command: EditScript['commands'][0];
  index: number;
}

const CommandItem: React.FC<CommandItemProps> = ({ command, index }) => {
  const getCommandIcon = (type: string): string => {
    switch (type) {
      case 'InsertClip':
        return '➕';
      case 'SplitClip':
        return '✂️';
      case 'DeleteClip':
        return '🗑️';
      case 'TrimClip':
        return '📐';
      case 'MoveClip':
        return '↔️';
      default:
        return '⚡';
    }
  };

  return (
    <div className="flex items-start gap-2 p-2 rounded bg-neutral-800/50 border border-neutral-700">
      <span className="text-lg">{getCommandIcon(command.commandType)}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-blue-400">{command.commandType}</span>
          <span className="text-xs text-neutral-500">#{index + 1}</span>
        </div>
        {command.description && (
          <p className="text-xs text-neutral-400 mt-1">{command.description}</p>
        )}
      </div>
    </div>
  );
};

interface RiskBadgeProps {
  level: string;
  label: string;
}

const RiskBadge: React.FC<RiskBadgeProps> = ({ level, label }) => {
  const getColorClass = (level: string): string => {
    switch (level) {
      case 'none':
        return 'bg-green-900/50 text-green-400 border-green-700';
      case 'low':
        return 'bg-yellow-900/50 text-yellow-400 border-yellow-700';
      case 'medium':
        return 'bg-orange-900/50 text-orange-400 border-orange-700';
      case 'high':
      case 'likely':
        return 'bg-red-900/50 text-red-400 border-red-700';
      case 'possible':
        return 'bg-yellow-900/50 text-yellow-400 border-yellow-700';
      default:
        return 'bg-neutral-900/50 text-neutral-400 border-neutral-700';
    }
  };

  return (
    <span
      className={`px-2 py-0.5 text-xs rounded border ${getColorClass(level)}`}
    >
      {label}: {level}
    </span>
  );
};

// =============================================================================
// Main Component
// =============================================================================

export const ProposalDialog: React.FC<ProposalDialogProps> = ({
  proposal,
  isApplying,
  onApprove,
  onReject,
  onModify,
}) => {
  const handleApprove = useCallback(async () => {
    try {
      await onApprove();
    } catch (error) {
      logger.error('Failed to apply proposal', { error });
    }
  }, [onApprove]);

  const handleReject = useCallback(() => {
    onReject();
  }, [onReject]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' && !isApplying && proposal && proposal.commands.length > 0) {
        event.preventDefault();
        void handleApprove();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        handleReject();
      }
    },
    [handleApprove, handleReject, isApplying, proposal]
  );

  const hasHighRisk = useMemo(() => {
    if (!proposal) return false;
    return (
      proposal.risk.copyright === 'high' ||
      proposal.risk.nsfw === 'likely'
    );
  }, [proposal]);

  const hasCommands = useMemo(() => {
    return proposal && proposal.commands.length > 0;
  }, [proposal]);

  if (!proposal) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="proposal-title"
    >
      <div className="w-full max-w-lg mx-4 bg-neutral-900 rounded-lg border border-neutral-700 shadow-2xl">
        {/* Header */}
        <div className="px-4 py-3 border-b border-neutral-700">
          <div className="flex items-center gap-2">
            <span className="text-lg">🤖</span>
            <h2 id="proposal-title" className="text-lg font-semibold text-white">
              AI Edit Proposal
            </h2>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Intent */}
          <div>
            <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-1">
              Your Request
            </h3>
            <p className="text-sm text-white bg-neutral-800 rounded p-2 border border-neutral-700">
              "{proposal.intent}"
            </p>
          </div>

          {/* Explanation */}
          <div>
            <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-1">
              AI Explanation
            </h3>
            <p className="text-sm text-neutral-300 whitespace-pre-wrap">
              {proposal.explanation}
            </p>
          </div>

          {/* Commands */}
          {hasCommands && (
            <div>
              <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-2">
                Commands to Execute ({proposal.commands.length})
              </h3>
              <div className="space-y-2">
                {proposal.commands.map((command, index) => (
                  <CommandItem key={index} command={command} index={index} />
                ))}
              </div>
            </div>
          )}

          {/* Risk Assessment */}
          <div>
            <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-2">
              Risk Assessment
            </h3>
            <div className="flex gap-2">
              <RiskBadge level={proposal.risk.copyright} label="Copyright" />
              <RiskBadge level={proposal.risk.nsfw} label="NSFW" />
            </div>
            {hasHighRisk && (
              <p className="mt-2 text-xs text-red-400">
                ⚠️ This proposal contains high-risk operations. Please review carefully.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-neutral-700 flex items-center justify-between">
          <div className="text-xs text-neutral-500">
            <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-600">
              Enter
            </kbd>{' '}
            to approve,{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-600">
              Esc
            </kbd>{' '}
            to reject
          </div>
          <div className="flex gap-2">
            {onModify && (
              <button
                type="button"
                onClick={onModify}
                disabled={isApplying}
                className="px-3 py-1.5 text-sm rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Modify
              </button>
            )}
            <button
              type="button"
              onClick={handleReject}
              disabled={isApplying}
              className="px-3 py-1.5 text-sm rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={isApplying || !hasCommands}
              className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {isApplying ? (
                <>
                  <span className="animate-spin">⏳</span>
                  Applying...
                </>
              ) : (
                <>
                  ✓ Approve
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProposalDialog;

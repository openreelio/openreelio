/**
 * CostEstimateDisplay Component
 *
 * Shows the estimated cost for a video generation request
 * with quality tier, duration, and formatted price.
 */

import React from 'react';

// =============================================================================
// Types
// =============================================================================

export interface CostEstimateDisplayProps {
  /** Estimated cost in cents */
  estimatedCents: number;
  /** Quality tier */
  quality: string;
  /** Duration in seconds */
  durationSec: number;
  /** Optional budget remaining in cents (null = no budget set) */
  budgetRemainingCents?: number | null;
  /** Optional class name */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export const CostEstimateDisplay: React.FC<CostEstimateDisplayProps> = ({
  estimatedCents,
  quality,
  durationSec,
  budgetRemainingCents,
  className = '',
}) => {
  const formattedCost = `$${(estimatedCents / 100).toFixed(2)}`;
  const isOverBudget =
    budgetRemainingCents != null && estimatedCents > budgetRemainingCents;

  return (
    <div
      className={`p-3 rounded-lg border ${
        isOverBudget
          ? 'bg-red-500/10 border-red-500/30'
          : 'bg-editor-bg border-editor-border'
      } ${className}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-editor-text-muted uppercase tracking-wider">
          Cost Estimate
        </span>
        <span
          className={`text-sm font-semibold ${
            isOverBudget ? 'text-red-400' : 'text-editor-text'
          }`}
        >
          {formattedCost}
        </span>
      </div>

      <div className="flex items-center gap-3 text-xs text-editor-text-muted">
        <span className="capitalize">{quality}</span>
        <span className="text-editor-border">|</span>
        <span>{durationSec}s</span>
        {budgetRemainingCents != null && (
          <>
            <span className="text-editor-border">|</span>
            <span className={isOverBudget ? 'text-red-400' : ''}>
              Budget: ${(budgetRemainingCents / 100).toFixed(2)} remaining
            </span>
          </>
        )}
      </div>

      {isOverBudget && (
        <p className="mt-2 text-xs text-red-400">
          Estimated cost exceeds remaining budget
        </p>
      )}
    </div>
  );
};

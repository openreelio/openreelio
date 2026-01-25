/**
 * CostControlPanel Component
 *
 * Panel for managing AI cost controls including monthly budget,
 * per-request limits, and usage tracking.
 */

import React, { useCallback, useState, useEffect } from 'react';
import type { AISettings } from '@/stores/settingsStore';

// =============================================================================
// Types
// =============================================================================

export interface CostControlPanelProps {
  /** Current AI settings */
  settings: AISettings;
  /** Callback when settings are updated */
  onUpdate: (values: Partial<AISettings>) => void;
  /** Whether inputs should be disabled */
  disabled?: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

/** Convert cents to dollars string with 2 decimal places */
function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Convert dollars string to cents, returns null for empty/invalid input */
function dollarsToCents(dollars: string): number | null {
  if (!dollars.trim()) return null;
  const value = parseFloat(dollars);
  if (isNaN(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** Get progress bar color based on percentage */
function getProgressBarColor(percentage: number): string {
  if (percentage >= 100) return 'bg-red-500';
  if (percentage >= 80) return 'bg-yellow-500';
  return 'bg-green-500';
}

// =============================================================================
// Component
// =============================================================================

export const CostControlPanel: React.FC<CostControlPanelProps> = ({
  settings,
  onUpdate,
  disabled = false,
}) => {
  // Local state for input fields (to handle editing before blur)
  const [budgetInput, setBudgetInput] = useState<string>(
    settings.monthlyBudgetCents != null ? centsToDollars(settings.monthlyBudgetCents) : ''
  );
  const [limitInput, setLimitInput] = useState<string>(
    centsToDollars(settings.perRequestLimitCents)
  );

  // Sync local state with props when settings change externally
  useEffect(() => {
    setBudgetInput(
      settings.monthlyBudgetCents != null ? centsToDollars(settings.monthlyBudgetCents) : ''
    );
    setLimitInput(centsToDollars(settings.perRequestLimitCents));
  }, [settings.monthlyBudgetCents, settings.perRequestLimitCents]);

  // Calculate usage percentage
  const usagePercentage =
    settings.monthlyBudgetCents != null && settings.monthlyBudgetCents > 0
      ? Math.round((settings.currentMonthUsageCents / settings.monthlyBudgetCents) * 100)
      : 0;

  // Handle budget input blur
  const handleBudgetBlur = useCallback(() => {
    const cents = dollarsToCents(budgetInput);
    onUpdate({ monthlyBudgetCents: cents });
  }, [budgetInput, onUpdate]);

  // Handle limit input blur
  const handleLimitBlur = useCallback(() => {
    const cents = dollarsToCents(limitInput);
    if (cents != null) {
      onUpdate({ perRequestLimitCents: cents });
    }
  }, [limitInput, onUpdate]);

  // Handle reset usage
  const handleResetUsage = useCallback(() => {
    onUpdate({
      currentMonthUsageCents: 0,
      currentUsageMonth: null,
    });
  }, [onUpdate]);

  return (
    <div className="space-y-6">
      {/* Section Header */}
      <div className="border-b border-editor-border pb-2">
        <h3 className="text-sm font-medium text-editor-text">Cost Controls</h3>
        <p className="text-xs text-editor-text-muted mt-1">
          Manage your AI usage budget and limits
        </p>
      </div>

      {/* Current Usage Display */}
      <div className="bg-editor-bg rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-editor-text-muted">Current Month Usage</span>
          <span className="text-lg font-semibold text-editor-text">
            ${centsToDollars(settings.currentMonthUsageCents)}
          </span>
        </div>

        {/* Progress Bar (only when budget is set) */}
        {settings.monthlyBudgetCents != null && settings.monthlyBudgetCents > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-editor-text-muted">
                of ${centsToDollars(settings.monthlyBudgetCents)} budget
              </span>
              <span className="font-medium text-editor-text">{usagePercentage}%</span>
            </div>
            <div className="h-2 bg-editor-border rounded-full overflow-hidden">
              <div
                role="progressbar"
                aria-valuenow={usagePercentage}
                aria-valuemin={0}
                aria-valuemax={100}
                className={`h-full transition-all duration-300 ${getProgressBarColor(usagePercentage)}`}
                style={{ width: `${Math.min(usagePercentage, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Reset Button */}
        <div className="pt-2">
          <button
            type="button"
            onClick={handleResetUsage}
            disabled={disabled}
            className="text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Reset Usage
          </button>
        </div>
      </div>

      {/* Budget Settings */}
      <div className="space-y-4">
        {/* Monthly Budget */}
        <div>
          <label
            htmlFor="monthly-budget"
            className="block text-sm font-medium text-editor-text-muted mb-1"
          >
            Monthly Budget ($)
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-editor-text-muted">
              $
            </span>
            <input
              id="monthly-budget"
              type="text"
              inputMode="decimal"
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              onBlur={handleBudgetBlur}
              placeholder="No limit"
              disabled={disabled}
              className="w-full pl-7 pr-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50"
            />
          </div>
          <p className="mt-1 text-xs text-editor-text-muted">
            Leave empty for no monthly budget limit
          </p>
        </div>

        {/* Per-Request Limit */}
        <div>
          <label
            htmlFor="per-request-limit"
            className="block text-sm font-medium text-editor-text-muted mb-1"
          >
            Per-Request Limit ($)
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-editor-text-muted">
              $
            </span>
            <input
              id="per-request-limit"
              type="text"
              inputMode="decimal"
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              onBlur={handleLimitBlur}
              disabled={disabled}
              className="w-full pl-7 pr-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50"
            />
          </div>
          <p className="mt-1 text-xs text-editor-text-muted">
            Maximum cost allowed per AI request
          </p>
        </div>
      </div>
    </div>
  );
};

export default CostControlPanel;

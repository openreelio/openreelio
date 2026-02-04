/**
 * PlanViewer Component
 *
 * Displays an AI-generated plan with steps, risk assessment,
 * and approval controls.
 */

import { useMemo } from 'react';
import type { Plan, PlanStep, RiskLevel } from '@/agents/engine';

// =============================================================================
// Types
// =============================================================================

export interface PlanViewerProps {
  /** The plan to display */
  plan: Plan | null;
  /** Whether awaiting approval */
  isAwaitingApproval?: boolean;
  /** Current step ID (for highlighting) */
  currentStepId?: string;
  /** Completed step IDs */
  completedStepIds?: string[];
  /** Called when plan is approved */
  onApprove?: () => void;
  /** Called when plan is rejected */
  onReject?: () => void;
  /** Show in collapsed mode */
  collapsed?: boolean;
  /** Optional className */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const RISK_COLORS: Record<RiskLevel, { bg: string; text: string; border: string }> = {
  low: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/20' },
  medium: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/20' },
  high: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/20' },
  critical: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/20' },
};

const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

function maxRiskLevel(steps: PlanStep[]): RiskLevel {
  let maxIndex = 0;
  for (const step of steps) {
    const idx = RISK_ORDER.indexOf(step.riskLevel);
    if (idx > maxIndex) {
      maxIndex = idx;
    }
  }
  return RISK_ORDER[maxIndex];
}

function riskNeedsApproval(level: RiskLevel): boolean {
  return level === 'high' || level === 'critical';
}

const RISK_ICONS: Record<RiskLevel, string> = {
  low: '✓',
  medium: '⚠',
  high: '⚠',
  critical: '⛔',
};

// =============================================================================
// Sub-Components
// =============================================================================

interface StepCardProps {
  step: PlanStep;
  index: number;
  isCurrent: boolean;
  isCompleted: boolean;
}

function StepCard({ step, index, isCurrent, isCompleted }: StepCardProps) {
  const riskStyle = RISK_COLORS[step.riskLevel];
  const needsApproval = riskNeedsApproval(step.riskLevel);

  return (
    <div
      data-testid={`plan-step-${step.id}`}
      className={`
        p-3 rounded-lg border transition-all
        ${isCurrent
          ? 'border-primary-500 bg-primary-500/5'
          : isCompleted
          ? 'border-border-subtle bg-surface-base opacity-60'
          : 'border-border-subtle bg-surface-elevated'
        }
      `}
    >
      <div className="flex items-start gap-3">
        {/* Step Number */}
        <div
          className={`
            w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium
            ${isCompleted
              ? 'bg-green-500/20 text-green-400'
              : isCurrent
              ? 'bg-primary-500/20 text-primary-400'
              : 'bg-surface-active text-text-tertiary'
            }
          `}
        >
          {isCompleted ? '✓' : index + 1}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text-primary">{step.description}</p>

          <div className="flex items-center gap-2 mt-2">
            {/* Tool */}
            <span className="px-2 py-0.5 text-xs bg-surface-active text-text-secondary rounded">
              {step.tool}
            </span>

            {/* Risk Badge */}
            <span
              className={`px-2 py-0.5 text-xs rounded ${riskStyle.bg} ${riskStyle.text}`}
            >
              {RISK_ICONS[step.riskLevel]} {step.riskLevel}
            </span>

            {/* Approval Badge */}
            {needsApproval && (
              <span className="px-2 py-0.5 text-xs bg-yellow-500/10 text-yellow-400 rounded">
                needs approval
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RiskBadge({ level }: { level: RiskLevel }) {
  const style = RISK_COLORS[level];

  return (
    <span
      className={`px-2 py-1 text-xs font-medium rounded ${style.bg} ${style.text} ${style.border} border`}
    >
      {RISK_ICONS[level]} {level.charAt(0).toUpperCase() + level.slice(1)} Risk
    </span>
  );
}

// =============================================================================
// Component
// =============================================================================

export function PlanViewer({
  plan,
  isAwaitingApproval = false,
  currentStepId,
  completedStepIds = [],
  onApprove,
  onReject,
  collapsed = false,
  className = '',
}: PlanViewerProps) {
  // ===========================================================================
  // Derived State
  // ===========================================================================

  const completedSet = useMemo(
    () => new Set(completedStepIds),
    [completedStepIds]
  );

  // ===========================================================================
  // No Plan
  // ===========================================================================

  if (!plan) {
    return <div data-testid="plan-viewer" className={className} />;
  }

  const overallRiskLevel = maxRiskLevel(plan.steps);

  // ===========================================================================
  // Collapsed Mode
  // ===========================================================================

  if (collapsed) {
    return (
      <div
        data-testid="plan-viewer"
        className={`p-3 bg-surface-elevated border border-border-subtle rounded-lg ${className}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-primary-400">📋</span>
            <span className="text-sm text-text-primary">{plan.goal}</span>
          </div>
          <RiskBadge level={overallRiskLevel} />
        </div>
        <p className="text-xs text-text-tertiary mt-1">
          {plan.steps.length} steps
        </p>
      </div>
    );
  }

  // ===========================================================================
  // Full Mode
  // ===========================================================================

  return (
    <div
      data-testid="plan-viewer"
      className={`bg-surface-elevated border border-border-subtle rounded-lg overflow-hidden ${className}`}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-primary-400">📋</span>
            <span className="text-sm font-medium text-text-primary">
              Execution Plan
            </span>
          </div>
          <RiskBadge level={overallRiskLevel} />
        </div>
      </div>

      {/* Goal */}
      <div className="px-4 py-3 border-b border-border-subtle bg-surface-base">
        <h3 className="text-sm font-medium text-text-primary">{plan.goal}</h3>
      </div>

      {/* Steps */}
      <div className="p-4 space-y-2">
        {plan.steps.map((step, index) => (
          <StepCard
            key={step.id}
            step={step}
            index={index}
            isCurrent={step.id === currentStepId}
            isCompleted={completedSet.has(step.id)}
          />
        ))}
      </div>

      {/* Approval Actions */}
      {isAwaitingApproval && onApprove && onReject && (
        <div className="px-4 py-3 border-t border-border-subtle bg-yellow-500/5 flex items-center justify-between">
          <span className="text-sm text-yellow-400">
            This plan requires your approval
          </span>
          <div className="flex gap-2">
            <button
              onClick={onReject}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary bg-surface-active hover:bg-surface-hover rounded-lg transition-colors"
            >
              Reject
            </button>
            <button
              onClick={onApprove}
              className="px-4 py-2 text-sm text-white bg-primary-600 hover:bg-primary-500 rounded-lg transition-colors"
            >
              Approve
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

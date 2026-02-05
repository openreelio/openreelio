/**
 * WorkflowProgress Component
 *
 * Displays the progress of an AI agent workflow.
 * Shows current phase, steps, and overall progress.
 */

import { useMemo } from 'react';
import type { WorkflowPhase } from '@/agents/workflow/WorkflowState';
import type { WorkflowStepData, WorkflowStepStatus } from '@/hooks/useAgentWorkflow';

// =============================================================================
// Types
// =============================================================================

export interface WorkflowProgressProps {
  /** Current workflow phase */
  phase: WorkflowPhase;
  /** List of workflow steps */
  steps: WorkflowStepData[];
  /** Overall progress percentage (0-100) */
  progress: number;
  /** Error message if workflow failed */
  error?: string | null;
  /** Whether the workflow is active */
  isActive: boolean;
  /** Optional callback when cancel is clicked */
  onCancel?: () => void;
  /** Whether to show in compact mode */
  compact?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const PHASE_LABELS: Record<WorkflowPhase, string> = {
  idle: 'Ready',
  analyzing: 'Analyzing',
  planning: 'Planning',
  awaiting_approval: 'Awaiting Approval',
  executing: 'Executing',
  verifying: 'Verifying',
  complete: 'Complete',
  failed: 'Failed',
  rolled_back: 'Rolled Back',
  cancelled: 'Cancelled',
};

const PHASE_COLORS: Record<WorkflowPhase, string> = {
  idle: 'text-text-tertiary',
  analyzing: 'text-blue-400',
  planning: 'text-blue-400',
  awaiting_approval: 'text-yellow-400',
  executing: 'text-primary-400',
  verifying: 'text-primary-400',
  complete: 'text-green-400',
  failed: 'text-red-400',
  rolled_back: 'text-yellow-400',
  cancelled: 'text-text-tertiary',
};

const STATUS_ICONS: Record<WorkflowStepStatus, { icon: string; color: string }> = {
  pending: { icon: '○', color: 'text-text-tertiary' },
  in_progress: { icon: '◉', color: 'text-primary-400' },
  completed: { icon: '✓', color: 'text-green-400' },
  failed: { icon: '✗', color: 'text-red-400' },
  skipped: { icon: '−', color: 'text-text-tertiary' },
};

// =============================================================================
// Sub-Components
// =============================================================================

interface StepItemProps {
  step: WorkflowStepData;
  isLast: boolean;
}

function StepItem({ step, isLast }: StepItemProps) {
  const { icon, color } = STATUS_ICONS[step.status];

  return (
    <div className="flex items-start gap-3">
      {/* Icon and Line */}
      <div className="flex flex-col items-center">
        <span className={`text-sm ${color}`}>{icon}</span>
        {!isLast && (
          <div className="w-px h-6 bg-border-subtle mt-1" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-4">
        <p
          className={`text-sm font-medium ${
            step.status === 'in_progress'
              ? 'text-text-primary'
              : step.status === 'completed'
              ? 'text-text-secondary'
              : 'text-text-tertiary'
          }`}
        >
          {step.name}
        </p>
        {step.description && (
          <p className="text-xs text-text-tertiary mt-0.5 truncate">
            {step.description}
          </p>
        )}
        {step.error && (
          <p className="text-xs text-red-400 mt-0.5">{step.error}</p>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export function WorkflowProgress({
  phase,
  steps,
  progress,
  error,
  isActive,
  onCancel,
  compact = false,
}: WorkflowProgressProps) {
  // ===========================================================================
  // Derived State
  // ===========================================================================

  const isComplete = phase === 'complete';
  const isFailed = phase === 'failed';

  const progressBarColor = useMemo(() => {
    if (isFailed) return 'bg-red-500';
    if (isComplete) return 'bg-green-500';
    return 'bg-primary-500';
  }, [isFailed, isComplete]);

  // ===========================================================================
  // Compact Mode
  // ===========================================================================

  if (compact) {
    return (
      <div
        data-testid="workflow-progress-compact"
        className="flex items-center gap-3 px-3 py-2 bg-surface-elevated rounded-lg border border-border-subtle"
      >
        {/* Spinner for active state */}
        {isActive && !isFailed && !isComplete && (
          <div className="w-4 h-4 border-2 border-primary-400/30 border-t-primary-400 rounded-full animate-spin" />
        )}

        {/* Phase Label */}
        <span className={`text-sm font-medium ${PHASE_COLORS[phase]}`}>
          {PHASE_LABELS[phase]}
        </span>

        {/* Progress */}
        {isActive && (
          <div className="flex-1 h-1.5 bg-surface-active rounded-full overflow-hidden">
            <div
              className={`h-full ${progressBarColor} transition-all duration-300`}
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* Cancel Button */}
        {isActive && onCancel && (
          <button
            onClick={onCancel}
            className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    );
  }

  // ===========================================================================
  // Full Mode
  // ===========================================================================

  return (
    <div
      data-testid="workflow-progress"
      className="bg-surface-elevated rounded-lg border border-border-subtle overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Spinner for active state */}
          {isActive && !isFailed && !isComplete && (
            <div className="w-5 h-5 border-2 border-primary-400/30 border-t-primary-400 rounded-full animate-spin" />
          )}

          {/* Complete icon */}
          {isComplete && (
            <div className="w-5 h-5 bg-green-500/20 rounded-full flex items-center justify-center">
              <span className="text-green-400 text-xs">✓</span>
            </div>
          )}

          {/* Failed icon */}
          {isFailed && (
            <div className="w-5 h-5 bg-red-500/20 rounded-full flex items-center justify-center">
              <span className="text-red-400 text-xs">✗</span>
            </div>
          )}

          <div>
            <h3 className={`text-sm font-medium ${PHASE_COLORS[phase]}`}>
              {PHASE_LABELS[phase]}
            </h3>
            {error && (
              <p className="text-xs text-red-400 mt-0.5">{error}</p>
            )}
          </div>
        </div>

        {/* Cancel Button */}
        {isActive && onCancel && (
          <button
            onClick={onCancel}
            className="text-sm text-text-tertiary hover:text-text-secondary transition-colors px-2 py-1"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Progress Bar */}
      <div className="h-1 bg-surface-active">
        <div
          className={`h-full ${progressBarColor} transition-all duration-300`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Steps List */}
      {steps.length > 0 && (
        <div className="px-4 py-3">
          {steps.map((step, index) => (
            <StepItem
              key={step.id}
              step={step}
              isLast={index === steps.length - 1}
            />
          ))}
        </div>
      )}

      {/* Empty State */}
      {steps.length === 0 && isActive && (
        <div className="px-4 py-6 text-center">
          <p className="text-sm text-text-tertiary">Preparing workflow...</p>
        </div>
      )}
    </div>
  );
}

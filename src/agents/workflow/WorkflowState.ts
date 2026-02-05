/**
 * Workflow State
 *
 * Defines workflow states, transitions, and related types for multi-step
 * agent operations.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Workflow phases representing the lifecycle of an agent operation.
 */
export type WorkflowPhase =
  | 'idle'           // No active workflow
  | 'analyzing'      // Analyzing user intent
  | 'planning'       // Planning operations
  | 'awaiting_approval' // Waiting for user approval
  | 'executing'      // Executing operations
  | 'verifying'      // Verifying results
  | 'complete'       // Workflow completed successfully
  | 'failed'         // Workflow failed
  | 'rolled_back'    // Workflow rolled back after failure
  | 'cancelled';     // Workflow cancelled by user

/**
 * Valid transitions between workflow phases.
 */
export const VALID_TRANSITIONS: Record<WorkflowPhase, WorkflowPhase[]> = {
  idle: ['analyzing'],
  analyzing: ['planning', 'failed', 'cancelled'],
  planning: ['awaiting_approval', 'executing', 'failed', 'cancelled'],
  awaiting_approval: ['executing', 'cancelled', 'idle'],
  executing: ['verifying', 'failed', 'cancelled'],
  verifying: ['complete', 'failed', 'rolled_back'],
  complete: ['idle'],
  failed: ['idle', 'rolled_back'],
  rolled_back: ['idle'],
  cancelled: ['idle'],
};

/**
 * A step in the workflow execution plan.
 */
export interface WorkflowStep {
  /** Unique identifier for this step */
  id: string;
  /** The tool to execute */
  toolName: string;
  /** Arguments for the tool */
  args: Record<string, unknown>;
  /** Description of what this step does */
  description: string;
  /** Whether this step requires approval */
  requiresApproval: boolean;
  /** Status of this step */
  status: StepStatus;
  /** Error message if step failed */
  error?: string;
  /** Result from execution */
  result?: unknown;
  /** Execution start time */
  startedAt?: number;
  /** Execution end time */
  completedAt?: number;
}

/**
 * Status of a workflow step.
 */
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/**
 * Complete workflow state.
 */
export interface WorkflowState {
  /** Unique workflow identifier */
  id: string;
  /** Current workflow phase */
  phase: WorkflowPhase;
  /** Steps to execute */
  steps: WorkflowStep[];
  /** Index of current step being executed */
  currentStepIndex: number;
  /** Original user intent */
  intent: string;
  /** When the workflow started */
  startedAt: number;
  /** When the workflow completed (if finished) */
  completedAt?: number;
  /** Overall workflow error (if failed) */
  error?: string;
  /** Whether any high-risk operations are present */
  hasHighRiskOperations: boolean;
  /** Approval status from user */
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  /** Rejection reason if rejected */
  rejectionReason?: string;
}

// =============================================================================
// State Factory
// =============================================================================

/**
 * Create a new workflow state.
 *
 * @param intent - The user's original intent
 * @param steps - Steps to execute
 * @returns New workflow state
 */
export function createWorkflowState(
  intent: string,
  steps: Omit<WorkflowStep, 'id' | 'status'>[] = []
): WorkflowState {
  const workflowSteps: WorkflowStep[] = steps.map((step, index) => ({
    ...step,
    id: `step_${index}_${Date.now()}`,
    status: 'pending',
  }));

  const hasHighRiskOperations = workflowSteps.some((step) => step.requiresApproval);

  return {
    id: crypto.randomUUID(),
    phase: 'idle',
    steps: workflowSteps,
    currentStepIndex: -1,
    intent,
    startedAt: Date.now(),
    hasHighRiskOperations,
  };
}

// =============================================================================
// Transition Validation
// =============================================================================

/**
 * Check if a phase transition is valid.
 *
 * @param from - Current phase
 * @param to - Target phase
 * @returns Whether the transition is valid
 */
export function isValidTransition(from: WorkflowPhase, to: WorkflowPhase): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Get valid next phases from current phase.
 *
 * @param current - Current phase
 * @returns Array of valid next phases
 */
export function getValidNextPhases(current: WorkflowPhase): WorkflowPhase[] {
  return VALID_TRANSITIONS[current];
}

/**
 * Check if workflow is in a terminal state.
 *
 * @param phase - Current phase
 * @returns Whether the workflow is finished
 */
export function isTerminalPhase(phase: WorkflowPhase): boolean {
  return ['complete', 'failed', 'rolled_back', 'cancelled'].includes(phase);
}

/**
 * Check if workflow can be cancelled.
 *
 * @param phase - Current phase
 * @returns Whether the workflow can be cancelled
 */
export function canCancel(phase: WorkflowPhase): boolean {
  return ['analyzing', 'planning', 'awaiting_approval', 'executing'].includes(phase);
}

// =============================================================================
// State Helpers
// =============================================================================

/**
 * Get the current step from workflow state.
 *
 * @param state - Workflow state
 * @returns Current step or null
 */
export function getCurrentStep(state: WorkflowState): WorkflowStep | null {
  if (state.currentStepIndex < 0 || state.currentStepIndex >= state.steps.length) {
    return null;
  }
  return state.steps[state.currentStepIndex];
}

/**
 * Get the next pending step.
 *
 * @param state - Workflow state
 * @returns Next pending step or null
 */
export function getNextPendingStep(state: WorkflowState): WorkflowStep | null {
  const nextIndex = state.steps.findIndex(
    (step, index) => index > state.currentStepIndex && step.status === 'pending'
  );
  return nextIndex >= 0 ? state.steps[nextIndex] : null;
}

/**
 * Calculate workflow progress as percentage.
 *
 * @param state - Workflow state
 * @returns Progress percentage (0-100)
 */
export function getWorkflowProgress(state: WorkflowState): number {
  if (state.steps.length === 0) return 100;

  const completedSteps = state.steps.filter(
    (step) => step.status === 'completed' || step.status === 'skipped'
  ).length;

  return Math.round((completedSteps / state.steps.length) * 100);
}

/**
 * Get a summary of step statuses.
 *
 * @param state - Workflow state
 * @returns Count of steps by status
 */
export function getStepStatusSummary(state: WorkflowState): Record<StepStatus, number> {
  const summary: Record<StepStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
  };

  for (const step of state.steps) {
    summary[step.status]++;
  }

  return summary;
}

/**
 * Get human-readable phase description.
 *
 * @param phase - Workflow phase
 * @returns Description string
 */
export function getPhaseDescription(phase: WorkflowPhase): string {
  const descriptions: Record<WorkflowPhase, string> = {
    idle: 'Ready',
    analyzing: 'Analyzing your request...',
    planning: 'Planning operations...',
    awaiting_approval: 'Waiting for your approval',
    executing: 'Executing operations...',
    verifying: 'Verifying results...',
    complete: 'Completed successfully',
    failed: 'Operation failed',
    rolled_back: 'Changes rolled back',
    cancelled: 'Operation cancelled',
  };

  return descriptions[phase];
}

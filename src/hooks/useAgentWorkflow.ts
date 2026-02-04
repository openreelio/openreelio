/**
 * useAgentWorkflow Hook
 *
 * Manages workflow state for the AI agent system.
 * Provides state tracking, transitions, and progress calculation.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  type WorkflowPhase,
  isValidTransition,
} from '@/agents/workflow/WorkflowState';

// =============================================================================
// Types
// =============================================================================

/** Step status in a workflow */
export type WorkflowStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

/** A step in the workflow */
export interface WorkflowStepData {
  id: string;
  name: string;
  status: WorkflowStepStatus;
  description?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

/** Workflow store state */
interface WorkflowState {
  workflowId: string | null;
  phase: WorkflowPhase;
  phaseHistory: WorkflowPhase[];
  intent: string | null;
  steps: WorkflowStepData[];
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

/** Workflow store actions */
interface WorkflowActions {
  startWorkflow: (intent: string) => void;
  transitionTo: (phase: WorkflowPhase) => boolean;
  addStep: (step: WorkflowStepData) => void;
  updateStep: (stepId: string, update: Partial<WorkflowStepData>) => void;
  completeWorkflow: () => void;
  failWorkflow: (error: string) => void;
  cancelWorkflow: () => void;
  reset: () => void;
}

type WorkflowStore = WorkflowState & WorkflowActions;

// =============================================================================
// Initial State
// =============================================================================

const initialState: WorkflowState = {
  workflowId: null,
  phase: 'idle',
  phaseHistory: [],
  intent: null,
  steps: [],
  error: null,
  startedAt: null,
  completedAt: null,
};

// =============================================================================
// Store
// =============================================================================

export const useAgentWorkflowStore = create<WorkflowStore>()(
  immer((set, get) => ({
    ...initialState,

    startWorkflow: (intent: string) => {
      const { phase } = get();

      // Don't start if already active
      if (phase !== 'idle' && phase !== 'complete' && phase !== 'failed' && phase !== 'cancelled') {
        return;
      }

      set((state) => {
        state.workflowId = crypto.randomUUID();
        state.phase = 'analyzing';
        state.phaseHistory = ['idle'];
        state.intent = intent;
        state.steps = [];
        state.error = null;
        state.startedAt = Date.now();
        state.completedAt = null;
      });
    },

    transitionTo: (newPhase: WorkflowPhase) => {
      const { phase } = get();

      if (!isValidTransition(phase, newPhase)) {
        return false;
      }

      set((state) => {
        state.phaseHistory.push(state.phase);
        state.phase = newPhase;
      });

      return true;
    },

    addStep: (step: WorkflowStepData) => {
      set((state) => {
        const existingIndex = state.steps.findIndex((s) => s.id === step.id);
        if (existingIndex >= 0) {
          state.steps[existingIndex] = step;
        } else {
          state.steps.push(step);
        }
      });
    },

    updateStep: (stepId: string, update: Partial<WorkflowStepData>) => {
      set((state) => {
        const step = state.steps.find((s) => s.id === stepId);
        if (step) {
          Object.assign(step, update);
        }
      });
    },

    completeWorkflow: () => {
      const { phase } = get();

      // Allow completion from verifying phase
      if (phase !== 'verifying' && phase !== 'executing') {
        return;
      }

      set((state) => {
        state.phaseHistory.push(state.phase);
        state.phase = 'complete';
        state.completedAt = Date.now();
      });
    },

    failWorkflow: (error: string) => {
      set((state) => {
        state.phaseHistory.push(state.phase);
        state.phase = 'failed';
        state.error = error;
        state.completedAt = Date.now();
      });
    },

    cancelWorkflow: () => {
      set((state) => {
        state.phaseHistory.push(state.phase);
        state.phase = 'cancelled';
        state.completedAt = Date.now();
      });
    },

    reset: () => {
      set(() => ({ ...initialState }));
    },
  }))
);

// =============================================================================
// Hook
// =============================================================================

export interface UseAgentWorkflowReturn {
  // State
  workflowId: string | null;
  phase: WorkflowPhase;
  phaseHistory: WorkflowPhase[];
  intent: string | null;
  steps: WorkflowStepData[];
  error: string | null;
  isActive: boolean;
  progress: number;
  currentStep: WorkflowStepData | null;

  // Actions
  startWorkflow: (intent: string) => void;
  transitionTo: (phase: WorkflowPhase) => boolean;
  addStep: (step: WorkflowStepData) => void;
  updateStep: (stepId: string, update: Partial<WorkflowStepData>) => void;
  completeWorkflow: () => void;
  failWorkflow: (error: string) => void;
  cancelWorkflow: () => void;
  reset: () => void;
}

export function useAgentWorkflow(): UseAgentWorkflowReturn {
  const store = useAgentWorkflowStore();

  // Calculate derived state
  const isActive =
    store.phase !== 'idle' &&
    store.phase !== 'complete' &&
    store.phase !== 'failed' &&
    store.phase !== 'cancelled' &&
    store.phase !== 'rolled_back';

  const progress =
    store.steps.length === 0
      ? 0
      : Math.round(
          (store.steps.filter((s) => s.status === 'completed').length /
            store.steps.length) *
            100
        );

  const currentStep =
    store.steps.find((s) => s.status === 'in_progress') ??
    store.steps.find((s) => s.status === 'pending') ??
    null;

  return {
    // State
    workflowId: store.workflowId,
    phase: store.phase,
    phaseHistory: store.phaseHistory,
    intent: store.intent,
    steps: store.steps,
    error: store.error,
    isActive,
    progress,
    currentStep,

    // Actions
    startWorkflow: store.startWorkflow,
    transitionTo: store.transitionTo,
    addStep: store.addStep,
    updateStep: store.updateStep,
    completeWorkflow: store.completeWorkflow,
    failWorkflow: store.failWorkflow,
    cancelWorkflow: store.cancelWorkflow,
    reset: store.reset,
  };
}

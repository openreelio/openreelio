/**
 * Workflow State Tests
 *
 * Tests for workflow state management utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  createWorkflowState,
  isValidTransition,
  getValidNextPhases,
  isTerminalPhase,
  canCancel,
  getCurrentStep,
  getNextPendingStep,
  getWorkflowProgress,
  getStepStatusSummary,
  getPhaseDescription,
  type WorkflowPhase,
} from './WorkflowState';

describe('WorkflowState', () => {
  describe('createWorkflowState', () => {
    it('should create workflow with default values', () => {
      const state = createWorkflowState('Test intent');

      expect(state.id).toBeDefined();
      expect(state.phase).toBe('idle');
      expect(state.steps).toEqual([]);
      expect(state.currentStepIndex).toBe(-1);
      expect(state.intent).toBe('Test intent');
      expect(state.startedAt).toBeDefined();
      expect(state.hasHighRiskOperations).toBe(false);
    });

    it('should create workflow with steps', () => {
      const steps = [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: true },
      ];

      const state = createWorkflowState('Test intent', steps);

      expect(state.steps).toHaveLength(2);
      expect(state.steps[0].status).toBe('pending');
      expect(state.steps[0].id).toBeDefined();
      expect(state.steps[1].requiresApproval).toBe(true);
    });

    it('should detect high risk operations', () => {
      const steps = [
        { toolName: 'safe', args: {}, description: 'Safe op', requiresApproval: false },
        { toolName: 'risky', args: {}, description: 'Risky op', requiresApproval: true },
      ];

      const state = createWorkflowState('Test', steps);
      expect(state.hasHighRiskOperations).toBe(true);
    });

    it('should not detect high risk when none present', () => {
      const steps = [
        { toolName: 'safe1', args: {}, description: 'Safe 1', requiresApproval: false },
        { toolName: 'safe2', args: {}, description: 'Safe 2', requiresApproval: false },
      ];

      const state = createWorkflowState('Test', steps);
      expect(state.hasHighRiskOperations).toBe(false);
    });
  });

  describe('isValidTransition', () => {
    it('should allow idle -> analyzing', () => {
      expect(isValidTransition('idle', 'analyzing')).toBe(true);
    });

    it('should allow analyzing -> planning', () => {
      expect(isValidTransition('analyzing', 'planning')).toBe(true);
    });

    it('should allow planning -> awaiting_approval', () => {
      expect(isValidTransition('planning', 'awaiting_approval')).toBe(true);
    });

    it('should allow planning -> executing (skip approval)', () => {
      expect(isValidTransition('planning', 'executing')).toBe(true);
    });

    it('should allow awaiting_approval -> executing', () => {
      expect(isValidTransition('awaiting_approval', 'executing')).toBe(true);
    });

    it('should allow awaiting_approval -> cancelled', () => {
      expect(isValidTransition('awaiting_approval', 'cancelled')).toBe(true);
    });

    it('should allow executing -> verifying', () => {
      expect(isValidTransition('executing', 'verifying')).toBe(true);
    });

    it('should allow verifying -> complete', () => {
      expect(isValidTransition('verifying', 'complete')).toBe(true);
    });

    it('should not allow idle -> executing', () => {
      expect(isValidTransition('idle', 'executing')).toBe(false);
    });

    it('should not allow complete -> analyzing', () => {
      expect(isValidTransition('complete', 'analyzing')).toBe(false);
    });

    it('should allow failure transitions', () => {
      expect(isValidTransition('analyzing', 'failed')).toBe(true);
      expect(isValidTransition('executing', 'failed')).toBe(true);
      expect(isValidTransition('verifying', 'failed')).toBe(true);
    });

    it('should allow rollback from verifying', () => {
      expect(isValidTransition('verifying', 'rolled_back')).toBe(true);
    });

    it('should allow rollback from failed', () => {
      expect(isValidTransition('failed', 'rolled_back')).toBe(true);
    });
  });

  describe('getValidNextPhases', () => {
    it('should return valid phases for idle', () => {
      expect(getValidNextPhases('idle')).toContain('analyzing');
    });

    it('should return multiple valid phases for awaiting_approval', () => {
      const phases = getValidNextPhases('awaiting_approval');
      expect(phases).toContain('executing');
      expect(phases).toContain('cancelled');
      expect(phases).toContain('idle');
    });
  });

  describe('isTerminalPhase', () => {
    it('should return true for complete', () => {
      expect(isTerminalPhase('complete')).toBe(true);
    });

    it('should return true for failed', () => {
      expect(isTerminalPhase('failed')).toBe(true);
    });

    it('should return true for rolled_back', () => {
      expect(isTerminalPhase('rolled_back')).toBe(true);
    });

    it('should return true for cancelled', () => {
      expect(isTerminalPhase('cancelled')).toBe(true);
    });

    it('should return false for executing', () => {
      expect(isTerminalPhase('executing')).toBe(false);
    });

    it('should return false for idle', () => {
      expect(isTerminalPhase('idle')).toBe(false);
    });
  });

  describe('canCancel', () => {
    it('should allow cancel during analyzing', () => {
      expect(canCancel('analyzing')).toBe(true);
    });

    it('should allow cancel during planning', () => {
      expect(canCancel('planning')).toBe(true);
    });

    it('should allow cancel during awaiting_approval', () => {
      expect(canCancel('awaiting_approval')).toBe(true);
    });

    it('should allow cancel during executing', () => {
      expect(canCancel('executing')).toBe(true);
    });

    it('should not allow cancel when idle', () => {
      expect(canCancel('idle')).toBe(false);
    });

    it('should not allow cancel when complete', () => {
      expect(canCancel('complete')).toBe(false);
    });
  });

  describe('getCurrentStep', () => {
    it('should return null when no current step', () => {
      const state = createWorkflowState('Test');
      expect(getCurrentStep(state)).toBeNull();
    });

    it('should return current step', () => {
      const state = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
      ]);
      state.currentStepIndex = 1;

      const step = getCurrentStep(state);
      expect(step?.toolName).toBe('tool2');
    });

    it('should return null when index out of bounds', () => {
      const state = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);
      state.currentStepIndex = 5;

      expect(getCurrentStep(state)).toBeNull();
    });
  });

  describe('getNextPendingStep', () => {
    it('should return first pending step', () => {
      const state = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
      ]);
      state.currentStepIndex = -1;

      const next = getNextPendingStep(state);
      expect(next?.toolName).toBe('tool1');
    });

    it('should skip completed steps', () => {
      const state = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
      ]);
      state.steps[0].status = 'completed';
      state.currentStepIndex = 0;

      const next = getNextPendingStep(state);
      expect(next?.toolName).toBe('tool2');
    });

    it('should return null when no pending steps', () => {
      const state = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);
      state.steps[0].status = 'completed';

      expect(getNextPendingStep(state)).toBeNull();
    });
  });

  describe('getWorkflowProgress', () => {
    it('should return 100 for empty workflow', () => {
      const state = createWorkflowState('Test');
      expect(getWorkflowProgress(state)).toBe(100);
    });

    it('should return 0 for all pending', () => {
      const state = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
      ]);

      expect(getWorkflowProgress(state)).toBe(0);
    });

    it('should calculate progress correctly', () => {
      const state = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
        { toolName: 'tool3', args: {}, description: 'Step 3', requiresApproval: false },
        { toolName: 'tool4', args: {}, description: 'Step 4', requiresApproval: false },
      ]);
      state.steps[0].status = 'completed';
      state.steps[1].status = 'completed';

      expect(getWorkflowProgress(state)).toBe(50);
    });

    it('should count skipped as progress', () => {
      const state = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
      ]);
      state.steps[0].status = 'completed';
      state.steps[1].status = 'skipped';

      expect(getWorkflowProgress(state)).toBe(100);
    });
  });

  describe('getStepStatusSummary', () => {
    it('should count steps by status', () => {
      const state = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
        { toolName: 'tool3', args: {}, description: 'Step 3', requiresApproval: false },
      ]);
      state.steps[0].status = 'completed';
      state.steps[1].status = 'in_progress';

      const summary = getStepStatusSummary(state);
      expect(summary.completed).toBe(1);
      expect(summary.in_progress).toBe(1);
      expect(summary.pending).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.skipped).toBe(0);
    });
  });

  describe('getPhaseDescription', () => {
    it('should return description for each phase', () => {
      const phases: WorkflowPhase[] = [
        'idle', 'analyzing', 'planning', 'awaiting_approval',
        'executing', 'verifying', 'complete', 'failed',
        'rolled_back', 'cancelled'
      ];

      for (const phase of phases) {
        expect(getPhaseDescription(phase)).toBeDefined();
        expect(getPhaseDescription(phase).length).toBeGreaterThan(0);
      }
    });
  });
});

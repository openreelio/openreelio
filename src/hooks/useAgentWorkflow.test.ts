/**
 * useAgentWorkflow Hook Tests
 *
 * Tests for the workflow management hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentWorkflow, useAgentWorkflowStore } from './useAgentWorkflow';

describe('useAgentWorkflow', () => {
  beforeEach(() => {
    // Reset store state before each test
    useAgentWorkflowStore.getState().reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should have idle phase initially', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      expect(result.current.phase).toBe('idle');
    });

    it('should have no active workflow initially', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      expect(result.current.isActive).toBe(false);
    });

    it('should have empty steps initially', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      expect(result.current.steps).toEqual([]);
    });

    it('should have no error initially', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      expect(result.current.error).toBeNull();
    });
  });

  describe('startWorkflow', () => {
    it('should start a new workflow', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test intent');
      });

      expect(result.current.phase).toBe('analyzing');
      expect(result.current.isActive).toBe(true);
      expect(result.current.intent).toBe('Test intent');
    });

    it('should generate workflow ID', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
      });

      expect(result.current.workflowId).toBeTruthy();
      expect(typeof result.current.workflowId).toBe('string');
    });

    it('should not start if already active', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('First');
      });

      const firstId = result.current.workflowId;

      act(() => {
        result.current.startWorkflow('Second');
      });

      // Should keep first workflow
      expect(result.current.workflowId).toBe(firstId);
      expect(result.current.intent).toBe('First');
    });
  });

  describe('transitionTo', () => {
    it('should transition to valid phase', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
      });

      act(() => {
        result.current.transitionTo('planning');
      });

      expect(result.current.phase).toBe('planning');
    });

    it('should reject invalid transition', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
      });

      // analyzing -> complete is not valid
      act(() => {
        result.current.transitionTo('complete');
      });

      expect(result.current.phase).toBe('analyzing');
    });

    it('should record transition in history', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
      });

      act(() => {
        result.current.transitionTo('planning');
      });

      expect(result.current.phaseHistory).toContain('idle');
      expect(result.current.phaseHistory).toContain('analyzing');
    });
  });

  describe('addStep', () => {
    it('should add step to workflow', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
      });

      act(() => {
        result.current.addStep({
          id: 'step_1',
          name: 'Analyze',
          status: 'pending',
        });
      });

      expect(result.current.steps).toHaveLength(1);
      expect(result.current.steps[0].name).toBe('Analyze');
    });

    it('should update existing step', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
        result.current.addStep({
          id: 'step_1',
          name: 'Analyze',
          status: 'pending',
        });
      });

      act(() => {
        result.current.updateStep('step_1', { status: 'completed' });
      });

      expect(result.current.steps[0].status).toBe('completed');
    });
  });

  describe('completeWorkflow', () => {
    it('should complete workflow successfully', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
        result.current.transitionTo('planning');
        result.current.transitionTo('executing');
        result.current.transitionTo('verifying');
      });

      act(() => {
        result.current.completeWorkflow();
      });

      expect(result.current.phase).toBe('complete');
      expect(result.current.isActive).toBe(false);
    });
  });

  describe('failWorkflow', () => {
    it('should mark workflow as failed with error', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
      });

      act(() => {
        result.current.failWorkflow('Something went wrong');
      });

      expect(result.current.phase).toBe('failed');
      expect(result.current.error).toBe('Something went wrong');
      expect(result.current.isActive).toBe(false);
    });
  });

  describe('cancelWorkflow', () => {
    it('should cancel active workflow', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
      });

      act(() => {
        result.current.cancelWorkflow();
      });

      expect(result.current.phase).toBe('cancelled');
      expect(result.current.isActive).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset to initial state', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
        result.current.addStep({
          id: 'step_1',
          name: 'Step',
          status: 'pending',
        });
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.phase).toBe('idle');
      expect(result.current.steps).toEqual([]);
      expect(result.current.workflowId).toBeNull();
    });
  });

  describe('progress calculation', () => {
    it('should calculate progress based on steps', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
        result.current.addStep({ id: '1', name: 'S1', status: 'completed' });
        result.current.addStep({ id: '2', name: 'S2', status: 'completed' });
        result.current.addStep({ id: '3', name: 'S3', status: 'pending' });
        result.current.addStep({ id: '4', name: 'S4', status: 'pending' });
      });

      expect(result.current.progress).toBe(50); // 2 of 4 completed
    });

    it('should return 0 when no steps', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      expect(result.current.progress).toBe(0);
    });

    it('should return 100 when all completed', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
        result.current.addStep({ id: '1', name: 'S1', status: 'completed' });
        result.current.addStep({ id: '2', name: 'S2', status: 'completed' });
      });

      expect(result.current.progress).toBe(100);
    });
  });

  describe('current step', () => {
    it('should return first in_progress step', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
        result.current.addStep({ id: '1', name: 'S1', status: 'completed' });
        result.current.addStep({ id: '2', name: 'S2', status: 'in_progress' });
        result.current.addStep({ id: '3', name: 'S3', status: 'pending' });
      });

      expect(result.current.currentStep?.id).toBe('2');
    });

    it('should return first pending if none in_progress', () => {
      const { result } = renderHook(() => useAgentWorkflow());

      act(() => {
        result.current.startWorkflow('Test');
        result.current.addStep({ id: '1', name: 'S1', status: 'completed' });
        result.current.addStep({ id: '2', name: 'S2', status: 'pending' });
      });

      expect(result.current.currentStep?.id).toBe('2');
    });
  });
});

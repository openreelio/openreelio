/**
 * Workflow Engine Tests
 *
 * Tests for workflow lifecycle management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkflowEngine,
  createWorkflowEngine,
  type StepExecutor,
  type WorkflowEvent,
} from './WorkflowEngine';

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(async () => {
    engine = createWorkflowEngine({
      autoRequestApproval: false, // Disable for most tests
      checkpointBeforeSteps: false, // Speed up tests
    });
    await engine.clearAll();
  });

  describe('createWorkflow', () => {
    it('should create workflow with steps', () => {
      const workflow = engine.createWorkflow('Test intent', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
      ]);

      expect(workflow.id).toBeDefined();
      expect(workflow.intent).toBe('Test intent');
      expect(workflow.steps).toHaveLength(2);
      expect(workflow.phase).toBe('idle');
    });

    it('should store workflow for retrieval', () => {
      const workflow = engine.createWorkflow('Test', []);
      const retrieved = engine.getWorkflow(workflow.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(workflow.id);
    });
  });

  describe('getActiveWorkflows', () => {
    it('should return non-terminal workflows', async () => {
      const workflow1 = engine.createWorkflow('Active', [
        { toolName: 'tool', args: {}, description: 'Step', requiresApproval: false },
      ]);

      const workflow2 = engine.createWorkflow('To Complete', [
        { toolName: 'tool', args: {}, description: 'Step', requiresApproval: false },
      ]);

      const executor: StepExecutor = async () => ({ success: true });
      await engine.execute(workflow2.id, executor);

      const active = engine.getActiveWorkflows();

      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(workflow1.id);
    });
  });

  describe('transition', () => {
    it('should transition between valid phases', () => {
      const workflow = engine.createWorkflow('Test', []);

      expect(engine.transition(workflow.id, 'analyzing')).toBe(true);
      expect(engine.getWorkflow(workflow.id)?.phase).toBe('analyzing');

      expect(engine.transition(workflow.id, 'planning')).toBe(true);
      expect(engine.getWorkflow(workflow.id)?.phase).toBe('planning');
    });

    it('should reject invalid transitions', () => {
      const workflow = engine.createWorkflow('Test', []);

      // idle -> executing is invalid
      expect(engine.transition(workflow.id, 'executing')).toBe(false);
      expect(engine.getWorkflow(workflow.id)?.phase).toBe('idle');
    });

    it('should return false for unknown workflow', () => {
      expect(engine.transition('unknown', 'analyzing')).toBe(false);
    });

    it('should set completedAt for terminal phases', () => {
      const workflow = engine.createWorkflow('Test', []);
      engine.transition(workflow.id, 'analyzing');
      engine.transition(workflow.id, 'planning');
      engine.transition(workflow.id, 'executing');
      engine.transition(workflow.id, 'verifying');
      engine.transition(workflow.id, 'complete');

      expect(engine.getWorkflow(workflow.id)?.completedAt).toBeDefined();
    });
  });

  describe('execute', () => {
    it('should execute all steps successfully', async () => {
      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
      ]);

      const executor: StepExecutor = async (step) => ({
        success: true,
        result: { tool: step.toolName },
      });

      const result = await engine.execute(workflow.id, executor);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(2);
      expect(engine.getWorkflow(workflow.id)?.phase).toBe('complete');
    });

    it('should stop on step failure', async () => {
      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
        { toolName: 'tool3', args: {}, description: 'Step 3', requiresApproval: false },
      ]);

      const executor: StepExecutor = async (step) => {
        if (step.toolName === 'tool2') {
          return { success: false, error: 'Tool 2 failed' };
        }
        return { success: true };
      };

      const result = await engine.execute(workflow.id, executor);

      expect(result.success).toBe(false);
      expect(result.completedSteps).toBe(1);
      expect(result.error).toBe('Tool 2 failed');
      expect(engine.getWorkflow(workflow.id)?.phase).toBe('failed');
    });

    it('should handle executor throwing error', async () => {
      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const executor: StepExecutor = async () => {
        throw new Error('Unexpected error');
      };

      const result = await engine.execute(workflow.id, executor);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error');
    });

    it('should return error for unknown workflow', async () => {
      const executor: StepExecutor = async () => ({ success: true });
      const result = await engine.execute('unknown', executor);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Workflow not found');
    });

    it('should update step timestamps', async () => {
      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const executor: StepExecutor = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { success: true };
      };

      await engine.execute(workflow.id, executor);

      const step = engine.getWorkflow(workflow.id)?.steps[0];
      expect(step?.startedAt).toBeDefined();
      expect(step?.completedAt).toBeDefined();
      expect(step!.completedAt! - step!.startedAt!).toBeGreaterThanOrEqual(10);
    });

    it('should store step results', async () => {
      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const executor: StepExecutor = async () => ({
        success: true,
        result: { data: 'test result' },
      });

      await engine.execute(workflow.id, executor);

      const step = engine.getWorkflow(workflow.id)?.steps[0];
      expect(step?.result).toEqual({ data: 'test result' });
    });
  });

  describe('execute with approval', () => {
    it('should wait for approval when high-risk steps present', async () => {
      const engineWithApproval = createWorkflowEngine({
        autoRequestApproval: true,
        checkpointBeforeSteps: false,
        approvalConfig: { requestTimeout: 1000 },
      });

      const workflow = engineWithApproval.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: true },
      ]);

      const executor: StepExecutor = async () => ({ success: true });

      // Start execution in background
      const executePromise = engineWithApproval.execute(workflow.id, executor);

      // Wait for approval request
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Submit approval
      engineWithApproval.submitApproval(workflow.id, true);

      const result = await executePromise;

      expect(result.success).toBe(true);
    });

    it('should reject workflow when approval denied', async () => {
      const engineWithApproval = createWorkflowEngine({
        autoRequestApproval: true,
        checkpointBeforeSteps: false,
        approvalConfig: { requestTimeout: 1000 },
      });

      const workflow = engineWithApproval.createWorkflow('Test', [
        { toolName: 'risky', args: {}, description: 'Risky op', requiresApproval: true },
      ]);

      const executor: StepExecutor = async () => ({ success: true });

      // Start execution
      const executePromise = engineWithApproval.execute(workflow.id, executor);

      // Wait a bit and reject
      await new Promise((resolve) => setTimeout(resolve, 50));
      engineWithApproval.submitApproval(workflow.id, false, 'Too risky');

      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('rejected');
      expect(result.error).toContain('Too risky');
    });
  });

  describe('cancel', () => {
    it('should cancel executing workflow', () => {
      const workflow = engine.createWorkflow('Test', []);
      engine.transition(workflow.id, 'analyzing');
      engine.transition(workflow.id, 'planning');
      engine.transition(workflow.id, 'executing');

      const cancelled = engine.cancel(workflow.id);

      expect(cancelled).toBe(true);
      expect(engine.getWorkflow(workflow.id)?.phase).toBe('cancelled');
    });

    it('should not cancel completed workflow', () => {
      const workflow = engine.createWorkflow('Test', []);
      engine.transition(workflow.id, 'analyzing');
      engine.transition(workflow.id, 'planning');
      engine.transition(workflow.id, 'executing');
      engine.transition(workflow.id, 'verifying');
      engine.transition(workflow.id, 'complete');

      const cancelled = engine.cancel(workflow.id);

      expect(cancelled).toBe(false);
      expect(engine.getWorkflow(workflow.id)?.phase).toBe('complete');
    });

    it('should return false for unknown workflow', () => {
      expect(engine.cancel('unknown')).toBe(false);
    });
  });

  describe('rollback', () => {
    it('should restore from checkpoint', async () => {
      const engineWithCheckpoints = createWorkflowEngine({
        checkpointBeforeSteps: true,
        autoRequestApproval: false,
      });

      const workflow = engineWithCheckpoints.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
        { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
      ]);

      let stepCount = 0;
      const executor: StepExecutor = async () => {
        stepCount++;
        if (stepCount === 2) {
          return { success: false, error: 'Step 2 failed' };
        }
        return { success: true };
      };

      await engineWithCheckpoints.execute(workflow.id, executor);

      const restored = await engineWithCheckpoints.rollback(workflow.id);

      expect(restored).not.toBeNull();
      expect(restored?.phase).toBe('rolled_back');
    });

    it('should return null for unknown workflow', async () => {
      const restored = await engine.rollback('unknown');
      expect(restored).toBeNull();
    });
  });

  describe('events', () => {
    it('should emit phaseChange events', async () => {
      const events: WorkflowEvent[] = [];
      engine.onEvent((event) => events.push(event));

      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const executor: StepExecutor = async () => ({ success: true });
      await engine.execute(workflow.id, executor);

      const phaseChanges = events.filter((e) => e.type === 'phaseChange');
      expect(phaseChanges.length).toBeGreaterThan(0);
      expect(phaseChanges.some((e) => e.data?.phase === 'executing')).toBe(true);
      expect(phaseChanges.some((e) => e.data?.phase === 'complete')).toBe(true);
    });

    it('should emit stepStart and stepComplete events', async () => {
      const events: WorkflowEvent[] = [];
      engine.onEvent((event) => events.push(event));

      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const executor: StepExecutor = async () => ({ success: true });
      await engine.execute(workflow.id, executor);

      expect(events.some((e) => e.type === 'stepStart')).toBe(true);
      expect(events.some((e) => e.type === 'stepComplete')).toBe(true);
    });

    it('should emit stepFailed event', async () => {
      const events: WorkflowEvent[] = [];
      engine.onEvent((event) => events.push(event));

      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const executor: StepExecutor = async () => ({
        success: false,
        error: 'Test error',
      });

      await engine.execute(workflow.id, executor);

      const failedEvents = events.filter((e) => e.type === 'stepFailed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].data?.error).toBe('Test error');
    });

    it('should emit workflowComplete event', async () => {
      const events: WorkflowEvent[] = [];
      engine.onEvent((event) => events.push(event));

      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const executor: StepExecutor = async () => ({ success: true });
      await engine.execute(workflow.id, executor);

      expect(events.some((e) => e.type === 'workflowComplete')).toBe(true);
    });

    it('should emit workflowFailed event', async () => {
      const events: WorkflowEvent[] = [];
      engine.onEvent((event) => events.push(event));

      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const executor: StepExecutor = async () => ({
        success: false,
        error: 'Failure',
      });

      await engine.execute(workflow.id, executor);

      expect(events.some((e) => e.type === 'workflowFailed')).toBe(true);
    });

    it('should emit workflowCancelled event', () => {
      const events: WorkflowEvent[] = [];
      engine.onEvent((event) => events.push(event));

      const workflow = engine.createWorkflow('Test', []);
      engine.transition(workflow.id, 'analyzing');
      engine.cancel(workflow.id);

      expect(events.some((e) => e.type === 'workflowCancelled')).toBe(true);
    });

    it('should allow unsubscribing', async () => {
      const events: WorkflowEvent[] = [];
      const unsubscribe = engine.onEvent((event) => events.push(event));

      unsubscribe();

      const workflow = engine.createWorkflow('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const executor: StepExecutor = async () => ({ success: true });
      await engine.execute(workflow.id, executor);

      expect(events).toHaveLength(0);
    });
  });

  describe('removeWorkflow', () => {
    it('should remove workflow', async () => {
      const workflow = engine.createWorkflow('Test', []);

      await engine.removeWorkflow(workflow.id);

      expect(engine.getWorkflow(workflow.id)).toBeUndefined();
    });
  });
});

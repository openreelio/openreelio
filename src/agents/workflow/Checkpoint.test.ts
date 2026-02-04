/**
 * Checkpoint Tests
 *
 * Tests for checkpoint management and state recovery.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CheckpointManager,
  createCheckpointManager,
  InMemoryCheckpointStorage,
  getCheckpointDiff,
  type Checkpoint,
} from './Checkpoint';
import { createWorkflowState } from './WorkflowState';

describe('InMemoryCheckpointStorage', () => {
  let storage: InMemoryCheckpointStorage;

  beforeEach(() => {
    storage = new InMemoryCheckpointStorage();
  });

  it('should save and load checkpoint', async () => {
    const workflow = createWorkflowState('Test');
    const checkpoint: Checkpoint = {
      id: 'cp_001',
      workflowId: workflow.id,
      state: workflow,
      createdAt: Date.now(),
      description: 'Test checkpoint',
    };

    await storage.save(checkpoint);
    const loaded = await storage.load('cp_001');

    expect(loaded).toEqual(checkpoint);
  });

  it('should return null for unknown checkpoint', async () => {
    const loaded = await storage.load('unknown');
    expect(loaded).toBeNull();
  });

  it('should load checkpoints for workflow', async () => {
    const workflow = createWorkflowState('Test');

    await storage.save({
      id: 'cp_001',
      workflowId: workflow.id,
      state: workflow,
      createdAt: 1000,
      description: 'First',
    });

    await storage.save({
      id: 'cp_002',
      workflowId: workflow.id,
      state: workflow,
      createdAt: 2000,
      description: 'Second',
    });

    await storage.save({
      id: 'cp_003',
      workflowId: 'other_workflow',
      state: workflow,
      createdAt: 3000,
      description: 'Other',
    });

    const checkpoints = await storage.loadForWorkflow(workflow.id);

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0].id).toBe('cp_002'); // Newest first
    expect(checkpoints[1].id).toBe('cp_001');
  });

  it('should delete checkpoint', async () => {
    const workflow = createWorkflowState('Test');
    const checkpoint: Checkpoint = {
      id: 'cp_001',
      workflowId: workflow.id,
      state: workflow,
      createdAt: Date.now(),
      description: 'Test',
    };

    await storage.save(checkpoint);
    await storage.delete('cp_001');

    const loaded = await storage.load('cp_001');
    expect(loaded).toBeNull();
  });

  it('should delete all checkpoints for workflow', async () => {
    const workflow = createWorkflowState('Test');

    await storage.save({
      id: 'cp_001',
      workflowId: workflow.id,
      state: workflow,
      createdAt: 1000,
      description: 'First',
    });

    await storage.save({
      id: 'cp_002',
      workflowId: workflow.id,
      state: workflow,
      createdAt: 2000,
      description: 'Second',
    });

    await storage.deleteForWorkflow(workflow.id);

    const checkpoints = await storage.loadForWorkflow(workflow.id);
    expect(checkpoints).toHaveLength(0);
  });
});

describe('CheckpointManager', () => {
  let manager: CheckpointManager;

  beforeEach(() => {
    manager = createCheckpointManager();
  });

  describe('createCheckpoint', () => {
    it('should create checkpoint with state snapshot', async () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const checkpoint = await manager.createCheckpoint(workflow, 'Test checkpoint');

      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.workflowId).toBe(workflow.id);
      expect(checkpoint.description).toBe('Test checkpoint');
      expect(checkpoint.state.intent).toBe('Test');
    });

    it('should deep clone state', async () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool1', args: { value: 1 }, description: 'Step 1', requiresApproval: false },
      ]);

      const checkpoint = await manager.createCheckpoint(workflow, 'Test');

      // Modify original
      workflow.steps[0].args.value = 999;
      workflow.phase = 'executing';

      // Checkpoint should be unchanged
      expect(checkpoint.state.steps[0].args.value).toBe(1);
      expect(checkpoint.state.phase).toBe('idle');
    });

    it('should include metadata', async () => {
      const workflow = createWorkflowState('Test');

      const checkpoint = await manager.createCheckpoint(
        workflow,
        'With metadata',
        { stepId: 'step_001', custom: 'data' }
      );

      expect(checkpoint.metadata?.stepId).toBe('step_001');
      expect(checkpoint.metadata?.custom).toBe('data');
    });
  });

  describe('checkpointBeforeStep', () => {
    it('should create checkpoint for step', async () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Important step', requiresApproval: false },
      ]);
      workflow.currentStepIndex = 0;

      const checkpoint = await manager.checkpointBeforeStep(
        workflow,
        workflow.steps[0]
      );

      expect(checkpoint.description).toContain('Important step');
      expect(checkpoint.metadata?.stepId).toBe(workflow.steps[0].id);
    });
  });

  describe('getCheckpoint', () => {
    it('should retrieve checkpoint by ID', async () => {
      const workflow = createWorkflowState('Test');
      const created = await manager.createCheckpoint(workflow, 'Test');

      const retrieved = await manager.getCheckpoint(created.id);

      expect(retrieved).toEqual(created);
    });

    it('should return null for unknown ID', async () => {
      const retrieved = await manager.getCheckpoint('unknown');
      expect(retrieved).toBeNull();
    });
  });

  describe('getLatestCheckpoint', () => {
    it('should return most recent checkpoint', async () => {
      const workflow = createWorkflowState('Test');

      await manager.createCheckpoint(workflow, 'First');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const latest = await manager.createCheckpoint(workflow, 'Second');

      const retrieved = await manager.getLatestCheckpoint(workflow.id);

      expect(retrieved?.id).toBe(latest.id);
    });

    it('should return null when no checkpoints', async () => {
      const retrieved = await manager.getLatestCheckpoint('unknown_workflow');
      expect(retrieved).toBeNull();
    });
  });

  describe('getCheckpointsForWorkflow', () => {
    it('should return all checkpoints newest first', async () => {
      const workflow = createWorkflowState('Test');

      await manager.createCheckpoint(workflow, 'First');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await manager.createCheckpoint(workflow, 'Second');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await manager.createCheckpoint(workflow, 'Third');

      const checkpoints = await manager.getCheckpointsForWorkflow(workflow.id);

      expect(checkpoints).toHaveLength(3);
      expect(checkpoints[0].description).toBe('Third');
      expect(checkpoints[1].description).toBe('Second');
      expect(checkpoints[2].description).toBe('First');
    });
  });

  describe('restoreFromCheckpoint', () => {
    it('should restore state from checkpoint', async () => {
      const workflow = createWorkflowState('Test', [
        { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      ]);

      const checkpoint = await manager.createCheckpoint(workflow, 'Before changes');

      // Modify workflow
      workflow.phase = 'executing';
      workflow.steps[0].status = 'completed';

      // Restore
      const restored = manager.restoreFromCheckpoint(checkpoint);

      expect(restored.phase).toBe('idle');
      expect(restored.steps[0].status).toBe('pending');
    });

    it('should return independent copy', async () => {
      const workflow = createWorkflowState('Test');
      const checkpoint = await manager.createCheckpoint(workflow, 'Test');

      const restored = manager.restoreFromCheckpoint(checkpoint);
      restored.phase = 'complete';

      // Checkpoint should be unchanged
      expect(checkpoint.state.phase).toBe('idle');
    });
  });

  describe('restoreToLatest', () => {
    it('should restore to latest checkpoint', async () => {
      vi.useFakeTimers();

      const workflow = createWorkflowState('Test');

      await manager.createCheckpoint(workflow, 'First');

      // Advance time so the second checkpoint has a later timestamp
      vi.advanceTimersByTime(100);
      workflow.phase = 'executing';
      await manager.createCheckpoint(workflow, 'Second');

      const restored = await manager.restoreToLatest(workflow.id);

      vi.useRealTimers();

      expect(restored?.phase).toBe('executing');
    });

    it('should return null when no checkpoints', async () => {
      const restored = await manager.restoreToLatest('unknown');
      expect(restored).toBeNull();
    });
  });

  describe('deleteCheckpoint', () => {
    it('should delete checkpoint', async () => {
      const workflow = createWorkflowState('Test');
      const checkpoint = await manager.createCheckpoint(workflow, 'Test');

      await manager.deleteCheckpoint(checkpoint.id);

      const retrieved = await manager.getCheckpoint(checkpoint.id);
      expect(retrieved).toBeNull();
    });
  });

  describe('deleteWorkflowCheckpoints', () => {
    it('should delete all workflow checkpoints', async () => {
      const workflow = createWorkflowState('Test');

      await manager.createCheckpoint(workflow, 'First');
      await manager.createCheckpoint(workflow, 'Second');

      await manager.deleteWorkflowCheckpoints(workflow.id);

      const checkpoints = await manager.getCheckpointsForWorkflow(workflow.id);
      expect(checkpoints).toHaveLength(0);
    });
  });

  describe('retention policy', () => {
    it('should enforce max checkpoints per workflow', async () => {
      const managerWithLimit = createCheckpointManager({
        maxCheckpointsPerWorkflow: 3,
      });

      const workflow = createWorkflowState('Test');

      for (let i = 0; i < 5; i++) {
        await managerWithLimit.createCheckpoint(workflow, `Checkpoint ${i}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const checkpoints = await managerWithLimit.getCheckpointsForWorkflow(workflow.id);

      expect(checkpoints).toHaveLength(3);
      // Should keep newest
      expect(checkpoints[0].description).toBe('Checkpoint 4');
      expect(checkpoints[1].description).toBe('Checkpoint 3');
      expect(checkpoints[2].description).toBe('Checkpoint 2');
    });
  });
});

describe('getCheckpointDiff', () => {
  it('should detect phase change', () => {
    const workflow = createWorkflowState('Test');
    const older: Checkpoint = {
      id: 'cp_1',
      workflowId: workflow.id,
      state: { ...workflow, phase: 'analyzing' },
      createdAt: 1000,
      description: 'Older',
    };

    const newer: Checkpoint = {
      id: 'cp_2',
      workflowId: workflow.id,
      state: { ...workflow, phase: 'executing' },
      createdAt: 2000,
      description: 'Newer',
    };

    const diff = getCheckpointDiff(older, newer);

    expect(diff.phaseChanged).toBe(true);
    expect(diff.newPhase).toBe('executing');
  });

  it('should detect step changes', () => {
    const workflow = createWorkflowState('Test', [
      { toolName: 'tool1', args: {}, description: 'Step 1', requiresApproval: false },
      { toolName: 'tool2', args: {}, description: 'Step 2', requiresApproval: false },
    ]);

    const older: Checkpoint = {
      id: 'cp_1',
      workflowId: workflow.id,
      state: workflow,
      createdAt: 1000,
      description: 'Older',
    };

    const newerState = { ...workflow, steps: [...workflow.steps] };
    newerState.steps[0] = { ...newerState.steps[0], status: 'completed' as const };

    const newer: Checkpoint = {
      id: 'cp_2',
      workflowId: workflow.id,
      state: newerState,
      createdAt: 2000,
      description: 'Newer',
    };

    const diff = getCheckpointDiff(older, newer);

    expect(diff.stepsChanged).toBe(1);
    expect(diff.completedSteps).toContain(workflow.steps[0].id);
  });

  it('should report no changes when identical', () => {
    const workflow = createWorkflowState('Test');
    const checkpoint: Checkpoint = {
      id: 'cp_1',
      workflowId: workflow.id,
      state: workflow,
      createdAt: 1000,
      description: 'Same',
    };

    const diff = getCheckpointDiff(checkpoint, checkpoint);

    expect(diff.phaseChanged).toBe(false);
    expect(diff.stepsChanged).toBe(0);
    expect(diff.newPhase).toBeUndefined();
  });
});

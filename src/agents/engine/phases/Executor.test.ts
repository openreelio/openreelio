/**
 * Executor Phase Tests
 *
 * Tests for the Execute phase of the agentic loop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  Executor,
  createExecutor,
  getPartialExecutionResult,
  type ExecutionProgress,
} from './Executor';
import {
  createMockToolExecutorWithVideoTools,
  type MockToolExecutor,
} from '../adapters/tools/MockToolExecutor';
import type { Plan } from '../core/types';
import type { ExecutionContext } from '../ports/IToolExecutor';
import {
  ToolExecutionError,
  ExecutionTimeoutError,
  DependencyError,
  ToolBudgetExceededError,
} from '../core/errors';

describe('Executor', () => {
  let executor: Executor;
  let mockToolExecutor: MockToolExecutor;
  let executionContext: ExecutionContext;

  const simplePlan: Plan = {
    goal: 'Split a clip',
    steps: [
      {
        id: 'step-1',
        tool: 'split_clip',
        args: { clipId: 'clip-1', position: 5 },
        description: 'Split clip at 5 seconds',
        riskLevel: 'low',
        estimatedDuration: 100,
      },
    ],
    estimatedTotalDuration: 100,
    requiresApproval: false,
    rollbackStrategy: 'Undo split',
  };

  beforeEach(() => {
    mockToolExecutor = createMockToolExecutorWithVideoTools();
    executor = createExecutor(mockToolExecutor);
    executionContext = {
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      sessionId: 'session-1',
    };
  });

  describe('execute', () => {
    it('should execute a simple single-step plan', async () => {
      const result = await executor.execute(simplePlan, executionContext);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toHaveLength(1);
      expect(result.failedSteps).toHaveLength(0);
    });

    it('should return tool results for each step', async () => {
      const result = await executor.execute(simplePlan, executionContext);

      expect(result.completedSteps[0].stepId).toBe('step-1');
      expect(result.completedSteps[0].result.success).toBe(true);
      expect(result.toolCallsUsed).toBe(1);
    });

    it('should execute multi-step plan in order', async () => {
      const multiStepPlan: Plan = {
        goal: 'Split and move clip',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Split clip',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
          {
            id: 'step-2',
            tool: 'move_clip',
            args: { clipId: 'clip-1', position: 10 },
            description: 'Move clip',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-1'],
          },
        ],
        estimatedTotalDuration: 200,
        requiresApproval: false,
        rollbackStrategy: 'Undo all',
      };

      const result = await executor.execute(multiStepPlan, executionContext);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toHaveLength(2);

      // Verify execution order
      const executions = mockToolExecutor.getCapturedExecutions();
      expect(executions[0].toolName).toBe('split_clip');
      expect(executions[1].toolName).toBe('move_clip');
    });

    it('should execute independent steps in parallel', async () => {
      const parallelPlan: Plan = {
        goal: 'Analyze timeline',
        steps: [
          {
            id: 'step-1',
            tool: 'get_timeline_info',
            args: { sequenceId: 'seq-1' },
            description: 'Get timeline info',
            riskLevel: 'low',
            estimatedDuration: 50,
          },
          {
            id: 'step-2',
            tool: 'get_timeline_info',
            args: { sequenceId: 'seq-2' },
            description: 'Get another timeline info',
            riskLevel: 'low',
            estimatedDuration: 50,
          },
        ],
        estimatedTotalDuration: 50, // Parallel, so not 100
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const parallelExecutor = createExecutor(mockToolExecutor, {
        parallelExecution: true,
      });

      const result = await parallelExecutor.execute(parallelPlan, executionContext);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toHaveLength(2);
    });

    it('should respect step dependencies', async () => {
      const dependentPlan: Plan = {
        goal: 'Sequential operations',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'First split',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
          {
            id: 'step-2',
            tool: 'split_clip',
            args: { clipId: 'clip-2', position: 10 },
            description: 'Second split',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-1'],
          },
          {
            id: 'step-3',
            tool: 'move_clip',
            args: { clipId: 'clip-1', position: 20 },
            description: 'Move after splits',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-1', 'step-2'],
          },
        ],
        estimatedTotalDuration: 300,
        requiresApproval: false,
        rollbackStrategy: 'Undo all',
      };

      const result = await executor.execute(dependentPlan, executionContext);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toHaveLength(3);

      // Step 3 should be last
      const executions = mockToolExecutor.getCapturedExecutions();
      expect(executions[2].toolName).toBe('move_clip');
    });

    it('should fail if a dependency was not executed', async () => {
      // Create a plan with missing dependency
      const badPlan: Plan = {
        goal: 'Bad dependencies',
        steps: [
          {
            id: 'step-2',
            tool: 'move_clip',
            args: { clipId: 'clip-1', position: 10 },
            description: 'Move clip',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-1'], // step-1 doesn't exist
          },
        ],
        estimatedTotalDuration: 100,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      await expect(executor.execute(badPlan, executionContext)).rejects.toThrow(DependencyError);
    });
  });

  describe('error handling', () => {
    it('should stop on first error when stopOnError is true', async () => {
      mockToolExecutor.setToolResult('split_clip', {
        success: false,
        error: 'Split failed',
        duration: 10,
      });

      const multiStepPlan: Plan = {
        goal: 'Multiple steps',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'This will fail',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
          {
            id: 'step-2',
            tool: 'move_clip',
            args: { clipId: 'clip-1', position: 10 },
            description: 'This should not run',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 200,
        requiresApproval: false,
        rollbackStrategy: 'Undo',
      };

      const strictExecutor = createExecutor(mockToolExecutor, {
        stopOnError: true,
      });

      const result = await strictExecutor.execute(multiStepPlan, executionContext);

      expect(result.success).toBe(false);
      expect(result.completedSteps).toHaveLength(0);
      expect(result.failedSteps).toHaveLength(1);
      expect(mockToolExecutor.getExecutionCount()).toBe(1);
    });

    it('should continue on error when stopOnError is false', async () => {
      mockToolExecutor.setToolResult('split_clip', {
        success: false,
        error: 'Split failed',
        duration: 10,
      });

      const multiStepPlan: Plan = {
        goal: 'Multiple steps',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'This will fail',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
          {
            id: 'step-2',
            tool: 'move_clip',
            args: { clipId: 'clip-1', position: 10 },
            description: 'This should still run',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 200,
        requiresApproval: false,
        rollbackStrategy: 'Undo',
      };

      const lenientExecutor = createExecutor(mockToolExecutor, {
        stopOnError: false,
      });

      const result = await lenientExecutor.execute(multiStepPlan, executionContext);

      expect(result.success).toBe(false);
      expect(result.failedSteps).toHaveLength(1);
      expect(result.completedSteps).toHaveLength(1);
      expect(mockToolExecutor.getExecutionCount()).toBe(2);
    });

    it('should handle tool throwing exception', async () => {
      mockToolExecutor.setToolError('split_clip', new Error('Tool crashed'));

      await expect(executor.execute(simplePlan, executionContext)).rejects.toThrow(
        ToolExecutionError,
      );
    });

    it('should include step context in error', async () => {
      mockToolExecutor.setToolError('split_clip', new Error('Tool crashed'));

      try {
        await executor.execute(simplePlan, executionContext);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ToolExecutionError);
        const execError = error as ToolExecutionError;
        expect(execError.stepId).toBe('step-1');
      }
    });

    it('should attach partial execution result when an error interrupts mid-plan', async () => {
      mockToolExecutor.setToolError('move_clip', new Error('Move crashed'));

      const midPlanFailure: Plan = {
        goal: 'Split then move',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Split first',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
          {
            id: 'step-2',
            tool: 'move_clip',
            args: { clipId: 'clip-1', position: 10 },
            description: 'Move second',
            riskLevel: 'low',
            estimatedDuration: 100,
            dependsOn: ['step-1'],
          },
        ],
        estimatedTotalDuration: 200,
        requiresApproval: false,
        rollbackStrategy: 'Undo all',
      };

      try {
        await executor.execute(midPlanFailure, executionContext);
        expect.fail('Execution should throw');
      } catch (error) {
        const partial = getPartialExecutionResult(error);
        expect(partial).not.toBeNull();
        expect(partial?.completedSteps).toHaveLength(1);
        expect(partial?.failedSteps).toHaveLength(1);
        expect(partial?.failedSteps[0]?.stepId).toBe('step-2');
      }
    });
  });

  describe('progress tracking', () => {
    it('should emit progress events', async () => {
      const progressEvents: ExecutionProgress[] = [];

      await executor.execute(simplePlan, executionContext, (progress) => {
        progressEvents.push(progress);
      });

      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents.some((p) => p.phase === 'started')).toBe(true);
      expect(progressEvents.some((p) => p.phase === 'completed')).toBe(true);
    });

    it('should track step progress', async () => {
      const multiStepPlan: Plan = {
        goal: 'Multi step',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Step 1',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
          {
            id: 'step-2',
            tool: 'move_clip',
            args: { clipId: 'clip-1', position: 10 },
            description: 'Step 2',
            riskLevel: 'low',
            estimatedDuration: 100,
          },
        ],
        estimatedTotalDuration: 200,
        requiresApproval: false,
        rollbackStrategy: 'Undo',
      };

      const progressEvents: ExecutionProgress[] = [];

      await executor.execute(multiStepPlan, executionContext, (progress) => {
        progressEvents.push(progress);
      });

      const stepStartEvents = progressEvents.filter((p) => p.phase === 'step_started');
      expect(stepStartEvents).toHaveLength(2);
    });
  });

  describe('timeout', () => {
    it('should timeout if step takes too long', async () => {
      mockToolExecutor.registerTool({
        info: {
          name: 'slow_tool',
          description: 'A slow tool',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {},
        delay: 500,
        result: { success: true, duration: 500 },
      });

      const slowPlan: Plan = {
        goal: 'Slow operation',
        steps: [
          {
            id: 'step-1',
            tool: 'slow_tool',
            args: {},
            description: 'Slow step',
            riskLevel: 'low',
            estimatedDuration: 500,
          },
        ],
        estimatedTotalDuration: 500,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const timeoutExecutor = createExecutor(mockToolExecutor, {
        stepTimeout: 100,
      });

      await expect(timeoutExecutor.execute(slowPlan, executionContext)).rejects.toThrow(
        ExecutionTimeoutError,
      );
    });
  });

  describe('abort', () => {
    it('should abort ongoing execution', async () => {
      mockToolExecutor.registerTool({
        info: {
          name: 'slow_tool',
          description: 'A slow tool',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {},
        delay: 1000,
        result: { success: true, duration: 1000 },
      });

      const slowPlan: Plan = {
        goal: 'Slow operation',
        steps: [
          {
            id: 'step-1',
            tool: 'slow_tool',
            args: {},
            description: 'Slow step',
            riskLevel: 'low',
            estimatedDuration: 1000,
          },
        ],
        estimatedTotalDuration: 1000,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const promise = executor.execute(slowPlan, executionContext);

      setTimeout(() => executor.abort(), 50);

      await expect(promise).rejects.toThrow();
    });

    it('should return partial results when aborted', async () => {
      const progressEvents: ExecutionProgress[] = [];

      mockToolExecutor.registerTool({
        info: {
          name: 'slow_tool',
          description: 'A slow tool',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: false,
        },
        parameters: {},
        delay: 1000,
        result: { success: true, duration: 1000 },
      });

      const slowPlan: Plan = {
        goal: 'Multiple slow steps',
        steps: [
          {
            id: 'step-1',
            tool: 'split_clip',
            args: { clipId: 'clip-1', position: 5 },
            description: 'Fast step',
            riskLevel: 'low',
            estimatedDuration: 10,
          },
          {
            id: 'step-2',
            tool: 'slow_tool',
            args: {},
            description: 'Slow step',
            riskLevel: 'low',
            estimatedDuration: 1000,
          },
        ],
        estimatedTotalDuration: 1010,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const promise = executor.execute(slowPlan, executionContext, (p) => {
        progressEvents.push(p);
      });

      // Wait for first step to complete, then abort
      await new Promise((resolve) => setTimeout(resolve, 100));
      executor.abort();

      try {
        await promise;
      } catch {
        // Expected
      }

      // First step should have started
      expect(progressEvents.some((p) => p.stepId === 'step-1')).toBe(true);
    });
  });

  describe('configuration', () => {
    it('should use custom step timeout', async () => {
      const customExecutor = createExecutor(mockToolExecutor, {
        stepTimeout: 5000,
      });

      const result = await customExecutor.execute(simplePlan, executionContext);
      expect(result.success).toBe(true);
    });

    it('should allow retries on failure', async () => {
      let callCount = 0;

      mockToolExecutor.registerTool({
        info: {
          name: 'flaky_tool',
          description: 'Fails first, then succeeds',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {},
        executor: async () => {
          callCount++;
          if (callCount < 2) {
            return { success: false, error: 'Temporary failure', duration: 10 };
          }
          return { success: true, data: { ok: true }, duration: 10 };
        },
      });

      const flakyPlan: Plan = {
        goal: 'Flaky operation',
        steps: [
          {
            id: 'step-1',
            tool: 'flaky_tool',
            args: {},
            description: 'Flaky step',
            riskLevel: 'low',
            estimatedDuration: 10,
          },
        ],
        estimatedTotalDuration: 10,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const retryExecutor = createExecutor(mockToolExecutor, {
        maxRetries: 3,
        stopOnError: true,
      });

      const result = await retryExecutor.execute(flakyPlan, executionContext);

      expect(result.success).toBe(true);
      expect(callCount).toBe(2);
    });

    it('should not retry deterministic terminal failures', async () => {
      let callCount = 0;

      mockToolExecutor.registerTool({
        info: {
          name: 'terminal_tool',
          description: 'Always fails with terminal not-found error',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {},
        executor: async () => {
          callCount += 1;
          return {
            success: false,
            error: 'Clip not found on timeline',
            duration: 10,
          };
        },
      });

      const plan: Plan = {
        goal: 'Terminal failure operation',
        steps: [
          {
            id: 'step-1',
            tool: 'terminal_tool',
            args: {},
            description: 'Fails with non-retryable error',
            riskLevel: 'low',
            estimatedDuration: 10,
          },
        ],
        estimatedTotalDuration: 10,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const retryExecutor = createExecutor(mockToolExecutor, {
        maxRetries: 3,
        stopOnError: true,
      });

      const result = await retryExecutor.execute(plan, executionContext);

      expect(result.success).toBe(false);
      expect(result.failedSteps).toHaveLength(1);
      expect(result.failedSteps[0]?.retryCount).toBe(0);
      expect(callCount).toBe(1);
    });

    it('Given retrying tool execution, When tool-call budget is exhausted, Then executor raises budget error', async () => {
      mockToolExecutor.registerTool({
        info: {
          name: 'flaky_budget_tool',
          description: 'Fails first, then succeeds',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {},
        executor: async () => {
          const attempts = mockToolExecutor.getExecutionsFor('flaky_budget_tool').length;
          if (attempts === 0) {
            return { success: false, error: 'Temporary failure', duration: 10 };
          }
          return { success: true, data: { ok: true }, duration: 10 };
        },
      });

      const plan: Plan = {
        goal: 'Budget constrained operation',
        steps: [
          {
            id: 'step-1',
            tool: 'flaky_budget_tool',
            args: {},
            description: 'Flaky with retries',
            riskLevel: 'low',
            estimatedDuration: 10,
          },
        ],
        estimatedTotalDuration: 10,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const retryExecutor = createExecutor(mockToolExecutor, {
        maxRetries: 3,
      });

      await expect(
        retryExecutor.execute(plan, executionContext, undefined, { maxToolCalls: 1 }),
      ).rejects.toBeInstanceOf(ToolBudgetExceededError);
    });
  });

  describe('execution record', () => {
    it('should create execution record for successful step', async () => {
      const result = await executor.execute(simplePlan, executionContext);

      expect(result.completedSteps[0]).toMatchObject({
        stepId: 'step-1',
        tool: 'split_clip',
        result: expect.objectContaining({ success: true }),
      });
      expect(result.completedSteps[0].startTime).toBeDefined();
      expect(result.completedSteps[0].endTime).toBeDefined();
    });

    it('should include duration in execution record', async () => {
      const result = await executor.execute(simplePlan, executionContext);

      const step = result.completedSteps[0];
      expect(step.endTime - step.startTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty plan', async () => {
      const emptyPlan: Plan = {
        goal: 'Empty plan',
        steps: [],
        estimatedTotalDuration: 0,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const result = await executor.execute(emptyPlan, executionContext);

      expect(result.success).toBe(true);
      expect(result.completedSteps).toHaveLength(0);
    });

    it('should handle plan with only analysis tools', async () => {
      const analysisPlan: Plan = {
        goal: 'Analyze only',
        steps: [
          {
            id: 'step-1',
            tool: 'get_timeline_info',
            args: { sequenceId: 'seq-1' },
            description: 'Get info',
            riskLevel: 'low',
            estimatedDuration: 10,
          },
        ],
        estimatedTotalDuration: 10,
        requiresApproval: false,
        rollbackStrategy: 'N/A',
      };

      const result = await executor.execute(analysisPlan, executionContext);

      expect(result.success).toBe(true);
      expect(result.completedSteps[0].result.data).toBeDefined();
    });
  });
});

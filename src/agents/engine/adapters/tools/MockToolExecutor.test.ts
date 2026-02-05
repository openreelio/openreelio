/**
 * MockToolExecutor Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MockToolExecutor,
  createMockToolExecutor,
  createMockToolExecutorWithVideoTools,
  type MockToolConfig,
} from './MockToolExecutor';
import type { ExecutionContext } from '../../ports/IToolExecutor';

describe('MockToolExecutor', () => {
  let executor: MockToolExecutor;
  const context: ExecutionContext = {
    projectId: 'project-1',
    sequenceId: 'sequence-1',
    sessionId: 'session-1',
  };

  beforeEach(() => {
    executor = createMockToolExecutor();
  });

  describe('tool registration', () => {
    it('should register a tool', () => {
      const config: MockToolConfig = {
        info: {
          name: 'test_tool',
          description: 'Test tool',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: { type: 'object' },
      };

      executor.registerTool(config);

      expect(executor.hasTool('test_tool')).toBe(true);
    });

    it('should register multiple tools', () => {
      const configs: MockToolConfig[] = [
        {
          info: {
            name: 'tool_1',
            description: 'Tool 1',
            category: 'test',
            riskLevel: 'low',
            supportsUndo: false,
            parallelizable: true,
          },
          parameters: {},
        },
        {
          info: {
            name: 'tool_2',
            description: 'Tool 2',
            category: 'test',
            riskLevel: 'medium',
            supportsUndo: true,
            parallelizable: false,
          },
          parameters: {},
        },
      ];

      executor.registerTools(configs);

      expect(executor.hasTool('tool_1')).toBe(true);
      expect(executor.hasTool('tool_2')).toBe(true);
    });

    it('should unregister a tool', () => {
      const config: MockToolConfig = {
        info: {
          name: 'test_tool',
          description: 'Test',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {},
      };

      executor.registerTool(config);
      executor.unregisterTool('test_tool');

      expect(executor.hasTool('test_tool')).toBe(false);
    });
  });

  describe('execute', () => {
    it('should execute registered tool and return result', async () => {
      executor.registerTool({
        info: {
          name: 'split_clip',
          description: 'Split clip',
          category: 'editing',
          riskLevel: 'low',
          supportsUndo: true,
          parallelizable: false,
        },
        parameters: {},
        result: { success: true, data: { newClipId: 'clip-2' }, duration: 50 },
      });

      const result = await executor.execute(
        'split_clip',
        { clipId: 'clip-1', position: 5 },
        context
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ newClipId: 'clip-2' });
    });

    it('should return error for unknown tool', async () => {
      const result = await executor.execute('unknown_tool', {}, context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should throw when tool has error configured', async () => {
      executor.registerTool({
        info: {
          name: 'error_tool',
          description: 'Error tool',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {},
        error: new Error('Tool failed'),
      });

      await expect(
        executor.execute('error_tool', {}, context)
      ).rejects.toThrow('Tool failed');
    });

    it('should apply delay', async () => {
      executor.registerTool({
        info: {
          name: 'slow_tool',
          description: 'Slow tool',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {},
        delay: 50,
        result: { success: true, duration: 0 },
      });

      const start = Date.now();
      await executor.execute('slow_tool', {}, context);
      const duration = Date.now() - start;

      expect(duration).toBeGreaterThanOrEqual(45);
    });

    it('should use custom executor', async () => {
      executor.registerTool({
        info: {
          name: 'custom_tool',
          description: 'Custom tool',
          category: 'test',
          riskLevel: 'low',
          supportsUndo: false,
          parallelizable: true,
        },
        parameters: {},
        executor: async (args) => ({
          success: true,
          data: { doubled: (args.value as number) * 2 },
          duration: 10,
        }),
      });

      const result = await executor.execute(
        'custom_tool',
        { value: 5 },
        context
      );

      expect(result.data).toEqual({ doubled: 10 });
    });
  });

  describe('executeBatch', () => {
    beforeEach(() => {
      executor = createMockToolExecutorWithVideoTools();
    });

    it('should execute tools sequentially', async () => {
      const result = await executor.executeBatch(
        {
          tools: [
            { name: 'split_clip', args: { clipId: 'clip-1', position: 5 } },
            { name: 'move_clip', args: { clipId: 'clip-1', position: 10 } },
          ],
          mode: 'sequential',
          stopOnError: false,
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2);
      expect(result.results).toHaveLength(2);
    });

    it('should execute tools in parallel', async () => {
      const result = await executor.executeBatch(
        {
          tools: [
            { name: 'split_clip', args: { clipId: 'clip-1', position: 5 } },
            { name: 'get_timeline_info', args: { sequenceId: 'seq-1' } },
          ],
          mode: 'parallel',
          stopOnError: false,
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2);
    });

    it('should stop on error when configured', async () => {
      executor.setToolResult('split_clip', {
        success: false,
        error: 'Failed',
        duration: 10,
      });

      const result = await executor.executeBatch(
        {
          tools: [
            { name: 'split_clip', args: { clipId: 'clip-1', position: 5 } },
            { name: 'move_clip', args: { clipId: 'clip-1', position: 10 } },
          ],
          mode: 'sequential',
          stopOnError: true,
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(1);
    });

    it('should continue on error when not stopOnError', async () => {
      executor.setToolResult('split_clip', {
        success: false,
        error: 'Failed',
        duration: 10,
      });

      const result = await executor.executeBatch(
        {
          tools: [
            { name: 'split_clip', args: { clipId: 'clip-1', position: 5 } },
            { name: 'move_clip', args: { clipId: 'clip-1', position: 10 } },
          ],
          mode: 'sequential',
          stopOnError: false,
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(2);
      expect(result.failureCount).toBe(1);
      expect(result.successCount).toBe(1);
    });
  });

  describe('execution capture', () => {
    beforeEach(() => {
      executor = createMockToolExecutorWithVideoTools();
    });

    it('should capture executions', async () => {
      await executor.execute(
        'split_clip',
        { clipId: 'clip-1', position: 5 },
        context
      );

      expect(executor.getExecutionCount()).toBe(1);
    });

    it('should capture all execution details', async () => {
      await executor.execute(
        'split_clip',
        { clipId: 'clip-1', position: 5 },
        context
      );

      const execution = executor.getLastExecution();

      expect(execution?.toolName).toBe('split_clip');
      expect(execution?.args).toEqual({ clipId: 'clip-1', position: 5 });
      expect(execution?.context).toEqual(context);
      expect(execution?.result?.success).toBe(true);
    });

    it('should get executions for specific tool', async () => {
      await executor.execute('split_clip', { clipId: 'c1', position: 5 }, context);
      await executor.execute('move_clip', { clipId: 'c1', position: 10 }, context);
      await executor.execute('split_clip', { clipId: 'c2', position: 3 }, context);

      const splitExecutions = executor.getExecutionsFor('split_clip');

      expect(splitExecutions).toHaveLength(2);
    });

    it('should check if tool was called', async () => {
      await executor.execute('split_clip', { clipId: 'clip-1', position: 5 }, context);

      expect(executor.wasToolCalled('split_clip')).toBe(true);
      expect(executor.wasToolCalled('delete_clip')).toBe(false);
    });

    it('should check if tool was called with specific args', async () => {
      await executor.execute('split_clip', { clipId: 'clip-1', position: 5 }, context);

      expect(
        executor.wasToolCalledWith('split_clip', { clipId: 'clip-1', position: 5 })
      ).toBe(true);
      expect(
        executor.wasToolCalledWith('split_clip', { clipId: 'clip-2', position: 5 })
      ).toBe(false);
    });

    it('should clear executions', async () => {
      await executor.execute('split_clip', { clipId: 'clip-1', position: 5 }, context);

      executor.clearExecutions();

      expect(executor.getExecutionCount()).toBe(0);
    });
  });

  describe('tool queries', () => {
    beforeEach(() => {
      executor = createMockToolExecutorWithVideoTools();
    });

    it('should get available tools', () => {
      const tools = executor.getAvailableTools();

      expect(tools.length).toBeGreaterThan(0);
      expect(tools.some((t) => t.name === 'split_clip')).toBe(true);
    });

    it('should filter tools by category', () => {
      const editingTools = executor.getAvailableTools('editing');
      const analysisTools = executor.getAvailableTools('analysis');

      expect(editingTools.every((t) => t.category === 'editing')).toBe(true);
      expect(analysisTools.every((t) => t.category === 'analysis')).toBe(true);
    });

    it('should get tool definition', () => {
      const definition = executor.getToolDefinition('split_clip');

      expect(definition).not.toBeNull();
      expect(definition?.name).toBe('split_clip');
      expect(definition?.parameters).toBeDefined();
    });

    it('should return null for unknown tool definition', () => {
      const definition = executor.getToolDefinition('unknown');

      expect(definition).toBeNull();
    });

    it('should get tools by category', () => {
      const byCategory = executor.getToolsByCategory();

      expect(byCategory.has('editing')).toBe(true);
      expect(byCategory.has('analysis')).toBe(true);
    });

    it('should get tools by risk level', () => {
      const lowRiskTools = executor.getToolsByRisk('low');
      const mediumRiskTools = executor.getToolsByRisk('medium');

      expect(lowRiskTools.every((t) => t.riskLevel === 'low')).toBe(true);
      expect(mediumRiskTools.length).toBeGreaterThan(lowRiskTools.length);
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      executor = createMockToolExecutorWithVideoTools();
    });

    it('should validate required args', () => {
      const result = executor.validateArgs('split_clip', {});

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: clipId');
      expect(result.errors).toContain('Missing required field: position');
    });

    it('should pass validation with required args', () => {
      const result = executor.validateArgs('split_clip', {
        clipId: 'clip-1',
        position: 5,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail validation for unknown tool', () => {
      const result = executor.validateArgs('unknown', {});

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('not found');
    });
  });

  describe('reset', () => {
    it('should reset all state', async () => {
      executor = createMockToolExecutorWithVideoTools();

      await executor.execute('split_clip', { clipId: 'c1', position: 5 }, context);

      executor.reset();

      expect(executor.getExecutionCount()).toBe(0);
      expect(executor.getAvailableTools()).toHaveLength(0);
    });
  });

  describe('factory functions', () => {
    it('should create executor with video tools', () => {
      const videoExecutor = createMockToolExecutorWithVideoTools();

      expect(videoExecutor.hasTool('split_clip')).toBe(true);
      expect(videoExecutor.hasTool('move_clip')).toBe(true);
      expect(videoExecutor.hasTool('delete_clip')).toBe(true);
      expect(videoExecutor.hasTool('get_timeline_info')).toBe(true);
    });
  });
});

/**
 * ToolRegistryAdapter Tests
 *
 * Tests for the adapter that bridges IToolExecutor
 * to the existing ToolRegistry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ToolRegistryAdapter,
  createToolRegistryAdapter,
} from './ToolRegistryAdapter';
import { ToolRegistry, type ToolDefinition } from '@/agents/ToolRegistry';
import type { ExecutionContext } from '../../ports/IToolExecutor';

describe('ToolRegistryAdapter', () => {
  let registry: ToolRegistry;
  let adapter: ToolRegistryAdapter;
  let executionContext: ExecutionContext;
  let splitClipTool: ToolDefinition;
  let deleteClipTool: ToolDefinition;
  let analyzeVideoTool: ToolDefinition;

  beforeEach(() => {
    // Create fresh tool definitions with mocks in each test
    splitClipTool = {
      name: 'split_clip',
      description: 'Split a clip at a specific time',
      category: 'clip',
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'The clip ID' },
          atTimelineSec: { type: 'number', description: 'Split position in seconds' },
        },
        required: ['clipId', 'atTimelineSec'],
      },
      handler: vi.fn().mockResolvedValue({ success: true, result: { newClipId: 'clip-2' } }),
    };

    deleteClipTool = {
      name: 'delete_clip',
      description: 'Delete a clip from the timeline',
      category: 'clip',
      parameters: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'The clip ID' },
        },
        required: ['clipId'],
      },
      handler: vi.fn().mockResolvedValue({ success: true }),
    };

    analyzeVideoTool = {
      name: 'analyze_video',
      description: 'Analyze video content',
      category: 'analysis',
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: 'Asset ID' },
        },
        required: ['assetId'],
      },
      handler: vi.fn().mockResolvedValue({ success: true, result: { scenes: 5 } }),
    };

    registry = new ToolRegistry();
    registry.register(splitClipTool);
    registry.register(deleteClipTool);
    registry.register(analyzeVideoTool);

    adapter = createToolRegistryAdapter(registry);

    executionContext = {
      projectId: 'project-1',
      sequenceId: 'sequence-1',
      sessionId: 'session-1',
    };
  });

  describe('execute', () => {
    it('should execute a tool successfully', async () => {
      const result = await adapter.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: 5 },
        executionContext
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ newClipId: 'clip-2' });
      expect(splitClipTool.handler).toHaveBeenCalledWith(
        { clipId: 'clip-1', atTimelineSec: 5 },
        expect.any(Object)
      );
    });

    it('should return failure for non-existent tool', async () => {
      const result = await adapter.execute(
        'non_existent_tool',
        {},
        executionContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should handle tool execution errors', async () => {
      const failingTool: ToolDefinition = {
        name: 'failing_tool',
        description: 'A tool that fails',
        category: 'utility',
        parameters: { type: 'object', properties: {} },
        handler: vi.fn().mockRejectedValue(new Error('Execution failed')),
      };
      registry.register(failingTool);

      const result = await adapter.execute('failing_tool', {}, executionContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Execution failed');
    });

    it('should measure execution duration', async () => {
      const result = await adapter.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: 5 },
        executionContext
      );

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('executeBatch', () => {
    it('should execute multiple tools sequentially', async () => {
      const result = await adapter.executeBatch(
        {
          tools: [
            { name: 'split_clip', args: { clipId: 'clip-1', atTimelineSec: 5 } },
            { name: 'delete_clip', args: { clipId: 'clip-1' } },
          ],
          mode: 'sequential',
          stopOnError: false,
        },
        executionContext
      );

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
    });

    it('should stop on error when stopOnError is true', async () => {
      const failingTool: ToolDefinition = {
        name: 'failing_tool',
        description: 'A tool that fails',
        category: 'utility',
        parameters: { type: 'object', properties: {} },
        handler: vi.fn().mockResolvedValue({ success: false, error: 'Failed' }),
      };
      registry.register(failingTool);

      const result = await adapter.executeBatch(
        {
          tools: [
            { name: 'failing_tool', args: {} },
            { name: 'split_clip', args: { clipId: 'clip-1', atTimelineSec: 5 } },
          ],
          mode: 'sequential',
          stopOnError: true,
        },
        executionContext
      );

      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(1);
      expect(splitClipTool.handler).not.toHaveBeenCalled();
    });

    it('should execute tools in parallel when mode is parallel', async () => {
      const result = await adapter.executeBatch(
        {
          tools: [
            { name: 'split_clip', args: { clipId: 'clip-1', atTimelineSec: 5 } },
            { name: 'analyze_video', args: { assetId: 'asset-1' } },
          ],
          mode: 'parallel',
          stopOnError: false,
        },
        executionContext
      );

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
    });
  });

  describe('getAvailableTools', () => {
    it('should return all available tools', () => {
      const tools = adapter.getAvailableTools();

      expect(tools).toHaveLength(3);
      expect(tools.map((t) => t.name)).toContain('split_clip');
      expect(tools.map((t) => t.name)).toContain('delete_clip');
      expect(tools.map((t) => t.name)).toContain('analyze_video');
    });

    it('should filter by category', () => {
      const tools = adapter.getAvailableTools('clip');

      expect(tools).toHaveLength(2);
      expect(tools.every((t) => t.category === 'clip')).toBe(true);
    });
  });

  describe('getToolDefinition', () => {
    it('should return tool definition', () => {
      const def = adapter.getToolDefinition('split_clip');

      expect(def).toBeDefined();
      expect(def!.name).toBe('split_clip');
      expect(def!.description).toBe('Split a clip at a specific time');
      expect(def!.parameters).toBeDefined();
    });

    it('should return null for non-existent tool', () => {
      const def = adapter.getToolDefinition('non_existent');

      expect(def).toBeNull();
    });
  });

  describe('validateArgs', () => {
    it('should return valid for correct args', () => {
      const result = adapter.validateArgs('split_clip', {
        clipId: 'clip-1',
        atTimelineSec: 5,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return invalid for missing required args', () => {
      const result = adapter.validateArgs('split_clip', {
        clipId: 'clip-1',
        // missing atTimelineSec
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('atTimelineSec');
    });

    it('should return invalid for non-existent tool', () => {
      const result = adapter.validateArgs('non_existent', {});

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('not found');
    });
  });

  describe('hasTool', () => {
    it('should return true for existing tool', () => {
      expect(adapter.hasTool('split_clip')).toBe(true);
    });

    it('should return false for non-existent tool', () => {
      expect(adapter.hasTool('non_existent')).toBe(false);
    });
  });

  describe('getToolsByCategory', () => {
    it('should return tools grouped by category', () => {
      const byCategory = adapter.getToolsByCategory();

      expect(byCategory.get('clip')).toHaveLength(2);
      expect(byCategory.get('analysis')).toHaveLength(1);
    });
  });

  describe('getToolsByRisk', () => {
    it('should return tools with risk at or below threshold', () => {
      const tools = adapter.getToolsByRisk('medium');

      // All tools should be included since they default to 'low' risk
      expect(tools.length).toBeGreaterThan(0);
    });
  });
});

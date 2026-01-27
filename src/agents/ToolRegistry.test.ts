/**
 * Tool Registry Tests
 *
 * TDD tests for the agent tool registry that manages available tools.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ToolRegistry,
  ToolHandler,
  ToolDefinition,
  ToolCategory,
  ToolExecutionResult,
} from './ToolRegistry';
import type { AgentContext } from './Agent';

// =============================================================================
// Test Data
// =============================================================================

const createMockHandler = (): ToolHandler => vi.fn().mockResolvedValue({
  success: true,
  result: { done: true },
});

const createSplitClipTool = (handler: ToolHandler): ToolDefinition => ({
  name: 'split_clip',
  description: 'Split a clip at the given position',
  category: 'timeline',
  parameters: {
    type: 'object',
    properties: {
      clipId: { type: 'string', description: 'The clip ID' },
      position: { type: 'number', description: 'Position in seconds' },
    },
    required: ['clipId', 'position'],
  },
  handler,
});

const createDeleteClipTool = (handler: ToolHandler): ToolDefinition => ({
  name: 'delete_clip',
  description: 'Delete a clip from the timeline',
  category: 'timeline',
  parameters: {
    type: 'object',
    properties: {
      clipId: { type: 'string', description: 'The clip ID' },
    },
    required: ['clipId'],
  },
  handler,
});

const createExportTool = (handler: ToolHandler): ToolDefinition => ({
  name: 'export_video',
  description: 'Export the timeline to a video file',
  category: 'export',
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['mp4', 'webm', 'mov'] },
      quality: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['format'],
  },
  handler,
});

// =============================================================================
// Tests
// =============================================================================

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('Tool Registration', () => {
    it('registers a tool', () => {
      const handler = createMockHandler();
      const tool = createSplitClipTool(handler);

      registry.register(tool);

      expect(registry.has('split_clip')).toBe(true);
    });

    it('retrieves a registered tool', () => {
      const handler = createMockHandler();
      const tool = createSplitClipTool(handler);
      registry.register(tool);

      const retrieved = registry.get('split_clip');

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('split_clip');
      expect(retrieved?.description).toBe('Split a clip at the given position');
    });

    it('returns undefined for unregistered tool', () => {
      expect(registry.get('unknown_tool')).toBeUndefined();
    });

    it('overwrites tool with same name', () => {
      const handler1 = createMockHandler();
      const handler2 = createMockHandler();

      const tool1: ToolDefinition = {
        ...createSplitClipTool(handler1),
        description: 'Old description',
      };
      const tool2: ToolDefinition = {
        ...createSplitClipTool(handler2),
        description: 'New description',
      };

      registry.register(tool1);
      registry.register(tool2);

      const retrieved = registry.get('split_clip');
      expect(retrieved?.description).toBe('New description');
    });

    it('unregisters a tool', () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));

      registry.unregister('split_clip');

      expect(registry.has('split_clip')).toBe(false);
    });

    it('does nothing when unregistering unknown tool', () => {
      // Should not throw
      registry.unregister('unknown_tool');
    });
  });

  describe('Tool Listing', () => {
    it('lists all registered tools', () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));
      registry.register(createDeleteClipTool(handler));

      const tools = registry.listAll();

      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toContain('split_clip');
      expect(tools.map((t) => t.name)).toContain('delete_clip');
    });

    it('returns empty array when no tools registered', () => {
      expect(registry.listAll()).toEqual([]);
    });

    it('lists tools by category', () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));
      registry.register(createDeleteClipTool(handler));
      registry.register(createExportTool(handler));

      const timelineTools = registry.listByCategory('timeline');
      const exportTools = registry.listByCategory('export');

      expect(timelineTools).toHaveLength(2);
      expect(exportTools).toHaveLength(1);
      expect(exportTools[0].name).toBe('export_video');
    });

    it('returns empty array for unknown category', () => {
      expect(registry.listByCategory('unknown' as ToolCategory)).toEqual([]);
    });

    it('lists available categories', () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));
      registry.register(createExportTool(handler));

      const categories = registry.listCategories();

      expect(categories).toContain('timeline');
      expect(categories).toContain('export');
    });
  });

  describe('Tool Execution', () => {
    it('executes a tool with arguments', async () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));

      const result = await registry.execute('split_clip', {
        clipId: 'clip_001',
        position: 5.5,
      });

      expect(result.success).toBe(true);
      expect(handler).toHaveBeenCalledWith(
        { clipId: 'clip_001', position: 5.5 },
        expect.any(Object)
      );
    });

    it('passes context to handler', async () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));

      const context: AgentContext = {
        projectId: 'proj_001',
        sequenceId: 'seq_001',
      };

      await registry.execute('split_clip', { clipId: 'c1', position: 1 }, context);

      expect(handler).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining(context)
      );
    });

    it('returns error for unknown tool', async () => {
      const result = await registry.execute('unknown_tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('catches and reports handler errors', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Handler failed'));
      registry.register(createSplitClipTool(handler));

      const result = await registry.execute('split_clip', {
        clipId: 'clip_001',
        position: 5.5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Handler failed');
    });

    it('validates required parameters', async () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));

      const result = await registry.execute('split_clip', {
        clipId: 'clip_001',
        // Missing required 'position' parameter
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('position');
    });

    it('validates parameter types', async () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));

      const result = await registry.execute('split_clip', {
        clipId: 'clip_001',
        position: 'not a number' as unknown as number,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('position');
    });
  });

  describe('Tool Schemas for AI', () => {
    it('exports tools as AI function schemas', () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));
      registry.register(createExportTool(handler));

      const schemas = registry.getAIFunctionSchemas();

      expect(schemas).toHaveLength(2);
      expect(schemas[0]).toMatchObject({
        name: expect.any(String),
        description: expect.any(String),
        parameters: expect.any(Object),
      });
    });

    it('excludes handler from AI schemas', () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));

      const schemas = registry.getAIFunctionSchemas();

      expect(schemas[0]).not.toHaveProperty('handler');
    });
  });

  describe('Bulk Operations', () => {
    it('registers multiple tools at once', () => {
      const handler = createMockHandler();
      const tools = [
        createSplitClipTool(handler),
        createDeleteClipTool(handler),
        createExportTool(handler),
      ];

      registry.registerMany(tools);

      expect(registry.listAll()).toHaveLength(3);
    });

    it('clears all tools', () => {
      const handler = createMockHandler();
      registry.register(createSplitClipTool(handler));
      registry.register(createDeleteClipTool(handler));

      registry.clear();

      expect(registry.listAll()).toHaveLength(0);
    });
  });
});

describe('ToolDefinition', () => {
  it('has correct structure', () => {
    const handler = createMockHandler();
    const tool = createSplitClipTool(handler);

    expect(tool).toMatchObject({
      name: 'split_clip',
      description: expect.any(String),
      category: 'timeline',
      parameters: {
        type: 'object',
        properties: expect.any(Object),
        required: expect.any(Array),
      },
      handler: expect.any(Function),
    });
  });
});

describe('ToolExecutionResult', () => {
  it('has correct structure for success', () => {
    const result: ToolExecutionResult = {
      success: true,
      result: { clipId: 'new_clip_001' },
    };

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
  });

  it('has correct structure for failure', () => {
    const result: ToolExecutionResult = {
      success: false,
      error: 'Tool execution failed',
    };

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

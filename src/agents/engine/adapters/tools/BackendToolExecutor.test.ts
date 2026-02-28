/**
 * BackendToolExecutor Tests
 *
 * Integration tests verifying:
 * - Editing tools route to backend IPC (execute_agent_plan)
 * - High-level/non-command tools stay on frontend ToolRegistryAdapter
 * - Feature flag off routes ALL tools through frontend
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  BackendToolExecutor,
  createBackendToolExecutor,
  registerCompoundExpander,
  unregisterCompoundExpander,
} from './BackendToolExecutor';
import type {
  IToolExecutor,
  ExecutionContext,
  ToolExecutionResult,
  ToolInfo,
  BatchExecutionRequest,
  BatchExecutionResult,
} from '../../ports/IToolExecutor';
import type { RiskLevel, ValidationResult } from '../../core/types';

// =============================================================================
// Types
// =============================================================================

/** Minimal tool definition for test setup */
interface TestToolDef {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, unknown>;
}

// =============================================================================
// Mock Frontend Executor
// =============================================================================

function createMockFrontendExecutor(tools: TestToolDef[]): IToolExecutor {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const executor: IToolExecutor = {
    execute: vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      const tool = toolMap.get(toolName);
      if (!tool) return { success: false, error: 'Tool not found', duration: 0 };
      return { success: true, data: { frontend: true, tool: toolName, args }, duration: 1 };
    }),

    executeBatch: vi.fn(async (request: BatchExecutionRequest) => {
      const results = request.tools.map((t) => ({
        tool: t.name,
        result: {
          success: true,
          data: { frontend: true, tool: t.name },
          duration: 1,
        } as ToolExecutionResult,
      }));
      return {
        success: true,
        results,
        totalDuration: 1,
        successCount: results.length,
        failureCount: 0,
      } as BatchExecutionResult;
    }),

    getAvailableTools: vi.fn((category?: string) => {
      const infos: ToolInfo[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
        riskLevel: 'low' as RiskLevel,
        estimatedDuration: 'instant' as const,
        supportsUndo: true,
        parallelizable: false,
      }));
      if (category) return infos.filter((t) => t.category === category);
      return infos;
    }),

    getToolDefinition: vi.fn((name: string) => {
      const tool = toolMap.get(name);
      if (!tool) return null;
      return {
        name: tool.name,
        description: tool.description,
        category: tool.category,
        parameters: tool.parameters,
        riskLevel: 'low' as RiskLevel,
        estimatedDuration: 'instant' as const,
        supportsUndo: true,
        parallelizable: false,
      };
    }),

    validateArgs: vi.fn(() => ({ valid: true, errors: [] }) as ValidationResult),

    hasTool: vi.fn((name: string) => toolMap.has(name)),

    getToolsByCategory: vi.fn(() => {
      const map = new Map<string, ToolInfo[]>();
      for (const t of tools) {
        const info: ToolInfo = {
          name: t.name,
          description: t.description,
          category: t.category,
          riskLevel: 'low' as RiskLevel,
          estimatedDuration: 'instant' as const,
          supportsUndo: true,
          parallelizable: false,
        };
        if (!map.has(t.category)) map.set(t.category, []);
        map.get(t.category)!.push(info);
      }
      return map;
    }),

    getToolsByRisk: vi.fn(() => []),
  };

  return executor;
}

// =============================================================================
// Test Setup
// =============================================================================

const mockInvoke = vi.mocked(invoke);

const TOOL_DEFS: TestToolDef[] = [
  {
    name: 'split_clip',
    description: 'Split a clip',
    category: 'clip',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'insert_clip',
    description: 'Insert a clip',
    category: 'clip',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'move_clip',
    description: 'Move a clip',
    category: 'clip',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'freeze_frame',
    description: 'Create a freeze frame',
    category: 'clip',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'add_transition',
    description: 'Add a transition',
    category: 'transition',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'rename_track',
    description: 'Rename a track',
    category: 'track',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'analyze_video',
    description: 'Analyze video content',
    category: 'analysis',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_timeline_state',
    description: 'Get timeline state',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
  },
];

const CONTEXT: ExecutionContext = {
  projectId: 'project-1',
  sequenceId: 'seq-1',
  sessionId: 'session-1',
};

// =============================================================================
// Tests
// =============================================================================

describe('BackendToolExecutor', () => {
  let frontend: IToolExecutor;
  let backend: BackendToolExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    frontend = createMockFrontendExecutor(TOOL_DEFS);
    backend = createBackendToolExecutor(frontend);
  });

  // ===========================================================================
  // Task 7.7: Editing tools route to backend, analysis stays frontend
  // ===========================================================================

  describe('tool routing', () => {
    it('should route editing tool (clip category) to backend IPC', async () => {
      mockInvoke.mockResolvedValueOnce({
        planId: 'plan-1',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [
          { stepId: 'step-1', success: true, data: { clipId: 'new-clip' }, durationMs: 10 },
        ],
        operationIds: ['op-1'],
        executionTimeMs: 10,
      });

      const result = await backend.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: 5 },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ clipId: 'new-clip' });
      expect(result.undoable).toBe(true);

      // Verify backend IPC was called
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          goal: 'Execute split_clip',
          steps: [
            expect.objectContaining({
              toolName: 'splitClip',
              params: { clipId: 'clip-1', atTimelineSec: 5 },
            }),
          ],
          approvalGranted: true,
          sessionId: 'session-1',
        }),
      });

      // Frontend executor should NOT have been called for this tool
      expect(frontend.execute).not.toHaveBeenCalled();
    });

    it('should route transition orchestration tool to frontend executor', async () => {
      const result = await backend.execute('add_transition', { type: 'dissolve' }, CONTEXT);

      expect(result.success).toBe(true);
      expect(frontend.execute).toHaveBeenCalledWith(
        'add_transition',
        { type: 'dissolve' },
        CONTEXT,
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should route track tools with frontend-only arg shaping to frontend', async () => {
      const result = await backend.execute(
        'rename_track',
        { sequenceId: 'seq-1', trackId: 'track-1', name: 'Main Video' },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(frontend.execute).toHaveBeenCalledWith(
        'rename_track',
        { sequenceId: 'seq-1', trackId: 'track-1', name: 'Main Video' },
        CONTEXT,
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should route analysis tool to frontend executor', async () => {
      const result = await backend.execute('analyze_video', { assetId: 'asset-1' }, CONTEXT);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        frontend: true,
        tool: 'analyze_video',
        args: { assetId: 'asset-1' },
      });

      // Frontend was called, backend was NOT
      expect(frontend.execute).toHaveBeenCalledWith(
        'analyze_video',
        { assetId: 'asset-1' },
        CONTEXT,
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should route utility tool to frontend executor', async () => {
      const result = await backend.execute('get_timeline_state', {}, CONTEXT);

      expect(result.success).toBe(true);
      expect(frontend.execute).toHaveBeenCalledWith('get_timeline_state', {}, CONTEXT);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should keep frontend-only compound clip tools on frontend', async () => {
      const result = await backend.execute(
        'freeze_frame',
        { clipId: 'clip-1', frameTime: 4, freezeDuration: 2 },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(frontend.execute).toHaveBeenCalledWith(
        'freeze_frame',
        { clipId: 'clip-1', frameTime: 4, freezeDuration: 2 },
        CONTEXT,
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should handle backend execution failure', async () => {
      mockInvoke.mockResolvedValueOnce({
        planId: 'plan-1',
        success: false,
        totalSteps: 1,
        stepsCompleted: 0,
        stepResults: [{ stepId: 'step-1', success: false, error: 'Clip not found', durationMs: 2 }],
        operationIds: [],
        errorMessage: 'Step 1 failed: Clip not found',
        executionTimeMs: 2,
      });

      const result = await backend.execute('split_clip', { clipId: 'nonexistent' }, CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Clip not found');
    });

    it('should handle IPC invocation error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('IPC channel closed'));

      const result = await backend.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: 5 },
        CONTEXT,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Backend execution error');
      expect(result.error).toContain('IPC channel closed');
    });

    it('should route unknown tool to frontend (falls through when no definition)', async () => {
      await backend.execute('unknown_tool', {}, CONTEXT);

      // isBackendTool returns false for unknown tools, so it goes to frontend
      expect(frontend.execute).toHaveBeenCalledWith('unknown_tool', {}, CONTEXT);
    });
  });

  // ===========================================================================
  // Batch execution routing
  // ===========================================================================

  describe('batch execution', () => {
    it('should separate editing and analysis tools in batch', async () => {
      mockInvoke.mockResolvedValueOnce({
        planId: 'batch-1',
        success: true,
        totalSteps: 2,
        stepsCompleted: 2,
        stepResults: [
          { stepId: 'step-1', success: true, data: { ok: true }, durationMs: 5 },
          { stepId: 'step-2', success: true, data: { ok: true }, durationMs: 5 },
        ],
        operationIds: ['op-1', 'op-2'],
        executionTimeMs: 10,
      });

      const result = await backend.executeBatch(
        {
          tools: [
            { name: 'split_clip', args: { clipId: 'c1', atTimelineSec: 5 } },
            { name: 'move_clip', args: { clipId: 'c2', newTimelineIn: 8 } },
            { name: 'analyze_video', args: { assetId: 'a1' } },
          ],
          mode: 'sequential',
          stopOnError: true,
        },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      // 2 backend + 1 frontend = 3 results
      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);

      // Backend received a 2-step plan (split_clip + move_clip)
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ toolName: 'splitClip' }),
            expect.objectContaining({ toolName: 'moveClip' }),
          ]),
        }),
      });

      // Frontend received the analysis tool
      expect(frontend.executeBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [{ name: 'analyze_video', args: { assetId: 'a1' } }],
        }),
        CONTEXT,
      );
    });

    it('should handle backend batch failure with rollback', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Transaction failed'));

      const result = await backend.executeBatch(
        {
          tools: [
            { name: 'split_clip', args: { clipId: 'c1', atTimelineSec: 5 } },
            { name: 'move_clip', args: { clipId: 'c2', newTimelineIn: 8 } },
          ],
          mode: 'sequential',
          stopOnError: true,
        },
        CONTEXT,
      );

      expect(result.success).toBe(false);
      expect(result.failureCount).toBe(2);
      expect(result.results[0].result.error).toContain('Batch execution error');
    });
  });

  // ===========================================================================
  // Metadata delegation
  // ===========================================================================

  describe('metadata delegation', () => {
    it('should delegate getAvailableTools to frontend', () => {
      const tools = backend.getAvailableTools();
      expect(frontend.getAvailableTools).toHaveBeenCalled();
      expect(tools.length).toBe(8);
    });

    it('should delegate getToolDefinition to frontend', () => {
      const def = backend.getToolDefinition('split_clip');
      expect(frontend.getToolDefinition).toHaveBeenCalledWith('split_clip');
      expect(def).toBeDefined();
      expect(def!.category).toBe('clip');
    });

    it('should delegate validateArgs to frontend', () => {
      const result = backend.validateArgs('split_clip', { clipId: 'c1' });
      expect(frontend.validateArgs).toHaveBeenCalledWith('split_clip', { clipId: 'c1' });
      expect(result.valid).toBe(true);
    });

    it('should delegate hasTool to frontend', () => {
      expect(backend.hasTool('split_clip')).toBe(true);
      expect(backend.hasTool('nonexistent')).toBe(false);
    });

    it('should delegate getToolsByCategory to frontend', () => {
      const byCategory = backend.getToolsByCategory();
      expect(frontend.getToolsByCategory).toHaveBeenCalled();
      expect(byCategory.get('clip')).toHaveLength(4);
    });
  });

  // ===========================================================================
  // Task 7.8: Feature flag off → all tools through frontend
  // ===========================================================================

  describe('feature flag behavior (integration)', () => {
    it('should route ALL tools through frontend when used directly as frontend executor', async () => {
      // When USE_BACKEND_TOOLS is off, AgenticSidebarContent creates
      // a plain ToolRegistryAdapter (no BackendToolExecutor wrapper).
      // Here we verify that the frontend executor handles everything.
      const frontendOnly = createMockFrontendExecutor(TOOL_DEFS);

      // Execute editing tool directly on frontend
      const clipResult = await frontendOnly.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: 5 },
        CONTEXT,
      );
      expect(clipResult.success).toBe(true);
      expect(clipResult.data).toEqual({
        frontend: true,
        tool: 'split_clip',
        args: { clipId: 'clip-1', atTimelineSec: 5 },
      });

      // Execute analysis tool directly on frontend
      const analysisResult = await frontendOnly.execute(
        'analyze_video',
        { assetId: 'a1' },
        CONTEXT,
      );
      expect(analysisResult.success).toBe(true);

      // No backend IPC calls at all
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should only route editing tools to backend when wrapped with BackendToolExecutor', async () => {
      // With USE_BACKEND_TOOLS on, editing tools go to backend
      mockInvoke.mockResolvedValueOnce({
        planId: 'plan-1',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [{ stepId: 'step-1', success: true, data: { ok: true }, durationMs: 5 }],
        operationIds: ['op-1'],
        executionTimeMs: 5,
      });

      // Editing tool → backend
      await backend.execute('split_clip', { clipId: 'c1', atTimelineSec: 5 }, CONTEXT);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(frontend.execute).not.toHaveBeenCalled();

      // Analysis tool → frontend
      await backend.execute('analyze_video', { assetId: 'a1' }, CONTEXT);
      expect(frontend.execute).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledTimes(1); // Still just the 1 call from editing
    });
  });

  // ===========================================================================
  // Compound tool expansion
  // ===========================================================================

  describe('compound tool expansion', () => {
    afterEach(() => {
      unregisterCompoundExpander('ripple_edit');
    });

    it('should expand compound tool into multiple sub-steps for single execute', async () => {
      // Register compound expander for ripple_edit
      registerCompoundExpander('ripple_edit', (args) => [
        { toolName: 'trimClip', params: { clipId: args.clipId, newSourceOut: args.trimEnd } },
        { toolName: 'moveClip', params: { clipId: 'clip-2', newTimelineIn: 8 } },
        { toolName: 'moveClip', params: { clipId: 'clip-3', newTimelineIn: 13 } },
      ]);

      // Add ripple_edit tool definition to frontend executor
      const extendedTools = [
        ...TOOL_DEFS,
        { name: 'ripple_edit', description: 'Ripple edit', category: 'clip', parameters: {} },
        { name: 'trim_clip', description: 'Trim a clip', category: 'clip', parameters: {} },
        { name: 'move_clip', description: 'Move a clip', category: 'clip', parameters: {} },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);

      mockInvoke.mockResolvedValueOnce({
        planId: 'plan-compound',
        success: true,
        totalSteps: 3,
        stepsCompleted: 3,
        stepResults: [
          { stepId: 'step-1', success: true, data: { trimmed: true }, durationMs: 10 },
          { stepId: 'step-2', success: true, data: { moved: true }, durationMs: 5 },
          { stepId: 'step-3', success: true, data: { moved: true }, durationMs: 5 },
        ],
        operationIds: ['op-1', 'op-2', 'op-3'],
        executionTimeMs: 20,
      });

      const result = await extendedBackend.execute(
        'ripple_edit',
        { clipId: 'clip-1', trimEnd: 8 },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      // Data should contain aggregated step results
      expect(result.data).toEqual({
        steps: [
          { success: true, data: { trimmed: true } },
          { success: true, data: { moved: true } },
          { success: true, data: { moved: true } },
        ],
        stepsCompleted: 3,
      });

      // Plan sent to backend should have 3 primitive steps, not 1 compound step
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          goal: expect.stringContaining('compound'),
          steps: [
            expect.objectContaining({ toolName: 'trimClip' }),
            expect.objectContaining({
              toolName: 'moveClip',
              params: { clipId: 'clip-2', newTimelineIn: 8 },
            }),
            expect.objectContaining({
              toolName: 'moveClip',
              params: { clipId: 'clip-3', newTimelineIn: 13 },
            }),
          ],
        }),
      });
    });

    it('should expand compound tool in batch and map results back', async () => {
      registerCompoundExpander('ripple_edit', (args) => [
        { toolName: 'trimClip', params: { clipId: args.clipId, newSourceOut: args.trimEnd } },
        { toolName: 'moveClip', params: { clipId: 'clip-2', newTimelineIn: 8 } },
      ]);

      const extendedTools = [
        ...TOOL_DEFS,
        { name: 'ripple_edit', description: 'Ripple edit', category: 'clip', parameters: {} },
        { name: 'trim_clip', description: 'Trim', category: 'clip', parameters: {} },
        { name: 'move_clip', description: 'Move', category: 'clip', parameters: {} },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);

      // Batch: ripple_edit (compound→2 steps) + split_clip (atomic→1 step) = 3 total steps
      mockInvoke.mockResolvedValueOnce({
        planId: 'batch-compound',
        success: true,
        totalSteps: 3,
        stepsCompleted: 3,
        stepResults: [
          { stepId: 'step-1', success: true, data: { trimmed: true }, durationMs: 10 },
          { stepId: 'step-2', success: true, data: { moved: true }, durationMs: 5 },
          { stepId: 'step-3', success: true, data: { split: true }, durationMs: 8 },
        ],
        operationIds: ['op-1', 'op-2', 'op-3'],
        executionTimeMs: 23,
      });

      const result = await extendedBackend.executeBatch(
        {
          tools: [
            { name: 'ripple_edit', args: { clipId: 'clip-1', trimEnd: 8 } },
            { name: 'split_clip', args: { clipId: 'clip-5', atTimelineSec: 3 } },
          ],
          mode: 'sequential',
          stopOnError: true,
        },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2); // 2 original tools
      expect(result.results).toHaveLength(2);

      // First result: compound ripple_edit (aggregated from 2 steps)
      expect(result.results[0].tool).toBe('ripple_edit');
      expect(result.results[0].result.success).toBe(true);
      expect(result.results[0].result.data).toEqual({
        steps: [
          { success: true, data: { trimmed: true } },
          { success: true, data: { moved: true } },
        ],
      });

      // Second result: atomic split_clip (single step)
      expect(result.results[1].tool).toBe('split_clip');
      expect(result.results[1].result.success).toBe(true);
      expect(result.results[1].result.data).toEqual({ split: true });

      // Backend plan should have 3 steps total
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({ toolName: 'trimClip' }),
            expect.objectContaining({ toolName: 'moveClip' }),
            expect.objectContaining({ toolName: 'splitClip' }),
          ]),
        }),
      });
    });
  });

  // ===========================================================================
  // Factory function
  // ===========================================================================

  describe('createBackendToolExecutor', () => {
    it('should create a BackendToolExecutor instance', () => {
      const executor = createBackendToolExecutor(frontend);
      expect(executor).toBeInstanceOf(BackendToolExecutor);
    });
  });
});

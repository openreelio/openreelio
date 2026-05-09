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
import { useProjectStore } from '@/stores/projectStore';
import { createMockAsset, createMockClip, createMockSequence, createMockTrack } from '@/test/mocks';

// Disable meta-tool filtering in unit tests (mock tools don't match meta-tool names)
vi.mock('@/config/featureFlags', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/config/featureFlags')>();
  return { ...orig, isMetaToolsEnabled: () => false };
});

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
    name: 'change_clip_speed',
    description: 'Change clip speed',
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
    name: 'add_marker',
    description: 'Add a timeline marker',
    category: 'timeline',
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
  {
    name: 'execute_plan',
    description: 'Execute a legacy sequential edit plan',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'check_generation_status',
    description: 'Check the status of a generation job',
    category: 'generation',
    parameters: { type: 'object', properties: {} },
  },
];

const CONTEXT: ExecutionContext = {
  projectId: 'project-1',
  sequenceId: 'seq-1',
  sessionId: 'session-1',
};

function seedActiveProjectState(
  options: {
    activeSequenceId?: string | null;
    sequenceId?: string;
    stateVersion?: number;
    clipIds?: string[];
  } = {},
): void {
  const sequenceId = options.sequenceId ?? 'seq-1';
  const activeSequenceId =
    options.activeSequenceId === undefined ? sequenceId : options.activeSequenceId;
  const clipIds = options.clipIds ?? ['clip-1', 'clip-2', 'clip-3', 'clip-5', 'c1', 'c2'];

  const clips = clipIds.map((clipId, index) =>
    createMockClip({
      id: clipId,
      assetId: `asset-${clipId}`,
      place: {
        timelineInSec: index * 5,
        durationSec: 5,
      },
    }),
  );
  const track = createMockTrack({
    id: 'track-1',
    kind: 'video',
    name: 'Video 1',
    clips,
  });
  const sequence = createMockSequence({
    id: sequenceId,
    name: 'Test Sequence',
    tracks: [track],
  });
  const assets = new Map(
    clips.map((clip) => [
      clip.assetId,
      createMockAsset({
        id: clip.assetId,
        name: `${clip.id}.mp4`,
        kind: 'video',
      }),
    ]),
  );

  useProjectStore.setState({
    isLoaded: true,
    meta: {
      id: 'project-1',
      name: 'Test',
      path: '/tmp/test.orio',
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    },
    stateVersion: options.stateVersion ?? 8,
    activeSequenceId,
    sequences: new Map([[sequenceId, sequence]]),
    assets,
  });
}

function buildBackendProjectState() {
  const project = useProjectStore.getState();
  return {
    assets: Array.from(project.assets.values()),
    sequences: Array.from(project.sequences.values()),
    effects: Array.from(project.effects.values()),
    activeSequenceId: project.activeSequenceId,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('BackendToolExecutor', () => {
  let frontend: IToolExecutor;
  let backend: BackendToolExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    seedActiveProjectState();
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'get_project_state') {
        return buildBackendProjectState();
      }

      throw new Error(`Unexpected invoke: ${command}`);
    });
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
      expect(result.data).toEqual({
        clipId: 'new-clip',
        sourceClipId: 'clip-1',
        newClipId: null,
      });
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

    it('should route change_clip_speed to backend IPC with reverse argument', async () => {
      mockInvoke.mockResolvedValueOnce({
        planId: 'plan-speed-1',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [{ stepId: 'step-1', success: true, data: { ok: true }, durationMs: 7 }],
        operationIds: ['op-speed-1'],
        executionTimeMs: 7,
      });

      const result = await backend.execute(
        'change_clip_speed',
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', speed: 1.5, reverse: true },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          goal: 'Execute change_clip_speed',
          steps: [
            expect.objectContaining({
              toolName: 'changeClipSpeed',
              params: {
                sequenceId: 'seq-1',
                trackId: 'track-1',
                clipId: 'clip-1',
                speed: 1.5,
                reverse: true,
              },
            }),
          ],
        }),
      });
      expect(frontend.execute).not.toHaveBeenCalled();
    });

    it('should route backend-safe edit meta-tool actions to backend IPC', async () => {
      const extendedTools = [
        ...TOOL_DEFS,
        { name: 'edit', description: 'Editing meta-tool', category: 'timeline', parameters: {} },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);

      mockInvoke.mockResolvedValueOnce({
        planId: 'plan-edit-1',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [{ stepId: 'step-1', success: true, data: { ok: true }, durationMs: 6 }],
        operationIds: ['op-edit-1'],
        executionTimeMs: 6,
      });

      const result = await extendedBackend.execute(
        'edit',
        { action: 'split_clip', clipId: 'clip-1', atTimelineSec: 5 },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          goal: 'Execute split_clip',
          steps: [
            expect.objectContaining({
              toolName: 'splitClip',
              params: { clipId: 'clip-1', atTimelineSec: 5 },
            }),
          ],
        }),
      });
      expect(extendedFrontend.execute).not.toHaveBeenCalled();
    });

    it('should normalize backend split results into the chained newClipId contract', async () => {
      mockInvoke.mockResolvedValueOnce({
        planId: 'plan-split-contract',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [
          {
            stepId: 'step-1',
            success: true,
            data: { operationId: 'op-1', createdIds: ['clip-2'] },
            durationMs: 5,
          },
        ],
        operationIds: ['op-1'],
        executionTimeMs: 5,
      });

      const result = await backend.execute(
        'split_clip',
        { clipId: 'clip-1', splitTime: 5 },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        operationId: 'op-1',
        createdIds: ['clip-2'],
        sourceClipId: 'clip-1',
        newClipId: 'clip-2',
      });
    });

    it('should route backend-safe edit meta-tool actions to backend IPC', async () => {
      const extendedTools = [
        ...TOOL_DEFS,
        { name: 'edit', description: 'Editing meta-tool', category: 'timeline', parameters: {} },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);
      mockInvoke.mockResolvedValueOnce({
        planId: 'plan-edit-rename',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [
          { stepId: 'step-1', success: true, data: { trackId: 'track-1' }, durationMs: 5 },
        ],
        operationIds: ['op-1'],
        executionTimeMs: 5,
      });

      const result = await extendedBackend.execute(
        'edit',
        { action: 'rename_track', sequenceId: 'seq-1', trackId: 'track-1', name: 'Main Video' },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          goal: 'Execute rename_track',
          steps: [
            expect.objectContaining({
              toolName: 'renameTrack',
              params: { sequenceId: 'seq-1', trackId: 'track-1', name: 'Main Video' },
            }),
          ],
        }),
      });
      expect(extendedFrontend.execute).not.toHaveBeenCalled();
    });

    it('should fall back to frontend execution for mutating transition tools that are not backend-safe', async () => {
      const result = await backend.execute(
        'add_transition',
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', transitionType: 'dissolve' },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(frontend.execute).toHaveBeenCalledWith(
        'add_transition',
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', transitionType: 'dissolve' },
        CONTEXT,
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should route backend-safe track tools to backend IPC', async () => {
      mockInvoke.mockResolvedValueOnce({
        planId: 'plan-rename-track',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [
          { stepId: 'step-1', success: true, data: { trackId: 'track-1' }, durationMs: 5 },
        ],
        operationIds: ['op-1'],
        executionTimeMs: 5,
      });

      const result = await backend.execute(
        'rename_track',
        { sequenceId: 'seq-1', trackId: 'track-1', name: 'Main Video' },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          goal: 'Execute rename_track',
          steps: [
            expect.objectContaining({
              toolName: 'renameTrack',
              params: { sequenceId: 'seq-1', trackId: 'track-1', name: 'Main Video' },
            }),
          ],
        }),
      });
      expect(frontend.execute).not.toHaveBeenCalled();
    });

    it('should normalize marker string colors before backend IPC', async () => {
      mockInvoke.mockResolvedValueOnce({
        planId: 'plan-add-marker',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [
          { stepId: 'step-1', success: true, data: { markerId: 'marker-1' }, durationMs: 5 },
        ],
        operationIds: ['op-1'],
        executionTimeMs: 5,
      });

      const result = await backend.execute(
        'add_marker',
        { sequenceId: 'seq-1', time: 1.5, label: 'Hook', color: '#FF000080' },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          goal: 'Execute add_marker',
          steps: [
            expect.objectContaining({
              toolName: 'addMarker',
              params: {
                sequenceId: 'seq-1',
                time: 1.5,
                label: 'Hook',
                color: { r: 1, g: 0, b: 0, a: 128 / 255 },
              },
            }),
          ],
        }),
      });
      expect(frontend.execute).not.toHaveBeenCalled();
    });

    it('should reject invalid marker colors before backend IPC', async () => {
      const result = await backend.execute(
        'add_marker',
        { sequenceId: 'seq-1', time: 1.5, label: 'Hook', color: 'not-a-color' },
        CONTEXT,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid marker color');
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(frontend.execute).not.toHaveBeenCalled();
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

    it('should route generation status tools to the frontend executor', async () => {
      const result = await backend.execute('check_generation_status', { jobId: 'job-1' }, CONTEXT);

      expect(result.success).toBe(true);
      expect(frontend.execute).toHaveBeenCalledWith(
        'check_generation_status',
        { jobId: 'job-1' },
        CONTEXT,
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should fall back to frontend execution for mutating compound tools that are not backend-safe', async () => {
      const result = await backend.execute(
        'freeze_frame',
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', frameTime: 4, duration: 2 },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(frontend.execute).toHaveBeenCalledWith(
        'freeze_frame',
        { sequenceId: 'seq-1', trackId: 'track-1', clipId: 'clip-1', frameTime: 4, duration: 2 },
        CONTEXT,
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should reject backend-routed mutations when the expected revision is stale', async () => {
      useProjectStore.setState({
        isLoaded: true,
        meta: {
          id: 'project-1',
          name: 'Test',
          path: '/tmp/test.orio',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
        },
        stateVersion: 8,
      });

      const result = await backend.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: 5 },
        {
          ...CONTEXT,
          expectedStateVersion: 3,
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('REV_CONFLICT');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should fail closed when no active sequence is available for backend mutations', async () => {
      seedActiveProjectState({ activeSequenceId: null });

      const result = await backend.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: 5 },
        {
          ...CONTEXT,
          expectedStateVersion: 8,
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No active sequence is loaded for mutation preflight');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should fail closed when backend mutation context targets a different sequence', async () => {
      seedActiveProjectState({
        activeSequenceId: 'seq-active',
        sequenceId: 'seq-active',
        clipIds: ['clip-1'],
      });

      const result = await backend.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: 5 },
        {
          ...CONTEXT,
          sequenceId: 'seq-stale',
          expectedStateVersion: 8,
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "context sequence 'seq-stale' does not match active sequence 'seq-active'",
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

      const result = await backend.execute('split_clip', { clipId: 'clip-1' }, CONTEXT);

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

    it('should promote backend-safe legacy execute_plan batches to backend atomic execution', async () => {
      mockInvoke.mockResolvedValueOnce({
        planId: 'legacy-plan-1',
        success: true,
        totalSteps: 2,
        stepsCompleted: 2,
        stepResults: [
          {
            stepId: 'split-step',
            success: true,
            data: { leftClipId: 'clip-1a', rightClipId: 'clip-1b' },
            durationMs: 5,
          },
          {
            stepId: 'move-step',
            success: true,
            data: { clipId: 'clip-2', timelineIn: 8 },
            durationMs: 7,
          },
        ],
        operationIds: ['op-1', 'op-2'],
        executionTimeMs: 12,
      });

      const result = await backend.execute(
        'execute_plan',
        {
          steps: [
            {
              id: 'split-step',
              toolName: 'split_clip',
              params: { clipId: 'clip-1', splitTime: 5 },
            },
            {
              id: 'move-step',
              toolName: 'move_clip',
              params: { clipId: 'clip-2', newTimelineIn: 8 },
            },
          ],
        },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(result.undoable).toBe(true);
      expect(result.data).toEqual({
        stepsExecuted: 2,
        stepResults: [
          {
            stepId: 'split-step',
            success: true,
            data: { leftClipId: 'clip-1a', rightClipId: 'clip-1b' },
            error: undefined,
          },
          {
            stepId: 'move-step',
            success: true,
            data: { clipId: 'clip-2', timelineIn: 8 },
            error: undefined,
          },
        ],
      });
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          goal: expect.stringContaining('legacy execute_plan'),
          sessionId: 'session-1',
          steps: [
            expect.objectContaining({
              id: 'split-step',
              toolName: 'splitClip',
              params: { clipId: 'clip-1', splitTime: 5 },
              dependsOn: [],
            }),
            expect.objectContaining({
              id: 'move-step',
              toolName: 'moveClip',
              params: { clipId: 'clip-2', newTimelineIn: 8 },
              dependsOn: ['split-step'],
            }),
          ],
        }),
      });
      expect(frontend.execute).not.toHaveBeenCalled();
    });

    it('should fail fast when a legacy execute_plan contains a frontend-only mutation step', async () => {
      const result = await backend.execute(
        'execute_plan',
        {
          steps: [
            {
              id: 'split-step',
              toolName: 'split_clip',
              params: { clipId: 'clip-1', splitTime: 5 },
            },
            {
              id: 'transition-step',
              toolName: 'add_transition',
              params: { clipId: 'clip-1b', transitionType: 'dissolve' },
            },
          ],
        },
        CONTEXT,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not approved for backend-safe agent execution');
      expect(frontend.execute).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should fail fast when legacy execute_plan promotion expansion throws', async () => {
      registerCompoundExpander('ripple_edit', () => {
        throw new Error('Invalid ripple request');
      });

      const extendedTools = [
        ...TOOL_DEFS,
        { name: 'ripple_edit', description: 'Ripple edit', category: 'clip', parameters: {} },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);
      const args = {
        steps: [
          {
            id: 'ripple-step',
            toolName: 'ripple_edit',
            params: { clipId: 'clip-1', trimEnd: 4 },
          },
        ],
      };

      try {
        const result = await extendedBackend.execute('execute_plan', args, CONTEXT);

        expect(result.success).toBe(false);
        expect(result.error).toContain('not approved for backend-safe agent execution');
        expect(extendedFrontend.execute).not.toHaveBeenCalled();
        expect(mockInvoke).not.toHaveBeenCalled();
      } finally {
        unregisterCompoundExpander('ripple_edit');
      }
    });

    it('should route unknown tool to frontend (falls through when no definition)', async () => {
      await backend.execute('unknown_tool', {}, CONTEXT);

      // isBackendTool returns false for unknown tools, so it goes to frontend
      expect(frontend.execute).toHaveBeenCalledWith('unknown_tool', {}, CONTEXT);
    });

    it('should promote backend-safe legacy execute_plan batches to backend atomic execution', async () => {
      const extendedTools = [
        ...TOOL_DEFS,
        {
          name: 'execute_plan',
          description: 'Legacy execute plan meta-tool',
          category: 'timeline',
          parameters: { type: 'object', properties: {} },
        },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);

      mockInvoke.mockResolvedValueOnce({
        planId: 'legacy-plan-1',
        success: true,
        totalSteps: 2,
        stepsCompleted: 2,
        stepResults: [
          { stepId: 'step-a', success: true, data: { split: true }, durationMs: 5 },
          { stepId: 'step-b', success: true, data: { moved: true }, durationMs: 4 },
        ],
        operationIds: ['op-1', 'op-2'],
        executionTimeMs: 9,
      });

      const result = await extendedBackend.execute(
        'execute_plan',
        {
          steps: [
            {
              id: 'step-a',
              toolName: 'split_clip',
              params: { clipId: 'clip-1', atTimelineSec: 5 },
            },
            { id: 'step-b', toolName: 'move_clip', params: { clipId: 'clip-2', newTimelineIn: 8 } },
          ],
        },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(result.undoable).toBe(true);
      expect(result.data).toEqual({
        stepsExecuted: 2,
        stepResults: [
          { stepId: 'step-a', success: true, data: { split: true }, error: undefined },
          { stepId: 'step-b', success: true, data: { moved: true }, error: undefined },
        ],
      });
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          goal: expect.stringContaining('Promote legacy execute_plan'),
          steps: [
            expect.objectContaining({ id: 'step-a', toolName: 'splitClip' }),
            expect.objectContaining({ id: 'step-b', toolName: 'moveClip' }),
          ],
        }),
      });
      expect(extendedFrontend.execute).not.toHaveBeenCalled();
    });

    it('should normalize marker colors when promoting legacy execute_plan batches', async () => {
      mockInvoke.mockResolvedValueOnce({
        planId: 'legacy-marker-plan',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [
          { stepId: 'marker-step', success: true, data: { markerId: 'm1' }, durationMs: 4 },
        ],
        operationIds: ['op-1'],
        executionTimeMs: 4,
      });

      const result = await backend.execute(
        'execute_plan',
        {
          steps: [
            {
              id: 'marker-step',
              toolName: 'add_marker',
              params: { sequenceId: 'seq-1', time: 2, label: 'Beat', color: 'blue' },
            },
          ],
        },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          steps: [
            expect.objectContaining({
              id: 'marker-step',
              toolName: 'addMarker',
              params: {
                sequenceId: 'seq-1',
                time: 2,
                label: 'Beat',
                color: { r: 0, g: 0, b: 1 },
              },
            }),
          ],
        }),
      });
      expect(frontend.execute).not.toHaveBeenCalled();
    });

    it('should fail fast when a legacy execute_plan includes frontend-only mutation tools', async () => {
      const extendedTools = [
        ...TOOL_DEFS,
        {
          name: 'execute_plan',
          description: 'Legacy execute plan meta-tool',
          category: 'timeline',
          parameters: { type: 'object', properties: {} },
        },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);

      const args = {
        steps: [
          { id: 'step-a', toolName: 'split_clip', params: { clipId: 'clip-1', atTimelineSec: 5 } },
          {
            id: 'step-b',
            toolName: 'add_transition',
            params: {
              sequenceId: 'seq-1',
              trackId: 'track-1',
              clipId: 'clip-1',
              transitionType: 'dissolve',
            },
          },
        ],
      };

      const result = await extendedBackend.execute('execute_plan', args, CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not approved for backend-safe agent execution');
      expect(extendedFrontend.execute).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Batch execution routing
  // ===========================================================================

  describe('batch execution', () => {
    it('should execute mixed backend/frontend batch in original order', async () => {
      // Backend tools execute individually via execute() for order preservation
      mockInvoke.mockResolvedValueOnce({
        planId: 'single-1',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [{ stepId: 'step-1', success: true, data: { ok: true }, durationMs: 5 }],
        operationIds: ['op-1'],
        executionTimeMs: 5,
      });
      mockInvoke.mockResolvedValueOnce(buildBackendProjectState());
      mockInvoke.mockResolvedValueOnce({
        planId: 'single-2',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [{ stepId: 'step-1', success: true, data: { ok: true }, durationMs: 5 }],
        operationIds: ['op-2'],
        executionTimeMs: 5,
      });
      mockInvoke.mockResolvedValueOnce(buildBackendProjectState());

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
      // 2 backend (per-tool) + 1 frontend = 3 results
      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);
      // Results preserve original request order
      expect(result.results).toHaveLength(3);
      expect(result.results[0].tool).toBe('split_clip');
      expect(result.results[1].tool).toBe('move_clip');
      expect(result.results[2].tool).toBe('analyze_video');
    });

    it('should allow frontend-safe mutation fallbacks inside mixed batches', async () => {
      mockInvoke.mockResolvedValueOnce({
        planId: 'single-1',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [{ stepId: 'step-1', success: true, data: { ok: true }, durationMs: 5 }],
        operationIds: ['op-1'],
        executionTimeMs: 5,
      });

      const result = await backend.executeBatch(
        {
          tools: [
            { name: 'split_clip', args: { clipId: 'c1', atTimelineSec: 5 } },
            {
              name: 'add_transition',
              args: {
                sequenceId: 'seq-1',
                trackId: 'track-1',
                clipId: 'clip-1',
                transitionType: 'dissolve',
              },
            },
          ],
          mode: 'sequential',
          stopOnError: true,
        },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
      expect(result.results.map((entry) => entry.tool)).toEqual(['split_clip', 'add_transition']);
      expect(frontend.execute).toHaveBeenCalledWith(
        'add_transition',
        {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'clip-1',
          transitionType: 'dissolve',
        },
        CONTEXT,
      );
    });

    it('should reject invalid marker colors before backend IPC in batch', async () => {
      const result = await backend.executeBatch(
        {
          tools: [
            {
              name: 'add_marker',
              args: { sequenceId: 'seq-1', time: 1.5, label: 'Hook', color: 'not-a-color' },
            },
            { name: 'split_clip', args: { clipId: 'c1', atTimelineSec: 5 } },
          ],
          mode: 'sequential',
          stopOnError: true,
        },
        CONTEXT,
      );

      expect(result.success).toBe(false);
      expect(result.failureCount).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].tool).toBe('add_marker');
      expect(result.results[0].result.error).toContain('Invalid marker color');
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(frontend.execute).not.toHaveBeenCalled();
    });

    it('should batch backend-safe edit meta-tool actions through one backend plan', async () => {
      const extendedTools = [
        ...TOOL_DEFS,
        { name: 'edit', description: 'Editing meta-tool', category: 'timeline', parameters: {} },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);

      mockInvoke.mockResolvedValueOnce({
        planId: 'batch-edit-1',
        success: true,
        totalSteps: 2,
        stepsCompleted: 2,
        stepResults: [
          { stepId: 'step-1', success: true, data: { split: true }, durationMs: 4 },
          { stepId: 'step-2', success: true, data: { moved: true }, durationMs: 5 },
        ],
        operationIds: ['op-1', 'op-2'],
        executionTimeMs: 9,
      });

      const result = await extendedBackend.executeBatch(
        {
          tools: [
            { name: 'edit', args: { action: 'split_clip', clipId: 'c1', atTimelineSec: 5 } },
            { name: 'edit', args: { action: 'move_clip', clipId: 'c2', newTimelineIn: 8 } },
          ],
          mode: 'sequential',
          stopOnError: true,
        },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
      expect(result.results).toEqual([
        {
          tool: 'edit',
          result: expect.objectContaining({
            success: true,
            data: { split: true },
          }),
        },
        {
          tool: 'edit',
          result: expect.objectContaining({
            success: true,
            data: { moved: true },
          }),
        },
      ]);
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          steps: [
            expect.objectContaining({
              toolName: 'splitClip',
              params: { clipId: 'c1', atTimelineSec: 5 },
            }),
            expect.objectContaining({
              toolName: 'moveClip',
              params: { clipId: 'c2', newTimelineIn: 8 },
            }),
          ],
        }),
      });
      expect(extendedFrontend.executeBatch).not.toHaveBeenCalled();
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

    it('should fail backend batch when compound expansion validation fails', async () => {
      registerCompoundExpander('ripple_edit', () => {
        throw new Error('Invalid ripple request');
      });

      try {
        const extendedTools = [
          ...TOOL_DEFS,
          { name: 'ripple_edit', description: 'Ripple edit', category: 'clip', parameters: {} },
        ];
        const extendedFrontend = createMockFrontendExecutor(extendedTools);
        const extendedBackend = createBackendToolExecutor(extendedFrontend);

        const result = await extendedBackend.executeBatch(
          {
            tools: [
              { name: 'ripple_edit', args: { clipId: 'c1', trimEnd: 4 } },
              { name: 'split_clip', args: { clipId: 'c2', atTimelineSec: 3 } },
            ],
            mode: 'sequential',
            stopOnError: true,
          },
          CONTEXT,
        );

        expect(result.success).toBe(false);
        expect(result.failureCount).toBe(2);
        expect(result.results[0].result.error).toContain('Batch expansion error');
        expect(result.results[1].result.error).toContain('Batch expansion error');
        expect(mockInvoke).not.toHaveBeenCalled();
      } finally {
        unregisterCompoundExpander('ripple_edit');
      }
    });
  });

  // ===========================================================================
  // Metadata delegation
  // ===========================================================================

  describe('metadata delegation', () => {
    it('should delegate getAvailableTools to frontend', () => {
      const tools = backend.getAvailableTools();
      expect(frontend.getAvailableTools).toHaveBeenCalled();
      expect(tools.length).toBe(TOOL_DEFS.length);
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
      expect(byCategory.get('clip')).toHaveLength(5);
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
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(frontend.execute).not.toHaveBeenCalled();

      // Analysis tool → frontend
      await backend.execute('analyze_video', { assetId: 'a1' }, CONTEXT);
      expect(frontend.execute).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledTimes(2); // execute_agent_plan + get_project_state
    });

    it('should sync backend-created clip ids into store for chained split steps', async () => {
      seedActiveProjectState({ clipIds: ['clip-1'] });

      const firstRefreshState = {
        assets: [
          createMockAsset({ id: 'asset-clip-1', name: 'clip-1.mp4', kind: 'video' }),
          createMockAsset({ id: 'asset-clip-new', name: 'clip-new.mp4', kind: 'video' }),
        ],
        sequences: [
          createMockSequence({
            id: 'seq-1',
            name: 'Test Sequence',
            tracks: [
              createMockTrack({
                id: 'track-1',
                kind: 'video',
                name: 'Video 1',
                clips: [
                  createMockClip({ id: 'clip-1', assetId: 'asset-clip-1' }),
                  createMockClip({ id: 'clip-new', assetId: 'asset-clip-new' }),
                ],
              }),
            ],
          }),
        ],
        effects: [],
        activeSequenceId: 'seq-1',
      };

      const secondRefreshState = {
        assets: [
          createMockAsset({ id: 'asset-clip-1', name: 'clip-1.mp4', kind: 'video' }),
          createMockAsset({ id: 'asset-clip-new', name: 'clip-new.mp4', kind: 'video' }),
          createMockAsset({ id: 'asset-clip-new-2', name: 'clip-new-2.mp4', kind: 'video' }),
        ],
        sequences: [
          createMockSequence({
            id: 'seq-1',
            name: 'Test Sequence',
            tracks: [
              createMockTrack({
                id: 'track-1',
                kind: 'video',
                name: 'Video 1',
                clips: [
                  createMockClip({ id: 'clip-1', assetId: 'asset-clip-1' }),
                  createMockClip({ id: 'clip-new', assetId: 'asset-clip-new' }),
                  createMockClip({ id: 'clip-new-2', assetId: 'asset-clip-new-2' }),
                ],
              }),
            ],
          }),
        ],
        effects: [],
        activeSequenceId: 'seq-1',
      };

      mockInvoke
        .mockResolvedValueOnce({
          planId: 'plan-1',
          success: true,
          totalSteps: 1,
          stepsCompleted: 1,
          stepResults: [
            {
              stepId: 'step-1',
              success: true,
              data: { createdIds: ['clip-new'] },
              durationMs: 5,
            },
          ],
          operationIds: ['op-1'],
          executionTimeMs: 5,
        })
        .mockResolvedValueOnce(firstRefreshState)
        .mockResolvedValueOnce({
          planId: 'plan-2',
          success: true,
          totalSteps: 1,
          stepsCompleted: 1,
          stepResults: [
            {
              stepId: 'step-1',
              success: true,
              data: { createdIds: ['clip-new-2'] },
              durationMs: 5,
            },
          ],
          operationIds: ['op-2'],
          executionTimeMs: 5,
        })
        .mockResolvedValueOnce(secondRefreshState);

      const firstResult = await backend.execute(
        'split_clip',
        { clipId: 'clip-1', splitTime: 1 },
        CONTEXT,
      );
      const secondResult = await backend.execute(
        'split_clip',
        { clipId: 'clip-new', splitTime: 2 },
        CONTEXT,
      );

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(useProjectStore.getState().stateVersion).toBeGreaterThan(8);
      expect(
        useProjectStore
          .getState()
          .getActiveSequence?.()
          ?.tracks[0]?.clips.some((clip) => clip.id === 'clip-new'),
      ).toBe(true);
    });

    it('should poison the session after backend sync failure and block later mutations', async () => {
      mockInvoke
        .mockResolvedValueOnce({
          planId: 'plan-1',
          success: true,
          totalSteps: 1,
          stepsCompleted: 1,
          stepResults: [{ stepId: 'step-1', success: true, data: { ok: true }, durationMs: 5 }],
          operationIds: ['op-1'],
          executionTimeMs: 5,
        })
        .mockRejectedValueOnce(new Error('refresh failed'));

      const firstResult = await backend.execute(
        'split_clip',
        { clipId: 'clip-1', splitTime: 1 },
        CONTEXT,
      );
      expect(firstResult.success).toBe(true);
      expect(firstResult.data).toEqual(expect.objectContaining({ syncWarning: 'refresh failed' }));

      const callCountAfterFirstMutation = mockInvoke.mock.calls.length;
      const secondResult = await backend.execute(
        'split_clip',
        { clipId: 'clip-1', splitTime: 2 },
        CONTEXT,
      );

      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toContain('SESSION_SYNC_FAILED');
      expect(mockInvoke.mock.calls.length).toBe(callCountAfterFirstMutation);
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

    it('should normalize backend-style marker sub-steps for single compound execute', async () => {
      registerCompoundExpander('ripple_edit', () => [
        {
          toolName: 'addMarker',
          params: { sequenceId: 'seq-1', time: 2, label: 'Beat', color: 'blue' },
        },
      ]);

      const extendedTools = [
        ...TOOL_DEFS,
        { name: 'ripple_edit', description: 'Ripple edit', category: 'clip', parameters: {} },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);

      mockInvoke.mockResolvedValueOnce({
        planId: 'compound-marker',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [
          { stepId: 'step-1', success: true, data: { markerId: 'marker-1' }, durationMs: 4 },
        ],
        operationIds: ['op-1'],
        executionTimeMs: 4,
      });

      const result = await extendedBackend.execute('ripple_edit', { clipId: 'clip-1' }, CONTEXT);

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          steps: [
            expect.objectContaining({
              toolName: 'addMarker',
              params: {
                sequenceId: 'seq-1',
                time: 2,
                label: 'Beat',
                color: { r: 0, g: 0, b: 1 },
              },
            }),
          ],
        }),
      });
      expect(extendedFrontend.execute).not.toHaveBeenCalled();
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

    it('should normalize backend-style marker sub-steps for compound batch execution', async () => {
      registerCompoundExpander('ripple_edit', () => [
        {
          toolName: 'addMarker',
          params: { sequenceId: 'seq-1', time: 2, label: 'Beat', color: '#FF000080' },
        },
      ]);

      const extendedTools = [
        ...TOOL_DEFS,
        { name: 'ripple_edit', description: 'Ripple edit', category: 'clip', parameters: {} },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);

      mockInvoke.mockResolvedValueOnce({
        planId: 'batch-compound-marker',
        success: true,
        totalSteps: 1,
        stepsCompleted: 1,
        stepResults: [
          { stepId: 'step-1', success: true, data: { markerId: 'marker-1' }, durationMs: 4 },
        ],
        operationIds: ['op-1'],
        executionTimeMs: 4,
      });

      const result = await extendedBackend.executeBatch(
        {
          tools: [{ name: 'ripple_edit', args: { clipId: 'clip-1' } }],
          mode: 'sequential',
          stopOnError: true,
        },
        CONTEXT,
      );

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_agent_plan', {
        plan: expect.objectContaining({
          steps: [
            expect.objectContaining({
              toolName: 'addMarker',
              params: {
                sequenceId: 'seq-1',
                time: 2,
                label: 'Beat',
                color: { r: 1, g: 0, b: 0, a: 128 / 255 },
              },
            }),
          ],
        }),
      });
      expect(extendedFrontend.executeBatch).not.toHaveBeenCalled();
    });

    it('should return validation failure when compound expander throws', async () => {
      registerCompoundExpander('ripple_edit', () => {
        throw new Error('Clips must be adjacent for roll edit');
      });

      const extendedTools = [
        ...TOOL_DEFS,
        { name: 'ripple_edit', description: 'Ripple edit', category: 'clip', parameters: {} },
      ];
      const extendedFrontend = createMockFrontendExecutor(extendedTools);
      const extendedBackend = createBackendToolExecutor(extendedFrontend);

      const result = await extendedBackend.execute(
        'ripple_edit',
        { clipId: 'clip-1', trimEnd: 8 },
        CONTEXT,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('ripple_edit validation failed');
      expect(result.error).toContain('Clips must be adjacent for roll edit');
      expect(mockInvoke).not.toHaveBeenCalled();
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

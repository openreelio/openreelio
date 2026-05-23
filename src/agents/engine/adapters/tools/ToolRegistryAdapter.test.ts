/**
 * ToolRegistryAdapter Tests
 *
 * Tests for the adapter that bridges IToolExecutor
 * to the existing ToolRegistry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistryAdapter, createToolRegistryAdapter } from './ToolRegistryAdapter';
import { ToolRegistry, type ToolDefinition } from '@/agents/ToolRegistry';
import type { ExecutionContext } from '../../ports/IToolExecutor';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { createMockAsset, createMockClip, createMockTrack, createMockSequence } from '@/test/mocks';

function seedActiveProjectState(): void {
  const clip = createMockClip({
    id: 'clip-1',
    assetId: 'asset-1',
    place: { timelineInSec: 0, durationSec: 10 },
  });
  const secondaryClip = createMockClip({
    id: 'clip-2',
    assetId: 'asset-2',
    place: { timelineInSec: 10, durationSec: 10 },
  });
  const track = createMockTrack({
    id: 'track-1',
    kind: 'video',
    name: 'Video 1',
    clips: [clip, secondaryClip],
  });
  const sequence = createMockSequence({
    id: 'sequence-1',
    name: 'Main Sequence',
    tracks: [track],
  });
  const asset = createMockAsset({
    id: 'asset-1',
    name: 'clip-1.mp4',
    kind: 'video',
  });
  const secondaryAsset = createMockAsset({
    id: 'asset-2',
    name: 'clip-2.mp4',
    kind: 'video',
  });

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
    activeSequenceId: 'sequence-1',
    sequences: new Map([['sequence-1', sequence]]),
    assets: new Map([
      ['asset-1', asset],
      ['asset-2', secondaryAsset],
    ]),
  });
}

describe('ToolRegistryAdapter', () => {
  let registry: ToolRegistry;
  let adapter: ToolRegistryAdapter;
  let executionContext: ExecutionContext;
  let splitClipTool: ToolDefinition;
  let deleteClipTool: ToolDefinition;
  let analyzeVideoTool: ToolDefinition;

  beforeEach(() => {
    seedActiveProjectState();
    useTimelineStore.setState({ selectedClipIds: [], selectedTrackIds: [] });
    usePlaybackStore.setState({ currentTime: 0, duration: 0 });

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
        executionContext,
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ newClipId: 'clip-2' });
      expect(splitClipTool.handler).toHaveBeenCalledWith(
        { clipId: 'clip-1', atTimelineSec: 5 },
        expect.any(Object),
      );
    });

    it('should return failure for non-existent tool', async () => {
      const result = await adapter.execute('non_existent_tool', {}, executionContext);

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
        executionContext,
      );

      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('accepts normalized tool-name aliases during execution', async () => {
      const result = await adapter.execute(
        'splitClip',
        { clipId: 'clip-1', atTimelineSec: 5 },
        executionContext,
      );

      expect(result.success).toBe(true);
      expect(splitClipTool.handler).toHaveBeenCalledWith(
        { clipId: 'clip-1', atTimelineSec: 5 },
        expect.any(Object),
      );
    });

    it('should fail fast when expected state version is stale', async () => {
      useProjectStore.setState({
        isLoaded: true,
        meta: {
          id: 'project-1',
          name: 'Test',
          path: '/tmp/test.orio',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
        },
        stateVersion: 3,
      });

      const result = await adapter.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: 5 },
        {
          ...executionContext,
          expectedStateVersion: 2,
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('REV_CONFLICT');
      expect(splitClipTool.handler).not.toHaveBeenCalled();
    });

    it('should allow read-only tools even when expected state version is stale', async () => {
      useProjectStore.setState({
        isLoaded: true,
        meta: {
          id: 'project-1',
          name: 'Test',
          path: '/tmp/test.orio',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
        },
        stateVersion: 7,
      });

      const readOnlyTool: ToolDefinition = {
        name: 'get_selection_snapshot',
        description: 'Read-only selection inspection',
        category: 'analysis',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        handler: vi.fn().mockResolvedValue({ success: true, result: { selected: [] } }),
      };
      registry.register(readOnlyTool);

      const result = await adapter.execute(
        'get_selection_snapshot',
        {},
        {
          ...executionContext,
          expectedStateVersion: 3,
        },
      );

      expect(result.success).toBe(true);
      expect(readOnlyTool.handler).toHaveBeenCalledTimes(1);
    });

    it('should allow non-mutating analysis tools with non-read prefixes when state version is stale', async () => {
      useProjectStore.setState({
        isLoaded: true,
        meta: {
          id: 'project-1',
          name: 'Test',
          path: '/tmp/test.orio',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
        },
        stateVersion: 9,
      });

      const analysisTool: ToolDefinition = {
        name: 'compare_edit_structure',
        description: 'Compare two edit structures',
        category: 'analysis',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        handler: vi.fn().mockResolvedValue({ success: true, result: { correlation: 0.91 } }),
      };
      registry.register(analysisTool);

      const result = await adapter.execute(
        'compare_edit_structure',
        {},
        {
          ...executionContext,
          expectedStateVersion: 2,
        },
      );

      expect(result.success).toBe(true);
      expect(analysisTool.handler).toHaveBeenCalledTimes(1);
    });

    it('should reject placeholder or unknown IDs before tool execution', async () => {
      const clip = createMockClip({
        id: 'clip_real',
        assetId: 'asset_real',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({
        id: 'track_real',
        kind: 'video',
        name: 'Video 1',
        clips: [clip],
      });
      const sequence = createMockSequence({
        id: 'seq_001',
        name: 'Main Sequence',
        tracks: [track],
      });
      const asset = createMockAsset({
        id: 'asset_real',
        name: 'concert.mp4',
        kind: 'video',
      });

      useProjectStore.setState({
        isLoaded: true,
        meta: {
          id: 'project-1',
          name: 'Test',
          path: '/tmp/test.orio',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
        },
        stateVersion: 10,
        activeSequenceId: 'seq_001',
        sequences: new Map([['seq_001', sequence]]),
        assets: new Map([['asset_real', asset]]),
      });

      const insertTool: ToolDefinition = {
        name: 'insert_clip',
        description: 'Insert clip from asset',
        category: 'clip',
        parameters: {
          type: 'object',
          properties: {
            sequenceId: { type: 'string', description: 'Sequence ID' },
            trackId: { type: 'string', description: 'Track ID' },
            assetId: { type: 'string', description: 'Asset ID' },
            timelineStart: { type: 'number', description: 'Timeline start' },
          },
          required: ['sequenceId', 'trackId', 'assetId', 'timelineStart'],
        },
        handler: vi.fn().mockResolvedValue({ success: true, result: { ok: true } }),
      };
      registry.register(insertTool);

      const result = await adapter.execute(
        'insert_clip',
        {
          sequenceId: 'seq_001',
          trackId: 'video_1',
          assetId: 'asset_id_from_catalog',
          timelineStart: 0,
        },
        {
          ...executionContext,
          sequenceId: 'seq_001',
          expectedStateVersion: 10,
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('PRECONDITION_FAILED');
      expect(result.error).toContain('placeholder');
      expect(insertTool.handler).not.toHaveBeenCalled();
    });

    it('should reject clip and track mismatches before tool execution', async () => {
      const clip = createMockClip({
        id: 'clip-1',
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const sourceTrack = createMockTrack({
        id: 'track-1',
        kind: 'video',
        name: 'Video 1',
        clips: [clip],
      });
      const unrelatedTrack = createMockTrack({
        id: 'track-2',
        kind: 'video',
        name: 'Video 2',
        clips: [],
      });
      const sequence = createMockSequence({
        id: 'sequence-1',
        name: 'Main Sequence',
        tracks: [sourceTrack, unrelatedTrack],
      });
      const asset = createMockAsset({
        id: 'asset-1',
        name: 'clip-1.mp4',
        kind: 'video',
      });

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
        activeSequenceId: 'sequence-1',
        sequences: new Map([['sequence-1', sequence]]),
        assets: new Map([['asset-1', asset]]),
      });

      const result = await adapter.execute(
        'split_clip',
        { clipId: 'clip-1', trackId: 'track-2', atTimelineSec: 5 },
        executionContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('PRECONDITION_FAILED');
      expect(result.error).toContain(
        "clipId 'clip-1' is on track 'track-1', not trackId 'track-2'",
      );
      expect(splitClipTool.handler).not.toHaveBeenCalled();
    });

    it('should reject split points outside the target clip range', async () => {
      const result = await adapter.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: 10 },
        executionContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('PRECONDITION_FAILED');
      expect(result.error).toContain("atTimelineSec 10 must be inside clip 'clip-1'");
      expect(splitClipTool.handler).not.toHaveBeenCalled();
    });

    it('should reject non-finite timeline numbers before tool execution', async () => {
      const result = await adapter.execute(
        'split_clip',
        { clipId: 'clip-1', atTimelineSec: Number.NaN },
        executionContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('PRECONDITION_FAILED');
      expect(result.error).toContain('atTimelineSec must be a finite number');
      expect(splitClipTool.handler).not.toHaveBeenCalled();
    });

    it('should reject inverted trim source ranges before tool execution', async () => {
      const trimClipTool: ToolDefinition = {
        name: 'trim_clip',
        description: 'Trim a clip by adjusting source in/out points',
        category: 'clip',
        parameters: {
          type: 'object',
          properties: {
            clipId: { type: 'string', description: 'The clip ID' },
            trackId: { type: 'string', description: 'The track ID' },
            newSourceIn: { type: 'number', description: 'New source in point' },
            newSourceOut: { type: 'number', description: 'New source out point' },
          },
          required: ['clipId', 'trackId'],
        },
        handler: vi.fn().mockResolvedValue({ success: true, result: { ok: true } }),
      };
      registry.register(trimClipTool);

      const result = await adapter.execute(
        'trim_clip',
        { clipId: 'clip-1', trackId: 'track-1', newSourceIn: 8, newSourceOut: 2 },
        executionContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('PRECONDITION_FAILED');
      expect(result.error).toContain('newSourceOut 2 must be greater than newSourceIn 8');
      expect(trimClipTool.handler).not.toHaveBeenCalled();
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
        executionContext,
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
        executionContext,
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
        executionContext,
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

    it('should validate meta-tool calls against the underlying action schema', () => {
      const metaRegistry = new ToolRegistry();
      metaRegistry.registerMany([
        {
          name: 'edit',
          description: 'Editing meta-tool',
          category: 'timeline',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Edit action' },
            },
            required: ['action'],
          },
          handler: vi.fn().mockResolvedValue({ success: true }),
        },
        {
          name: 'split_clip',
          description: 'Split a clip at a specific time',
          category: 'clip',
          parameters: {
            type: 'object',
            properties: {
              clipId: { type: 'string', description: 'Clip ID' },
              splitTime: { type: 'number', description: 'Split position in seconds' },
            },
            required: ['clipId', 'splitTime'],
          },
          handler: vi.fn().mockResolvedValue({ success: true }),
        },
      ]);

      const metaAdapter = createToolRegistryAdapter(metaRegistry);

      const valid = metaAdapter.validateArgs('edit', {
        action: 'split_clip',
        clipId: 'clip-1',
        atTimelineSec: 5,
      });
      expect(valid.valid).toBe(true);

      const invalid = metaAdapter.validateArgs('edit', {
        action: 'split_clip',
        clipId: 'clip-1',
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.some((error) => error.includes('splitTime'))).toBe(true);
    });

    it('should validate generate meta-tool calls against the underlying action schema', () => {
      const metaRegistry = new ToolRegistry();
      metaRegistry.registerMany([
        {
          name: 'generate',
          description: 'Generation meta-tool',
          category: 'generation',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Generate action' },
            },
            required: ['action'],
          },
          handler: vi.fn().mockResolvedValue({ success: true }),
        },
        {
          name: 'generate_video',
          description: 'Generate video',
          category: 'generation',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Prompt' },
            },
            required: ['prompt'],
          },
          handler: vi.fn().mockResolvedValue({ success: true }),
        },
      ]);

      const metaAdapter = createToolRegistryAdapter(metaRegistry);

      const valid = metaAdapter.validateArgs('generate', {
        action: 'generate_video',
        prompt: 'Generate a skyline shot',
      });
      expect(valid.valid).toBe(true);

      const invalid = metaAdapter.validateArgs('generate', {
        action: 'generate_video',
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.some((error) => error.includes('prompt'))).toBe(true);
    });

    it('should validate canonical meta-tool names resolved from aliases', () => {
      const metaRegistry = new ToolRegistry();
      metaRegistry.registerMany([
        {
          name: 'generate',
          description: 'Generation meta-tool',
          category: 'generation',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Generate action' },
            },
            required: ['action'],
          },
          handler: vi.fn().mockResolvedValue({ success: true }),
        },
        {
          name: 'generate_video',
          description: 'Generate video',
          category: 'generation',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Prompt' },
            },
            required: ['prompt'],
          },
          handler: vi.fn().mockResolvedValue({ success: true }),
        },
      ]);

      const metaAdapter = createToolRegistryAdapter(metaRegistry);

      const invalid = metaAdapter.validateArgs('Generate', {
        action: 'generate_video',
      });

      expect(invalid.valid).toBe(false);
      expect(invalid.errors.some((error) => error.includes('prompt'))).toBe(true);
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

  // ===========================================================================
  // Context Forwarding (Phase 2.1 BDD)
  // ===========================================================================

  describe('context forwarding from stores', () => {
    beforeEach(() => {
      // Set up store state with known values
      const clip = createMockClip({
        id: 'C1',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 10 },
      });

      const track = createMockTrack({
        id: 'V1',
        kind: 'video',
        name: 'Video 1',
        clips: [clip],
      });

      const sequence = createMockSequence({
        id: 'seq_001',
        name: 'Test Sequence',
        tracks: [track],
      });

      useProjectStore.setState({
        activeSequenceId: 'seq_001',
        sequences: new Map([['seq_001', sequence]]),
        assets: new Map(),
        isLoaded: true,
      });

      useTimelineStore.setState({
        selectedClipIds: ['C1', 'C2'],
        selectedTrackIds: ['V1'],
      });

      usePlaybackStore.setState({
        currentTime: 5.5,
        duration: 30,
      });
    });

    afterEach(() => {
      useProjectStore.setState({
        activeSequenceId: null,
        sequences: new Map(),
        assets: new Map(),
        isLoaded: false,
      });
      useTimelineStore.setState({
        selectedClipIds: [],
        selectedTrackIds: [],
      });
      usePlaybackStore.setState({
        currentTime: 0,
        duration: 0,
      });
    });

    it('should pass selected clips from timelineStore to tool handler', async () => {
      let capturedContext: Record<string, unknown> | null = null;
      const contextCaptureTool: ToolDefinition = {
        name: 'context_capture',
        description: 'Captures the legacy context for testing',
        category: 'utility',
        parameters: { type: 'object', properties: {} },
        handler: vi.fn().mockImplementation(async (_args, ctx) => {
          capturedContext = ctx;
          return { success: true, result: {} };
        }),
      };
      registry.register(contextCaptureTool);

      // Use matching sequenceId so the guard allows forwarding
      const ctx = { ...executionContext, sequenceId: 'seq_001' };
      await adapter.execute('context_capture', {}, ctx);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.selectedClipIds).toEqual(['C1', 'C2']);
      expect(capturedContext!.selectedClips).toEqual(['C1', 'C2']);
    });

    it('should pass selected tracks from timelineStore to tool handler', async () => {
      let capturedContext: Record<string, unknown> | null = null;
      const contextCaptureTool: ToolDefinition = {
        name: 'context_capture_tracks',
        description: 'Captures the legacy context for testing',
        category: 'utility',
        parameters: { type: 'object', properties: {} },
        handler: vi.fn().mockImplementation(async (_args, ctx) => {
          capturedContext = ctx;
          return { success: true, result: {} };
        }),
      };
      registry.register(contextCaptureTool);

      const ctx = { ...executionContext, sequenceId: 'seq_001' };
      await adapter.execute('context_capture_tracks', {}, ctx);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.selectedTrackIds).toEqual(['V1']);
      expect(capturedContext!.selectedTracks).toEqual(['V1']);
    });

    it('should pass playhead position from playbackStore to tool handler', async () => {
      let capturedContext: Record<string, unknown> | null = null;
      const contextCaptureTool: ToolDefinition = {
        name: 'context_capture_playhead',
        description: 'Captures the legacy context for testing',
        category: 'utility',
        parameters: { type: 'object', properties: {} },
        handler: vi.fn().mockImplementation(async (_args, ctx) => {
          capturedContext = ctx;
          return { success: true, result: {} };
        }),
      };
      registry.register(contextCaptureTool);

      const ctx = { ...executionContext, sequenceId: 'seq_001' };
      await adapter.execute('context_capture_playhead', {}, ctx);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.playheadPosition).toBe(5.5);
    });

    it('should return empty selection when context targets a different sequence', async () => {
      let capturedContext: Record<string, unknown> | null = null;
      const contextCaptureTool: ToolDefinition = {
        name: 'context_capture_mismatch',
        description: 'Captures the legacy context for testing',
        category: 'utility',
        parameters: { type: 'object', properties: {} },
        handler: vi.fn().mockImplementation(async (_args, ctx) => {
          capturedContext = ctx;
          return { success: true, result: {} };
        }),
      };
      registry.register(contextCaptureTool);

      // Use a different sequenceId than the active one ('seq_001')
      const ctx = { ...executionContext, sequenceId: 'other_seq' };
      await adapter.execute('context_capture_mismatch', {}, ctx);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.selectedClipIds).toEqual([]);
      expect(capturedContext!.selectedTrackIds).toEqual([]);
      expect(capturedContext!.selectedClips).toEqual([]);
      expect(capturedContext!.selectedTracks).toEqual([]);
      expect(capturedContext!.playheadPosition).toBe(0);
    });
  });

  // ===========================================================================
  // Analysis tools estimated duration
  // ===========================================================================

  describe('analysis tools estimated duration', () => {
    it('should report analysis tools as instant (not slow)', () => {
      const toolInfo = adapter.getAvailableTools().find((t) => t.name === 'analyze_video');

      expect(toolInfo).toBeDefined();
      expect(toolInfo!.estimatedDuration).toBe('instant');
    });
  });
});

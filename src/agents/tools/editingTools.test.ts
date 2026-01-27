/**
 * Editing Tools Tests
 *
 * Tests for the video editing tools registered with ToolRegistry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { globalToolRegistry } from '../ToolRegistry';
import { registerEditingTools, unregisterEditingTools } from './editingTools';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

describe('editingTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalToolRegistry.clear();
    registerEditingTools();
  });

  afterEach(() => {
    unregisterEditingTools();
  });

  describe('registration', () => {
    it('should register all editing tools', () => {
      expect(globalToolRegistry.has('move_clip')).toBe(true);
      expect(globalToolRegistry.has('trim_clip')).toBe(true);
      expect(globalToolRegistry.has('split_clip')).toBe(true);
      expect(globalToolRegistry.has('delete_clip')).toBe(true);
      expect(globalToolRegistry.has('insert_clip')).toBe(true);
    });

    it('should register tools in clip category', () => {
      const clipTools = globalToolRegistry.listByCategory('clip');
      expect(clipTools.length).toBeGreaterThanOrEqual(4);
    });

    it('should unregister all tools', () => {
      unregisterEditingTools();
      expect(globalToolRegistry.has('move_clip')).toBe(false);
      expect(globalToolRegistry.has('trim_clip')).toBe(false);
    });
  });

  describe('move_clip', () => {
    it('should have correct parameters', () => {
      const tool = globalToolRegistry.get('move_clip');
      expect(tool).toBeDefined();
      expect(tool?.parameters.required).toContain('sequenceId');
      expect(tool?.parameters.required).toContain('trackId');
      expect(tool?.parameters.required).toContain('clipId');
      expect(tool?.parameters.required).toContain('newTimelineIn');
    });

    it('should execute IPC command', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_001', success: true });

      const result = await globalToolRegistry.execute('move_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newTimelineIn: 10.5,
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'MoveClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          newTimelineIn: 10.5,
          newTrackId: undefined,
        },
      });
    });

    it('should support moving to different track', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_002', success: true });

      await globalToolRegistry.execute('move_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newTimelineIn: 10.5,
        newTrackId: 'track_002',
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'MoveClip',
        payload: expect.objectContaining({
          newTrackId: 'track_002',
        }),
      });
    });

    it('should return error on IPC failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('IPC error'));

      const result = await globalToolRegistry.execute('move_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newTimelineIn: 10.5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC error');
    });
  });

  describe('trim_clip', () => {
    it('should have correct parameters', () => {
      const tool = globalToolRegistry.get('trim_clip');
      expect(tool).toBeDefined();
      expect(tool?.parameters.required).toContain('sequenceId');
      expect(tool?.parameters.required).toContain('trackId');
      expect(tool?.parameters.required).toContain('clipId');
    });

    it('should execute IPC command with source in/out', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_003', success: true });

      const result = await globalToolRegistry.execute('trim_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newSourceIn: 2.0,
        newSourceOut: 8.0,
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'TrimClip',
        payload: expect.objectContaining({
          newSourceIn: 2.0,
          newSourceOut: 8.0,
        }),
      });
    });

    it('should support timeline position change', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_004', success: true });

      await globalToolRegistry.execute('trim_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newTimelineIn: 5.0,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'TrimClip',
        payload: expect.objectContaining({
          newTimelineIn: 5.0,
        }),
      });
    });
  });

  describe('split_clip', () => {
    it('should have correct parameters', () => {
      const tool = globalToolRegistry.get('split_clip');
      expect(tool).toBeDefined();
      expect(tool?.parameters.required).toContain('sequenceId');
      expect(tool?.parameters.required).toContain('trackId');
      expect(tool?.parameters.required).toContain('clipId');
      expect(tool?.parameters.required).toContain('splitTime');
    });

    it('should execute IPC command', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_005', success: true });

      const result = await globalToolRegistry.execute('split_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        splitTime: 5.0,
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'SplitClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          splitTime: 5.0,
        },
      });
    });
  });

  describe('delete_clip', () => {
    it('should have correct parameters', () => {
      const tool = globalToolRegistry.get('delete_clip');
      expect(tool).toBeDefined();
      expect(tool?.parameters.required).toContain('sequenceId');
      expect(tool?.parameters.required).toContain('trackId');
      expect(tool?.parameters.required).toContain('clipId');
    });

    it('should execute IPC command', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_006', success: true });

      const result = await globalToolRegistry.execute('delete_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'RemoveClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
        },
      });
    });
  });

  describe('insert_clip', () => {
    it('should have correct parameters', () => {
      const tool = globalToolRegistry.get('insert_clip');
      expect(tool).toBeDefined();
      expect(tool?.parameters.required).toContain('sequenceId');
      expect(tool?.parameters.required).toContain('trackId');
      expect(tool?.parameters.required).toContain('assetId');
      expect(tool?.parameters.required).toContain('timelineStart');
    });

    it('should execute IPC command', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_007', success: true });

      const result = await globalToolRegistry.execute('insert_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        assetId: 'asset_001',
        timelineStart: 0,
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          assetId: 'asset_001',
          timelineStart: 0,
        },
      });
    });
  });

  describe('parameter validation', () => {
    it('should reject missing required parameters', async () => {
      const result = await globalToolRegistry.execute('move_clip', {
        sequenceId: 'seq_001',
        // missing trackId, clipId, newTimelineIn
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required parameter');
    });

    it('should reject invalid parameter types', async () => {
      const result = await globalToolRegistry.execute('move_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newTimelineIn: 'not a number', // should be number
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('must be a number');
    });
  });
});

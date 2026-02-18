/**
 * Editing Tools Tests
 *
 * Tests for the video editing tools registered with ToolRegistry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { globalToolRegistry } from '../ToolRegistry';
import { registerEditingTools, unregisterEditingTools } from './editingTools';
import { useProjectStore } from '@/stores/projectStore';
import { createMockAsset, createMockSequence, createMockTrack } from '@/test/mocks';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('./storeAccessor', () => ({
  getTimelineSnapshot: vi.fn(),
}));

vi.mock('@/utils/ffmpeg', () => ({
  probeMedia: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { getTimelineSnapshot } from './storeAccessor';
import { probeMedia } from '@/utils/ffmpeg';

const mockInvoke = vi.mocked(invoke);
const mockGetTimelineSnapshot = vi.mocked(getTimelineSnapshot);
const mockProbeMedia = vi.mocked(probeMedia);
type ExecuteCommandFn = ReturnType<typeof useProjectStore.getState>['executeCommand'];

describe('editingTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProbeMedia.mockResolvedValue({
      durationSec: 0,
      format: 'unknown',
      sizeBytes: 0,
      video: undefined,
      audio: undefined,
    });
    useProjectStore.setState({
      isLoaded: false,
      meta: null,
      activeSequenceId: null,
      sequences: new Map(),
      assets: new Map(),
    });
    mockGetTimelineSnapshot.mockReturnValue({
      stateVersion: 0,
      sequenceId: 'seq_001',
      sequenceName: 'Test',
      duration: 60,
      trackCount: 1,
      clipCount: 2,
      tracks: [],
      clips: [
        {
          id: 'clip_001',
          assetId: 'asset_001',
          trackId: 'track_001',
          timelineIn: 5,
          duration: 8,
          sourceIn: 0,
          sourceOut: 8,
          speed: 1,
          opacity: 1,
          hasEffects: false,
          effectCount: 0,
          label: undefined,
        },
        {
          id: 'clip_002',
          assetId: 'asset_002',
          trackId: 'track_001',
          timelineIn: 18,
          duration: 6,
          sourceIn: 0,
          sourceOut: 6,
          speed: 1,
          opacity: 1,
          hasEffects: false,
          effectCount: 0,
          label: undefined,
        },
      ],
      selectedClipIds: [],
      selectedTrackIds: [],
      playheadPosition: 0,
    });
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
      expect(globalToolRegistry.has('delete_clips_in_range')).toBe(true);
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

    it('should split linked audio by default for video assets in loaded project', async () => {
      const videoTrack = createMockTrack({ id: 'track_v1', kind: 'video', name: 'Video 1' });
      const audioTrack = createMockTrack({ id: 'track_a1', kind: 'audio', name: 'Audio 1' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [videoTrack, audioTrack],
      });
      const asset = createMockAsset({
        id: 'asset_001',
        kind: 'video',
        durationSec: 12,
        audio: {
          sampleRate: 48000,
          channels: 2,
          codec: 'aac',
        },
      });

      const executeCalls: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const mockExecuteCommand = vi
        .fn()
        .mockImplementation(
          async ({ type, payload }: { type: string; payload: Record<string, unknown> }) => {
            executeCalls.push({ type, payload });
            if (type === 'InsertClip') {
              return {
                opId: `op_${executeCalls.length}`,
                createdIds: [`clip_${executeCalls.length}`],
                deletedIds: [],
              };
            }

            return { opId: `op_${executeCalls.length}`, createdIds: [], deletedIds: [] };
          },
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
        activeSequenceId: 'seq_001',
        sequences: new Map([['seq_001', sequence]]),
        assets: new Map([['asset_001', asset]]),
        executeCommand: mockExecuteCommand as unknown as ExecuteCommandFn,
      });

      const result = await globalToolRegistry.execute('insert_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_v1',
        assetId: 'asset_001',
        timelineStart: 2,
      });

      expect(result.success).toBe(true);
      expect(executeCalls).toHaveLength(3);
      expect(executeCalls[0]).toEqual({
        type: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_v1',
          assetId: 'asset_001',
          timelineStart: 2,
        },
      });
      expect(executeCalls[1]).toEqual({
        type: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_a1',
          assetId: 'asset_001',
          timelineStart: 2,
        },
      });
      expect(executeCalls[2]).toEqual({
        type: 'SetClipMute',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_v1',
          clipId: 'clip_1',
          muted: true,
        },
      });
      expect(mockProbeMedia).not.toHaveBeenCalled();
    });

    it('should probe media when audio metadata is missing and still insert linked audio', async () => {
      const videoTrack = createMockTrack({ id: 'track_v1', kind: 'video', name: 'Video 1' });
      const audioTrack = createMockTrack({ id: 'track_a1', kind: 'audio', name: 'Audio 1' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [videoTrack, audioTrack],
      });
      const asset = createMockAsset({
        id: 'asset_001',
        kind: 'video',
        durationSec: 12,
        audio: undefined,
        uri: '/path/to/video-with-audio.mp4',
      });

      mockProbeMedia.mockResolvedValueOnce({
        durationSec: 12,
        format: 'mov,mp4,m4a,3gp,3g2,mj2',
        sizeBytes: 1024,
        video: {
          width: 1920,
          height: 1080,
          fps: 30,
          codec: 'h264',
          pixelFormat: 'yuv420p',
        },
        audio: {
          sampleRate: 48000,
          channels: 2,
          codec: 'aac',
        },
      });

      const executeCalls: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const mockExecuteCommand = vi
        .fn()
        .mockImplementation(
          async ({ type, payload }: { type: string; payload: Record<string, unknown> }) => {
            executeCalls.push({ type, payload });
            if (type === 'InsertClip') {
              return {
                opId: `op_${executeCalls.length}`,
                createdIds: [`clip_${executeCalls.length}`],
                deletedIds: [],
              };
            }

            return { opId: `op_${executeCalls.length}`, createdIds: [], deletedIds: [] };
          },
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
        activeSequenceId: 'seq_001',
        sequences: new Map([['seq_001', sequence]]),
        assets: new Map([['asset_001', asset]]),
        executeCommand: mockExecuteCommand as unknown as ExecuteCommandFn,
      });

      const result = await globalToolRegistry.execute('insert_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_v1',
        assetId: 'asset_001',
        timelineStart: 4,
      });

      expect(result.success).toBe(true);
      expect(mockProbeMedia).toHaveBeenCalledWith('/path/to/video-with-audio.mp4');
      expect(executeCalls).toHaveLength(3);
      expect(executeCalls[1]).toEqual({
        type: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_a1',
          assetId: 'asset_001',
          timelineStart: 4,
        },
      });
    });

    it('should not auto-extract linked audio when inserting directly onto an audio track', async () => {
      const videoTrack = createMockTrack({ id: 'track_v1', kind: 'video', name: 'Video 1' });
      const audioTrack = createMockTrack({ id: 'track_a1', kind: 'audio', name: 'Audio 1' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [videoTrack, audioTrack],
      });
      const asset = createMockAsset({
        id: 'asset_001',
        kind: 'video',
        durationSec: 12,
        audio: {
          sampleRate: 48000,
          channels: 2,
          codec: 'aac',
        },
      });

      const executeCalls: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const mockExecuteCommand = vi
        .fn()
        .mockImplementation(
          async ({ type, payload }: { type: string; payload: Record<string, unknown> }) => {
            executeCalls.push({ type, payload });
            if (type === 'InsertClip') {
              return {
                opId: `op_${executeCalls.length}`,
                createdIds: [`clip_${executeCalls.length}`],
                deletedIds: [],
              };
            }

            return { opId: `op_${executeCalls.length}`, createdIds: [], deletedIds: [] };
          },
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
        activeSequenceId: 'seq_001',
        sequences: new Map([['seq_001', sequence]]),
        assets: new Map([['asset_001', asset]]),
        executeCommand: mockExecuteCommand as unknown as ExecuteCommandFn,
      });

      const result = await globalToolRegistry.execute('insert_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_a1',
        assetId: 'asset_001',
        timelineStart: 6,
      });

      expect(result.success).toBe(true);
      expect(executeCalls).toHaveLength(1);
      expect(executeCalls[0]).toEqual({
        type: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_a1',
          assetId: 'asset_001',
          timelineStart: 6,
        },
      });
      expect(mockProbeMedia).not.toHaveBeenCalled();
    });
  });

  describe('delete_clips_in_range', () => {
    it('should have correct parameters', () => {
      const tool = globalToolRegistry.get('delete_clips_in_range');
      expect(tool).toBeDefined();
      expect(tool?.parameters.required).toContain('sequenceId');
      expect(tool?.parameters.required).toContain('startTime');
      expect(tool?.parameters.required).toContain('endTime');
    });

    it('should remove overlapping clips in descending timeline order', async () => {
      mockInvoke.mockResolvedValue({ opId: 'op-range', success: true });

      const result = await globalToolRegistry.execute('delete_clips_in_range', {
        sequenceId: 'seq_001',
        startTime: 4,
        endTime: 20,
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'execute_command', {
        commandType: 'RemoveClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_002',
        },
      });
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'execute_command', {
        commandType: 'RemoveClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
        },
      });
    });

    it('should reject invalid ranges', async () => {
      const result = await globalToolRegistry.execute('delete_clips_in_range', {
        sequenceId: 'seq_001',
        startTime: 10,
        endTime: 5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid range');
      expect(mockInvoke).not.toHaveBeenCalled();
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

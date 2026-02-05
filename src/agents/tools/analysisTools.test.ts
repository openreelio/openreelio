/**
 * Analysis Tools Tests
 *
 * Tests for timeline analysis tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { globalToolRegistry } from '../ToolRegistry';
import {
  registerAnalysisTools,
  unregisterAnalysisTools,
  getAnalysisToolNames,
} from './analysisTools';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

describe('analysisTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalToolRegistry.clear();
    registerAnalysisTools();
  });

  afterEach(() => {
    unregisterAnalysisTools();
  });

  describe('registration', () => {
    it('should register all analysis tools', () => {
      expect(globalToolRegistry.has('get_timeline_info')).toBe(true);
      expect(globalToolRegistry.has('find_clips_by_asset')).toBe(true);
      expect(globalToolRegistry.has('find_gaps')).toBe(true);
      expect(globalToolRegistry.has('find_overlaps')).toBe(true);
      expect(globalToolRegistry.has('get_clip_info')).toBe(true);
    });

    it('should register tools in analysis category', () => {
      const analysisTools = globalToolRegistry.listByCategory('analysis');
      expect(analysisTools.length).toBe(5);
    });

    it('should return correct tool names', () => {
      const names = getAnalysisToolNames();
      expect(names).toContain('get_timeline_info');
      expect(names).toContain('find_gaps');
      expect(names).toHaveLength(5);
    });

    it('should unregister all tools', () => {
      unregisterAnalysisTools();
      expect(globalToolRegistry.has('get_timeline_info')).toBe(false);
      expect(globalToolRegistry.has('find_overlaps')).toBe(false);
    });
  });

  describe('get_timeline_info', () => {
    it('should return timeline information', async () => {
      const mockTimelineInfo = {
        sequenceId: 'seq_001',
        name: 'My Timeline',
        duration: 120.5,
        trackCount: 4,
        clipCount: 12,
        frameRate: 30,
      };
      mockInvoke.mockResolvedValueOnce(mockTimelineInfo);

      const result = await globalToolRegistry.execute('get_timeline_info', {
        sequenceId: 'seq_001',
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual(mockTimelineInfo);
      expect(mockInvoke).toHaveBeenCalledWith('get_timeline_info', {
        sequenceId: 'seq_001',
      });
    });
  });

  describe('find_clips_by_asset', () => {
    it('should find clips using specific asset', async () => {
      const mockClips = [
        {
          id: 'clip_001',
          assetId: 'asset_001',
          trackId: 'track_001',
          timelineIn: 0,
          duration: 10,
          sourceIn: 0,
          sourceOut: 10,
          hasEffects: false,
          effectCount: 0,
        },
        {
          id: 'clip_003',
          assetId: 'asset_001',
          trackId: 'track_002',
          timelineIn: 20,
          duration: 15,
          sourceIn: 5,
          sourceOut: 20,
          hasEffects: true,
          effectCount: 2,
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockClips);

      const result = await globalToolRegistry.execute('find_clips_by_asset', {
        sequenceId: 'seq_001',
        assetId: 'asset_001',
      });

      expect(result.success).toBe(true);
      expect(result.result).toHaveLength(2);
      expect(mockInvoke).toHaveBeenCalledWith('find_clips_by_asset', {
        sequenceId: 'seq_001',
        assetId: 'asset_001',
      });
    });

    it('should return empty array when no clips found', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      const result = await globalToolRegistry.execute('find_clips_by_asset', {
        sequenceId: 'seq_001',
        assetId: 'nonexistent_asset',
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual([]);
    });
  });

  describe('find_gaps', () => {
    it('should find gaps in timeline', async () => {
      const mockGaps = [
        {
          trackId: 'track_001',
          startTime: 10,
          endTime: 15,
          duration: 5,
        },
        {
          trackId: 'track_001',
          startTime: 30,
          endTime: 35,
          duration: 5,
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockGaps);

      const result = await globalToolRegistry.execute('find_gaps', {
        sequenceId: 'seq_001',
      });

      expect(result.success).toBe(true);
      expect(result.result).toHaveLength(2);
      expect(mockInvoke).toHaveBeenCalledWith('find_timeline_gaps', {
        sequenceId: 'seq_001',
        trackId: undefined,
        minDuration: 0,
      });
    });

    it('should find gaps on specific track', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      await globalToolRegistry.execute('find_gaps', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
      });

      expect(mockInvoke).toHaveBeenCalledWith('find_timeline_gaps', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        minDuration: 0,
      });
    });

    it('should filter gaps by minimum duration', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      await globalToolRegistry.execute('find_gaps', {
        sequenceId: 'seq_001',
        minDuration: 2.0,
      });

      expect(mockInvoke).toHaveBeenCalledWith('find_timeline_gaps', {
        sequenceId: 'seq_001',
        trackId: undefined,
        minDuration: 2.0,
      });
    });
  });

  describe('find_overlaps', () => {
    it('should find overlapping clips', async () => {
      const mockOverlaps = [
        {
          trackId: 'track_001',
          clip1Id: 'clip_001',
          clip2Id: 'clip_002',
          overlapStart: 8,
          overlapEnd: 10,
          overlapDuration: 2,
        },
      ];
      mockInvoke.mockResolvedValueOnce(mockOverlaps);

      const result = await globalToolRegistry.execute('find_overlaps', {
        sequenceId: 'seq_001',
      });

      expect(result.success).toBe(true);
      expect(result.result).toHaveLength(1);
      expect(mockInvoke).toHaveBeenCalledWith('find_timeline_overlaps', {
        sequenceId: 'seq_001',
        trackId: undefined,
      });
    });

    it('should find overlaps on specific track', async () => {
      mockInvoke.mockResolvedValueOnce([]);

      await globalToolRegistry.execute('find_overlaps', {
        sequenceId: 'seq_001',
        trackId: 'track_002',
      });

      expect(mockInvoke).toHaveBeenCalledWith('find_timeline_overlaps', {
        sequenceId: 'seq_001',
        trackId: 'track_002',
      });
    });
  });

  describe('get_clip_info', () => {
    it('should return detailed clip information', async () => {
      const mockClipInfo = {
        id: 'clip_001',
        assetId: 'asset_001',
        trackId: 'track_001',
        timelineIn: 0,
        duration: 10,
        sourceIn: 0,
        sourceOut: 10,
        hasEffects: true,
        effectCount: 3,
      };
      mockInvoke.mockResolvedValueOnce(mockClipInfo);

      const result = await globalToolRegistry.execute('get_clip_info', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
      });

      expect(result.success).toBe(true);
      expect(result.result).toEqual(mockClipInfo);
      expect(mockInvoke).toHaveBeenCalledWith('get_clip_info', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
      });
    });
  });

  describe('error handling', () => {
    it('should return error on IPC failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Timeline not found'));

      const result = await globalToolRegistry.execute('get_timeline_info', {
        sequenceId: 'nonexistent_seq',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeline not found');
    });

    it('should handle clip not found error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Clip not found'));

      const result = await globalToolRegistry.execute('get_clip_info', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'nonexistent_clip',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Clip not found');
    });
  });
});

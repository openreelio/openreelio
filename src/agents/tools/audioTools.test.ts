/**
 * Audio Tools Tests
 *
 * Tests for audio-related tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { globalToolRegistry } from '../ToolRegistry';
import {
  registerAudioTools,
  unregisterAudioTools,
  getAudioToolNames,
} from './audioTools';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

describe('audioTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalToolRegistry.clear();
    registerAudioTools();
  });

  afterEach(() => {
    unregisterAudioTools();
  });

  describe('registration', () => {
    it('should register all audio tools', () => {
      expect(globalToolRegistry.has('adjust_volume')).toBe(true);
      expect(globalToolRegistry.has('add_fade_in')).toBe(true);
      expect(globalToolRegistry.has('add_fade_out')).toBe(true);
      expect(globalToolRegistry.has('mute_clip')).toBe(true);
      expect(globalToolRegistry.has('mute_track')).toBe(true);
      expect(globalToolRegistry.has('normalize_audio')).toBe(true);
    });

    it('should register tools in audio category', () => {
      const audioTools = globalToolRegistry.listByCategory('audio');
      expect(audioTools.length).toBe(6);
    });

    it('should return correct tool names', () => {
      const names = getAudioToolNames();
      expect(names).toContain('adjust_volume');
      expect(names).toContain('add_fade_in');
      expect(names).toHaveLength(6);
    });

    it('should unregister all tools', () => {
      unregisterAudioTools();
      expect(globalToolRegistry.has('adjust_volume')).toBe(false);
      expect(globalToolRegistry.has('mute_track')).toBe(false);
    });
  });

  describe('adjust_volume', () => {
    it('should execute IPC command', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_001', success: true });

      const result = await globalToolRegistry.execute('adjust_volume', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        volume: 150,
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AdjustVolume',
        payload: expect.objectContaining({
          volume: 150,
        }),
      });
    });

    it('should support clip-specific volume', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_002', success: true });

      await globalToolRegistry.execute('adjust_volume', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        volume: 80,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AdjustVolume',
        payload: expect.objectContaining({
          clipId: 'clip_001',
          volume: 80,
        }),
      });
    });
  });

  describe('add_fade_in', () => {
    it('should execute with correct fade type', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_003', success: true });

      await globalToolRegistry.execute('add_fade_in', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        duration: 1.5,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddAudioFade',
        payload: expect.objectContaining({
          fadeType: 'in',
          duration: 1.5,
        }),
      });
    });
  });

  describe('add_fade_out', () => {
    it('should execute with correct fade type', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_004', success: true });

      await globalToolRegistry.execute('add_fade_out', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        duration: 2.0,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddAudioFade',
        payload: expect.objectContaining({
          fadeType: 'out',
          duration: 2.0,
        }),
      });
    });
  });

  describe('mute_clip', () => {
    it('should mute a clip', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_005', success: true });

      await globalToolRegistry.execute('mute_clip', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        muted: true,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'SetClipMute',
        payload: expect.objectContaining({
          muted: true,
        }),
      });
    });
  });

  describe('mute_track', () => {
    it('should mute a track', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_006', success: true });

      await globalToolRegistry.execute('mute_track', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        muted: true,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'SetTrackMute',
        payload: expect.objectContaining({
          trackId: 'track_001',
          muted: true,
        }),
      });
    });
  });

  describe('normalize_audio', () => {
    it('should normalize with default level', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_007', success: true });

      await globalToolRegistry.execute('normalize_audio', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'NormalizeAudio',
        payload: expect.objectContaining({
          targetLevel: -3,
        }),
      });
    });

    it('should support custom target level', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_008', success: true });

      await globalToolRegistry.execute('normalize_audio', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        targetLevel: -6,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'NormalizeAudio',
        payload: expect.objectContaining({
          targetLevel: -6,
        }),
      });
    });
  });

  describe('error handling', () => {
    it('should return error on IPC failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Audio processing failed'));

      const result = await globalToolRegistry.execute('adjust_volume', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        volume: 100,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Audio processing failed');
    });
  });
});
